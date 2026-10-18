import {db} from '../../db';
import {log} from '../../log';

export const MODULE = 'health';
const SETTINGS_KEY = 'settings';

export interface HealthGroup {
  role_id: string | null;
  reminder_topics: string[];
  fact_topics: string[];
  color: number | null;
  start_time?: string;
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
    Kindness: {
      role_id: null,
      reminder_topics: ['kindself', 'kindothers', 'kindanimals', 'kindmisc'],
      fact_topics: ['kindness'],
      color: 0xeb459e,
    },
  },
};

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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

const cache = new Map<string, HealthSettings>();

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

export const hasStoredSettings = (guildId: string): boolean => db().getGuildSetting(guildId, MODULE, SETTINGS_KEY) !== undefined;

export const guildsWithStoredSettings = (): string[] => db().guildsWithSettings(MODULE).filter(hasStoredSettings);

export const dropSettings = (guildId: string): void => {
  cache.delete(guildId);
};
