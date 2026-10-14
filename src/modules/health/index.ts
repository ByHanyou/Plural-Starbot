// Health reminders, ported from the Python bot (bot.py). On a schedule each
// server sets, the bot pings the roles it chose with a warm nudge about
// eating, drinking, taking meds, moving, resting your eyes, hygiene or
// kindness, plus a related fact. Everything is configured with /health
// (Manage Server). Settings and the no-repeat content memory are kept per
// guild in SQLite.

import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  EmbedBuilder,
  Events,
  HTTPError,
  Interaction,
  MessageFlags,
  PermissionFlagsBits,
  SendableChannels,
  SlashCommandBuilder,
  SlashCommandStringOption,
} from 'discord.js';
import {log} from '../../log';
import type {BotModule} from '../types';
import {DEFAULT_COLOR, FACTS, TOPIC_META} from './content';
import {contentFor, dropContent} from './memory';
import {
  ClockTime,
  computeTimes,
  dueGroupNames,
  formatClock,
  groupSchedule,
  groupTimesLabel,
  isValidInterval,
  nextFireTime,
  parseStartTime,
  timesLabel,
} from './schedule';
import {dropSettings, getSettings, guildsWithStoredSettings, HealthGroup, HealthSettings, saveSettings} from './settings';
import {isValidZone, wallAt} from './zones';

// ---- Message building ---------------------------------------------------------

const hasKey = <T>(o: Readonly<Record<string, T>>, k: string): boolean => Object.hasOwn(o, k);

const keyError = (k: string): Error => new Error(`KeyError: '${k}'`);

/** random.choices(topics, weights=[len(FACTS[t]) for t in topics], k=1)[0] */
const weightedTopic = (topics: string[]): string => {
  const cum: number[] = [];
  let total = 0;
  for (const t of topics) {
    if (!hasKey(FACTS, t)) throw keyError(t);
    total += FACTS[t].length;
    cum.push(total);
  }
  if (!(total > 0)) throw new RangeError('Total of weights must be greater than zero');
  const x = Math.random() * total;
  let i = cum.findIndex(c => c > x);
  if (i === -1) i = cum.length - 1;
  return topics[i];
};

/**
 * One reminder line per reminder_topic (in order), then one fact dealt from the
 * group's fact_topics. Everything comes off the guild's no-repeat decks.
 */
const buildEmbed = (guildId: string, group: HealthGroup): EmbedBuilder => {
  const content = contentFor(guildId);
  const reminderLines: string[] = [];
  for (const topic of group.reminder_topics) {
    if (!hasKey(TOPIC_META, topic)) throw keyError(topic);
    if (!hasKey(content.nudgeDecks, topic)) throw keyError(topic);
    reminderLines.push(`${TOPIC_META[topic].emoji} ${content.nudgeDecks[topic].draw()}`);
  }

  // Weighting by pool size keeps every individual fact equally likely even if
  // one topic's list is longer than another's.
  const factTopic = weightedTopic(group.fact_topics);
  if (!hasKey(content.factDecks, factTopic)) throw keyError(factTopic);
  const fact = content.factDecks[factTopic].draw();
  if (!hasKey(TOPIC_META, factTopic)) throw keyError(factTopic);
  const factMeta = TOPIC_META[factTopic];

  return new EmbedBuilder()
    .setDescription(reminderLines.join('\n'))
    .setColor('color' in group ? group.color : DEFAULT_COLOR)
    .addFields({name: `💡 ${factMeta.kicker}`, value: fact, inline: false});
};

// Allow role pings, but never let the bot ping @everyone or individual users.
const ALLOWED = {parse: ['roles' as const]};
const QUIET = {parse: []};

const isHttpError = (e: unknown): boolean => e instanceof DiscordAPIError || e instanceof HTTPError;

const getChannelOrNone = async (client: Client, s: HealthSettings): Promise<SendableChannels | null> => {
  const cid = s.channel_id;
  if (!cid) return null;
  let channel = client.channels.cache.get(cid) ?? null;
  if (!channel) {
    try {
      channel = await client.channels.fetch(cid);
    } catch (e) {
      if (isHttpError(e)) return null;
      throw e;
    }
  }
  return channel && channel.isSendable() ? channel : null;
};

const guildLabel = (client: Client, guildId: string): string => client.guilds.cache.get(guildId)?.name ?? guildId;

const channelLabel = (channel: SendableChannels): string => ('name' in channel && channel.name ? channel.name : channel.id);

// Groups already warned about in this process, so the console gets one loud
// line per group instead of one per firing.
const warnedRoleless = new Set<string>();

/**
 * Send one message per configured group (a group with no role is skipped).
 * `only` limits the round to the named groups; null means all of them, which is
 * what /health test wants.
 */
const sendRound = async (client: Client, guildId: string, channel: SendableChannels, only: string[] | null): Promise<number> => {
  const s = getSettings(guildId);
  const where = guildLabel(client, guildId);
  let sent = 0;
  const skippedRoleless: string[] = [];
  for (const [name, group] of Object.entries(s.groups)) {
    if (only !== null && !only.includes(name)) continue;
    if (!group.role_id) {
      // A scheduled group with no role would otherwise vanish without a trace;
      // say it once.
      if (only !== null) {
        skippedRoleless.push(name);
        const warnKey = `${guildId}\u0000${name}`;
        if (!warnedRoleless.has(warnKey)) {
          warnedRoleless.add(warnKey);
          log.warn("[%s] '%s' is scheduled but has NO role assigned, so nothing is sent for it. Fix with /health role.", where, name);
        }
      }
      continue;
    }
    try {
      const embed = buildEmbed(guildId, group);
      await channel.send({content: `<@&${group.role_id}>`, embeds: [embed], allowedMentions: ALLOWED});
      sent += 1;
      log.info('[%s] Sent %s reminder.', where, name);
    } catch (e) {
      if (e instanceof DiscordAPIError && e.status === 403) {
        log.error("[%s] Missing permission to post/mention for '%s' in #%s.", where, name, channelLabel(channel));
      } else {
        log.exception(e, "[%s] Failed sending '%s' reminder.", where, name);
      }
    }
  }
  if (skippedRoleless.length) log.info('[%s] Skipped this round (no role): %s', where, skippedRoleless.join(', '));
  // One write per round covers every line dealt above.
  contentFor(guildId).memory.save();
  return sent;
};

// ---- The scheduled loop (one per guild) -------------------------------------------

/** What happens at each wake: bot.py's reminder_loop body. */
const reminderTick = async (client: Client, guildId: string): Promise<void> => {
  const s = getSettings(guildId);
  if (!s.enabled) return;
  const where = guildLabel(client, guildId);
  const channel = await getChannelOrNone(client, s);
  if (!channel) {
    log.warn('[%s] No channel set yet — use /health channel. Skipping this round.', where);
    return;
  }
  const now = wallAt(s.timezone, Date.now());
  const due = dueGroupNames(s, now);
  // One honest line per wake, so the console proves the loop fired even when
  // every due group ends up skipped.
  log.info('[%s] Woke at %s (%s); due: %s', where, formatClock(now), s.timezone, due.length ? due.join(', ') : 'nobody');
  if (!due.length) return;
  await sendRound(client, guildId, channel, due);
};

/**
 * A guild's reminder loop: discord.py's tasks.loop(time=compute_times(settings)).
 * It sleeps until the next wake time, runs the body, and repeats. restart()
 * picks up a changed schedule.
 */
class ReminderLoop {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    const gen = ++this.generation;
    const s = getSettings(this.guildId);
    let times: ClockTime[];
    try {
      times = computeTimes(s);
    } catch (e) {
      log.exception(e, "[%s] Could not compute the reminder schedule.", guildLabel(this.client, this.guildId));
      this.timer = null;
      return;
    }
    const zone = s.timezone;
    log.info(
      '[%s] Reminder schedule (%s): shared %s; loop wakes at %s',
      guildLabel(this.client, this.guildId),
      zone,
      timesLabel(s),
      times.map(formatClock).join(', '),
    );
    this.arm(gen, times, zone, nextFireTime(times, zone, Date.now()));
  }

  restart(): void {
    this.stop();
    this.start();
  }

  stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(gen: number, times: ClockTime[], zone: string, target: number): void {
    if (gen !== this.generation) return;
    this.timer = setTimeout(() => void this.wake(gen, times, zone, target), Math.max(0, target - Date.now()));
    this.timer.unref();
  }

  private async wake(gen: number, times: ClockTime[], zone: string, target: number): Promise<void> {
    if (gen !== this.generation) return;
    if (Date.now() < target) {
      // Woke a little early; sleep the rest.
      this.arm(gen, times, zone, target);
      return;
    }
    // The next iteration always follows this one (discord.py's clock-drift guard).
    let next: number;
    try {
      next = nextFireTime(times, zone, Math.max(Date.now(), target + 1));
    } catch (e) {
      log.exception(e, '[%s] Could not compute the next reminder time.', guildLabel(this.client, this.guildId));
      this.timer = null;
      return;
    }
    try {
      await reminderTick(this.client, this.guildId);
    } catch (e) {
      log.exception(e, '[%s] Reminder round failed.', guildLabel(this.client, this.guildId));
    }
    this.arm(gen, times, zone, next);
  }
}

const loops = new Map<string, ReminderLoop>();

/** Starts the guild's loop if it is not running yet (the Python loop always ran). */
const ensureLoop = (client: Client, guildId: string): void => {
  let loop = loops.get(guildId);
  if (!loop) {
    loop = new ReminderLoop(client, guildId);
    loops.set(guildId, loop);
  }
  if (!loop.running) loop.start();
};

/** Apply a changed start time / interval / timezone to the running loop. */
const reschedule = (client: Client, guildId: string): void => {
  const loop = loops.get(guildId);
  if (loop?.running) loop.restart();
  else ensureLoop(client, guildId);
};

const stopLoop = (guildId: string): void => {
  loops.get(guildId)?.stop();
  loops.delete(guildId);
};

// ---- /health slash commands (Manage Server) ---------------------------------------

const GROUP_CHOICES = [
  {name: 'Nutrition (food + water)', value: 'Nutrition'},
  {name: 'Medicine (meds)', value: 'Medicine'},
  {name: 'Activity (stretch + move)', value: 'Activity'},
  {name: 'Eye Strain (screen breaks)', value: 'Eye Strain'},
  {name: 'Hygiene (grooming + teeth + shower)', value: 'Hygiene'},
  {name: 'Kindness (self + others + animals + world)', value: 'Kindness'},
];

const groupOption = (o: SlashCommandStringOption): SlashCommandStringOption =>
  o.setName('group').setDescription('Which reminder group').setRequired(true).addChoices(...GROUP_CHOICES);

const healthCommand = new SlashCommandBuilder()
  .setName('health')
  .setDescription('Configure the health reminder bot')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(c => c.setName('show').setDescription('Show the current settings and schedule'))
  .addSubcommand(c =>
    c
      .setName('channel')
      .setDescription('Set the channel where reminders are posted')
      .addChannelOption(o =>
        o
          .setName('channel')
          .setDescription('The text channel to post reminders in')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand(c =>
    c
      .setName('role')
      .setDescription('Choose the role to ping for a reminder group')
      .addStringOption(groupOption)
      .addRoleOption(o => o.setName('role').setDescription('The role to ping').setRequired(true)),
  )
  .addSubcommand(c =>
    c
      .setName('starttime')
      .setDescription("Set the shared schedule's first ping of the day (24-hour HH:MM)")
      .addStringOption(o => o.setName('time').setDescription('24-hour time, e.g. 08:00 or 14:30').setRequired(true)),
  )
  .addSubcommand(c =>
    c
      .setName('interval')
      .setDescription("Set the shared schedule's hours between pings (must divide 24)")
      .addIntegerOption(o => o.setName('hours').setDescription('Hours between pings: 1, 2, 3, 4, 6, 8, 12, or 24').setRequired(true)),
  )
  .addSubcommand(c =>
    c
      .setName('groupschedule')
      .setDescription('Give one group its own schedule, or send it back to the shared one')
      .addStringOption(groupOption)
      .addStringOption(o => o.setName('time').setDescription("This group's first ping of the day, 24-hour HH:MM"))
      .addIntegerOption(o => o.setName('hours').setDescription("This group's hours between pings: 1, 2, 3, 4, 6, 8, 12, or 24"))
      .addBooleanOption(o => o.setName('shared').setDescription('True = drop this group\'s own schedule and follow the shared one again')),
  )
  .addSubcommand(c =>
    c
      .setName('timezone')
      .setDescription('Set the timezone (IANA name)')
      .addStringOption(o =>
        o.setName('name').setDescription('IANA timezone, e.g. America/New_York, America/Chicago, Europe/London').setRequired(true),
      ),
  )
  .addSubcommand(c => c.setName('enable').setDescription('Turn the scheduled reminders on'))
  .addSubcommand(c => c.setName('disable').setDescription('Pause the scheduled reminders'))
  .addSubcommand(c => c.setName('test').setDescription('Send one round of reminders right now'));

const ephemeral = MessageFlags.Ephemeral;

const MISSING_PERMISSION = '❌ You need the **Manage Server** permission to change Plural Starbot.';
const BAD_TIME = '❌ Please use 24-hour HH:MM, like `08:00` or `14:30`.';
const BAD_INTERVAL = '❌ Interval must be one of 1, 2, 3, 4, 6, 8, 12, or 24.';

const hasOwnSchedule = (g: HealthGroup): boolean => !!(g.start_time || g.interval_hours);

const healthShow = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const s = getSettings(guildId);
  const channel = s.channel_id ? `<#${s.channel_id}>` : '*not set — use /health channel*';
  const lines = [
    '**Health reminder settings**',
    `• Channel: ${channel}`,
    `• Timezone: \`${s.timezone}\``,
    `• Shared schedule: start \`${s.start_time}\`  •  every \`${s.interval_hours}h\`  •  fires at \`${timesLabel(s)}\``,
    `• Status: ${s.enabled ? '🟢 on' : '🔴 paused'}`,
  ];
  for (const [name, g] of Object.entries(s.groups)) {
    const role = g.role_id ? `<@&${g.role_id}>` : '*not set — use /health role*';
    let sched = '';
    if (hasOwnSchedule(g)) {
      const [st, iv] = groupSchedule(s, g);
      sched = `  ·  own schedule: \`${st}\` every \`${iv}h\` (fires at \`${groupTimesLabel(s, g)}\`)`;
      if (!g.role_id) sched += '  ⚠️ **no role, so it never sends**';
    }
    lines.push(`• ${name} role: ${role}${sched}`);
  }
  await i.reply({content: lines.join('\n'), flags: ephemeral, allowedMentions: QUIET});
};

const healthChannel = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const channel = i.options.getChannel('channel', true);
  const s = getSettings(guildId);
  s.channel_id = channel.id;
  saveSettings(guildId, s);
  ensureLoop(i.client, guildId);
  await i.reply({content: `✅ Reminders will post in <#${channel.id}>.`, flags: ephemeral, allowedMentions: QUIET});
};

const healthRole = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const group = i.options.getString('group', true);
  const role = i.options.getRole('role', true);
  const s = getSettings(guildId);
  if (!Object.hasOwn(s.groups, group)) throw new Error(`KeyError: '${group}'`);
  s.groups[group].role_id = role.id;
  saveSettings(guildId, s);
  ensureLoop(i.client, guildId);
  const mention = role.id === guildId ? '@everyone' : `<@&${role.id}>`;
  await i.reply({content: `✅ ${group} reminders will ping ${mention}.`, flags: ephemeral, allowedMentions: QUIET});
};

const healthStartTime = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const parsed = parseStartTime(i.options.getString('time', true));
  if (parsed === null) {
    await i.reply({content: BAD_TIME, flags: ephemeral});
    return;
  }
  const s = getSettings(guildId);
  s.start_time = parsed;
  saveSettings(guildId, s);
  reschedule(i.client, guildId);
  await i.reply({content: `✅ Start time set. Now firing at: \`${timesLabel(s)}\` (${s.timezone}).`, flags: ephemeral});
};

const healthInterval = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const hours = i.options.getInteger('hours', true);
  if (!isValidInterval(hours)) {
    await i.reply({content: BAD_INTERVAL, flags: ephemeral});
    return;
  }
  const s = getSettings(guildId);
  s.interval_hours = hours;
  saveSettings(guildId, s);
  reschedule(i.client, guildId);
  await i.reply({content: `✅ Now pinging every ${hours}h. Firing at: \`${timesLabel(s)}\`.`, flags: ephemeral});
};

const healthGroupSchedule = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const group = i.options.getString('group', true);
  const time = i.options.getString('time');
  const hours = i.options.getInteger('hours');
  const shared = i.options.getBoolean('shared') ?? false;
  const s = getSettings(guildId);
  if (!Object.hasOwn(s.groups, group)) throw new Error(`KeyError: '${group}'`);
  const g = s.groups[group];

  if (shared) {
    delete g.start_time;
    delete g.interval_hours;
    saveSettings(guildId, s);
    reschedule(i.client, guildId);
    await i.reply({content: `✅ ${group} follows the shared schedule again: \`${timesLabel(s)}\`.`, flags: ephemeral});
    return;
  }

  if (time === null && hours === null) {
    const [st, iv] = groupSchedule(s, g);
    const which = hasOwnSchedule(g) ? 'its own' : 'the shared';
    const noRole = g.role_id
      ? ''
      : '\n⚠️ This group has **no role assigned**, so nothing actually sends. Fix that with `/health role`.';
    await i.reply({
      content:
        `${group} is on ${which} schedule: start \`${st}\`, every \`${iv}h\`, firing at \`${groupTimesLabel(s, g)}\`.\n` +
        'Pass `time` and/or `hours` to give it its own, or `shared: True` to clear it.' +
        noRole,
      flags: ephemeral,
    });
    return;
  }

  // Validate everything BEFORE touching settings, so a bad half can't leave a
  // half-applied schedule behind.
  let newTime: string | null = null;
  if (time !== null) {
    newTime = parseStartTime(time);
    if (newTime === null) {
      await i.reply({content: BAD_TIME, flags: ephemeral});
      return;
    }
  }
  if (hours !== null && !isValidInterval(hours)) {
    await i.reply({content: BAD_INTERVAL, flags: ephemeral});
    return;
  }

  if (newTime !== null) g.start_time = newTime;
  if (hours !== null) g.interval_hours = hours;
  saveSettings(guildId, s);
  reschedule(i.client, guildId);
  const noRole = g.role_id
    ? ''
    : "\n⚠️ This group has **no role assigned**, so these reminders won't actually send yet. Fix that with `/health role`.";
  await i.reply({
    content: `✅ ${group} now has its own schedule: firing at \`${groupTimesLabel(s, g)}\` (${s.timezone}).` + noRole,
    flags: ephemeral,
  });
};

const healthTimezone = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const name = i.options.getString('name', true);
  if (!isValidZone(name)) {
    await i.reply({content: '❌ Unknown timezone. Use an IANA name like `America/Chicago` or `Europe/London`.', flags: ephemeral});
    return;
  }
  const s = getSettings(guildId);
  s.timezone = name;
  saveSettings(guildId, s);
  reschedule(i.client, guildId);
  await i.reply({content: `✅ Timezone set to \`${name}\`. Firing at: \`${timesLabel(s)}\`.`, flags: ephemeral});
};

const healthEnable = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const s = getSettings(guildId);
  s.enabled = true;
  saveSettings(guildId, s);
  ensureLoop(i.client, guildId);
  await i.reply({content: `🟢 Reminders are on. Next times: \`${timesLabel(s)}\`.`, flags: ephemeral});
};

const healthDisable = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const s = getSettings(guildId);
  s.enabled = false;
  saveSettings(guildId, s);
  ensureLoop(i.client, guildId);
  await i.reply({content: '🔴 Reminders paused. Use /health enable to resume. (/health test still works.)', flags: ephemeral});
};

const healthTest = async (i: ChatInputCommandInteraction, guildId: string): Promise<void> => {
  const s = getSettings(guildId);
  const channel = await getChannelOrNone(i.client, s);
  if (!channel) {
    await i.reply({content: '❌ Set a channel first with /health channel.', flags: ephemeral});
    return;
  }
  if (!Object.values(s.groups).some(g => g.role_id)) {
    await i.reply({content: '❌ Assign at least one role first with /health role.', flags: ephemeral});
    return;
  }
  await i.reply({content: `📨 Sending a test round to <#${channel.id}> now…`, flags: ephemeral, allowedMentions: QUIET});
  await sendRound(i.client, guildId, channel, null);
};

const HANDLERS: Record<string, (i: ChatInputCommandInteraction, guildId: string) => Promise<void>> = {
  show: healthShow,
  channel: healthChannel,
  role: healthRole,
  starttime: healthStartTime,
  interval: healthInterval,
  groupschedule: healthGroupSchedule,
  timezone: healthTimezone,
  enable: healthEnable,
  disable: healthDisable,
  test: healthTest,
};

// ---- Module ---------------------------------------------------------------------

const health: BotModule = {
  name: 'health',
  commands: [healthCommand],

  async onInteraction(interaction: Interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'health') return;
    if (!interaction.inGuild()) return;
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({content: MISSING_PERMISSION, flags: ephemeral});
      return;
    }
    const handler = HANDLERS[interaction.options.getSubcommand()];
    if (!handler) return;
    await handler(interaction, interaction.guildId);
  },

  onReady(client) {
    for (const guildId of guildsWithStoredSettings()) {
      if (client.guilds.cache.has(guildId)) ensureLoop(client, guildId);
    }
    client.on(Events.GuildCreate, guild => {
      try {
        if (guildsWithStoredSettings().includes(guild.id)) ensureLoop(client, guild.id);
      } catch (e) {
        log.exception(e, "Could not start reminders for server '%s'.", guild.name);
      }
    });
    client.on(Events.GuildDelete, guild => {
      stopLoop(guild.id);
      dropSettings(guild.id);
      dropContent(guild.id);
      for (const k of warnedRoleless) if (k.startsWith(`${guild.id}\u0000`)) warnedRoleless.delete(k);
    });
  },
};

export default health;
