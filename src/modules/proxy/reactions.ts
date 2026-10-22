import {escapeMarkdown, MessageReaction, PartialMessageReaction, RESTJSONErrorCodes, User, userMention} from 'discord.js';
import {db} from '../../db';
import {log} from '../../log';
import {errorText, orNull} from '../../util';
import {jumpUrl} from './text';
import {isApiError} from './webhooks';

const VARIATION_SELECTOR_16 = String.fromCharCode(0xfe0f);
const DELETE = '❌';
const WHO = '❓';

const emojiOf = (reaction: MessageReaction | PartialMessageReaction): string => (reaction.emoji.name ?? '').split(VARIATION_SELECTOR_16).join('');

export const wantsReaction = (reaction: MessageReaction | PartialMessageReaction): boolean => {
  const emoji = emojiOf(reaction);
  return (emoji === DELETE || emoji === WHO) && !!db().proxiedByMessageId(reaction.message.id);
};

export const handleReaction = async (reaction: MessageReaction, user: User): Promise<void> => {
  if (user.bot) return;
  const emoji = emojiOf(reaction);
  if (emoji !== DELETE && emoji !== WHO) return;
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
