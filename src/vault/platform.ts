import {EventEmitter} from 'node:events';
import * as nodeCrypto from 'node:crypto';
import type {CloudPlatform} from '../cloud/cloudVault';
import {joinDataUri, VAULT_KDF} from '../cloud/cloudCrypto';
import {CLOUD_MEDIA_REF} from '../cloud/cloudKeys';
import type {CloudLimits, CloudLinkState, CloudTransport, ManifestEntry} from '../cloud/cloudTypes';
import {tunables} from '../config';
import {fetchTransport} from './transport';
import {MEDIA_PREFIX} from './types';

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

const MARKER = /^ref:([^:]*):([^:]+):(.+)$/;

export interface MediaMarker {
  hash: string;
  mime: string;
  key: string;
}

export const mediaMarker = (hash: string, mime: string, key: string): string => `${CLOUD_MEDIA_REF}${hash}:${mime}:${key}`;

export const parseMediaMarker = (raw: string | undefined): MediaMarker | null => {
  const m = raw === undefined ? null : MARKER.exec(raw);
  return m ? {hash: m[1], mime: m[2].toLowerCase(), key: m[3]} : null;
};

export interface PendingMedia {
  hash: string;
  mime: string;
  bytes: Uint8Array;
}

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
  private readonly pending = new Map<string, PendingMedia>();
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
    this.pending.delete(key);
    if (this.data.delete(key)) this.emit('applied', [key]);
  }

  async readMedia(ref: string): Promise<string | null> {
    const marker = parseMediaMarker(`${CLOUD_MEDIA_REF}${ref}`);
    const p = marker ? this.pending.get(marker.key) : undefined;
    return p && marker && p.hash === marker.hash ? joinDataUri(p.mime, p.bytes) : null;
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
    for (const [k, p] of this.pending) {
      const marker = parseMediaMarker(this.data.get(k));
      if (!marker || marker.hash !== p.hash || state?.known[k]?.hash === p.hash) this.pending.delete(k);
    }
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

  deferMedia(entry: ManifestEntry): string {
    return mediaMarker(entry.hash, entry.mime || 'image/jpeg', entry.path);
  }

  mediaHashOf(raw: string): string | null {
    return parseMediaMarker(raw)?.hash ?? null;
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

  stageMedia(key: string, hash: string, mime: string, bytes: Uint8Array): void {
    this.pending.set(key, {hash, mime, bytes});
    this.setLocal({[key]: mediaMarker(hash, mime, key)});
  }

  pendingMedia(key: string): PendingMedia | undefined {
    return this.pending.get(key);
  }

  dropMedia(key: string): void {
    this.pending.delete(key);
    if (this.data.delete(key)) this.emit('applied', [key]);
  }

  bytes(): {media: number; data: number} {
    let media = 0;
    let data = 0;
    for (const [k, v] of this.data) {
      if (k.startsWith(MEDIA_PREFIX)) media += v.length;
      else data += v.length;
    }
    return {media, data};
  }

  clear(): void {
    this.pending.clear();
    if (!this.data.size) return;
    const keys = [...this.data.keys()];
    this.data.clear();
    this.emit('applied', keys);
  }
}
