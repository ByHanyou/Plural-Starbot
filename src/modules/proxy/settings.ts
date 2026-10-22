import {db} from '../../db';
import {isRecord} from '../../util';
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

const memberFormats = (v: unknown): Map<string, string> =>
  new Map(isRecord(v) ? Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim()) : []);

export const getAutoproxy = (guildId: string, userId: string): AutoproxySetting | null =>
  parseAutoproxy(db().getGuildSetting(guildId, MODULE, autoproxyKey(userId)));

export const setAutoproxy = (guildId: string, userId: string, value: AutoproxySetting | null): void => {
  if (value) db().setGuildSetting(guildId, MODULE, autoproxyKey(userId), value);
  else db().deleteGuildSetting(guildId, MODULE, autoproxyKey(userId));
};

export const getLogChannel = (guildId: string): string | null => {
  const v = db().getGuildSetting(guildId, MODULE, LOG_CHANNEL);
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

const serverValue = (guildId: string | null, key: string): unknown => (guildId ? db().getGuildSetting(guildId, MODULE, key) : undefined);

const scopedValue = (guildId: string | null, userId: string, guildKey: string, userKey: string): unknown =>
  guildId ? db().getGuildSetting(guildId, MODULE, guildKey) : db().getUserSetting(userId, userKey);

const setScoped = (guildId: string | null, userId: string, guildKey: string, userKey: string, value: unknown): void => {
  const d = db();
  if (guildId) {
    if (value) d.setGuildSetting(guildId, MODULE, guildKey, value);
    else d.deleteGuildSetting(guildId, MODULE, guildKey);
  } else if (value) d.setUserSetting(userId, userKey, value);
  else d.deleteUserSetting(userId, userKey);
};

export const getNameSettings = (guildId: string | null, userId: string, memberId?: string): NameSettings => {
  const d = db();
  const general = resolveSetting(serverValue(guildId, formatKey(userId)), d.getUserSetting(userId, USER_FORMAT), DEFAULT_FORMAT);
  return {
    format: memberId
      ? resolveMemberFormat(
          memberFormats(serverValue(guildId, memberFormatsKey(userId))).get(memberId),
          memberFormats(d.getUserSetting(userId, USER_MEMBER_FORMATS)).get(memberId),
          general,
        )
      : general,
    sysTag: resolveSetting(serverValue(guildId, sysTagKey(userId)), d.getUserSetting(userId, USER_SYS_TAG), ''),
  };
};

export const setNameFormat = (guildId: string | null, userId: string, template: string | null): void =>
  setScoped(guildId, userId, formatKey(userId), USER_FORMAT, template);

export const setMemberFormat = (guildId: string | null, userId: string, memberId: string, template: string | null): void => {
  const next = memberFormats(scopedValue(guildId, userId, memberFormatsKey(userId), USER_MEMBER_FORMATS));
  next.delete(memberId);
  if (template) next.set(memberId, template);
  setScoped(guildId, userId, memberFormatsKey(userId), USER_MEMBER_FORMATS, next.size > 0 ? Object.fromEntries(next) : null);
};

export const setSysTag = (guildId: string | null, userId: string, sysTag: string | null): void =>
  setScoped(guildId, userId, sysTagKey(userId), USER_SYS_TAG, sysTag);

export const forgetNameSettings = (userId: string): void => {
  db().deleteUserSetting(userId, USER_FORMAT);
  db().deleteUserSetting(userId, USER_SYS_TAG);
  db().deleteUserSetting(userId, USER_MEMBER_FORMATS);
  db().deleteGuildSettingInAllGuilds(MODULE, formatKey(userId));
  db().deleteGuildSettingInAllGuilds(MODULE, sysTagKey(userId));
  db().deleteGuildSettingInAllGuilds(MODULE, memberFormatsKey(userId));
};
