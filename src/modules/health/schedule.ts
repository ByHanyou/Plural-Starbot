// Schedule maths, ported from bot.py (times_from, group_schedule, compute_times,
// due_group_names, times_label, group_times_label) plus the part of
// discord.py's tasks.loop(time=[...]) that picks the next wake-up
// (_get_next_sleep_time, _start_time_relative_to, resolve_datetime).

import type {HealthGroup, HealthSettings} from './settings';
import {addWallMs, assertZone, resolveWall, Wall, wallAt} from './zones';

/** A time of day on the zone's wall clock. */
export interface ClockTime {
  hour: number;
  minute: number;
}

// ---- Python int() / str.strip() -------------------------------------------

// Characters Python's str.isspace() treats as whitespace.
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const INT_RE = /^([+-]?)(\p{Nd}+(?:_\p{Nd}+)*)$/u;
const ND_RE = /^\p{Nd}$/u;

export const pyStrip = (s: string): string => s.replace(STRIP_RE, '');

// Unicode decimal digits come in runs of ten (0-9), so a digit's value is its
// distance from the start of its run, modulo 10.
const digitValue = (ch: string): number => {
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (start > 0 && ND_RE.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
};

/** Python int(): a str in base 10 (whitespace, sign, underscores, any Unicode digits), or a number truncated. */
export const pyInt = (v: unknown): number => {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError(`cannot convert ${v} to integer`);
    return Math.trunc(v);
  }
  if (typeof v === 'string') {
    const m = INT_RE.exec(pyStrip(v));
    if (!m) throw new RangeError(`invalid literal for int() with base 10: '${v}'`);
    let n = 0;
    for (const ch of m[2]) if (ch !== '_') n = n * 10 + digitValue(ch);
    return m[1] === '-' ? -n : n;
  }
  throw new TypeError(`int() argument must be a string or a number, not '${v === null ? 'NoneType' : typeof v}'`);
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The /health starttime and /health groupschedule time check:
 * `hh, mm = time.strip().split(":")`, both int(), 0-23 and 0-59.
 * Returns the normalised "HH:MM", or null when the input is not accepted.
 */
export const parseStartTime = (raw: string): string | null => {
  try {
    const parts = pyStrip(raw).split(':');
    if (parts.length !== 2) return null;
    const hh = pyInt(parts[0]);
    const mm = pyInt(parts[1]);
    if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
    return `${pad2(hh)}:${pad2(mm)}`;
  } catch {
    return null;
  }
};

/** The interval check shared by /health interval and /health groupschedule. */
export const isValidInterval = (hours: number): boolean => !(hours < 1 || hours > 24 || 24 % hours !== 0);

// ---- bot.py schedule maths ---------------------------------------------------

/**
 * times_from(): a start time + interval as times of day, in generation order,
 * e.g. 08:00 every 6h -> [08:00, 14:00, 20:00, 02:00].
 */
export const timesFrom = (startTime: string, intervalHours: unknown): ClockTime[] => {
  const parts = String(startTime).split(':');
  if (parts.length !== 2) throw new RangeError(`expected HH:MM, got '${startTime}'`);
  const hour = pyInt(parts[0]);
  const minute = pyInt(parts[1]);
  const interval = pyInt(intervalHours);
  if (interval === 0) throw new RangeError('integer division or modulo by zero');
  if (minute < 0 || minute > 59) throw new RangeError('minute must be in 0..59');
  const count = Math.max(1, Math.floor(24 / interval));
  const times: ClockTime[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const h = (((hour + i * interval) % 24) + 24) % 24;
    if (seen.has(h)) continue;
    seen.add(h);
    times.push({hour: h, minute});
  }
  return times;
};

/**
 * group_schedule(): a group's own start_time / interval_hours if set, else the
 * shared ones. Absent keys mean "follow the shared schedule".
 */
export const groupSchedule = (s: HealthSettings, group: HealthGroup): [string, number] => [
  group.start_time || s.start_time,
  pyInt(group.interval_hours || s.interval_hours),
];

/**
 * compute_times(): every minute the loop must wake at, sorted: the union of the
 * shared schedule and each group's own. Each firing then sends only the groups
 * actually due at that minute.
 */
export const computeTimes = (s: HealthSettings): ClockTime[] => {
  assertZone(s.timezone);
  const byMinute = new Map<number, ClockTime>();
  for (const t of timesFrom(s.start_time, s.interval_hours)) byMinute.set(t.hour * 60 + t.minute, t);
  for (const g of Object.values(s.groups)) {
    const [st, iv] = groupSchedule(s, g);
    for (const t of timesFrom(st, iv)) byMinute.set(t.hour * 60 + t.minute, t);
  }
  return [...byMinute.keys()].sort((a, b) => a - b).map(k => byMinute.get(k)!);
};

/**
 * due_group_names(): groups whose schedule includes this firing, given the
 * zone's wall clock now. The two-minute grace covers a callback that lands
 * late, including across midnight.
 */
export const dueGroupNames = (s: HealthSettings, now: Wall): string[] => {
  assertZone(s.timezone);
  const nowSec = now.hour * 3600 + now.minute * 60 + now.second + now.ms / 1000;
  const due: string[] = [];
  for (const [name, g] of Object.entries(s.groups)) {
    const [st, iv] = groupSchedule(s, g);
    for (const t of timesFrom(st, iv)) {
      const delta = nowSec - (t.hour * 3600 + t.minute * 60);
      if ((delta >= 0 && delta <= 120) || (delta + 86400 >= 0 && delta + 86400 <= 120)) {
        due.push(name);
        break;
      }
    }
  }
  return due;
};

export const formatClock = (t: ClockTime): string => `${pad2(t.hour)}:${pad2(t.minute)}`;

/** times_label(): the SHARED schedule's fire times (group overrides render separately). */
export const timesLabel = (s: HealthSettings): string => {
  try {
    assertZone(s.timezone);
    return timesFrom(s.start_time, s.interval_hours).map(formatClock).join(', ');
  } catch {
    return '(invalid schedule)';
  }
};

/** group_times_label(): one group's fire times (its own schedule or the shared one). */
export const groupTimesLabel = (s: HealthSettings, group: HealthGroup): string => {
  try {
    const [st, iv] = groupSchedule(s, group);
    assertZone(s.timezone);
    return timesFrom(st, iv).map(formatClock).join(', ');
  } catch {
    return '(invalid schedule)';
  }
};

// ---- discord.py tasks.loop(time=[...]) ----------------------------------------

const cmpTuple = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

/**
 * The instant (epoch ms) the loop sleeps until next, given the loop's times and
 * zone and the current instant: the first time of day at or after the current
 * wall-clock time today, else the first time tomorrow, resolved through DST
 * (a time in a spring-forward gap moves forward by the gap, a repeated time
 * fires on its second occurrence). A time equal to now counts as upcoming.
 */
export const nextFireTime = (times: ClockTime[], zone: string, nowMs: number): number => {
  if (!times.length) throw new RangeError('time parameter must not be an empty sequence.');
  const sorted = [...times].sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  const now = wallAt(zone, nowMs);
  const nowKey = [now.hour, now.minute, now.second, now.ms];
  const idx = sorted.findIndex(t => cmpTuple([t.hour, t.minute, 0, 0], nowKey) >= 0);
  const date = idx === -1 ? addWallMs(now, 24 * 60 * 60 * 1000) : now;
  const t = idx === -1 ? sorted[0] : sorted[idx];
  return resolveWall(zone, {year: date.year, month: date.month, day: date.day, hour: t.hour, minute: t.minute, second: 0, ms: 0});
};
