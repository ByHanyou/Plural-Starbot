export class SlidingWindow {
  private readonly stamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  waitMs(): number {
    const t = this.now();
    for (let first = this.stamps[0]; first !== undefined && first <= t - this.windowMs; first = this.stamps[0]) this.stamps.shift();
    const oldest = this.stamps[0];
    return this.stamps.length < this.limit || oldest === undefined ? 0 : oldest + this.windowMs - t;
  }

  acquire(): Promise<void> {
    const turn = this.tail.then(async () => {
      for (let wait = this.waitMs(); wait > 0; wait = this.waitMs()) await new Promise<void>(r => setTimeout(r, wait));
      this.stamps.push(this.now());
    });
    this.tail = turn.catch(() => {});
    return turn;
  }
}

export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly max: number) {}

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

  retryInMs(key: string): number {
    const list = this.recent(key);
    const oldest = list[0];
    return list.length < this.limit || oldest === undefined ? 0 : oldest + this.windowMs - this.now();
  }

  note(key: string): void {
    this.attempts.set(key, [...this.recent(key), this.now()]);
  }
}

export const lookupWindow = new SlidingWindow(4, 60 * 1000);

export const linkSlots = new Semaphore(2);

export const linkAttempts = new AttemptLimiter(3, 10 * 60 * 1000);
