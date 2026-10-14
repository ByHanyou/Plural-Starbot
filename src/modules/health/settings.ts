// Per-guild health reminder settings. The Python bot kept one settings.json for
// one server; here the same structure is stored per guild in SQLite (the
// guild_settings table, module "health", key "settings"), with the same
// defaults and the same fill-in-missing-keys rule as load_settings().
// Discord ids are kept as strings (snowflakes do not fit a JS number).

import {db} from '../../db';
import {log} from '../../log';

export const MODULE = 'health';
const SETTINGS_KEY = 'settings';

export interface HealthGroup {
  role_id: string | null;
  reminder_topics: string[];
  fact_topics: string[];
  color: number | null;
  /** Present only when the group has its own schedule. */
  start_time?: string;
  /** Present only when the group has its own schedule. */
  interval_hours?: number;
}

export interface HealthSettings {
  channel_id: string | null;
  timezone: string;
  start_time: string;
  interval_hours: number;
  enabled: boolean;
  groups: Record<string, HealthGroup>;
}

export const DEFAULT_SETTINGS: HealthSettings = {
  channel_id: null,
  timezone: 'America/New_York',
  start_time: '08:00',
  interval_hours: 6,
  enabled: true,
  groups: {
    Nutrition: {
      role_id: null,
      reminder_topics: ['food', 'hydration'],
      fact_topics: ['food', 'hydration'],
      color: 0x57f287,
    },
    Medicine: {
      role_id: null,
      reminder_topics: ['meds'],
      fact_topics: ['meds'],
      color: 0x9b59b6,
    },
    // New groups arrive with no role, and sendRound skips roleless groups,
    // so nothing changes in a server until an admin runs /health role.
    Activity: {
      role_id: null,
      reminder_topics: ['activity'],
      fact_topics: ['activity'],
      color: 0xe67e22,
    },
    'Eye Strain': {
      role_id: null,
      reminder_topics: ['eyestrain'],
      fact_topics: ['eyestrain'],
      color: 0x3498db,
    },
    Hygiene: {
      role_id: null,
      reminder_topics: ['grooming', 'teeth', 'shower'],
      fact_topics: ['grooming', 'teeth', 'shower'],
      color: 0x1abc9c,
    },
    // Four nudge topics, ONE shared fact pool: every Kindness round nudges
    // all four directions and deals a fact from the common kindness deck.
    Kindness: {
      role_id: null,
      reminder_topics: ['kindself', 'kindothers', 'kindanimals', 'kindmisc'],
      fact_topics: ['kindness'],
      color: 0xeb459e,
    },
  },
};

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * load_settings(): start from a deep copy of the defaults, then lay the stored
 * values over them. Stored groups update the matching default group key by key;
 * groups the defaults do not know are dropped; every other stored key replaces
 * the default.
 */
export const mergeSettings = (data: unknown): HealthSettings => {
  const merged = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown> & {groups: Record<string, Record<string, unknown>>};
  if (isDict(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (key === 'groups' && isDict(value)) {
        for (const [gname, gval] of Object.entries(value)) {
          if (Object.hasOwn(merged.groups, gname) && isDict(gval)) Object.assign(merged.groups[gname], gval);
        }
      } else {
        merged[key] = value;
      }
    }
  }
  return merged as unknown as HealthSettings;
};

// The Python bot held its settings in one in-memory object and wrote it out on
// every change; this keeps one such object per guild.
const cache = new Map<string, HealthSettings>();

/** The guild's settings (defaults filled in). Always the same object for a guild until it is dropped. */
export const getSettings = (guildId: string): HealthSettings => {
  let s = cache.get(guildId);
  if (!s) {
    let stored: unknown;
    try {
      stored = db().getGuildSetting(guildId, MODULE, SETTINGS_KEY);
    } catch (e) {
      log.exception(e, "Health settings for server %s were unreadable; starting from defaults.", guildId);
      stored = undefined;
    }
    s = mergeSettings(stored ?? {});
    cache.set(guildId, s);
  }
  return s;
};

export const saveSettings = (guildId: string, s: HealthSettings): void => {
  cache.set(guildId, s);
  db().setGuildSetting(guildId, MODULE, SETTINGS_KEY, s);
};

/** True when the guild has saved health settings (the Python bot's settings.json exists). */
export const hasStoredSettings = (guildId: string): boolean => db().getGuildSetting(guildId, MODULE, SETTINGS_KEY) !== undefined;

/** Guild ids with saved health settings. */
export const guildsWithStoredSettings = (): string[] => db().guildsWithSettings(MODULE).filter(hasStoredSettings);

/** Forgets the cached copy (the rows themselves are removed by the bot when it leaves a guild). */
export const dropSettings = (guildId: string): void => {
  cache.delete(guildId);
};
