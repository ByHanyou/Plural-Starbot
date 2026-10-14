import {format} from 'node:util';

type Level = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

const pad = (n: number): string => String(n).padStart(2, '0');

const stamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const debugOn = process.env.LOG_LEVEL?.toLowerCase() === 'debug';

const write = (level: Level, args: unknown[]): void => {
  const line = `${stamp(new Date())} [${level}] ${format(...(args as [unknown, ...unknown[]]))}`;
  if (level === 'ERROR' || level === 'WARNING') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

const describe = (err: unknown): string => {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  return String(err);
};

export const log = {
  debug: (...args: unknown[]): void => {
    if (debugOn) write('DEBUG', args);
  },
  info: (...args: unknown[]): void => write('INFO', args),
  warn: (...args: unknown[]): void => write('WARNING', args),
  error: (...args: unknown[]): void => write('ERROR', args),
  exception: (err: unknown, ...args: unknown[]): void => {
    const head = args.length ? format(...(args as [unknown, ...unknown[]])) : 'Unhandled error';
    write('ERROR', [`${head}\n${describe(err)}`]);
  },
};
