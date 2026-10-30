import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  escapeMarkdown,
  MessageReaction,
  PartialMessageReaction,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  User,
  userMention,
} from 'discord.js';
import {db, type ProxiedMessage, retentionMs} from '../../db';
import {log} from '../../log';
import {errorText, orNull} from '../../util';
import {getPings, PINGS_OFF} from './settings';
import {jumpUrl} from './text';
import {isApiError} from './webhooks';

const VARIATION_SELECTOR_16 = String.fromCharCode(0xfe0f);
const DELETE = '❌';
const WHO = '❓';
const BELL = '🔔';

const emojiOf = (reaction: MessageReaction | PartialMessageReaction): string => (reaction.emoji.name ?? '').split(VARIATION_SELECTOR_16).join('');

const rung = new Map<string, number>();

const ringOnce = (messageId: string, userId: string, now = Date.now()): boolean => {
  for (const [key, at] of rung) {
    if (now - at < retentionMs()) break;
    rung.delete(key);
  }
  const key = `${messageId}:${userId}`;
  if (rung.has(key)) return false;
  rung.set(key, now);
  return true;
};

export const wantsReaction = (reaction: MessageReaction | PartialMessageReaction): boolean => {
  const emoji = emojiOf(reaction);
  return (emoji === DELETE || emoji === WHO || emoji === BELL) && !!db().proxiedByMessageId(reaction.message.id);
};

const ringBell = async (reaction: MessageReaction, user: User, record: ProxiedMessage): Promise<void> => {
  const message = reaction.message;
  if (user.id === record.userId || !message.inGuild()) return;
  const member = message.guild.members.cache.get(user.id) ?? (await orNull(message.guild.members.fetch(user.id), `Fetching server member ${user.id}`));
  const send = message.channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (!member || !message.channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, send])) return;
  if (!ringOnce(message.id, user.id)) return;
  const link = jumpUrl(record.guildId, record.channelId, record.messageId);

  if (getPings(message.guildId, record.userId).value === PINGS_OFF) {
    const text =
      `That message (${link}) was sent by ${userMention(record.userId)}, who has 🔔 pings turned off, so I did not ping them. ` +
      'To ping them anyway, copy their mention below.';
    try {
      await user.send({content: text, allowedMentions: {parse: []}});
      await user.send({content: `\`${userMention(record.userId)}\``, allowedMentions: {parse: []}});
    } catch (e) {
      log.debug('Could not DM %s about the 🔔 pings setting of proxied message %s: %s', user.id, message.id, errorText(e));
    }
  } else {
    try {
      await message.channel.send({
        content: `${BELL} ${userMention(record.userId)}, ${userMention(user.id)} pinged you.`,
        allowedMentions: {users: [record.userId]},
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump').setURL(link))],
      });
    } catch (e) {
      log.warn('Could not post a 🔔 ping for proxied message %s: %s', message.id, errorText(e));
    }
  }

  try {
    await reaction.users.remove(user.id);
  } catch (e) {
    log.debug('Could not remove a 🔔 reaction on %s: %s', message.id, errorText(e));
  }
};

export const handleReaction = async (reaction: MessageReaction, user: User): Promise<void> => {
  if (user.bot) return;
  const emoji = emojiOf(reaction);
  if (emoji !== DELETE && emoji !== WHO && emoji !== BELL) return;
  const message = reaction.message;
  if (!message.webhookId || !message.guildId) return;
  const record = db().proxiedByMessageId(message.id);
  if (!record) return;

  if (emoji === DELETE) {
    if (user.id !== record.userId) return;
    try {
      await message.delete();
    } catch (e) {
      if (!isApiError(e, RESTJSONErrorCodes.UnknownMessage)) {
        log.warn('Could not delete proxied message %s for its sender: %s', message.id, errorText(e));
        return;
      }
    }
    db().deleteProxied(message.id);
    return;
  }

  if (emoji === BELL) {
    await ringBell(reaction, user, record);
    return;
  }

  const sender = await orNull(reaction.client.users.fetch(record.userId), `Fetching the sender ${record.userId} of proxied message ${message.id}`);
  const shown = message.author?.username || 'a member';
  const link = jumpUrl(record.guildId, record.channelId, record.messageId);
  const text =
    `That message (${link}) was sent as **${escapeMarkdown(shown)}** by ${userMention(record.userId)} ` +
    `(${sender ? escapeMarkdown(sender.tag) : 'unknown user'}, ID ${record.userId}) through Plural Starbot.`;
  try {
    await user.send({content: text, allowedMentions: {parse: []}});
  } catch (e) {
    log.debug('Could not DM %s about proxied message %s: %s', user.id, message.id, errorText(e));
  }
  try {
    await reaction.users.remove(user.id);
  } catch (e) {
    log.debug('Could not remove a ❓ reaction on %s: %s', message.id, errorText(e));
  }
};
