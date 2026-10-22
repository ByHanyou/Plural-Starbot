import {log} from './log';

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const asRecord = (v: unknown): Record<string, unknown> | null => (isRecord(v) ? v : null);

export const orNull = <T>(p: Promise<T>, what: string): Promise<T | null> =>
  p.catch((e: unknown) => {
    log.debug('%s failed: %s', what, errorText(e));
    return null;
  });
