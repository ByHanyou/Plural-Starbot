import Database from 'better-sqlite3';
import {chmodSync, existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type {CloudLinkState} from './cloud/cloudTypes';
import {log} from './log';

/** Proxied-message records are kept this long, then purged. */
export const PROXIED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
export const DB_FILE_NAME = 'starbot.db';

export interface ProxiedMessage {
  /** The webhook message the bot posted. */
  messageId: string;
  /** The user's original message that was replaced. */
  originalId: string;
  channelId: string;
  guildId: string | null;
  /** Vault member id the message was proxied as. */
  memberId: string;
  /** Discord user id of the sender. */
  userId: string;
  timestamp: number;
}

interface ProxiedRow {
  message_id: string;
  original_id: string;
  channel_id: string;
  guild_id: string | null;
  member_id: string;
  user_id: string;
  created_at: number;
}

const toProxied = (r: ProxiedRow | undefined): ProxiedMessage | null =>
  r
    ? {
        messageId: r.message_id,
        originalId: r.original_id,
        channelId: r.channel_id,
        guildId: r.guild_id,
        memberId: r.member_id,
        userId: r.user_id,
        timestamp: r.created_at,
      }
    : null;

// Each entry upgrades the schema by one version (PRAGMA user_version). Append only.
const MIGRATIONS: string[] = [
  `CREATE TABLE links (
     user_id    TEXT PRIMARY KEY,
     state      TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE guild_settings (
     guild_id   TEXT NOT NULL,
     module     TEXT NOT NULL,
     key        TEXT NOT NULL,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (guild_id, module, key)
   );
   CREATE TABLE proxied_messages (
     message_id  TEXT PRIMARY KEY,
     original_id TEXT NOT NULL,
     channel_id  TEXT NOT NULL,
     guild_id    TEXT,
     member_id   TEXT NOT NULL,
     user_id     TEXT NOT NULL,
     created_at  INTEGER NOT NULL
   );
   CREATE INDEX proxied_by_original ON proxied_messages(original_id);
   CREATE INDEX proxied_by_user ON proxied_messages(user_id, channel_id, created_at);
   CREATE INDEX proxied_by_time ON proxied_messages(created_at);`,
  `CREATE TABLE user_settings (
     user_id TEXT NOT NULL,
     key     TEXT NOT NULL,
     value   TEXT NOT NULL,
     PRIMARY KEY (user_id, key)
   );`,
];

export class StarbotDb {
  readonly path: string;
  private db: Database.Database;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(path);
    // The file holds every linked vault's key: owner-only. SQLite gives the -wal and -shm files
    // the database file's mode, so set it before WAL is switched on.
    restrictToOwner(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    // Deleted rows (an unlinked vault's key) are overwritten, not left in free pages.
    this.db.pragma('secure_delete = ON');
    for (const extra of ['-wal', '-shm']) restrictToOwner(path + extra);
    this.migrate();
  }

  private migrate(): void {
    const current = Number(this.db.pragma('user_version', {simple: true})) || 0;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
      log.info('Database migrated to schema version %d.', v + 1);
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  // ---- vault links (one per Discord user) --------------------------------

  getLink(userId: string): CloudLinkState | null {
    const row = this.db.prepare('SELECT state FROM links WHERE user_id = ?').get(userId) as {state: string} | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.state) as CloudLinkState;
    } catch {
      log.error('Stored vault link for user %s is unreadable.', userId);
      return null;
    }
  }

  /** Stores the engine's CloudLinkState for a user; null deletes the row. */
  saveLink(userId: string, state: CloudLinkState | null): void {
    if (!state) {
      if (this.db.prepare('DELETE FROM links WHERE user_id = ?').run(userId).changes > 0) {
        // Copy the overwritten pages into the database and empty the WAL, so no old copy of the key stays in it.
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO links (user_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(userId, JSON.stringify(state), Date.now());
  }

  hasLink(userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM links WHERE user_id = ?').get(userId);
  }

  linkedUserIds(): string[] {
    return (this.db.prepare('SELECT user_id FROM links ORDER BY user_id').all() as {user_id: string}[]).map(r => r.user_id);
  }

  // ---- per-guild settings: JSON values by (guild, module, key) -----------

  getGuildSetting<T = unknown>(guildId: string, module: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM guild_settings WHERE guild_id = ? AND module = ? AND key = ?')
      .get(guildId, module, key) as {value: string} | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  /** Stores a JSON-serialisable value. undefined deletes the setting. */
  setGuildSetting(guildId: string, module: string, key: string, value: unknown): void {
    if (value === undefined) {
      this.deleteGuildSetting(guildId, module, key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, module, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, module, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(guildId, module, key, JSON.stringify(value), Date.now());
  }

  deleteGuildSetting(guildId: string, module: string, key: string): boolean {
    return this.db.prepare('DELETE FROM guild_settings WHERE guild_id = ? AND module = ? AND key = ?').run(guildId, module, key).changes > 0;
  }

  /** Every setting a module has for one guild, as key -> value. */
  guildSettings(guildId: string, module: string): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM guild_settings WHERE guild_id = ? AND module = ?').all(guildId, module) as {
      key: string;
      value: string;
    }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {}
    }
    return out;
  }

  /** Guild ids that have at least one setting for the module. */
  guildsWithSettings(module: string): string[] {
    return (
      this.db.prepare('SELECT DISTINCT guild_id FROM guild_settings WHERE module = ? ORDER BY guild_id').all(module) as {guild_id: string}[]
    ).map(r => r.guild_id);
  }

  /** Every guild id that has at least one setting (any module). */
  guildIdsWithSettings(): string[] {
    return (this.db.prepare('SELECT DISTINCT guild_id FROM guild_settings ORDER BY guild_id').all() as {guild_id: string}[]).map(r => r.guild_id);
  }

  /** Removes every setting of a guild (all modules, or one). Returns rows removed. */
  clearGuild(guildId: string, module?: string): number {
    if (module) return this.db.prepare('DELETE FROM guild_settings WHERE guild_id = ? AND module = ?').run(guildId, module).changes;
    return this.db.prepare('DELETE FROM guild_settings WHERE guild_id = ?').run(guildId).changes;
  }

  /** Removes one key from every guild (e.g. a user's per-guild setting). Returns rows removed. */
  deleteGuildSettingInAllGuilds(module: string, key: string): number {
    return this.db.prepare('DELETE FROM guild_settings WHERE module = ? AND key = ?').run(module, key).changes;
  }

  // ---- per-user settings: JSON values by (user, key), for every guild ------

  getUserSetting<T = unknown>(userId: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as {value: string} | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  /** Stores a JSON-serialisable value. undefined deletes the setting. */
  setUserSetting(userId: string, key: string, value: unknown): void {
    if (value === undefined) {
      this.deleteUserSetting(userId, key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(userId, key, JSON.stringify(value));
  }

  deleteUserSetting(userId: string, key: string): boolean {
    return this.db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key).changes > 0;
  }

  // ---- proxied messages (7-day retention) ---------------------------------

  recordProxied(m: ProxiedMessage): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO proxied_messages (message_id, original_id, channel_id, guild_id, member_id, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.messageId, m.originalId, m.channelId, m.guildId, m.memberId, m.userId, m.timestamp);
  }

  proxiedByMessageId(messageId: string, now = Date.now()): ProxiedMessage | null {
    const row = this.db
      .prepare('SELECT * FROM proxied_messages WHERE message_id = ? AND created_at >= ?')
      .get(messageId, now - PROXIED_RETENTION_MS) as ProxiedRow | undefined;
    return toProxied(row);
  }

  proxiedByOriginalId(originalId: string, now = Date.now()): ProxiedMessage | null {
    const row = this.db
      .prepare('SELECT * FROM proxied_messages WHERE original_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
      .get(originalId, now - PROXIED_RETENTION_MS) as ProxiedRow | undefined;
    return toProxied(row);
  }

  /** The user's most recent proxied message, optionally limited to one channel. */
  lastProxied(userId: string, channelId?: string, now = Date.now()): ProxiedMessage | null {
    const since = now - PROXIED_RETENTION_MS;
    const row = channelId
      ? this.db
          .prepare('SELECT * FROM proxied_messages WHERE user_id = ? AND channel_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
          .get(userId, channelId, since)
      : this.db.prepare('SELECT * FROM proxied_messages WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1').get(userId, since);
    return toProxied(row as ProxiedRow | undefined);
  }

  /** The user's most recent proxied message in one guild, in any channel. */
  lastProxiedInGuild(userId: string, guildId: string, now = Date.now()): ProxiedMessage | null {
    const row = this.db
      .prepare('SELECT * FROM proxied_messages WHERE user_id = ? AND guild_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
      .get(userId, guildId, now - PROXIED_RETENTION_MS) as ProxiedRow | undefined;
    return toProxied(row);
  }

  deleteProxied(messageId: string): boolean {
    return this.db.prepare('DELETE FROM proxied_messages WHERE message_id = ?').run(messageId).changes > 0;
  }

  /** Deletes records older than the retention window. Returns rows removed. */
  purgeProxied(now = Date.now()): number {
    return this.db.prepare('DELETE FROM proxied_messages WHERE created_at < ?').run(now - PROXIED_RETENTION_MS).changes;
  }
}

/** chmod 600 where the platform has POSIX modes (a no-op for the bits Windows ignores). */
const restrictToOwner = (file: string): void => {
  try {
    if (existsSync(file)) chmodSync(file, 0o600);
  } catch (e) {
    log.warn('Could not restrict the permissions of %s: %s', file, e instanceof Error ? e.message : String(e));
  }
};

let instance: StarbotDb | null = null;

/** Opens (creating if needed) DATA_DIR/starbot.db and runs migrations. */
export const openDb = (dataDir: string): StarbotDb => {
  if (instance) return instance;
  mkdirSync(dataDir, {recursive: true, mode: 0o700});
  instance = new StarbotDb(join(dataDir, DB_FILE_NAME));
  return instance;
};

/** The open database. openDb() must have run first. */
export const db = (): StarbotDb => {
  if (!instance) throw new Error('Database is not open.');
  return instance;
};

export const closeDb = (): void => {
  instance?.close();
  instance = null;
};

/** Purges expired proxied-message records now and then every hour. Returns a stop function. */
export const startPurgeJob = (): (() => void) => {
  const run = (): void => {
    try {
      const n = db().purgeProxied();
      if (n) log.info('Purged %d proxied-message record(s) older than 7 days.', n);
    } catch (e) {
      log.exception(e, 'Proxied-message purge failed.');
    }
  };
  run();
  const timer = setInterval(run, PURGE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
};

/** The vault-link store the sessions use: rows in the links table. */
export const dbLinkStore = {
  load: (userId: string): CloudLinkState | null => db().getLink(userId),
  save: (userId: string, state: CloudLinkState | null): void => db().saveLink(userId, state),
  has: (userId: string): boolean => db().hasLink(userId),
  userIds: (): string[] => db().linkedUserIds(),
};
