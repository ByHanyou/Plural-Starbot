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
import {log} from './log';
import {modules} from './modules/index';
import {BotModule, commandJSON} from './modules/types';
import {configureRegistry, loadAllSessions, stopAllSessions} from './vault/registry';

// Permissions from README: View Channels, Send Messages, Manage Messages, Manage Webhooks, Embed Links,
// Attach Files, Read Message History, Add Reactions, Mention Everyone.
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
  const j = json as {contexts?: number[] | null; dm_permission?: boolean};
  if (Array.isArray(j.contexts)) return j.contexts.includes(InteractionContextType.BotDM);
  return j.dm_permission === true;
};

interface CommandPlan {
  global: RESTPostAPIApplicationCommandsJSONBody[];
  guild: RESTPostAPIApplicationCommandsJSONBody[];
  owner: Map<string, BotModule>;
}

const planCommands = (list: BotModule[]): CommandPlan => {
  const plan: CommandPlan = {global: [], guild: [], owner: new Map()};
  for (const m of list) {
    for (const c of m.commands) {
      const json = commandJSON(c);
      const other = plan.owner.get(json.name);
      if (other) {
        log.error("Command '%s' is declared by both '%s' and '%s'; keeping '%s'.", json.name, other.name, m.name, other.name);
        continue;
      }
      plan.owner.set(json.name, m);
      (isDmCapable(json) ? plan.global : plan.guild).push(json);
    }
  }
  return plan;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const replyFailure = async (interaction: Interaction): Promise<void> => {
  if (!interaction.isRepliable()) return;
  const content = '❌ Something went wrong running that command.';
  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp({content, flags: MessageFlags.Ephemeral});
    else await interaction.reply({content, flags: MessageFlags.Ephemeral});
  } catch {}
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

  const syncGuild = async (guild: Guild): Promise<number> => {
    try {
      const synced = await guild.commands.set(plan.guild);
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

    // Servers that removed the bot while it was offline: drop their settings, as GuildDelete would have.
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
      const synced = await c.application.commands.set(plan.global);
      total += synced.size;
      log.info('Synced %d global command(s).', synced.size);
    } catch (e) {
      log.exception(e, 'Could not sync global commands.');
    }

    if (!c.guilds.cache.size) log.warn('The bot is not in any server yet. Invite it with:\n  %s', inviteUrl(c));
    for (const guild of c.guilds.cache.values()) total += await syncGuild(guild);

    log.info(
      "Ready. %d command(s) synced across %d server(s). If a command isn't visible, refresh Discord (Ctrl+R).",
      total,
      c.guilds.cache.size,
    );

    for (const m of modules) {
      if (!m.onReady) continue;
      try {
        await m.onReady(c);
      } catch (e) {
        log.exception(e, "Module '%s' failed in onReady.", m.name);
      }
    }
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
    if (interaction.isCommand() || interaction.isAutocomplete()) {
      const owner = plan.owner.get(interaction.commandName);
      if (!owner) return;
      try {
        await owner.onInteraction(interaction);
      } catch (e) {
        log.exception(e, "Command '/%s' failed in module '%s'.", interaction.commandName, owner.name);
        if (!interaction.isAutocomplete()) await replyFailure(interaction);
      }
      return;
    }
    for (const m of modules) {
      try {
        await m.onInteraction(interaction);
      } catch (e) {
        log.exception(e, "Module '%s' failed handling an interaction.", m.name);
        await replyFailure(interaction);
        return;
      }
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    for (const m of modules) {
      if (!m.onMessage) continue;
      try {
        await m.onMessage(message);
      } catch (e) {
        log.exception(e, "Module '%s' failed handling a message.", m.name);
      }
    }
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
    for (const m of interested) {
      if (!m.onReactionAdd) continue;
      try {
        await m.onReactionAdd(reaction, user);
      } catch (e) {
        log.exception(e, "Module '%s' failed handling a reaction.", m.name);
      }
    }
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
