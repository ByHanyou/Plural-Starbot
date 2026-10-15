// Proxy settings in db.ts's guild_settings table (module 'proxy'):
//   logChannel          -> channel id for /proxylog
//   autoproxy:<userId>  -> {mode: 'front'} | {mode: 'member', memberId} | {mode: 'latch'}
//   format:<userId>     -> the user's proxy name format in this guild (overrides their global one)
//   systag:<userId>     -> the user's Sys Tag in this guild (overrides their global one)
// and in its user_settings table (per user, every guild):
//   proxy:format        -> the user's global proxy name format
//   proxy:systag        -> the user's global Sys Tag
import {db} from '../../db';
import {DEFAULT_FORMAT, Resolved, resolveSetting} from './format';
import {AutoproxySetting, parseAutoproxy} from './match';

const MODULE = 'proxy';
const LOG_CHANNEL = 'logChannel';
const autoproxyKey = (userId: string): string => `autoproxy:${userId}`;
const formatKey = (userId: string): string => `format:${userId}`;
const sysTagKey = (userId: string): string => `systag:${userId}`;
const USER_FORMAT = 'proxy:format';
const USER_SYS_TAG = 'proxy:systag';

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

export interface NameSettings {
  format: Resolved;
  sysTag: Resolved;
}

/**
 * The proxy name format and Sys Tag that apply for a user: in a guild its override, else the global
 * setting, else the default ({Name}, no Sys Tag). guildId null: outside any guild (the global settings).
 */
export const getNameSettings = (guildId: string | null, userId: string): NameSettings => {
  const d = db();
  return {
    format: resolveSetting(guildId ? d.getGuildSetting(guildId, MODULE, formatKey(userId)) : undefined, d.getUserSetting(userId, USER_FORMAT), DEFAULT_FORMAT),
    sysTag: resolveSetting(guildId ? d.getGuildSetting(guildId, MODULE, sysTagKey(userId)) : undefined, d.getUserSetting(userId, USER_SYS_TAG), ''),
  };
};

/** Saves a format for one guild (guildId) or everywhere (null); template null clears that one. */
export const setNameFormat = (guildId: string | null, userId: string, template: string | null): void => {
  if (guildId) {
    if (template) db().setGuildSetting(guildId, MODULE, formatKey(userId), template);
    else db().deleteGuildSetting(guildId, MODULE, formatKey(userId));
  } else if (template) db().setUserSetting(userId, USER_FORMAT, template);
  else db().deleteUserSetting(userId, USER_FORMAT);
};

/** Saves a Sys Tag for one guild (guildId) or everywhere (null); sysTag null clears that one. */
export const setSysTag = (guildId: string | null, userId: string, sysTag: string | null): void => {
  if (guildId) {
    if (sysTag) db().setGuildSetting(guildId, MODULE, sysTagKey(userId), sysTag);
    else db().deleteGuildSetting(guildId, MODULE, sysTagKey(userId));
  } else if (sysTag) db().setUserSetting(userId, USER_SYS_TAG, sysTag);
  else db().deleteUserSetting(userId, USER_SYS_TAG);
};

/** Deletes a user's format and Sys Tag everywhere (global rows and every guild override), as /unlink should. */
export const forgetNameSettings = (userId: string): void => {
  db().deleteUserSetting(userId, USER_FORMAT);
  db().deleteUserSetting(userId, USER_SYS_TAG);
  db().deleteGuildSettingInAllGuilds(MODULE, formatKey(userId));
  db().deleteGuildSettingInAllGuilds(MODULE, sysTagKey(userId));
};
