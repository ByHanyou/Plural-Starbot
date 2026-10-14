import type {CloudTransport} from '../cloud/cloudTypes';
import {log} from '../log';
import type {LinkStore} from './platform';
import {VaultSession} from './session';

export interface RegistryOptions {
  cloudNodeUrl: string;
  links: LinkStore & {has(userId: string): boolean; userIds(): string[]};
  transport?: CloudTransport;
}

const sessions = new Map<string, VaultSession>();
const loading = new Map<string, Promise<VaultSession>>();
let options: RegistryOptions | null = null;

export const configureRegistry = (opts: RegistryOptions): void => {
  options = opts;
};

const opts = (): RegistryOptions => {
  if (!options) throw new Error('Vault registry is not configured.');
  return options;
};

/** The session for a Discord user (created and initialised on first use; linked or not). */
export const getSession = (userId: string): Promise<VaultSession> => {
  const have = sessions.get(userId);
  if (have) return have.init().then(() => have);
  const inFlight = loading.get(userId);
  if (inFlight) return inFlight;
  const o = opts();
  const s = new VaultSession({userId, cloudNodeUrl: o.cloudNodeUrl, links: o.links, transport: o.transport});
  sessions.set(userId, s);
  const p = s
    .init()
    .then(() => s)
    .catch(e => {
      // Let the next call try again with a fresh session.
      if (sessions.get(userId) === s) sessions.delete(userId);
      s.stop();
      throw e;
    })
    .finally(() => loading.delete(userId));
  loading.set(userId, p);
  return p;
};

/** The user's session when a vault is linked, else null. Never creates a session for unlinked users. */
export const linkedSession = async (userId: string): Promise<VaultSession | null> => {
  const have = sessions.get(userId);
  if (have) {
    await have.init();
    return have.isLinked() ? have : null;
  }
  if (!hasStoredLink(userId)) return null;
  const s = await getSession(userId);
  return s.isLinked() ? s : null;
};

/** The session if it is already in memory (no loading). */
export const peekSession = (userId: string): VaultSession | undefined => sessions.get(userId);

/** Whether SQLite holds a vault link for the user. */
export const hasStoredLink = (userId: string): boolean => opts().links.has(userId);

/** Every session in memory. */
export const allSessions = (): VaultSession[] => [...sessions.values()];

/** Stops and forgets a session (after unlink). */
export const dropSession = (userId: string): void => {
  const s = sessions.get(userId);
  if (!s) return;
  s.stop();
  s.removeAllListeners();
  sessions.delete(userId);
};

/** Loads every linked user's session from SQLite (a few at a time); each runs a first check. */
export const loadAllSessions = async (concurrency = 4): Promise<number> => {
  const ids = opts().links.userIds();
  let next = 0;
  let loaded = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const s = await getSession(id);
        if (s.isLinked()) loaded++;
      } catch (e) {
        log.exception(e, 'Could not load the vault session for user %s.', id);
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, ids.length)}, worker));
  return loaded;
};

/** Stops every periodic check and waits (bounded) for in-flight syncs. */
export const stopAllSessions = async (): Promise<void> => {
  const all = allSessions();
  all.forEach(s => s.stop());
  await Promise.all(all.map(s => s.settle(5000)));
};
