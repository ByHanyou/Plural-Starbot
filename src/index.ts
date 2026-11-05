import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Guild,
  Interaction,
  InteractionContextType,
  Message,
  MessageFlags,
  MessageReaction,
  Partials,
  PartialMessageReaction,
  PartialUser,
  PermissionFlagsBits,
  PermissionsBitField,
  RESTPostAPIApplicationCommandsJSONBody,
  User,
} from 'discord.js';
import type {Server} from 'node:http';
import {startAvatarServer} from './avatars';
import {Config, ConfigError, loadConfig, setConfig} from './config';
import {closeDb, db, dbLinkStore, openDb, startPurgeJob} from './db';
import {type Command, CommandContext, CommandOptions, commandJSON, matchCommand, parseArgs, usageError} from './discord/commands';
import {log, setLogLevel} from './log';
import {startMemoryLog} from './memoryLog';
import {SERVER_ONLY} from './modules/replies';
import type {BotModule} from './modules/types';
import {errorText} from './util';
import {configureRegistry, loadAllSessions, stopAllSessions} from './vault/registry';

const INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.MentionEveryone,
]).bitfield;

const inviteUrl = (client: Client): string =>
  `https://discord.com/oauth2/authorize?client_id=${client.application?.id || client.user?.id || 'YOUR_CLIENT_ID'}` +
  `&permissions=${INVITE_PERMISSIONS}&scope=bot+applications.commands`;

const isDmCapable = (json: RESTPostAPIApplicationCommandsJSONBody): boolean => {
  if (Array.isArray(json.contexts)) return json.contexts.includes(InteractionContextType.BotDM);
  return json.dm_permission === true;
};

interface CommandPlan {
  global: RESTPostAPIApplicationCommandsJSONBody[];
  guild: RESTPostAPIApplicationCommandsJSONBody[];
  owner: Map<string, BotModule>;
  commands: Map<string, Command>;
}

const planCommands = (list: BotModule[]): CommandPlan => {
  const plan: CommandPlan = {global: [], guild: [], owner: new Map(), commands: new Map()};
  for (const m of list) {
    for (const c of m.commands) {
      const other = plan.owner.get(c.def.name);
      if (other) {
        log.error("Command '%s' is declared by both '%s' and '%s'; keeping '%s'.", c.def.name, other.name, m.name, other.name);
        continue;
      }
      const json = commandJSON(c.def);
      plan.owner.set(c.def.name, m);
      plan.commands.set(c.def.name, c);
      (isDmCapable(json) ? plan.global : plan.guild).push(json);
    }
  }
  return plan;
};

const eachModule = async (list: BotModule[], what: string, run: (m: BotModule) => Promise<void> | void): Promise<void> => {
  for (const m of list) {
    try {
      await run(m);
    } catch (e) {
      log.exception(e, "Module '%s' failed %s.", m.name, what);
    }
  }
};

const FAILED = '❌ Something went wrong running that command.';

const replyFailure = async (ctx: CommandContext): Promise<void> => {
  try {
    if (ctx.replied || ctx.deferred) await ctx.followUp({content: FAILED, flags: MessageFlags.Ephemeral});
    else await ctx.reply({content: FAILED, flags: MessageFlags.Ephemeral});
  } catch (e) {
    log.debug('Could not report a command failure: %s', errorText(e));
  }
};

const replyInteractionFailure = async (interaction: Interaction): Promise<void> => {
  if (!interaction.isRepliable()) return;
  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp({content: FAILED, flags: MessageFlags.Ephemeral});
    else await interaction.reply({content: FAILED, flags: MessageFlags.Ephemeral});
  } catch (e) {
    log.debug('Could not report a command failure: %s', errorText(e));
  }
};

const isUserMessage = (message: Message): boolean => !message.author.bot && !message.webhookId && !message.system;

const runCommand = async (command: Command, ctx: CommandContext, usage: string | null): Promise<void> => {
  try {
    if (!command.def.dm && !ctx.inGuild()) {
      await ctx.reply({content: SERVER_ONLY, flags: MessageFlags.Ephemeral});
      return;
    }
    if (usage !== null) {
      await ctx.reply({content: usage, flags: MessageFlags.Ephemeral});
      return;
    }
    await command.run(ctx);
  } catch (e) {
    log.exception(e, "Command '%s' failed.", command.def.name);
    await replyFailure(ctx);
  }
};

const runTextCommand = async (message: Message, command: Command, args: string): Promise<void> => {
  const parsed = await parseArgs(command.def, args, {client: message.client, guild: message.guild}, message.attachments.first() ?? null);
  const ctx = await CommandContext.fromMessage(message, command.def, parsed.ok ? parsed.options : new CommandOptions(null, new Map()));
  await runCommand(command, ctx, parsed.ok ? null : usageError(command.def, parsed.sub, parsed.error));
};

const main = async (): Promise<void> => {
  let cfg: Config;
  try {
    cfg = setConfig(loadConfig());
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  setLogLevel(cfg.logLevel);
  if (cfg.devGuildId) log.warn('DEV_GUILD_ID is set: every command is registered to server %s only and the global command list is cleared.', cfg.devGuildId);

  openDb(cfg.dataDir);
  log.info('Database open at %s.', cfg.dataDir);
  const stopPurge = startPurgeJob();

  configureRegistry({cloudNodeUrl: cfg.cloudNodeUrl, links: dbLinkStore});

  let avatarServer: Server;
  try {
    avatarServer = await startAvatarServer(cfg.avatarPort);
  } catch (e) {
    log.exception(e, 'Could not start the avatar server on 127.0.0.1:%d.', cfg.avatarPort);
    process.exit(1);
  }
  log.info('Avatar server listening on 127.0.0.1:%d (public base %s).', cfg.avatarPort, cfg.avatarBaseUrl);

  loadAllSessions()
    .then(n => log.info('Loaded %d linked vault(s).', n))
    .catch(e => log.exception(e, 'Loading linked vaults failed.'));

  const {modules} = await import('./modules/index');
  const plan = planCommands(modules);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });
  const stopMemoryLog = startMemoryLog(client);

  const syncGuild = async (guild: Guild): Promise<number> => {
    try {
      const synced = await guild.commands.set(guild.id === cfg.devGuildId ? [...plan.global, ...plan.guild] : plan.guild);
      log.info("Synced %d command(s) to '%s'.", synced.size, guild.name);
      return synced.size;
    } catch (e) {
      if (e instanceof DiscordAPIError && e.status === 403) {
        log.error(
          "Can't register commands in '%s' - the bot is missing the 'applications.commands' scope. Re-invite it with:\n  %s",
          guild.name,
          inviteUrl(client),
        );
      } else {
        log.exception(e, "Could not sync commands to '%s'.", guild.name);
      }
      return 0;
    }
  };

  client.once(Events.ClientReady, async c => {
    log.info('Logged in as %s (id: %s).', c.user.tag, c.user.id);

    try {
      for (const guildId of db().guildIdsWithSettings()) {
        if (c.guilds.cache.has(guildId)) continue;
        const n = db().clearGuild(guildId);
        log.info("No longer in server %s; removed %d setting(s).", guildId, n);
      }
    } catch (e) {
      log.exception(e, 'Could not remove settings of servers the bot has left.');
    }

    let total = 0;
    try {
      const synced = await c.application.commands.set(cfg.devGuildId ? [] : plan.global);
      total += synced.size;
      if (cfg.devGuildId) log.info('Global command list cleared; server %s gets every command.', cfg.devGuildId);
      else log.info('Synced %d global command(s).', synced.size);
    } catch (e) {
      log.exception(e, 'Could not sync global commands.');
    }

    if (!c.guilds.cache.size) log.warn('The bot is not in any server yet. Invite it with:\n  %s', inviteUrl(c));
    for (const guild of c.guilds.cache.values()) total += await syncGuild(guild);
    if (cfg.devGuildId && !c.guilds.cache.has(cfg.devGuildId)) log.warn('DEV_GUILD_ID %s is not a server this bot is in.', cfg.devGuildId);

    log.info(
      "Ready. %d command(s) synced across %d server(s); text commands start with %s. If a command isn't visible, refresh Discord (Ctrl+R).",
      total,
      c.guilds.cache.size,
      cfg.commandPrefix,
    );

    await eachModule(modules, 'in onReady', m => m.onReady?.(c));
  });

  client.on(Events.GuildCreate, guild => {
    log.info("Joined server '%s'.", guild.name);
    void syncGuild(guild);
  });

  client.on(Events.GuildDelete, guild => {
    try {
      const n = db().clearGuild(guild.id);
      log.info("Left server '%s'; removed %d setting(s).", guild.name || guild.id, n);
    } catch (e) {
      log.exception(e, "Could not remove settings for server '%s'.", guild.id);
    }
  });

  client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand()) {
      const command = plan.commands.get(interaction.commandName);
      if (!command) return;
      let ctx: CommandContext;
      try {
        ctx = await CommandContext.fromInteraction(interaction, command.def);
      } catch (e) {
        log.exception(e, "Could not read the options of '/%s'.", interaction.commandName);
        await replyInteractionFailure(interaction);
        return;
      }
      await runCommand(command, ctx, null);
      return;
    }
    if (interaction.isAutocomplete()) {
      const owner = plan.owner.get(interaction.commandName);
      try {
        await owner?.onInteraction?.(interaction);
      } catch (e) {
        log.exception(e, "Autocomplete for '/%s' failed.", interaction.commandName);
      }
      return;
    }
    for (const m of modules) {
      try {
        await m.onInteraction?.(interaction);
      } catch (e) {
        log.exception(e, "Module '%s' failed handling an interaction.", m.name);
        await replyInteractionFailure(interaction);
        return;
      }
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (isUserMessage(message)) {
      const matched = matchCommand(message.content, plan.commands);
      if (matched) {
        await runTextCommand(message, matched.command, matched.args);
        return;
      }
    }
    await eachModule(modules, 'handling a message', m => m.onMessage?.(message));
  });

  client.on(Events.MessageReactionAdd, async (r: MessageReaction | PartialMessageReaction, u: User | PartialUser) => {
    let interested: BotModule[];
    try {
      interested = modules.filter(m => m.onReactionAdd && (!m.wantsReaction || m.wantsReaction(r)));
    } catch (e) {
      log.exception(e, 'Could not check a reaction.');
      return;
    }
    if (!interested.length) return;
    let reaction: MessageReaction;
    let user: User;
    try {
      reaction = r.partial ? await r.fetch() : r;
      user = u.partial ? await u.fetch() : u;
      if (reaction.message.partial) await reaction.message.fetch();
    } catch (e) {
      log.debug('Ignoring a reaction that could not be fetched: %s', errorText(e));
      return;
    }
    await eachModule(interested, 'handling a reaction', m => m.onReactionAdd?.(reaction, user));
  });

  client.on(Events.Error, e => log.exception(e, 'Discord client error.'));

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('Received %s; shutting down.', signal);
    try {
      await stopAllSessions();
      await client.destroy();
      await new Promise<void>(r => avatarServer.close(() => r()));
    } catch (e) {
      log.exception(e, 'Error during shutdown.');
    }
    stopMemoryLog();
    stopPurge();
    closeDb();
    log.info('Stopped.');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(cfg.discordToken);
};

process.on('unhandledRejection', e => log.exception(e, 'Unhandled promise rejection.'));

main().catch(e => {
  log.exception(e, 'Plural Starbot failed to start.');
  process.exit(1);
});
