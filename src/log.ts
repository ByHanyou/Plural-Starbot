import {format} from 'node:util';
import type {LogLevel} from './config';

const RANK: Record<LogLevel, number> = {debug: 0, info: 1, warn: 2, error: 3};

const LABEL: Record<LogLevel, string> = {debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR'};

let threshold = RANK.info;

export const setLogLevel = (level: LogLevel): void => {
  threshold = RANK[level];
};

const pad = (n: number): string => String(n).padStart(2, '0');

const stamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const write = (level: LogLevel, fmt: unknown, args: unknown[]): void => {
  if (RANK[level] < threshold) return;
  const line = `${stamp(new Date())} [${LABEL[level]}] ${format(fmt, ...args)}\n`;
  if (RANK[level] >= RANK.warn) process.stderr.write(line);
  else process.stdout.write(line);
};

const describe = (err: unknown): string => {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  return String(err);
};

export const log = {
  debug: (fmt: unknown, ...args: unknown[]): void => write('debug', fmt, args),
  info: (fmt: unknown, ...args: unknown[]): void => write('info', fmt, args),
  warn: (fmt: unknown, ...args: unknown[]): void => write('warn', fmt, args),
  error: (fmt: unknown, ...args: unknown[]): void => write('error', fmt, args),
  exception: (err: unknown, fmt?: unknown, ...args: unknown[]): void => {
    const head = fmt === undefined ? 'Unhandled error' : format(fmt, ...args);
    write('error', `${head}\n${describe(err)}`, []);
  },
};
