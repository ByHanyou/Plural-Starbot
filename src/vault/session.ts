import {EventEmitter} from 'node:events';
import {CloudApi} from '../cloud/cloudApi';
import {deriveVaultCredentials} from '../cloud/cloudCrypto';
import {CloudError, CloudPhase, CloudTransport} from '../cloud/cloudTypes';
import {CloudService} from '../cloud/cloudVault';
import {log} from '../log';
import {LinkStore, MemoryPlatform} from './platform';
import {linkSlots} from './throttle';
import {VaultCreateRefused} from './transport';
import {AppSettings, CustomFieldDef, FrontState, HistoryEntry, Member, MemberGroup, SystemInfo, VAULT_KEYS} from './types';

/** How often a linked session runs the engine's check. */
export const CHECK_INTERVAL_MS = 2 * 60 * 1000;
/** freshen() checks again when the last check started longer ago than this. */
export const FRESH_MS = 30 * 1000;
const SETTLE_TIMEOUT_MS = 20000;

export type LinkStage = 'queued' | 'deriving' | 'looking-up' | 'opening' | 'importing';

export type LinkResult = {kind: 'not-found'} | {kind: 'linked'; systemName: string; memberCount: number};

export interface UnlinkResult {
  /** False when removing the device from the vault failed (the link is gone from the bot either way). */
  deviceRemoved: boolean;
  error: string | null;
}

/** Outcome of writeAndPush(). */
export type PushResult =
  | {ok: true}
  /**
   * Another device had changed some of the written keys (`replaced`); its version of those replaced
   * the bot's change in memory. The vault resolves each key on its own: `saved` lists the written
   * keys it now holds as the bot wrote them.
   */
  | {ok: false; reason: 'conflict'; replaced: string[]; saved: string[]}
  /** The push failed (error) or had not finished (pending); the change is in memory only and is retried. */
  | {ok: false; reason: 'failed' | 'pending'; error: string | null};

/** Text shown to a user whose stored link no longer opens their vault. */
export const LINK_BROKEN_TEXT =
  'Plural Starbot can no longer open your vault: it was deleted, or its cloud password was changed. ' +
  'Run `/unlink` and then `/link` again in a direct message with me.';

/** The node says the stored credentials are dead: the vault is gone or its password (and so its auth secret) changed. */
const isDeadLink = (e: unknown): boolean =>
  e instanceof CloudError && ((e.status === 404 && e.code === 'no vault') || (e.status === 401 && e.code === 'bad auth secret'));

export interface VaultSessionOptions {
  userId: string;
  cloudNodeUrl: string;
  links: LinkStore;
  transport?: CloudTransport;
}

/** Members shown in the app's Members tab: not deleted, not archived, not custom fronts or facets. */
const rosterCount = (members: Member[]): number => members.filter(m => !m.deleted && !m.archived && !m.isCustomFront && !m.isFacet).length;

/**
 * One linked (or linkable) Discord user: a CloudService over an in-memory platform.
 * Emits 'applied' (keys: string[]) whenever vault values in memory change.
 */
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
  /** True once the whole vault is in memory: after a successful check or import. Writes need it. */
  private hydrated = false;
  /** Set when the node rejected the stored credentials ('no vault' / 'bad auth secret'); checks stop. */
  private broken: string | null = null;

  constructor(opts: VaultSessionOptions) {
    super();
    this.userId = opts.userId;
    this.cloudNodeUrl = opts.cloudNodeUrl;
    this.links = opts.links;
    this.platform = new MemoryPlatform(opts);
    this.service = new CloudService(this.platform);
    this.platform.on('applied', (keys: string[]) => this.emit('applied', keys));
  }

  /** Loads the stored link; when linked, starts the 2-minute check and runs a first check (pulls the vault). */
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

  /** Whether the whole vault is in memory (a check or the import has succeeded since startup). */
  isLoaded(): boolean {
    return this.hydrated;
  }

  /** Why the stored link stopped working (the node's error), or null while it works. */
  linkProblem(): string | null {
    return this.broken;
  }

  /** Whether a /link attempt is running on this session. */
  isLinking(): boolean {
    return this.linking;
  }

  /**
   * Runs the engine's runSync('checking') now. Returns false (and logs) when it failed.
   * When the node rejects the stored credentials the session stops checking for good (see linkProblem()).
   */
  async check(): Promise<boolean> {
    if (!this.service.isLinked() || this.broken) return false;
    this.lastCheckAt = Date.now();
    try {
      await this.runSync('checking');
      this.hydrated = true;
      return true;
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (isDeadLink(e) && this.service.isLinked()) {
        this.broken = text;
        this.stopTimer();
        // The engine armed its own retry when the sync failed; drop it and any queued push.
        this.service['clearTimers']();
        log.warn('Vault link for user %s no longer works (%s); checks stopped until they unlink and link again.', this.userId, text);
      } else {
        log.warn('Vault check for user %s failed: %s', this.userId, text);
      }
      return false;
    }
  }

  /**
   * Checks the vault first when the last check started more than 30 s ago.
   * Call before profile/front commands (after deferring the interaction: a check can take a few seconds).
   * Throws CloudError 'link broken' when the stored link no longer opens the vault, and
   * 'not loaded' when the vault has not been read since startup (the node could not be reached).
   */
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

  /**
   * Writes vault values (JSON-serialised like the app's store.set) into memory and pushes them now.
   * Media keys are refused: the bot never uploads images. Refused unless the whole vault is in
   * memory, so a value computed from an empty memory can never replace what the vault holds.
   * Returns the raw values written.
   */
  write(values: Record<string, unknown>): Record<string, string> {
    this.assertUsable();
    const raw: Record<string, string> = {};
    for (const k of Object.keys(values)) {
      if (k.startsWith('ps:media:')) throw new Error(`Plural Starbot does not write media (${k}).`);
      raw[k] = JSON.stringify(values[k]);
    }
    this.platform.setLocal(raw);
    this.service.schedulePush(0);
    return raw;
  }

  /**
   * write(), then waits (bounded) for the push and reports, key by key, whether the vault now holds
   * the values. A failed push stays in memory and is retried by the engine, but is lost if the bot
   * restarts first.
   */
  async writeAndPush(values: Record<string, unknown>, timeoutMs = SETTLE_TIMEOUT_MS): Promise<PushResult> {
    const raw = this.write(values);
    await this.settle(timeoutMs);
    const known = this.platform.link()?.known || {};
    const replaced: string[] = [];
    const saved: string[] = [];
    for (const [k, v] of Object.entries(raw)) {
      if (this.platform.get(k) !== v) replaced.push(k);
      else if (known[k]?.hash === this.service['keyHash'](k, v)) saved.push(k);
    }
    if (replaced.length) return {ok: false, reason: 'conflict', replaced, saved};
    if (saved.length === Object.keys(raw).length) return {ok: true};
    const pending = !!(this.service['queued'] || this.service['syncing']);
    return {ok: false, reason: pending ? 'pending' : 'failed', error: this.service.status().lastError};
  }

  // ---- linking ---------------------------------------------------------------

  /**
   * Links an existing vault by password. Never creates one: derives the credentials, asks the node
   * whether the vault exists, and only then lets the engine link (linkWithPassword -> 'existing')
   * and import it. A wrong password on an existing vault throws the engine's 'bad password' error.
   */
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

  /** The link itself, inside a link slot (at most two run at once: each derives the key twice). */
  private async linkExisting(password: string, onStage?: (stage: LinkStage) => void | Promise<void>): Promise<LinkResult> {
    await onStage?.('deriving');
    const creds = await deriveVaultCredentials(password);
    creds.kek.fill(0);
    await onStage?.('looking-up');
    const exists = await new CloudApi(this.cloudNodeUrl, '', this.platform.transport).lookup(creds.lookupId);
    if (!exists) return {kind: 'not-found'};

    await onStage?.('opening');
    let outcome;
    try {
      outcome = await this.service.linkWithPassword(password, true);
    } catch (e) {
      if (e instanceof VaultCreateRefused) return {kind: 'not-found'};
      throw e;
    }
    if (outcome.kind !== 'existing') {
      // Unreachable while the transport refuses vault creation; never keep a vault the bot made.
      await this.service.unlink();
      this.links.save(this.userId, null);
      return {kind: 'not-found'};
    }

    await onStage?.('importing');
    try {
      await this.service.importExisting(true);
    } catch (e) {
      this.service.cancelPendingLink();
      await this.removeStaleDevice(creds, e);
      throw e;
    }
    this.lastCheckAt = Date.now();
    this.hydrated = true;
    this.broken = null;
    this.startTimer();
    return {kind: 'linked', systemName: this.system()?.name || '', memberCount: rosterCount(this.members())};
  }

  /**
   * After a failed import the engine has dropped the link, but it may already have registered the bot
   * as a device on the vault. Removes that device again (best effort), so no stale "Plural Starbot"
   * stays listed. Skipped when the vault refused the credentials, which happens before registering.
   */
  private async removeStaleDevice(creds: {lookupId: string; authSecret: string}, cause: unknown): Promise<void> {
    if (cause instanceof CloudError && (cause.code === 'bad password' || cause.status === 401 || cause.status === 404)) return;
    try {
      const api = new CloudApi(this.cloudNodeUrl, '', this.platform.transport);
      await api.unlinkDevice({lookupId: creds.lookupId, authSecret: creds.authSecret}, await this.platform.deviceSubId());
    } catch (e) {
      log.warn('Could not remove the Plural Starbot device after a failed link for user %s: %s', this.userId, e instanceof Error ? e.message : String(e));
    }
  }

  /** Removes the bot's device from the vault and deletes the stored link and the in-memory vault. */
  async unlink(): Promise<UnlinkResult> {
    await this.init();
    this.stopTimer();
    this.hydrated = false;
    this.broken = null;
    if (!this.service.isLinked()) {
      this.links.save(this.userId, null);
      this.platform.clear();
      return {deviceRemoved: false, error: 'No vault was linked.'};
    }
    await this.settle();
    // While unlink() runs, the engine only emits a still-linked status when removing the device failed.
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

  /** Stops the periodic check (shutdown, or the session is dropped). */
  stop(): void {
    this.stopTimer();
  }

  /** Waits (bounded) for an in-flight or queued engine sync to finish, including a push scheduled with schedulePush(0). */
  async settle(timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
    await new Promise<void>(r => setTimeout(r, 0));
    const pending = this.service['queued'] || this.service['syncing'];
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending.catch(() => {}), new Promise<void>(r => (timer = setTimeout(r, timeoutMs)))]);
    if (timer) clearTimeout(timer);
  }

  // ---- typed accessors (vault contents in memory) ---------------------------

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

  /** Every member record in ps:members, including deleted, archived and private ones. */
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

  /** The vault object id of a key (link.known[key].id), e.g. for ps:media:av:<memberId>. */
  mediaObjectId(key: string): string | undefined {
    return this.platform.link()?.known[key]?.id;
  }

  /** The media key whose vault object id is `id`, if this session holds it. */
  mediaKeyForObjectId(id: string): string | undefined {
    const known = this.platform.link()?.known;
    if (!known) return undefined;
    for (const k in known) {
      if (known[k].id === id && k.startsWith('ps:media:')) return k;
    }
    return undefined;
  }

  /** The data URI held for a media key, if any. */
  mediaDataUri(key: string): string | undefined {
    const v = this.platform.get(key);
    return v !== undefined && v.startsWith('data:') ? v : undefined;
  }

  phase(): CloudPhase {
    return this.service.status().phase;
  }

  // ---- internals -------------------------------------------------------------

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
