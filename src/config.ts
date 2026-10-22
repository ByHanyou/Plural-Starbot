import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Tunables {
  buttonWaitMs: number;
  profileStaleMs: number;
  defaultTimezone: string;
  memoryReuseCooldownSeconds: number;
  latchHours: number;
  downloadTimeoutMs: number;
  vaultCheckIntervalMs: number;
  vaultFreshMs: number;
  vaultSettleTimeoutMs: number;
  vaultHttpTimeoutMs: number;
  proxiedRetentionDays: number;
  purgeIntervalMs: number;
  lookupsPerMinute: number;
  linkSlots: number;
  vaultJsonTimeoutMs: number;
  vaultObjectTimeoutMs: number;
  vaultPushDebounceMs: number;
  vaultRetryBaseMs: number;
  vaultRetryMaxMs: number;
  vaultCheckMinIntervalMs: number;
  vaultUnlinkWaitMs: number;
  vaultSentSaveMs: number;
  linkAttempts: number;
  linkAttemptWindowMs: number;
  shutdownSettleMs: number;
  sessionLoadConcurrency: number;
}

export interface Config {
  discordToken: string;
  cloudNodeUrl: string;
  avatarBaseUrl: string;
  avatarPort: number;
  dataDir: string;
  logLevel: LogLevel;
  devGuildId: string | null;
  tunables: Tunables;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_TUNABLES: Tunables = {
  buttonWaitMs: 1500,
  profileStaleMs: 15 * 60 * 1000,
  defaultTimezone: 'America/New_York',
  memoryReuseCooldownSeconds: 2 * 24 * 60 * 60,
  latchHours: 6,
  downloadTimeoutMs: 60 * 1000,
  vaultCheckIntervalMs: 2 * 60 * 1000,
  vaultFreshMs: 30 * 1000,
  vaultSettleTimeoutMs: 20 * 1000,
  vaultHttpTimeoutMs: 30 * 1000,
  proxiedRetentionDays: 7,
  purgeIntervalMs: 60 * 60 * 1000,
  lookupsPerMinute: 4,
  linkSlots: 2,
  vaultJsonTimeoutMs: 15 * 1000,
  vaultObjectTimeoutMs: 120 * 1000,
  vaultPushDebounceMs: 4 * 1000,
  vaultRetryBaseMs: 5 * 1000,
  vaultRetryMaxMs: 5 * 60 * 1000,
  vaultCheckMinIntervalMs: 20 * 1000,
  vaultUnlinkWaitMs: 20 * 1000,
  vaultSentSaveMs: 5 * 1000,
  linkAttempts: 3,
  linkAttemptWindowMs: 10 * 60 * 1000,
  shutdownSettleMs: 5 * 1000,
  sessionLoadConcurrency: 4,
};

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const TOKEN_PLACEHOLDER = 'paste-your-bot-token-here';

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
};

const loadEnvFile = (path: string): boolean => {
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

const positiveInt = (name: string, raw: string | undefined, fallback: number, problems: string[]): number => {
  const v = (raw || '').trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    problems.push(`${name} must be a whole number of at least 1, got: ${v}`);
    return fallback;
  }
  return n;
};

const logLevel = (raw: string | undefined, problems: string[]): LogLevel => {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return 'info';
  const level = v === 'warning' ? 'warn' : v;
  const found = LOG_LEVELS.find(l => l === level);
  if (found) return found;
  problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${raw}`);
  return 'info';
};

const snowflake = (name: string, raw: string | undefined, problems: string[]): string | null => {
  const v = (raw || '').trim();
  if (!v) return null;
  if (!/^\d{15,25}$/.test(v)) {
    problems.push(`${name} must be a Discord server ID (15-25 digits), got: ${v}`);
    return null;
  }
  return v;
};

const timezone = (name: string, raw: string | undefined, fallback: string, problems: string[]): string => {
  const v = (raw || '').trim();
  if (!v) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: v});
  } catch {
    problems.push(`${name} must be an IANA timezone name such as America/Chicago, got: ${v}`);
    return fallback;
  }
  return v;
};

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_S = 3600;

const loadTunables = (env: NodeJS.ProcessEnv, problems: string[]): Tunables => {
  const d = DEFAULT_TUNABLES;
  const int = (name: string, fallback: number, unit = 1): number => positiveInt(name, env[name], fallback / unit, problems) * unit;
  return {
    buttonWaitMs: int('BUTTON_WAIT_MS', d.buttonWaitMs),
    profileStaleMs: int('PROFILE_STALE_MINUTES', d.profileStaleMs, MINUTE_MS),
    defaultTimezone: timezone('DEFAULT_TIMEZONE', env.DEFAULT_TIMEZONE, d.defaultTimezone, problems),
    memoryReuseCooldownSeconds: int('MEMORY_REUSE_COOLDOWN_HOURS', d.memoryReuseCooldownSeconds, HOUR_S),
    latchHours: int('LATCH_HOURS', d.latchHours),
    downloadTimeoutMs: int('DOWNLOAD_TIMEOUT_SECONDS', d.downloadTimeoutMs, SECOND_MS),
    vaultCheckIntervalMs: int('VAULT_CHECK_INTERVAL_SECONDS', d.vaultCheckIntervalMs, SECOND_MS),
    vaultFreshMs: int('VAULT_FRESH_SECONDS', d.vaultFreshMs, SECOND_MS),
    vaultSettleTimeoutMs: int('VAULT_SETTLE_TIMEOUT_SECONDS', d.vaultSettleTimeoutMs, SECOND_MS),
    vaultHttpTimeoutMs: int('VAULT_HTTP_TIMEOUT_SECONDS', d.vaultHttpTimeoutMs, SECOND_MS),
    proxiedRetentionDays: int('PROXIED_RETENTION_DAYS', d.proxiedRetentionDays),
    purgeIntervalMs: int('PURGE_INTERVAL_MINUTES', d.purgeIntervalMs, MINUTE_MS),
    lookupsPerMinute: int('LOOKUPS_PER_MINUTE', d.lookupsPerMinute),
    linkSlots: int('LINK_SLOTS', d.linkSlots),
    vaultJsonTimeoutMs: int('VAULT_JSON_TIMEOUT_SECONDS', d.vaultJsonTimeoutMs, SECOND_MS),
    vaultObjectTimeoutMs: int('VAULT_OBJECT_TIMEOUT_SECONDS', d.vaultObjectTimeoutMs, SECOND_MS),
    vaultPushDebounceMs: int('VAULT_PUSH_DEBOUNCE_SECONDS', d.vaultPushDebounceMs, SECOND_MS),
    vaultRetryBaseMs: int('VAULT_RETRY_BASE_SECONDS', d.vaultRetryBaseMs, SECOND_MS),
    vaultRetryMaxMs: int('VAULT_RETRY_MAX_SECONDS', d.vaultRetryMaxMs, SECOND_MS),
    vaultCheckMinIntervalMs: int('VAULT_CHECK_MIN_INTERVAL_SECONDS', d.vaultCheckMinIntervalMs, SECOND_MS),
    vaultUnlinkWaitMs: int('VAULT_UNLINK_WAIT_SECONDS', d.vaultUnlinkWaitMs, SECOND_MS),
    vaultSentSaveMs: int('VAULT_SENT_SAVE_SECONDS', d.vaultSentSaveMs, SECOND_MS),
    linkAttempts: int('LINK_ATTEMPTS', d.linkAttempts),
    linkAttemptWindowMs: int('LINK_ATTEMPT_WINDOW_MINUTES', d.linkAttemptWindowMs, MINUTE_MS),
    shutdownSettleMs: int('SHUTDOWN_SETTLE_SECONDS', d.shutdownSettleMs, SECOND_MS),
    sessionLoadConcurrency: int('SESSION_LOAD_CONCURRENCY', d.sessionLoadConcurrency),
  };
};

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

  const level = logLevel(env.LOG_LEVEL, problems);
  const devGuildId = snowflake('DEV_GUILD_ID', env.DEV_GUILD_ID, problems);
  const tunables = loadTunables(env, problems);

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
    logLevel: level,
    devGuildId,
    tunables,
  };
};

let current: Config | null = null;

export const config = (): Config => {
  if (!current) throw new ConfigError('Configuration has not been loaded.');
  return current;
};

export const tunables = (): Tunables => config().tunables;

export const setConfig = (c: Config): Config => {
  current = c;
  return c;
};
