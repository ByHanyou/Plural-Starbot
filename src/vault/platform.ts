import {EventEmitter} from 'node:events';
import type {CloudPlatform} from '../cloud/cloudVault';
import type {CloudLinkState, CloudTransport} from '../cloud/cloudTypes';
import {fetchTransport} from './transport';

// The app's sync hash (src/network/NetworkManager.ts: contentHash, canonicalForSync, syncHash),
// copied verbatim so the bot's manifest hashes match the phone's.
const contentHash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
};

const canonicalForSync = (s: string): string =>
  s
    .replace(/file:\/\/[^"\\]*\/Documents\//g, 'file:///Documents/')
    .replace(/(file:[^"\\]*?)\?t=\d+/g, '$1');

export const syncHash = (s: string): string => contentHash(canonicalForSync(s));

/** Where the platform keeps the link state (SQLite in the bot, swappable in tests). */
export interface LinkStore {
  load(userId: string): CloudLinkState | null;
  save(userId: string, state: CloudLinkState | null): void;
}

export interface MemoryPlatformOptions {
  userId: string;
  cloudNodeUrl: string;
  links: LinkStore;
  transport?: CloudTransport;
}

/**
 * CloudPlatform for one Discord user. Vault contents live only in this in-memory map;
 * only the link state is persisted (through LinkStore). Emits 'applied' (keys: string[])
 * whenever the map changes: after the engine's apply() or remove(), and after a local write.
 */
export class MemoryPlatform extends EventEmitter implements CloudPlatform {
  readonly transport: CloudTransport;
  readonly userId: string;
  private readonly cloudNodeUrl: string;
  private readonly links: LinkStore;
  private readonly data = new Map<string, string>();
  private linkState: CloudLinkState | null = null;

  constructor(opts: MemoryPlatformOptions) {
    super();
    this.userId = opts.userId;
    this.cloudNodeUrl = opts.cloudNodeUrl;
    this.links = opts.links;
    this.transport = opts.transport || fetchTransport;
  }

  relay(): {relayUrl: string; token: string} {
    return {relayUrl: this.cloudNodeUrl, token: ''};
  }

  async snapshot(): Promise<Record<string, string>> {
    return Object.fromEntries(this.data);
  }

  async apply(keys: Record<string, string>): Promise<void> {
    const changed = Object.keys(keys);
    for (const k of changed) this.data.set(k, keys[k]);
    if (changed.length) this.emit('applied', changed);
  }

  async remove(key: string): Promise<void> {
    if (this.data.delete(key)) this.emit('applied', [key]);
  }

  // The bot never takes over the user's network identity or friends.
  async adoptIdentity(_identityRaw: string, _friendsRaw: string | null): Promise<void> {}

  async mergeFriends(_friendsRaw: string | null, _tombstonesRaw: string | null): Promise<void> {}

  // The bot never uploads images, so nothing is re-encoded.
  async reencodeImage(dataUri: string): Promise<string> {
    return dataUri;
  }

  localHash(raw: string): string {
    return syncHash(raw);
  }

  async loadLink(): Promise<CloudLinkState | null> {
    this.linkState = this.links.load(this.userId);
    return this.linkState;
  }

  async saveLink(state: CloudLinkState | null): Promise<void> {
    this.links.save(this.userId, state);
    this.linkState = state;
    if (!state) this.clear();
  }

  async deviceSubId(): Promise<string> {
    return `starbot:${this.userId}`;
  }

  deviceLabel(): string {
    return 'Plural Starbot';
  }

  now(): number {
    return Date.now();
  }

  // ---- bot-side helpers ----------------------------------------------------

  /** Raw stored value of a vault key, if held in memory. */
  get(key: string): string | undefined {
    return this.data.get(key);
  }

  /** Writes values into memory as a local change (the session pushes them). */
  setLocal(keys: Record<string, string>): void {
    const changed = Object.keys(keys);
    for (const k of changed) this.data.set(k, keys[k]);
    if (changed.length) this.emit('applied', changed);
  }

  /** The current link state as last loaded or saved by the engine (live object). */
  link(): CloudLinkState | null {
    return this.linkState;
  }

  /** Drops every vault value held in memory. */
  clear(): void {
    if (!this.data.size) return;
    const keys = [...this.data.keys()];
    this.data.clear();
    this.emit('applied', keys);
  }

  keys(): string[] {
    return [...this.data.keys()];
  }
}
