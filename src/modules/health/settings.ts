import {tunables} from '../../config';
import {db} from '../../db';
import {log} from '../../log';
import {isRecord} from '../../util';

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

const DEFAULT_SETTINGS: HealthSettings = {
  channel_id: null,
  timezone: tunables().defaultTimezone,
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

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringOrNull = (v: unknown): v is string | null => v === null || isString(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumberOrNull = (v: unknown): v is number | null => v === null || isNumber(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const or = <T>(v: unknown, ok: (x: unknown) => x is T, fallback: T): T => (ok(v) ? v : fallback);

const mergeGroup = (base: HealthGroup, over: Record<string, unknown>): HealthGroup => {
  const group: HealthGroup = {
    role_id: or(over.role_id, isStringOrNull, base.role_id),
    reminder_topics: or(over.reminder_topics, isStrings, base.reminder_topics),
    fact_topics: or(over.fact_topics, isStrings, base.fact_topics),
    color: or(over.color, isNumberOrNull, base.color),
  };
  if (isString(over.start_time)) group.start_time = over.start_time;
  if (isNumber(over.interval_hours)) group.interval_hours = over.interval_hours;
  return group;
};

const mergeSettings = (data: unknown): HealthSettings => {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!isRecord(data)) return base;
  const groups = isRecord(data.groups) ? data.groups : {};
  return {
    channel_id: or(data.channel_id, isStringOrNull, base.channel_id),
    timezone: or(data.timezone, isString, base.timezone),
    start_time: or(data.start_time, isString, base.start_time),
    interval_hours: or(data.interval_hours, isNumber, base.interval_hours),
    enabled: or(data.enabled, isBoolean, base.enabled),
    groups: Object.fromEntries(
      Object.entries(base.groups).map(([name, g]): [string, HealthGroup] => {
        const over = Object.hasOwn(groups, name) ? groups[name] : undefined;
        return [name, isRecord(over) ? mergeGroup(g, over) : g];
      }),
    ),
  };
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

const hasStoredSettings = (guildId: string): boolean => db().getGuildSetting(guildId, MODULE, SETTINGS_KEY) !== undefined;

export const guildsWithStoredSettings = (): string[] => db().guildsWithSettings(MODULE).filter(hasStoredSettings);

export const dropSettings = (guildId: string): void => {
  cache.delete(guildId);
};
