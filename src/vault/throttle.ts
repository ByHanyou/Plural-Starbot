// Limits on how hard the bot leans on the cloud node. The node rate-limits by address (10 recorded
// events per minute) and every request from the bot comes from the same address, so one user's link
// attempts could otherwise lock every linked user out. Pure: no Discord or engine imports.

/** At most `limit` events in any `windowMs`; acquire() waits for a free slot (callers are served in order). */
export class SlidingWindow {
  private readonly stamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until a slot is free (0 when one is free now). */
  waitMs(): number {
    const t = this.now();
    for (let first = this.stamps[0]; first !== undefined && first <= t - this.windowMs; first = this.stamps[0]) this.stamps.shift();
    const oldest = this.stamps[0];
    return this.stamps.length < this.limit || oldest === undefined ? 0 : oldest + this.windowMs - t;
  }

  /** Waits for a free slot and takes it. */
  acquire(): Promise<void> {
    const turn = this.tail.then(async () => {
      for (let wait = this.waitMs(); wait > 0; wait = this.waitMs()) await new Promise<void>(r => setTimeout(r, wait));
      this.stamps.push(this.now());
    });
    this.tail = turn.catch(() => {});
    return turn;
  }
}

/** At most `max` tasks at a time; the rest wait in order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly max: number) {}

  /** True when a task started now would have to wait. */
  busy(): boolean {
    return this.active >= this.max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>(r => this.waiting.push(r));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Per-key attempt counter: at most `limit` attempts per key in any `windowMs`. In memory only. */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const t = this.now();
    const list = (this.attempts.get(key) || []).filter(at => at > t - this.windowMs);
    if (list.length) this.attempts.set(key, list);
    else this.attempts.delete(key);
    return list;
  }

  /** Milliseconds until the key may try again (0 when it may try now). */
  retryInMs(key: string): number {
    const list = this.recent(key);
    const oldest = list[0];
    return list.length < this.limit || oldest === undefined ? 0 : oldest + this.windowMs - this.now();
  }

  /** Records an attempt. */
  note(key: string): void {
    this.attempts.set(key, [...this.recent(key), this.now()]);
  }
}

/** Vault lookups (POST /cloud/vault/lookup) across all users: each one is a rate-limited event on the node. */
export const lookupWindow = new SlidingWindow(4, 60 * 1000);

/** Linking runs Argon2 (64 MiB each) twice per attempt; at most two link attempts run at once. */
export const linkSlots = new Semaphore(2);

/** /link attempts (submitted passwords) per Discord user. */
export const linkAttempts = new AttemptLimiter(3, 10 * 60 * 1000);
