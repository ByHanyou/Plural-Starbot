import {EmbedBuilder, Guild, Message, User} from 'discord.js';
import {errorText} from '../../util';
import {ellipsize, EMBED_LIMIT, logFooter, logSender} from './text';
import {getLogChannel} from './settings';
import {warnHourly} from './warn';

export interface ProxyLogEntry {
  sent: Message<true>;
  originalId: string;
  sender: User;
  channelName: string;
  shownName: string;
  avatarUrl?: string;
  content: string;
}

const buildLogEmbed = (e: ProxyLogEntry): EmbedBuilder => {
  const embed = new EmbedBuilder()
    .setAuthor({name: ellipsize(`#${e.channelName}: ${e.shownName}`, EMBED_LIMIT.author), ...(e.avatarUrl ? {iconURL: e.avatarUrl} : {})})
    .setFooter({
      text: logFooter({
        messageId: e.sent.id,
        originalId: e.originalId,
      }),
    })
    .setTimestamp(e.sent.createdTimestamp || Date.now());
  if (e.avatarUrl) embed.setThumbnail(e.avatarUrl);
  if (e.content.trim()) embed.setDescription(ellipsize(e.content, EMBED_LIMIT.description));
  embed.addFields({name: 'Sender', value: logSender(e.sender.id)});
  const files = [...e.sent.attachments.values()];
  if (files.length) {
    const lines: string[] = [];
    let used = 0;
    for (const a of files) {
      const line = `[${a.name.replace(/[[\]]/g, '')}](${a.url})`;
      if (used + line.length + 1 > EMBED_LIMIT.fieldValue) break;
      lines.push(line);
      used += line.length + 1;
    }
    embed.addFields({name: 'Attachments', value: lines.join('\n') || files.map(a => a.name).join(', ').slice(0, EMBED_LIMIT.fieldValue)});
  }
  return embed;
};

export const postProxyLog = async (guild: Guild, entry: ProxyLogEntry): Promise<void> => {
  const channelId = getLogChannel(guild.id);
  if (!channelId) return;
  try {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
    if (!channel || !channel.isTextBased()) {
      warnHourly(`log-missing:${channelId}`, "The proxy log channel %s in '%s' is gone or not a text channel.", channelId, guild.name);
      return;
    }
    await channel.send({content: entry.sent.url, embeds: [buildLogEmbed(entry)], allowedMentions: {parse: []}});
  } catch (e) {
    warnHourly(`log-send:${channelId}`, "Could not post to the proxy log channel %s in '%s': %s", channelId, guild.name, errorText(e));
  }
};
