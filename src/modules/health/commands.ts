import {MessageFlags, PermissionFlagsBits} from 'discord.js';
import type {Command, CommandContext, OptionDef} from '../../discord/commands';
import {MISSING_PERMISSION} from '../replies';
import {groupSchedule, groupTimesLabel, isValidInterval, parseStartTime, timesLabel} from './schedule';
import {getSettings, HealthGroup, saveSettings} from './settings';
import {isValidZone} from './zones';
import {ensureLoop, getChannelOrNone, reschedule, sendRound} from './delivery';

const QUIET = {parse: []};

const GROUP_CHOICES = [
  {name: 'Nutrition (food + water)', value: 'Nutrition'},
  {name: 'Medicine (meds)', value: 'Medicine'},
  {name: 'Activity (stretch + move)', value: 'Activity'},
  {name: 'Eye Strain (screen breaks)', value: 'Eye Strain'},
  {name: 'Hygiene (grooming + teeth + shower)', value: 'Hygiene'},
  {name: 'Kindness (self + others + animals + world)', value: 'Kindness'},
];

const groupOption: OptionDef = {name: 'group', description: 'Which reminder group', type: 'string', required: true, choices: GROUP_CHOICES};

const ephemeral = MessageFlags.Ephemeral;

const BAD_TIME = '❌ Please use 24-hour HH:MM, like `08:00` or `14:30`.';
const BAD_INTERVAL = '❌ Interval must be one of 1, 2, 3, 4, 6, 8, 12, or 24.';

const hasOwnSchedule = (g: HealthGroup): boolean => !!(g.start_time || g.interval_hours);

const healthShow = async (i: CommandContext, guildId: string): Promise<void> => {
  const s = getSettings(guildId);
  const channel = s.channel_id ? `<#${s.channel_id}>` : '*not set, use /health channel*';
  const lines = [
    '**Health reminder settings**',
    `• Channel: ${channel}`,
    `• Timezone: \`${s.timezone}\``,
    `• Shared schedule: start \`${s.start_time}\`  •  every \`${s.interval_hours}h\`  •  fires at \`${timesLabel(s)}\``,
    `• Status: ${s.enabled ? '🟢 on' : '🔴 paused'}`,
  ];
  for (const [name, g] of Object.entries(s.groups)) {
    const role = g.role_id ? `<@&${g.role_id}>` : '*not set, use /health role*';
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

const healthChannel = async (i: CommandContext, guildId: string): Promise<void> => {
  const channel = i.options.getChannel('channel', true);
  const s = getSettings(guildId);
  s.channel_id = channel.id;
  saveSettings(guildId, s);
  ensureLoop(i.client, guildId);
  await i.reply({content: `✅ Reminders will post in <#${channel.id}>.`, flags: ephemeral, allowedMentions: QUIET});
};

const healthRole = async (i: CommandContext, guildId: string): Promise<void> => {
  const group = i.options.getString('group', true);
  const role = i.options.getRole('role', true);
  const s = getSettings(guildId);
  if (!Object.hasOwn(s.groups, group)) throw new Error(`unknown reminder group: ${group}`);
  s.groups[group].role_id = role.id;
  saveSettings(guildId, s);
  ensureLoop(i.client, guildId);
  const mention = role.id === guildId ? '@everyone' : `<@&${role.id}>`;
  await i.reply({content: `✅ ${group} reminders will ping ${mention}.`, flags: ephemeral, allowedMentions: QUIET});
};

const healthStartTime = async (i: CommandContext, guildId: string): Promise<void> => {
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

const healthInterval = async (i: CommandContext, guildId: string): Promise<void> => {
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

const healthGroupSchedule = async (i: CommandContext, guildId: string): Promise<void> => {
  const group = i.options.getString('group', true);
  const time = i.options.getString('time');
  const hours = i.options.getInteger('hours');
  const shared = i.options.getBoolean('shared') ?? false;
  const s = getSettings(guildId);
  if (!Object.hasOwn(s.groups, group)) throw new Error(`unknown reminder group: ${group}`);
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

const healthTimezone = async (i: CommandContext, guildId: string): Promise<void> => {
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

const healthEnable = async (i: CommandContext, guildId: string): Promise<void> => {
  const s = getSettings(guildId);
  s.enabled = true;
  saveSettings(guildId, s);
  ensureLoop(i.client, guildId);
  await i.reply({content: `🟢 Reminders are on. Next times: \`${timesLabel(s)}\`.`, flags: ephemeral});
};

const healthDisable = async (i: CommandContext, guildId: string): Promise<void> => {
  const s = getSettings(guildId);
  s.enabled = false;
  saveSettings(guildId, s);
  ensureLoop(i.client, guildId);
  await i.reply({content: '🔴 Reminders paused. Use /health enable to resume. (/health test still works.)', flags: ephemeral});
};

const healthTest = async (i: CommandContext, guildId: string): Promise<void> => {
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

const HANDLERS = new Map<string, (i: CommandContext, guildId: string) => Promise<void>>([
  ['show', healthShow],
  ['channel', healthChannel],
  ['role', healthRole],
  ['starttime', healthStartTime],
  ['interval', healthInterval],
  ['groupschedule', healthGroupSchedule],
  ['timezone', healthTimezone],
  ['enable', healthEnable],
  ['disable', healthDisable],
  ['test', healthTest],
]);

export const handleHealth = async (interaction: CommandContext): Promise<void> => {
  if (!interaction.inGuild()) return;
  if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({content: MISSING_PERMISSION, flags: ephemeral});
    return;
  }
  const handler = HANDLERS.get(interaction.options.getSubcommand());
  if (!handler) return;
  await handler(interaction, interaction.guildId);
};

export const healthCommand: Command = {
  def: {
    name: 'health',
    description: 'Configure the health reminder bot',
    permissions: PermissionFlagsBits.ManageGuild,
    subcommands: [
      {name: 'show', description: 'Show the current settings and schedule'},
      {
        name: 'channel',
        description: 'Set the channel where reminders are posted',
        options: [{name: 'channel', description: 'The text channel to post reminders in', type: 'channel', required: true}],
      },
      {
        name: 'role',
        description: 'Choose the role to ping for a reminder group',
        options: [groupOption, {name: 'role', description: 'The role to ping', type: 'role', required: true}],
      },
      {
        name: 'starttime',
        description: "Set the shared schedule's first ping of the day (24-hour HH:MM)",
        options: [{name: 'time', description: '24-hour time, e.g. 08:00 or 14:30', type: 'string', required: true}],
      },
      {
        name: 'interval',
        description: "Set the shared schedule's hours between pings (must divide 24)",
        options: [{name: 'hours', description: 'Hours between pings: 1, 2, 3, 4, 6, 8, 12, or 24', type: 'integer', required: true}],
      },
      {
        name: 'groupschedule',
        description: 'Give one group its own schedule, or send it back to the shared one',
        options: [
          groupOption,
          {name: 'time', description: "This group's first ping of the day, 24-hour HH:MM", type: 'string'},
          {name: 'hours', description: "This group's hours between pings: 1, 2, 3, 4, 6, 8, 12, or 24", type: 'integer'},
          {name: 'shared', description: "True = drop this group's own schedule and follow the shared one again", type: 'boolean'},
        ],
      },
      {
        name: 'timezone',
        description: 'Set the timezone (IANA name)',
        options: [{name: 'name', description: 'IANA timezone, e.g. America/New_York, America/Chicago, Europe/London', type: 'string', required: true}],
      },
      {name: 'enable', description: 'Turn the scheduled reminders on'},
      {name: 'disable', description: 'Pause the scheduled reminders'},
      {name: 'test', description: 'Send one round of reminders right now'},
    ],
  },
  run: handleHealth,
};
