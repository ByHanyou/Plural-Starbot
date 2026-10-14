import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export interface Config {
  discordToken: string;
  cloudNodeUrl: string;
  avatarBaseUrl: string;
  avatarPort: number;
  dataDir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TOKEN_PLACEHOLDER = 'paste-your-bot-token-here';

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
};

/** Reads KEY=VALUE lines from a .env file into process.env without overriding values already set. */
export const loadEnvFile = (path: string): boolean => {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7) : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(body.slice(eq + 1));
  }
  return true;
};

const httpUrl = (name: string, raw: string | undefined, problems: string[]): string => {
  const v = (raw || '').trim();
  if (!v) {
    problems.push(`${name} is not set.`);
    return '';
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    problems.push(`${name} is not a valid URL: ${v}`);
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    problems.push(`${name} must start with http:// or https://`);
    return '';
  }
  return v.replace(/\/+$/, '');
};

/**
 * Loads `.env` from the working directory (values already in the environment win)
 * and validates the five settings. Throws ConfigError listing every problem.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env, envFile = resolve(process.cwd(), '.env')): Config => {
  if (env === process.env) loadEnvFile(envFile);
  const problems: string[] = [];

  const token = (env.DISCORD_BOT_TOKEN || '').trim();
  if (!token || token === TOKEN_PLACEHOLDER) problems.push('DISCORD_BOT_TOKEN is not set. Put the bot token from the Discord Developer Portal in .env.');

  const cloudNodeUrl = httpUrl('CLOUD_NODE_URL', env.CLOUD_NODE_URL, problems);
  const avatarBaseUrl = httpUrl('AVATAR_BASE_URL', env.AVATAR_BASE_URL, problems);

  const portRaw = (env.AVATAR_PORT || '').trim();
  const avatarPort = Number(portRaw);
  if (!portRaw) problems.push('AVATAR_PORT is not set.');
  else if (!Number.isInteger(avatarPort) || avatarPort < 1 || avatarPort > 65535) problems.push(`AVATAR_PORT must be a port number (1-65535), got: ${portRaw}`);

  const dataDirRaw = (env.DATA_DIR || '').trim();
  if (!dataDirRaw) problems.push('DATA_DIR is not set.');

  if (problems.length) {
    throw new ConfigError(
      `Plural Starbot is not configured:\n  - ${problems.join('\n  - ')}\nCopy .env.example to .env and fill in every value (see README.md).`,
    );
  }

  return {
    discordToken: token,
    cloudNodeUrl,
    avatarBaseUrl,
    avatarPort,
    dataDir: resolve(dataDirRaw),
  };
};

let current: Config | null = null;

/** The loaded configuration. loadConfig()/setConfig() must have run first. */
export const config = (): Config => {
  if (!current) throw new ConfigError('Configuration has not been loaded.');
  return current;
};

export const setConfig = (c: Config): Config => {
  current = c;
  return c;
};
