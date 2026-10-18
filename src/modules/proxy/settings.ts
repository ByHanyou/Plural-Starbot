import {db} from '../../db';
import {DEFAULT_FORMAT, Resolved, resolveMemberFormat, resolveSetting} from './format';
import {AutoproxySetting, parseAutoproxy} from './match';

const MODULE = 'proxy';
const LOG_CHANNEL = 'logChannel';
const autoproxyKey = (userId: string): string => `autoproxy:${userId}`;
const formatKey = (userId: string): string => `format:${userId}`;
const sysTagKey = (userId: string): string => `systag:${userId}`;
const memberFormatsKey = (userId: string): string => `memberFormats:${userId}`;
const USER_FORMAT = 'proxy:format';
const USER_SYS_TAG = 'proxy:systag';
const USER_MEMBER_FORMATS = 'proxy:memberFormats';

const memberFormats = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim()))
    : {};

export const getAutoproxy = (guildId: string, userId: string): AutoproxySetting | null =>
  parseAutoproxy(db().getGuildSetting(guildId, MODULE, autoproxyKey(userId)));

export const setAutoproxy = (guildId: string, userId: string, value: AutoproxySetting | null): void => {
  if (value) db().setGuildSetting(guildId, MODULE, autoproxyKey(userId), value);
  else db().deleteGuildSetting(guildId, MODULE, autoproxyKey(userId));
};

export const getLogChannel = (guildId: string): string | null => {
  const v = db().getGuildSetting<unknown>(guildId, MODULE, LOG_CHANNEL);
  return typeof v === 'string' && v ? v : null;
};

export const setLogChannel = (guildId: string, channelId: string | null): void => {
  if (channelId) db().setGuildSetting(guildId, MODULE, LOG_CHANNEL, channelId);
  else db().deleteGuildSetting(guildId, MODULE, LOG_CHANNEL);
};

export interface NameSettings {
  format: Resolved;
  sysTag: Resolved;
}

export const getNameSettings = (guildId: string | null, userId: string, memberId?: string): NameSettings => {
  const d = db();
  const general = resolveSetting(guildId ? d.getGuildSetting(guildId, MODULE, formatKey(userId)) : undefined, d.getUserSetting(userId, USER_FORMAT), DEFAULT_FORMAT);
  return {
    format: memberId
      ? resolveMemberFormat(
          guildId ? memberFormats(d.getGuildSetting(guildId, MODULE, memberFormatsKey(userId)))[memberId] : undefined,
          memberFormats(d.getUserSetting(userId, USER_MEMBER_FORMATS))[memberId],
          general,
        )
      : general,
    sysTag: resolveSetting(guildId ? d.getGuildSetting(guildId, MODULE, sysTagKey(userId)) : undefined, d.getUserSetting(userId, USER_SYS_TAG), ''),
  };
};

export const setNameFormat = (guildId: string | null, userId: string, template: string | null): void => {
  if (guildId) {
    if (template) db().setGuildSetting(guildId, MODULE, formatKey(userId), template);
    else db().deleteGuildSetting(guildId, MODULE, formatKey(userId));
  } else if (template) db().setUserSetting(userId, USER_FORMAT, template);
  else db().deleteUserSetting(userId, USER_FORMAT);
};

export const setMemberFormat = (guildId: string | null, userId: string, memberId: string, template: string | null): void => {
  const current = memberFormats(guildId ? db().getGuildSetting(guildId, MODULE, memberFormatsKey(userId)) : db().getUserSetting(userId, USER_MEMBER_FORMATS));
  const next = Object.fromEntries(Object.entries(current).filter(([id]) => id !== memberId));
  if (template) next[memberId] = template;
  const keep = Object.keys(next).length > 0;
  if (guildId) {
    if (keep) db().setGuildSetting(guildId, MODULE, memberFormatsKey(userId), next);
    else db().deleteGuildSetting(guildId, MODULE, memberFormatsKey(userId));
  } else if (keep) db().setUserSetting(userId, USER_MEMBER_FORMATS, next);
  else db().deleteUserSetting(userId, USER_MEMBER_FORMATS);
};

export const setSysTag = (guildId: string | null, userId: string, sysTag: string | null): void => {
  if (guildId) {
    if (sysTag) db().setGuildSetting(guildId, MODULE, sysTagKey(userId), sysTag);
    else db().deleteGuildSetting(guildId, MODULE, sysTagKey(userId));
  } else if (sysTag) db().setUserSetting(userId, USER_SYS_TAG, sysTag);
  else db().deleteUserSetting(userId, USER_SYS_TAG);
};

export const forgetNameSettings = (userId: string): void => {
  db().deleteUserSetting(userId, USER_FORMAT);
  db().deleteUserSetting(userId, USER_SYS_TAG);
  db().deleteUserSetting(userId, USER_MEMBER_FORMATS);
  db().deleteGuildSettingInAllGuilds(MODULE, formatKey(userId));
  db().deleteGuildSettingInAllGuilds(MODULE, sysTagKey(userId));
  db().deleteGuildSettingInAllGuilds(MODULE, memberFormatsKey(userId));
};
