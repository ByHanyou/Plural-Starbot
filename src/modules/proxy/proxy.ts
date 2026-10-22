import {
  AttachmentBuilder,
  EmbedBuilder,
  GuildMember,
  GuildTextBasedChannel,
  Message,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  WebhookMessageCreateOptions,
} from 'discord.js';
import {avatarUrlFor} from '../../avatars';
import {tunables} from '../../config';
import {db} from '../../db';
import {log} from '../../log';
import {errorText, orNull} from '../../util';
import {hasStoredLink, linkedSession, peekSession} from '../../vault/registry';
import type {VaultSession} from '../../vault/session';
import {MEDIA_KEYS, Member} from '../../vault/types';
import {proxyNameFor} from './format';
import {planProxy} from './match';
import {postProxyLog} from './proxylog';
import {getAutoproxy, getNameSettings} from './settings';
import {
  allowedMentionsFor,
  AllowedMentions,
  ellipsize,
  EMBED_LIMIT,
  embedColor,
  planAttachments,
  replyQuote,
  splitContent,
  tooLargeNote,
  uploadLimitBytes,
} from './text';
import {isApiError, sendViaWebhook, targetOf} from './webhooks';
import {warnHourly} from './warn';

const REPLY_MARK = ' ' + String.fromCharCode(0x2003, 0x21a9, 0xfe0f);

export const mentionsFor = (content: string, channel: GuildTextBasedChannel, member: GuildMember | null): AllowedMentions => {
  const everyone = !!member && !!channel.permissionsFor(member)?.has(PermissionFlagsBits.MentionEveryone);
  return allowedMentionsFor(content, everyone, id => channel.guild.roles.cache.get(id)?.mentionable === true);
};

const canProxyIn = async (message: Message<true>): Promise<boolean> => {
  const channel = message.channel;
  const target = targetOf(channel);
  if (!target) return false;
  const guild = message.guild;
  const me = guild.members.me ?? (await orNull(guild.members.fetchMe(), `Fetching the bot's own member in '${guild.name}'`));
  if (!me) return false;
  const missing: string[] = [];
  if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) missing.push('Manage Messages');
  if (!target.host.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) missing.push('Manage Webhooks');
  if (!missing.length) return true;
  warnHourly(`perms:${channel.id}`, "Not proxying in #%s ('%s'): the bot is missing %s there.", channel.name, guild.name, missing.join(' and '));
  return false;
};

const download = async (url: string): Promise<Buffer | null> => {
  try {
    const res = await fetch(url, {signal: AbortSignal.timeout(tunables().downloadTimeoutMs)});
    if (!res.ok) {
      log.debug('Attachment download returned status %d.', res.status);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log.debug('Attachment download failed: %s', errorText(e));
    return null;
  }
};

const replyEmbed = async (message: Message<true>, member: Member): Promise<EmbedBuilder | null> => {
  if (message.type !== MessageType.Reply) return null;
  let ref: Message;
  try {
    ref = await message.fetchReference();
  } catch (e) {
    log.debug('Could not fetch the message %s replies to: %s', message.id, errorText(e));
    return null;
  }
  const name = ref.member?.displayName ?? ref.author.displayName;
  const embed = new EmbedBuilder()
    .setAuthor({name: ellipsize(`${name}${REPLY_MARK}`, EMBED_LIMIT.author), iconURL: (ref.member ?? ref.author).displayAvatarURL()})
    .setDescription(replyQuote(ref.content, ref.attachments.size > 0, ref.url));
  const color = embedColor(member.color);
  if (color !== null) embed.setColor(color);
  return embed;
};

const deleteQuietly = async (m: Message): Promise<void> => {
  try {
    await m.delete();
  } catch (e) {
    log.debug('Could not delete message %s: %s', m.id, errorText(e));
  }
};

const repost = async (message: Message<true>, session: VaultSession, member: Member, text: string): Promise<void> => {
  if (!(await canProxyIn(message))) return;
  const target = targetOf(message.channel);
  if (!target) return;

  const originals = [...message.attachments.values()];
  const budget = planAttachments(originals.map(a => ({name: a.name, size: a.size})), uploadLimitBytes(message.guild.premiumTier));
  const files: AttachmentBuilder[] = [];
  for (const idx of budget.keep) {
    const a = originals[idx];
    const bytes = await download(a.url);
    if (!bytes) {
      log.warn('Not proxying message %s: attachment %s could not be downloaded.', message.id, a.name);
      return;
    }
    files.push(new AttachmentBuilder(bytes, {name: a.name, ...(a.description ? {description: a.description} : {})}));
  }

  const body = [text, ...budget.skipped.map(tooLargeNote)].filter(s => s.trim()).join('\n');
  const chunks = splitContent(body);
  if (!chunks.length && !files.length) return;

  const names = getNameSettings(message.guildId, message.author.id, member.id);
  const username = proxyNameFor(member, names.format.value, names.sysTag.value);
  const avatarURL = avatarUrlFor(session, MEDIA_KEYS.memberAvatar(member.id));
  const allowedMentions = mentionsFor(body, message.channel, message.member);
  const flags: ('SuppressEmbeds' | 'SuppressNotifications')[] = [];
  if (message.flags.has(MessageFlags.SuppressEmbeds)) flags.push('SuppressEmbeds');
  if (message.flags.has(MessageFlags.SuppressNotifications)) flags.push('SuppressNotifications');
  const quote = await replyEmbed(message, member);

  const parts = chunks.length ? chunks : [''];
  const sent: Message<true>[] = [];
  try {
    for (let n = 0; n < parts.length; n++) {
      const opts: WebhookMessageCreateOptions = {username, allowedMentions};
      if (avatarURL) opts.avatarURL = avatarURL;
      if (flags.length) opts.flags = flags;
      if (parts[n]) opts.content = parts[n];
      if (n === 0 && quote) opts.embeds = [quote];
      if (n === parts.length - 1 && files.length) opts.files = files;
      sent.push(await sendViaWebhook(target, opts));
    }
  } catch (e) {
    warnHourly(`send:${message.channelId}`, "Proxying failed in #%s ('%s'): %s", message.channel.name, message.guild.name, errorText(e));
    for (const m of sent) await deleteQuietly(m);
    return;
  }

  const now = Date.now();
  sent.forEach((m, n) => {
    db().recordProxied({
      messageId: m.id,
      originalId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      memberId: member.id,
      userId: message.author.id,
      timestamp: m.createdTimestamp || now + n,
    });
  });

  try {
    await message.delete();
  } catch (e) {
    if (!isApiError(e, RESTJSONErrorCodes.UnknownMessage)) {
      log.warn('Proxied message %s but could not delete the original: %s', message.id, errorText(e));
    }
  }

  for (let n = 0; n < sent.length; n++) {
    await postProxyLog(message.guild, {
      sent: sent[n],
      originalId: message.id,
      sender: message.author,
      channelName: message.channel.name,
      shownName: username,
      avatarUrl: avatarURL,
      content: parts[n] ?? '',
    });
  }
};

const queues = new Map<string, Promise<void>>();

const enqueue = (key: string, task: () => Promise<void>): Promise<void> => {
  const run = (queues.get(key) ?? Promise.resolve()).then(task).catch((e: unknown) => log.exception(e, 'Proxying failed in channel %s.', key));
  queues.set(key, run);
  void run.finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  });
  return run;
};

export const handleMessage = async (message: Message): Promise<void> => {
  if (message.partial || !message.inGuild()) return;
  if (message.author.bot || message.webhookId || message.system) return;
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;
  if (message.stickers.size || message.poll) return;
  if (message.channel.isThread() && message.id === message.channelId) return;

  if (!peekSession(message.author.id)?.isLinked() && !hasStoredLink(message.author.id)) return;

  await enqueue(message.channelId, async () => {
    let session: VaultSession | null;
    try {
      session = await linkedSession(message.author.id);
    } catch (e) {
      log.debug('No vault session for %s: %s', message.author.id, errorText(e));
      return;
    }
    if (!session) return;

    const autoproxy = getAutoproxy(message.guildId, message.author.id);
    const plan = planProxy({
      content: message.content,
      hasAttachments: message.attachments.size > 0,
      members: session.members(),
      front: session.front(),
      autoproxy,
      settings: session.settings(),
      latch: autoproxy?.mode === 'latch' ? db().lastProxiedInGuild(message.author.id, message.guildId) : null,
      now: Date.now(),
    });
    if (plan.kind !== 'proxy') return;
    await repost(message, session, plan.member, plan.content);
  });
};
