import {AutocompleteInteraction, escapeMarkdown, MessageFlags, PermissionFlagsBits, RESTJSONErrorCodes} from 'discord.js';
import {CloudError, isCloudKind} from '../../cloud/cloudTypes';
import type {Command, CommandContext, OptionDef} from '../../discord/commands';
import {tunables} from '../../config';
import {db} from '../../db';
import {log} from '../../log';
import {MISSING_PERMISSION, SERVER_ONLY} from '../replies';
import {errorText, orNull} from '../../util';
import {linkedSession, peekSession} from '../../vault/registry';
import {LINK_BROKEN_TEXT, type VaultSession} from '../../vault/session';
import type {Member} from '../../vault/types';
import {DEFAULT_FORMAT, FORMAT_MAX_LENGTH, parseFormatInput, parseSysTagInput, proxyNameFor, SettingSource, SYS_TAG_MAX, usesSysTag} from './format';
import {
  displayNameOf,
  emojiTagKey,
  emojiTagOf,
  findMember,
  findMemberByEmoji,
  firstPrimaryFronter,
  isProxyable,
  latchMember,
} from './match';
import {mentionsFor} from './proxy';
import {getNameSettings, getPings, NameSettings, PINGS_OFF, PINGS_ON, setAutoproxy, setLogChannel, setMemberFormat, setNameFormat, setPings, setSysTag} from './settings';
import {ellipsize, jumpUrl, MESSAGE_LIMIT} from './text';
import {forgetWebhook, isApiError, targetOf, webhookFor} from './webhooks';

const NOT_LINKED = 'No Plural Star vault is linked to your Discord account. Send me a direct message and run `/link` first.';
const SCOPE_EVERYWHERE = 'everywhere';
const SCOPE_SERVER = 'server';

const retentionText = (): string => {
  const d = tunables().proxiedRetentionDays;
  return d === 1 ? '1 day' : `${d} days`;
};

const scopeOption: OptionDef = {
  name: 'scope',
  description: 'Where it applies (default: everywhere)',
  type: 'string',
  choices: [
    {name: 'everywhere', value: SCOPE_EVERYWHERE},
    {name: 'this server', value: SCOPE_SERVER},
  ],
};

const sessionOrSay = async (i: CommandContext): Promise<VaultSession | null> => {
  try {
    const session = await linkedSession(i.user.id);
    if (session) return session;
    await i.editReply({content: NOT_LINKED});
  } catch (e) {
    if (!(e instanceof CloudError)) log.exception(e, 'Could not open the vault session for %s.', i.user.id);
    await i.editReply({content: `❌ Could not open your vault: ${errorText(e)}`});
  }
  return null;
};

const vaultReadFailure = (i: CommandContext, e: unknown): string => {
  if (!(e instanceof CloudError)) log.exception(e, 'Could not read the vault of %s.', i.user.id);
  return isCloudKind(e, 'LINK_BROKEN') ? `❌ ${LINK_BROKEN_TEXT}` : `❌ Could not read your vault: ${errorText(e)}`;
};

const latchStateLine = (guildId: string, userId: string, session: VaultSession): string => {
  const member = latchMember(db().lastProxiedInGuild(userId, guildId), session.members());
  return member ? `latch: currently **${escapeMarkdown(displayNameOf(member))}**` : `latch: none (nothing proxied in the last ${tunables().latchHours} hours)`;
};

export const handleAutoproxy = async (i: CommandContext): Promise<void> => {
  if (!i.inGuild()) {
    await i.reply({content: SERVER_ONLY, flags: MessageFlags.Ephemeral});
    return;
  }
  const sub = i.options.getSubcommand();
  if (sub === 'off') {
    setAutoproxy(i.guildId, i.user.id, null);
    await i.reply({content: 'Autoproxy is off in this server. Only messages with a proxy tag are proxied.', flags: MessageFlags.Ephemeral});
    return;
  }
  await i.deferReply({flags: MessageFlags.Ephemeral});
  const session = await sessionOrSay(i);
  if (!session) return;

  if (sub === 'front') {
    setAutoproxy(i.guildId, i.user.id, {mode: 'front'});
    const now = firstPrimaryFronter(session.front(), session.members(), session.settings());
    await i.editReply({
      content:
        'Autoproxy is set to **front** in this server: messages without a proxy tag are sent as the first listed primary fronter' +
        (now ? ` (right now **${escapeMarkdown(displayNameOf(now))}**).` : '. Nobody is fronting right now, so nothing is proxied until someone is.'),
    });
    return;
  }

  if (sub === 'latch') {
    setAutoproxy(i.guildId, i.user.id, {mode: 'latch'});
    await i.editReply({
      content:
        'Autoproxy is set to **latch** in this server: messages without a proxy tag are sent as the member of your last proxied message ' +
        `in this server (any channel), until ${tunables().latchHours} hours after it.\n` +
        latchStateLine(i.guildId, i.user.id, session),
    });
    return;
  }

  const query = i.options.getString('name', true);
  try {
    await session.freshen();
  } catch (e) {
    await i.editReply({content: vaultReadFailure(i, e)});
    return;
  }
  const found = findMember(session.members(), query);
  if (found.kind === 'none') {
    await i.editReply({content: `No member called **${escapeMarkdown(query.trim())}** in your vault.`});
    return;
  }
  if (found.kind === 'ambiguous') {
    await i.editReply({content: `${found.count} members are called **${escapeMarkdown(query.trim())}**. Pick one from the list that appears while you type.`});
    return;
  }
  setAutoproxy(i.guildId, i.user.id, {mode: 'member', memberId: found.member.id});
  await i.editReply({content: `Autoproxy is set to **${escapeMarkdown(displayNameOf(found.member))}** in this server.`});
};

const respondWithMembers = async (i: AutocompleteInteraction, option: string, byEmoji: boolean): Promise<void> => {
  const focused = i.options.getFocused(true);
  const session = peekSession(i.user.id);
  if (focused.name !== option || !session?.isLinked()) {
    await i.respond([]);
    return;
  }
  const typed = String(focused.value).trim();
  const q = typed.toLowerCase();
  const key = byEmoji ? emojiTagKey(typed) : '';
  const choices = session
    .members()
    .filter(isProxyable)
    .filter(m => m.id.length <= 100)
    .map(m => ({m, label: displayNameOf(m) || m.id, nick: String(m.nickname ?? '').trim().toLowerCase()}))
    .filter(c => !q || c.label.toLowerCase().includes(q) || c.nick.includes(q) || (!!key && emojiTagKey(emojiTagOf(c.m)).includes(key)))
    .slice(0, 25)
    .map(c => ({name: ellipsize(c.label, 100), value: c.m.id}));
  await i.respond(choices);
};

export const autocompleteAutoproxy = (i: AutocompleteInteraction): Promise<void> => respondWithMembers(i, 'name', false);

export const autocompleteProxy = (i: AutocompleteInteraction): Promise<void> => respondWithMembers(i, 'member', true);

const SERVER_SCOPE_IN_DM = 'The **this server** scope only works in a server. Leave it out to change the setting everywhere.';
const SOURCE_TEXT: Record<SettingSource, string> = {
  memberServer: 'their own format, set for this server',
  memberEverywhere: 'their own format, set everywhere',
  server: 'set for this server',
  everywhere: 'set everywhere',
  default: 'the default',
};
const MEMBER_SOURCE_TEXT: Record<SettingSource, string> = {
  ...SOURCE_TEXT,
  server: 'your format for all members, set for this server',
  everywhere: 'your format for all members, set everywhere',
};

const shown = (s: string): string => (s.includes('`') ? `**${escapeMarkdown(s)}**` : `\`${s}\``);

const memberPreviewLine = (member: Member, names: NameSettings): string =>
  `Preview: **${escapeMarkdown(proxyNameFor(member, names.format.value, names.sysTag.value))}**`;

const previewLine = async (userId: string, names: NameSettings): Promise<string> => {
  let session: VaultSession | null = null;
  try {
    session = await linkedSession(userId);
  } catch (e) {
    log.debug('No vault session for the proxy name preview of %s: %s', userId, errorText(e));
  }
  if (!session) return 'Link your vault with `/link` in a DM with me to see a preview.';
  const first = session.members().find(isProxyable);
  return first ? memberPreviewLine(first, names) : 'Your vault has no member to show a preview with.';
};

const saveTarget = async (i: CommandContext, saving: boolean): Promise<string | null | undefined> => {
  if (i.options.getString('scope') !== SCOPE_SERVER) return null;
  if (i.inGuild()) return i.guildId;
  if (!saving) return null;
  await i.reply({content: SERVER_SCOPE_IN_DM, flags: MessageFlags.Ephemeral});
  return undefined;
};

type Say = (lines: string[]) => Promise<void>;

const sayLines =
  (i: CommandContext): Say =>
  async lines => {
    await i.editReply({content: lines.join('\n'), allowedMentions: {parse: []}});
  };

const formatMemberOrSay = async (i: CommandContext, query: string, say: Say): Promise<Member | null> => {
  const session = await sessionOrSay(i);
  if (!session) return null;
  try {
    await session.freshen();
  } catch (e) {
    await say([vaultReadFailure(i, e)]);
    return null;
  }
  const typed = `**${escapeMarkdown(query.trim())}**`;
  const byName = findMember(session.members(), query);
  if (byName.kind === 'found') return byName.member;
  if (byName.kind === 'ambiguous') {
    await say([`${byName.count} members are called ${typed}. Pick one from the list that appears while you type.`]);
    return null;
  }
  const byEmoji = findMemberByEmoji(session.members(), query);
  if (byEmoji.kind === 'found') return byEmoji.member;
  if (byEmoji.kind === 'ambiguous') {
    await say([`${byEmoji.count} members have ${typed} as their emoji. Give the member's name instead.`]);
    return null;
  }
  await say([`No member in your vault is called ${typed} or has it as their emoji.`]);
  return null;
};

const handleMemberFormat = async (
  i: CommandContext,
  query: string,
  raw: string | null,
  target: string | null,
  here: string | null,
  say: Say,
): Promise<void> => {
  const member = await formatMemberOrSay(i, query, say);
  if (!member) return;
  const name = `**${escapeMarkdown(displayNameOf(member))}**`;

  if (raw === null) {
    const names = getNameSettings(here, i.user.id, member.id);
    await say([
      `The proxy name format for ${name} ${here ? 'in this server' : 'everywhere'} is ${shown(names.format.value)} (${MEMBER_SOURCE_TEXT[names.format.source]}).`,
      memberPreviewLine(member, names),
    ]);
    return;
  }

  const input = parseFormatInput(raw);
  if (input.kind === 'error') {
    await say([`❌ ${input.message}`]);
    return;
  }
  setMemberFormat(target, i.user.id, member.id, input.kind === 'set' ? input.template : null);
  const names = getNameSettings(target, i.user.id, member.id);
  const lines: string[] = [];
  if (input.kind === 'set') lines.push(`✅ The proxy name format for ${name} ${target ? 'in this server' : 'everywhere'} is now ${shown(input.template)}.`);
  else {
    lines.push(
      `✅ ${name} no longer has their own proxy name format ${target ? 'for this server' : 'everywhere'}. ` +
        `${target ? 'Here they' : 'They'} now get ${shown(names.format.value)} (${MEMBER_SOURCE_TEXT[names.format.source]}).`,
    );
  }
  if (!target && here) {
    const local = getNameSettings(here, i.user.id, member.id).format;
    if (local.source !== names.format.source) lines.push(`In this server ${name} gets ${shown(local.value)} (${MEMBER_SOURCE_TEXT[local.source]}).`);
  }
  lines.push(memberPreviewLine(member, names));
  await say(lines);
};

const handleFormat = async (i: CommandContext): Promise<void> => {
  const raw = i.options.getString('template');
  const target = await saveTarget(i, raw !== null);
  if (target === undefined) return;
  await i.deferReply({flags: MessageFlags.Ephemeral});
  const say = sayLines(i);
  const here = i.inGuild() ? i.guildId : null;

  const memberQuery = i.options.getString('member');
  if (memberQuery !== null) {
    await handleMemberFormat(i, memberQuery, raw, target, here, say);
    return;
  }

  if (raw === null) {
    const names = getNameSettings(here, i.user.id);
    await say([
      `Your proxy name format ${here ? 'in this server' : 'everywhere'} is ${shown(names.format.value)} (${SOURCE_TEXT[names.format.source]}).`,
      await previewLine(i.user.id, names),
    ]);
    return;
  }

  const input = parseFormatInput(raw);
  if (input.kind === 'error') {
    await say([`❌ ${input.message}`]);
    return;
  }
  setNameFormat(target, i.user.id, input.kind === 'set' ? input.template : null);
  const names = getNameSettings(target, i.user.id);
  const lines: string[] = [];
  if (input.kind === 'set') lines.push(`✅ Your proxy name format ${target ? 'in this server' : 'everywhere'} is now ${shown(input.template)}.`);
  else if (target) lines.push(`✅ Removed your proxy name format for this server. Here you now get ${shown(names.format.value)} (${SOURCE_TEXT[names.format.source]}).`);
  else lines.push(`✅ Your proxy name format everywhere is back to the default, ${shown(DEFAULT_FORMAT)}.`);
  if (!target && here) {
    const local = getNameSettings(here, i.user.id).format;
    if (local.source === 'server') lines.push(`This server has its own format, ${shown(local.value)}, which still applies here.`);
  }
  lines.push(await previewLine(i.user.id, names));
  await say(lines);
};

const unusedSysTagNote = (names: NameSettings): string[] =>
  names.sysTag.value && !usesSysTag(names.format.value)
    ? [`Your proxy name format ${shown(names.format.value)} has no {Sys Tag}, so the Sys Tag is not shown. Add it with \`/proxy format\`.`]
    : [];

const handleSysTag = async (i: CommandContext): Promise<void> => {
  const raw = i.options.getString('text');
  const target = await saveTarget(i, raw !== null);
  if (target === undefined) return;
  await i.deferReply({flags: MessageFlags.Ephemeral});
  const say = sayLines(i);
  const here = i.inGuild() ? i.guildId : null;

  if (raw === null) {
    const names = getNameSettings(here, i.user.id);
    await say([
      names.sysTag.source === 'default'
        ? `You have no Sys Tag ${here ? 'in this server' : 'set'}.`
        : `Your Sys Tag ${here ? 'in this server' : 'everywhere'} is ${shown(names.sysTag.value)} (${SOURCE_TEXT[names.sysTag.source]}).`,
      ...unusedSysTagNote(names),
      await previewLine(i.user.id, names),
    ]);
    return;
  }

  const input = parseSysTagInput(raw);
  if (input.kind === 'error') {
    await say([`❌ ${input.message}`]);
    return;
  }
  setSysTag(target, i.user.id, input.kind === 'set' ? input.sysTag : null);
  const names = getNameSettings(target, i.user.id);
  const lines: string[] = [];
  if (input.kind === 'set') lines.push(`✅ Your Sys Tag ${target ? 'in this server' : 'everywhere'} is now ${shown(input.sysTag)}.`);
  else if (target) {
    lines.push(
      '✅ Removed your Sys Tag for this server.' +
        (names.sysTag.source === 'everywhere' ? ` Here you now get ${shown(names.sysTag.value)} (set everywhere).` : ''),
    );
  } else lines.push('✅ Removed your Sys Tag everywhere.');
  if (!target && here) {
    const local = getNameSettings(here, i.user.id).sysTag;
    if (local.source === 'server') lines.push(`This server has its own Sys Tag, ${shown(local.value)}, which still applies here.`);
  }
  lines.push(...unusedSysTagNote(names), await previewLine(i.user.id, names));
  await say(lines);
};

const PINGS_MEANING: Record<string, string> = {
  [PINGS_ON]: 'Reacting 🔔 to one of your proxied messages pings you in that channel.',
  [PINGS_OFF]: 'Reacting 🔔 to one of your proxied messages does not ping you; the person who reacted gets a DM with your mention instead.',
};

const handlePings = async (i: CommandContext): Promise<void> => {
  const raw = i.options.getString('state');
  const target = await saveTarget(i, raw !== null);
  if (target === undefined) return;
  const here = i.inGuild() ? i.guildId : null;

  if (raw === null) {
    const pings = getPings(here, i.user.id);
    const lines = [`🔔 pings are **${pings.value}** for you ${here ? 'in this server' : 'everywhere'} (${SOURCE_TEXT[pings.source]}).`, PINGS_MEANING[pings.value] ?? ''];
    await i.reply({content: lines.filter(Boolean).join('\n'), flags: MessageFlags.Ephemeral});
    return;
  }

  setPings(target, i.user.id, raw);
  const lines = [`✅ 🔔 pings are now **${raw}** for you ${target ? 'in this server' : 'everywhere'}.`, PINGS_MEANING[raw] ?? ''];
  if (!target && here) {
    const local = getPings(here, i.user.id);
    if (local.source === 'server') lines.push(`This server has its own setting, **${local.value}**, which still applies here.`);
  }
  await i.reply({content: lines.filter(Boolean).join('\n'), flags: MessageFlags.Ephemeral});
};

export const handleProxy = async (i: CommandContext): Promise<void> => {
  const sub = i.options.getSubcommand();
  if (sub === 'format') {
    await handleFormat(i);
    return;
  }
  if (sub === 'systag') {
    await handleSysTag(i);
    return;
  }
  if (sub === 'pings') {
    await handlePings(i);
    return;
  }
  if (!i.inGuild()) {
    await i.reply({content: SERVER_ONLY, flags: MessageFlags.Ephemeral});
    return;
  }
  if (sub !== 'edit') return;
  const text = i.options.getString('text', true);
  const idRaw = i.options.getString('message_id')?.trim() || '';
  await i.deferReply({flags: MessageFlags.Ephemeral});

  if (!text.trim()) {
    await i.editReply({content: 'The new text cannot be empty.'});
    return;
  }

  let record;
  if (idRaw) {
    if (!/^\d{15,25}$/.test(idRaw)) {
      await i.editReply({content: 'That is not a message ID.'});
      return;
    }
    record = db().proxiedByMessageId(idRaw);
    if (!record) {
      await i.editReply({content: `I have no record of a proxied message with that ID. Proxied messages can only be edited for ${retentionText()} after they were sent.`});
      return;
    }
    if (record.userId !== i.user.id) {
      await i.editReply({content: 'That message was not proxied by you.'});
      return;
    }
  } else {
    record = db().lastProxied(i.user.id, i.channelId);
    if (!record) {
      await i.editReply({content: `You have no proxied message in this channel from the last ${retentionText()}. Older messages cannot be edited.`});
      return;
    }
  }

  const channel = await orNull(i.client.channels.fetch(record.channelId), `Fetching channel ${record.channelId}`);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await i.editReply({content: 'The channel of that message is gone.'});
    return;
  }
  const target = targetOf(channel);
  if (!target) {
    await i.editReply({content: 'Messages in that channel cannot be edited.'});
    return;
  }
  const member =
    channel.guild.members.cache.get(i.user.id) ?? (await orNull(channel.guild.members.fetch(i.user.id), `Fetching server member ${i.user.id}`));

  try {
    const hook = await webhookFor(target.host);
    await hook.editMessage(record.messageId, {
      content: text,
      allowedMentions: mentionsFor(text, channel, member),
      ...(target.threadId ? {threadId: target.threadId} : {}),
    });
  } catch (e) {
    if (isApiError(e, RESTJSONErrorCodes.UnknownWebhook)) {
      forgetWebhook(target.host.id);
      await i.editReply({content: 'The webhook that posted that message was removed, so it can no longer be edited.'});
      return;
    }
    if (isApiError(e, RESTJSONErrorCodes.UnknownMessage)) {
      await i.editReply({content: 'That message can no longer be edited: it was deleted, or posted through a webhook that has since been replaced.'});
      return;
    }
    log.warn('Editing proxied message %s failed: %s', record.messageId, errorText(e));
    await i.editReply({content: `❌ Could not edit that message: ${errorText(e)}`});
    return;
  }
  const link = jumpUrl(channel.guildId, record.channelId, record.messageId);
  await i.editReply({content: `✅ Edited ${link}.`});
};

export const handleProxylog = async (i: CommandContext): Promise<void> => {
  if (!i.inCachedGuild()) {
    await i.reply({content: SERVER_ONLY, flags: MessageFlags.Ephemeral});
    return;
  }
  if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    await i.reply({content: MISSING_PERMISSION, flags: MessageFlags.Ephemeral});
    return;
  }
  const sub = i.options.getSubcommand();
  if (sub === 'off') {
    setLogChannel(i.guildId, null);
    await i.reply({content: 'Proxied messages are no longer logged in this server.', flags: MessageFlags.Ephemeral});
    return;
  }
  const channel = i.options.getChannel('channel', true);
  const me = i.guild.members.me ?? (await orNull(i.guild.members.fetchMe(), `Fetching the bot's own member in '${i.guild.name}'`));
  const perms = me ? channel.permissionsFor(me) : null;
  const missing = (
    [
      [PermissionFlagsBits.ViewChannel, 'View Channel'],
      [PermissionFlagsBits.SendMessages, 'Send Messages'],
      [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
    ] as const
  )
    .filter(([flag]) => !perms?.has(flag))
    .map(([, label]) => label);
  if (missing.length) {
    await i.reply({content: `I can't post in ${channel}: I need ${missing.join(', ')} there.`, flags: MessageFlags.Ephemeral});
    return;
  }
  setLogChannel(i.guildId, channel.id);
  await i.reply({content: `Proxied messages in this server are now logged in ${channel}.`, flags: MessageFlags.Ephemeral});
};

export const autoproxyCommand: Command = {
  def: {
    name: 'autoproxy',
    description: 'Proxy your messages in this server without proxy tags',
    subcommands: [
      {name: 'off', description: 'Turn autoproxy off in this server'},
      {name: 'front', description: 'Proxy as the first listed primary fronter'},
      {
        name: 'member',
        description: 'Proxy as one member',
        options: [{name: 'name', description: 'Member name', type: 'string', required: true, maxLength: 100, autocomplete: true}],
      },
      {name: 'latch', description: `Proxy as the member of your last proxied message in this server, for up to ${tunables().latchHours} hours`},
    ],
  },
  run: handleAutoproxy,
};

export const proxyCommand: Command = {
  def: {
    name: 'proxy',
    description: 'Your proxied messages',
    dm: true,
    subcommands: [
      {
        name: 'edit',
        description: 'Edit your last proxied message in this channel, or one you name by ID',
        options: [
          {name: 'text', description: 'The new text', type: 'string', required: true, maxLength: MESSAGE_LIMIT},
          {name: 'message_id', description: 'ID of a proxied message of yours (default: your last one here)', type: 'string', maxLength: 25},
        ],
      },
      {
        name: 'format',
        description: 'Set how your proxied messages are named, for all members or one, or show the current format',
        options: [
          {
            name: 'member',
            description: 'One member (emoji or name) to set or show their own format, used instead of yours',
            type: 'string',
            maxLength: 100,
            autocomplete: true,
          },
          {
            name: 'template',
            description: 'Formatting tags: {Emoji} {Name} {Pronouns} {Role} {Sys Tag}. Other text is kept. "default" resets',
            type: 'string',
            maxLength: FORMAT_MAX_LENGTH,
          },
          scopeOption,
        ],
      },
      {
        name: 'systag',
        description: 'Set the Sys Tag that {Sys Tag} fills in your proxy format, or show it',
        options: [{name: 'text', description: `Up to ${SYS_TAG_MAX} characters. "clear" removes it`, type: 'string'}, scopeOption],
      },
      {
        name: 'pings',
        description: 'Turn 🔔 reaction pings on your proxied messages on or off, or show the setting',
        options: [
          {
            name: 'state',
            description: 'on or off',
            type: 'string',
            choices: [
              {name: 'on', value: PINGS_ON},
              {name: 'off', value: PINGS_OFF},
            ],
          },
          scopeOption,
        ],
      },
    ],
  },
  run: handleProxy,
};

export const proxylogCommand: Command = {
  def: {
    name: 'proxylog',
    description: 'Log every proxied message in this server to a channel',
    permissions: PermissionFlagsBits.ManageGuild,
    subcommands: [
      {
        name: 'channel',
        description: 'Channel proxied messages are logged in',
        options: [{name: 'channel', description: 'Log channel', type: 'channel', required: true}],
      },
      {name: 'off', description: 'Stop logging proxied messages'},
    ],
  },
  run: handleProxylog,
};
