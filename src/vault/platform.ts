import {EventEmitter} from 'node:events';
import * as nodeCrypto from 'node:crypto';
import type {CloudPlatform} from '../cloud/cloudVault';
import {VAULT_KDF} from '../cloud/cloudCrypto';
import type {CloudLimits, CloudLinkState, CloudTransport} from '../cloud/cloudTypes';
import {tunables} from '../config';
import {fetchTransport} from './transport';

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

const syncHash = (s: string): string => contentHash(canonicalForSync(s));

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

export class MemoryPlatform extends EventEmitter implements CloudPlatform {
  readonly transport: CloudTransport;
  readonly userId: string;
  readonly skipMediaReupload = true;
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
    this.setLocal(keys);
  }

  async remove(key: string): Promise<void> {
    if (this.data.delete(key)) this.emit('applied', [key]);
  }

  async adoptIdentity(_identityRaw: string, _friendsRaw: string | null): Promise<void> {}

  async mergeFriends(_friendsRaw: string | null, _tombstonesRaw: string | null): Promise<void> {}

  async reencodeImage(dataUri: string, _key: string): Promise<string> {
    return dataUri;
  }

  async localHash(raw: string): Promise<string> {
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

  limits(): CloudLimits {
    const t = tunables();
    return {
      transportTimeoutMs: t.vaultHttpTimeoutMs,
      jsonTimeoutMs: t.vaultJsonTimeoutMs,
      objectTimeoutMs: t.vaultObjectTimeoutMs,
      pushDebounceMs: t.vaultPushDebounceMs,
      retryBaseMs: t.vaultRetryBaseMs,
      retryMaxMs: t.vaultRetryMaxMs,
      checkMinIntervalMs: t.vaultCheckMinIntervalMs,
      unlinkWaitMs: t.vaultUnlinkWaitMs,
      sentSaveMs: t.vaultSentSaveMs,
    };
  }

  now(): number {
    return Date.now();
  }

  argon2id(password: string, salt: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      nodeCrypto.argon2(
        'argon2id',
        {message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: VAULT_KDF.p, tagLength: 32, memory: VAULT_KDF.m, passes: VAULT_KDF.t},
        (err, key) => (err ? reject(err) : resolve(key)),
      );
    });
  }

  get(key: string): string | undefined {
    return this.data.get(key);
  }

  setLocal(keys: Record<string, string>): void {
    const changed = Object.keys(keys);
    for (const k of changed) this.data.set(k, keys[k]);
    if (changed.length) this.emit('applied', changed);
  }

  link(): CloudLinkState | null {
    return this.linkState;
  }

  clear(): void {
    if (!this.data.size) return;
    const keys = [...this.data.keys()];
    this.data.clear();
    this.emit('applied', keys);
  }
}
