import {EventEmitter} from 'node:events';
import {CloudApi} from '../cloud/cloudApi';
import {CloudError, CloudPhase, CloudTransport} from '../cloud/cloudTypes';
import {CloudService} from '../cloud/cloudVault';
import {log} from '../log';
import {LinkStore, MemoryPlatform} from './platform';
import {linkSlots} from './throttle';
import {VaultCreateRefused} from './transport';
import {AppSettings, CustomFieldDef, FrontState, HistoryEntry, Member, MemberGroup, SystemInfo, VAULT_KEYS} from './types';

export const CHECK_INTERVAL_MS = 2 * 60 * 1000;
export const FRESH_MS = 30 * 1000;
const SETTLE_TIMEOUT_MS = 20000;

export type LinkStage = 'queued' | 'deriving' | 'looking-up' | 'opening' | 'importing';

export type LinkResult = {kind: 'not-found'} | {kind: 'linked'; systemName: string; memberCount: number};

export interface UnlinkResult {
  deviceRemoved: boolean;
  error: string | null;
}

export type PushResult =
  | {ok: true}
  | {ok: false; reason: 'conflict'; replaced: string[]; saved: string[]}
  | {ok: false; reason: 'failed' | 'pending'; error: string | null};

export const LINK_BROKEN_TEXT =
  'Plural Starbot can no longer open your vault: it was deleted, or its cloud password was changed. ' +
  'Run `/unlink` and then `/link` again in a direct message with me.';

export const NO_DATA_TEXT = 'Your vault has no data yet. Finish the first backup in the Plural Star app.';

const isDeadLink = (e: unknown): boolean =>
  e instanceof CloudError && ((e.status === 404 && e.code === 'no vault') || (e.status === 401 && e.code === 'bad auth secret'));

const isRemovedDevice = (e: unknown): boolean => e instanceof CloudError && e.status === 401 && e.code === 'device unlinked';

export interface VaultSessionOptions {
  userId: string;
  cloudNodeUrl: string;
  links: LinkStore;
  transport?: CloudTransport;
}

const rosterCount = (members: Member[]): number => members.filter(m => !m.deleted && !m.archived && !m.isCustomFront && !m.isFacet).length;

export class VaultSession extends EventEmitter {
  readonly userId: string;
  readonly platform: MemoryPlatform;
  readonly service: CloudService;
  private readonly cloudNodeUrl: string;
  private readonly links: LinkStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheckAt = 0;
  private linking = false;
  private initPromise: Promise<void> | null = null;
  private hydrated = false;
  private broken: string | null = null;
  private lastSyncOkAt = 0;
  private lastSyncError: string | null = null;

  constructor(opts: VaultSessionOptions) {
    super();
    this.userId = opts.userId;
    this.cloudNodeUrl = opts.cloudNodeUrl;
    this.links = opts.links;
    this.platform = new MemoryPlatform(opts);
    this.service = new CloudService(this.platform);
    this.platform.on('applied', (keys: string[]) => this.emit('applied', keys));
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.service.init();
        if (this.service.isLinked()) {
          this.startTimer();
          await this.check();
        }
      })();
    }
    return this.initPromise;
  }

  isLinked(): boolean {
    return this.service.isLinked();
  }

  isLoaded(): boolean {
    return this.hydrated;
  }

  hasData(): boolean {
    return this.service.status().vaultEntries > 0;
  }

  linkProblem(): string | null {
    return this.broken;
  }

  syncState(): {okAt: number; error: string | null} {
    return {okAt: this.lastSyncOkAt, error: this.broken ?? this.lastSyncError};
  }

  isLinking(): boolean {
    return this.linking;
  }

  async check(): Promise<boolean> {
    if (!this.service.isLinked() || this.broken) return false;
    this.lastCheckAt = Date.now();
    try {
      await this.runSync('checking');
      this.hydrated = true;
      this.lastSyncOkAt = Date.now();
      this.lastSyncError = null;
      return true;
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      this.lastSyncError = text;
      if ((isDeadLink(e) && this.service.isLinked()) || isRemovedDevice(e)) {
        this.broken = text;
        this.stopTimer();
        this.service['clearTimers']();
        log.warn('Vault link for user %s no longer works (%s); checks stopped until they unlink and link again.', this.userId, text);
      } else {
        log.warn('Vault check for user %s failed: %s', this.userId, text);
      }
      return false;
    }
  }

  async freshen(maxAgeMs = FRESH_MS): Promise<void> {
    await this.init();
    if (!this.service.isLinked()) return;
    if (!this.broken && Date.now() - this.lastCheckAt > maxAgeMs) await this.check();
    this.assertUsable();
  }

  private assertUsable(): void {
    if (!this.service.isLinked()) throw new CloudError(0, 'not linked', 'No vault is linked.');
    if (this.broken) throw new CloudError(0, 'link broken', LINK_BROKEN_TEXT);
    if (!this.hydrated) throw new CloudError(0, 'not loaded', 'The vault could not be read from the Plural Star cloud yet. Try again in a minute.');
  }

  write(values: Record<string, unknown>): Record<string, string> {
    this.assertUsable();
    if (!this.hasData()) throw new CloudError(0, 'no data', NO_DATA_TEXT);
    const raw: Record<string, string> = {};
    for (const k of Object.keys(values)) {
      if (k.startsWith('ps:media:')) throw new Error(`Plural Starbot does not write media (${k}).`);
      raw[k] = JSON.stringify(values[k]);
    }
    this.platform.setLocal(raw);
    this.service.schedulePush(0);
    return raw;
  }

  async writeAndPush(values: Record<string, unknown>, timeoutMs = SETTLE_TIMEOUT_MS): Promise<PushResult> {
    const raw = this.write(values);
    await this.settle(timeoutMs);
    const known = this.platform.link()?.known || {};
    const replaced: string[] = [];
    const saved: string[] = [];
    for (const [k, v] of Object.entries(raw)) {
      if (this.platform.get(k) !== v) replaced.push(k);
      else if (known[k]?.hash === (await this.service['keyHash'](k, v))) saved.push(k);
    }
    if (replaced.length) return {ok: false, reason: 'conflict', replaced, saved};
    if (saved.length === Object.keys(raw).length) return {ok: true};
    const pending = !!(this.service['queued'] || this.service['syncing']);
    return {ok: false, reason: pending ? 'pending' : 'failed', error: this.service.status().lastError};
  }

  async linkWithPassword(password: string, onStage?: (stage: LinkStage) => void | Promise<void>): Promise<LinkResult> {
    await this.init();
    if (this.service.isLinked()) throw new CloudError(0, 'already linked', 'A vault is already linked to this Discord account.');
    if (this.linking) throw new CloudError(0, 'link in progress', 'Linking is already in progress.');
    this.linking = true;
    try {
      if (linkSlots.busy()) await onStage?.('queued');
      return await linkSlots.run(() => this.linkExisting(password, onStage));
    } finally {
      this.linking = false;
    }
  }

  private async linkExisting(password: string, onStage?: (stage: LinkStage) => void | Promise<void>): Promise<LinkResult> {
    await onStage?.('deriving');
    const shown = new Set<LinkStage>();
    let staged: Promise<void> = Promise.resolve();
    const report = (stage: LinkStage): void => {
      if (shown.has(stage)) return;
      shown.add(stage);
      staged = staged
        .then(async () => {
          await onStage?.(stage);
        })
        .catch(() => {});
    };
    const off = this.service.subscribe(s => {
      if (s.phase === 'deriving' && s.progress >= 1) report('looking-up');
      else if (s.phase === 'checking') report('opening');
    });
    let outcome;
    try {
      outcome = await this.service.linkWithPassword(password, true);
    } catch (e) {
      if (e instanceof VaultCreateRefused) return {kind: 'not-found'};
      throw e;
    } finally {
      off();
      await staged;
    }
    if (outcome.kind !== 'existing') {
      await this.service.unlink();
      this.links.save(this.userId, null);
      return {kind: 'not-found'};
    }

    await onStage?.('importing');
    const pending = this.service['pendingCreds'];
    try {
      await this.service.importExisting(true, true);
    } catch (e) {
      this.service.cancelPendingLink();
      if (pending) await this.removeStaleDevice(pending, e, pending.deviceKey);
      throw e;
    }
    this.lastCheckAt = Date.now();
    this.hydrated = true;
    this.broken = null;
    this.lastSyncOkAt = Date.now();
    this.lastSyncError = null;
    this.startTimer();
    return {kind: 'linked', systemName: this.system()?.name || '', memberCount: rosterCount(this.members())};
  }

  private async removeStaleDevice(creds: {lookupId: string; authSecret: string}, cause: unknown, deviceKey?: string): Promise<void> {
    if (cause instanceof CloudError && (cause.code === 'bad password' || cause.status === 401 || cause.status === 404)) return;
    try {
      const api = new CloudApi(this.cloudNodeUrl, '', this.platform.transport);
      const sub = await this.platform.deviceSubId();
      await api.unlinkDevice({lookupId: creds.lookupId, authSecret: creds.authSecret, deviceId: sub, deviceKey}, sub);
    } catch (e) {
      log.warn('Could not remove the Plural Starbot device after a failed link for user %s: %s', this.userId, e instanceof Error ? e.message : String(e));
    }
  }

  async unlink(): Promise<UnlinkResult> {
    await this.init();
    this.stopTimer();
    this.hydrated = false;
    this.broken = null;
    this.lastSyncOkAt = 0;
    this.lastSyncError = null;
    if (!this.service.isLinked()) {
      this.links.save(this.userId, null);
      this.platform.clear();
      return {deviceRemoved: false, error: 'No vault was linked.'};
    }
    await this.settle();
    let failure: string | null = null;
    let armed = false;
    const off = this.service.subscribe(s => {
      if (armed && s.linked && s.lastError) failure = s.lastError;
    });
    armed = true;
    try {
      await this.service.unlink();
    } finally {
      off();
    }
    this.links.save(this.userId, null);
    this.platform.clear();
    return {deviceRemoved: failure === null, error: failure};
  }

  stop(): void {
    this.stopTimer();
  }

  async settle(timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
    await new Promise<void>(r => setTimeout(r, 0));
    const pending = this.service['queued'] || this.service['syncing'];
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending.catch(() => {}), new Promise<void>(r => (timer = setTimeout(r, timeoutMs)))]);
    if (timer) clearTimeout(timer);
  }

  private json<T>(key: string): T | undefined {
    const raw = this.platform.get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private list<T>(key: string): T[] {
    const v = this.json<unknown>(key);
    return Array.isArray(v) ? (v as T[]) : [];
  }

  system(): SystemInfo | null {
    const v = this.json<SystemInfo>(VAULT_KEYS.system);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }

  members(): Member[] {
    return this.list<Member>(VAULT_KEYS.members);
  }

  front(): FrontState | null {
    const v = this.json<FrontState>(VAULT_KEYS.front);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }

  history(): HistoryEntry[] {
    return this.list<HistoryEntry>(VAULT_KEYS.history);
  }

  groups(): MemberGroup[] {
    return this.list<MemberGroup>(VAULT_KEYS.groups);
  }

  customFieldDefs(): CustomFieldDef[] {
    return this.list<CustomFieldDef>(VAULT_KEYS.customFieldDefs);
  }

  settings(): AppSettings | null {
    const v = this.json<AppSettings>(VAULT_KEYS.settings);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }

  mediaObjectId(key: string): string | undefined {
    return this.platform.link()?.known[key]?.id;
  }

  mediaKeyForObjectId(id: string): string | undefined {
    const known = this.platform.link()?.known;
    if (!known) return undefined;
    for (const k in known) {
      if (known[k].id === id && k.startsWith('ps:media:')) return k;
    }
    return undefined;
  }

  mediaDataUri(key: string): string | undefined {
    const v = this.platform.get(key);
    return v !== undefined && v.startsWith('data:') ? v : undefined;
  }

  phase(): CloudPhase {
    return this.service.status().phase;
  }

  private runSync(phase: CloudPhase): Promise<void> {
    return this.service['runSync'](phase);
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.service.isLinked()) void this.check();
    }, CHECK_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
