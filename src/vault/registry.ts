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
      if (sessions.get(userId) === s) sessions.delete(userId);
      s.stop();
      throw e;
    })
    .finally(() => loading.delete(userId));
  loading.set(userId, p);
  return p;
};

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

export const peekSession = (userId: string): VaultSession | undefined => sessions.get(userId);

export const hasStoredLink = (userId: string): boolean => opts().links.has(userId);

export const allSessions = (): VaultSession[] => [...sessions.values()];

export const dropSession = (userId: string): void => {
  const s = sessions.get(userId);
  if (!s) return;
  s.stop();
  s.removeAllListeners();
  sessions.delete(userId);
};

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

export const stopAllSessions = async (): Promise<void> => {
  const all = allSessions();
  all.forEach(s => s.stop());
  await Promise.all(all.map(s => s.settle(5000)));
};
