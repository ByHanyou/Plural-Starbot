// Proxying one message: decide (match.ts), then re-post through the channel webhook and delete the original.
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
import {db} from '../../db';
import {log} from '../../log';
import {hasStoredLink, linkedSession, peekSession} from '../../vault/registry';
import type {VaultSession} from '../../vault/session';
import {MEDIA_KEYS, Member} from '../../vault/types';
import {displayNameOf, planProxy} from './match';
import {postProxyLog} from './proxylog';
import {getAutoproxy} from './settings';
import {
  allowedMentionsFor,
  AllowedMentions,
  ellipsize,
  embedColor,
  planAttachments,
  replyQuote,
  sanitizeWebhookName,
  splitContent,
  tooLargeNote,
  uploadLimitBytes,
} from './text';
import {isApiError, sendViaWebhook, targetOf} from './webhooks';
import {warnHourly} from './warn';

/** em space + the return-arrow emoji, after the replied-to author's name (as PluralKit shows it). */
const REPLY_MARK = ' ' + String.fromCharCode(0x2003, 0x21a9, 0xfe0f);
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

/** The webhook username for a member: its name (nickname only when the name is blank), sanitised for Discord. */
export const webhookUsername = (m: Member): string => sanitizeWebhookName(displayNameOf(m));

/** The member's avatar URL on the bot's avatar server, if the vault holds one. */
export const memberAvatarUrl = (session: VaultSession, m: Member): string | undefined => avatarUrlFor(session, MEDIA_KEYS.memberAvatar(m.id));

/** Allowed mentions for text sent on behalf of `member` in `channel`. */
export const mentionsFor = (content: string, channel: GuildTextBasedChannel, member: GuildMember | null): AllowedMentions => {
  const everyone = !!member && !!channel.permissionsFor(member)?.has(PermissionFlagsBits.MentionEveryone);
  return allowedMentionsFor(content, everyone, id => channel.guild.roles.cache.get(id)?.mentionable === true);
};

/** Whether the bot can proxy in a channel (Manage Messages there, Manage Webhooks on the webhook's channel); warns hourly when not. */
const canProxyIn = async (message: Message<true>): Promise<boolean> => {
  const channel = message.channel;
  const target = targetOf(channel);
  if (!target) return false;
  const guild = message.guild;
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
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
    const res = await fetch(url, {signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)});
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
};

const replyEmbed = async (message: Message<true>, member: Member): Promise<EmbedBuilder | null> => {
  if (message.type !== MessageType.Reply) return null;
  let ref: Message;
  try {
    ref = await message.fetchReference();
  } catch {
    return null;
  }
  const name = ref.member?.displayName ?? ref.author.displayName;
  const embed = new EmbedBuilder()
    .setAuthor({name: ellipsize(`${name}${REPLY_MARK}`, 256), iconURL: (ref.member ?? ref.author).displayAvatarURL()})
    .setDescription(replyQuote(ref.content, ref.attachments.size > 0, ref.url));
  const color = embedColor(member.color);
  if (color !== null) embed.setColor(color);
  return embed;
};

const deleteQuietly = async (m: Message): Promise<void> => {
  try {
    await m.delete();
  } catch {}
};

/** Re-posts a message as `member` and deletes the original. Every failure before the delete leaves the original alone. */
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

  const username = webhookUsername(member);
  const avatarURL = memberAvatarUrl(session, member);
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
    warnHourly(`send:${message.channelId}`, "Proxying failed in #%s ('%s'): %s", message.channel.name, message.guild.name, e instanceof Error ? e.message : String(e));
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
      // Distinct, ordered times so "last proxied message" is the last part of a split message.
      timestamp: m.createdTimestamp || now + n,
    });
  });

  try {
    await message.delete();
  } catch (e) {
    if (!isApiError(e, RESTJSONErrorCodes.UnknownMessage)) {
      log.warn('Proxied message %s but could not delete the original: %s', message.id, e instanceof Error ? e.message : String(e));
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

// Messages in one channel are proxied one after another so they keep their order.
const queues = new Map<string, Promise<void>>();

const enqueue = (key: string, task: () => Promise<void>): Promise<void> => {
  const run = (queues.get(key) ?? Promise.resolve()).then(task).catch((e: unknown) => log.exception(e, 'Proxying failed in channel %s.', key));
  queues.set(key, run);
  void run.finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  });
  return run;
};

/** messageCreate entry point. */
export const handleMessage = async (message: Message): Promise<void> => {
  if (message.partial || !message.inGuild()) return;
  if (message.author.bot || message.webhookId || message.system) return;
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;
  // Stickers and polls cannot be carried over by a webhook.
  if (message.stickers.size || message.poll) return;
  // The starter post of a forum or media thread is the thread itself.
  if (message.channel.isThread() && message.id === message.channelId) return;

  // Only users with a vault link go further (no queueing, no loading for everyone else).
  if (!peekSession(message.author.id)?.isLinked() && !hasStoredLink(message.author.id)) return;

  // Queued before the session is resolved, so messages keep their order even while a vault loads.
  await enqueue(message.channelId, async () => {
    let session: VaultSession | null;
    try {
      session = await linkedSession(message.author.id);
    } catch (e) {
      log.debug('No vault session for %s: %s', message.author.id, e instanceof Error ? e.message : String(e));
      return;
    }
    if (!session) return;

    const plan = planProxy({
      content: message.content,
      hasAttachments: message.attachments.size > 0,
      members: session.members(),
      front: session.front(),
      autoproxy: getAutoproxy(message.guildId, message.author.id),
      settings: session.settings(),
    });
    if (plan.kind !== 'proxy') return;
    await repost(message, session, plan.member, plan.content);
  });
};
