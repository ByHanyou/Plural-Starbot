// Proxy settings in db.ts's guild_settings table (module 'proxy'):
//   logChannel          -> channel id for /proxylog
//   autoproxy:<userId>  -> {mode: 'front'} | {mode: 'member', memberId}
import {db} from '../../db';
import {AutoproxySetting, parseAutoproxy} from './match';

const MODULE = 'proxy';
const LOG_CHANNEL = 'logChannel';
const autoproxyKey = (userId: string): string => `autoproxy:${userId}`;

export const getAutoproxy = (guildId: string, userId: string): AutoproxySetting | null =>
  parseAutoproxy(db().getGuildSetting(guildId, MODULE, autoproxyKey(userId)));

/** null turns autoproxy off (deletes the setting). */
export const setAutoproxy = (guildId: string, userId: string, value: AutoproxySetting | null): void => {
  if (value) db().setGuildSetting(guildId, MODULE, autoproxyKey(userId), value);
  else db().deleteGuildSetting(guildId, MODULE, autoproxyKey(userId));
};

export const getLogChannel = (guildId: string): string | null => {
  const v = db().getGuildSetting<unknown>(guildId, MODULE, LOG_CHANNEL);
  return typeof v === 'string' && v ? v : null;
};

/** null turns logging off (deletes the setting). */
export const setLogChannel = (guildId: string, channelId: string | null): void => {
  if (channelId) db().setGuildSetting(guildId, MODULE, LOG_CHANNEL, channelId);
  else db().deleteGuildSetting(guildId, MODULE, LOG_CHANNEL);
};
