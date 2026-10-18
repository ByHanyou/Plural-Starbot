const DAY_MS = 24 * 60 * 60 * 1000;

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

export const isValidZone = (name: string): boolean => {
  if (typeof name !== 'string' || !name || /^[+-]/.test(name)) return false;
  try {
    formatterFor(name);
    return true;
  } catch {
    return false;
  }
};

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

export const addWallMs = (w: Wall, deltaMs: number): Wall => utcMsToWall(wallToUtcMs(w) + deltaMs);

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

export const offsetAt = (zone: string, epochMs: number): number => wallToUtcMs(wallAt(zone, epochMs)) - epochMs;

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

export const toInstant = (zone: string, w: Wall, fold: 0 | 1 = 0): number => {
  const found = instantsForWall(zone, w);
  if (found.length) return fold ? found[found.length - 1] : found[0];
  const naive = wallToUtcMs(w);
  return naive - (fold ? offsetAt(zone, naive + DAY_MS) : offsetAt(zone, naive - DAY_MS));
};

const utcoffsetOfWall = (zone: string, w: Wall): number => wallToUtcMs(w) - toInstant(zone, w, 0);

export const resolveWall = (zone: string, w: Wall): number => {
  const found = instantsForWall(zone, w);
  if (found.length === 0) {
    const shift = utcoffsetOfWall(zone, addWallMs(w, DAY_MS)) - utcoffsetOfWall(zone, addWallMs(w, -DAY_MS));
    return toInstant(zone, addWallMs(w, shift), 0);
  }
  if (found.length > 1) return found[found.length - 1];
  return found[0];
};
