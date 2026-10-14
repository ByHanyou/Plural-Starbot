import {log} from '../../log';

const HOUR_MS = 60 * 60 * 1000;
const lastWarned = new Map<string, number>();

/** Logs a warning at most once per hour for the same key (e.g. one channel's missing permissions). */
export const warnHourly = (key: string, ...args: unknown[]): void => {
  const now = Date.now();
  const at = lastWarned.get(key);
  if (at !== undefined && now - at < HOUR_MS) return;
  lastWarned.set(key, now);
  log.warn(...args);
};
