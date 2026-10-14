// Time-zone arithmetic for the reminder schedule, built on Intl so no zone
// library is needed. It reproduces what the Python bot got from zoneinfo:
// wall-clock fields of an instant, and wall clock -> instant with PEP 495
// fold semantics (fold=0 is the first of two repeated times, fold=1 the
// second; a time inside a spring-forward gap maps with the offset before the
// gap for fold=0 and the offset after it for fold=1).

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wall-clock date and time in some zone (month 1-12). */
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (zone: string): Intl.DateTimeFormat => {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
};

/**
 * True when `name` is a time zone the Python bot's ZoneInfo(name) would also accept:
 * an IANA name Intl knows. UTC offset strings such as "+05:00" are not zone names.
 */
export const isValidZone = (name: string): boolean => {
  if (typeof name !== 'string' || !name || /^[+-]/.test(name)) return false;
  try {
    formatterFor(name);
    return true;
  } catch {
    return false;
  }
};

/** Throws like ZoneInfo(name) does for an unknown zone. */
export const assertZone = (name: string): void => {
  if (!isValidZone(name)) throw new RangeError(`No time zone found with key ${name}`);
};

export const wallToUtcMs = (w: Wall): number => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.ms);

export const utcMsToWall = (ms: number): Wall => {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
  };
};

/** Naive wall-clock arithmetic, like adding a timedelta to an aware Python datetime. */
export const addWallMs = (w: Wall, deltaMs: number): Wall => utcMsToWall(wallToUtcMs(w) + deltaMs);

/** The wall clock in `zone` at the instant `epochMs`. */
export const wallAt = (zone: string, epochMs: number): Wall => {
  const parts = formatterFor(zone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find(x => x.type === type);
    if (!p) throw new Error(`Intl did not return a ${type} for ${zone}`);
    return Number(p.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
    ms: ((epochMs % 1000) + 1000) % 1000,
  };
};

/** UTC offset of `zone` at the instant `epochMs`, in milliseconds. */
export const offsetAt = (zone: string, epochMs: number): number => wallToUtcMs(wallAt(zone, epochMs)) - epochMs;

/** Every instant whose wall clock in `zone` is `w`, earliest first: none in a gap, two in a repeated hour. */
export const instantsForWall = (zone: string, w: Wall): number[] => {
  const naive = wallToUtcMs(w);
  const offsets = new Set([offsetAt(zone, naive - DAY_MS), offsetAt(zone, naive), offsetAt(zone, naive + DAY_MS)]);
  const found = new Set<number>();
  for (const o of offsets) {
    const t = naive - o;
    if (wallToUtcMs(wallAt(zone, t)) === naive) found.add(t);
  }
  return [...found].sort((a, b) => a - b);
};

/** Wall clock -> instant with PEP 495 fold semantics (what zoneinfo does). */
export const toInstant = (zone: string, w: Wall, fold: 0 | 1 = 0): number => {
  const found = instantsForWall(zone, w);
  if (found.length) return fold ? found[found.length - 1] : found[0];
  const naive = wallToUtcMs(w);
  return naive - (fold ? offsetAt(zone, naive + DAY_MS) : offsetAt(zone, naive - DAY_MS));
};

/** utcoffset() of an aware datetime with this wall clock (fold=0), in milliseconds. */
const utcoffsetOfWall = (zone: string, w: Wall): number => wallToUtcMs(w) - toInstant(zone, w, 0);

/**
 * discord.py's resolve_datetime() applied to datetime.combine(date, time, tzinfo=zone):
 * a time inside a DST gap is pushed forward by the gap's length, a repeated time
 * takes its second occurrence (fold=1), any other time is unique. Returns the instant.
 */
export const resolveWall = (zone: string, w: Wall): number => {
  const found = instantsForWall(zone, w);
  if (found.length === 0) {
    const shift = utcoffsetOfWall(zone, addWallMs(w, DAY_MS)) - utcoffsetOfWall(zone, addWallMs(w, -DAY_MS));
    return toInstant(zone, addWallMs(w, shift), 0);
  }
  if (found.length > 1) return found[found.length - 1];
  return found[0];
};
