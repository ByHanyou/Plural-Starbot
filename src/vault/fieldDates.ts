const fieldDateOf = (y: number, m: number, d: number, h = 0, min = 0): Date | null => {
  const dt = new Date(y, m - 1, d, h, min, 0, 0);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
};

export const parseFieldDate = (val: unknown): Date | null => {
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    if (Number.isInteger(val) && val >= 1000 && val <= 9999) return new Date(val, 0, 1);
    return new Date(val);
  }
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (!s) return null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})$/.exec(s))) return fieldDateOf(+m[1], 1, 1);
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(s))) return fieldDateOf(+m[1], +m[2], 1);
  if ((m = /^(\d{1,2})-(\d{1,2})$/.exec(s))) return fieldDateOf(2000, +m[1], +m[2]);
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s))) {
    return fieldDateOf(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})T00:00(?::00(?:\.0+)?)?Z$/.exec(s))) return fieldDateOf(+m[1], +m[2], +m[3]);
  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFieldDate(Number(s));
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
};

export const parseFieldRange = (val: unknown): {start: Date; end: Date} | null => {
  if (typeof val !== 'string' || !val.trim()) return null;
  const s = val.trim();
  if (s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s);
      const start = parseFieldDate(parsed?.start);
      const end = parseFieldDate(parsed?.end);
      return start && end ? {start, end} : null;
    } catch {
      return null;
    }
  }
  const [a, b] = s.split('|');
  const start = parseFieldDate(a);
  const end = parseFieldDate(b);
  const first = start ?? end;
  const last = end ?? start;
  return first && last ? {start: first, end: last} : null;
};
