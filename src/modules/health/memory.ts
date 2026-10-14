// No-repeat randomness, ported from bot.py's ContentMemory and RecencyDeck.
// The rule: a nudge or fact may not be re-used within two days. When each line
// last went out is remembered per guild in SQLite (module "health", key
// "content_memory"), so the spacing survives restarts.

import {createHash} from 'node:crypto';
import {db} from '../../db';
import {log} from '../../log';
import {FACTS, NUDGES} from './content';
import {MODULE} from './settings';

export const REUSE_COOLDOWN_SECONDS = 2 * 24 * 60 * 60;
const MEMORY_KEY = 'content_memory';

/** deck key ("food|nudge") -> line key -> unix seconds the line last went out. */
export type MemoryData = Record<string, Record<string, number>>;

/** Lines are tracked by a short hash, so the store stays small and an edited line simply counts as brand new. */
export const lineKey = (text: string): string => createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** When did each line last go out. `persist` writes the whole record. */
export class ContentMemory {
  private data: MemoryData = {};

  constructor(
    raw: unknown,
    private readonly persist: (data: MemoryData) => void,
  ) {
    if (isDict(raw)) this.data = raw as MemoryData;
  }

  lastUsed(deckKey: string, text: string): number {
    const bucket = Object.hasOwn(this.data, deckKey) ? this.data[deckKey] : undefined;
    const key = lineKey(text);
    return Number(bucket && Object.hasOwn(bucket, key) ? bucket[key] : 0);
  }

  mark(deckKey: string, text: string, when: number): void {
    if (!Object.hasOwn(this.data, deckKey)) this.data[deckKey] = {};
    this.data[deckKey][lineKey(text)] = Math.trunc(when);
  }

  /** Drop records for lines that no longer exist in content.ts. */
  prune(deckKey: string, texts: readonly string[]): void {
    const keep = new Set(texts.map(lineKey));
    const bucket = Object.hasOwn(this.data, deckKey) ? this.data[deckKey] : undefined;
    if (bucket && Object.keys(bucket).length) {
      for (const k of Object.keys(bucket)) if (!keep.has(k)) delete bucket[k];
    }
  }

  /** A copy of what would be persisted. */
  snapshot(): MemoryData {
    return structuredClone(this.data);
  }

  save(): void {
    try {
      this.persist(this.data);
    } catch (e) {
      log.exception(e, "Couldn't save the content memory; spacing may reset on restart.");
    }
  }
}

/**
 * Picks a line that hasn't gone out in the last two days, preferring the ones
 * idle longest so the whole pool keeps cycling. If a schedule fires so often
 * that every line has been used inside the window (hourly pings will outrun a
 * 40-line pool), the least-recently-used line goes out: the closest anything
 * can get to the rule, and still never a back-to-back.
 */
export class RecencyDeck {
  private readonly items: string[];

  constructor(
    private readonly key: string,
    items: readonly string[],
    private readonly memory: ContentMemory,
  ) {
    this.items = [...items];
    memory.prune(key, this.items);
  }

  /** `now` is unix seconds; `random` returns [0, 1). Both are injectable for tests. */
  draw(now: number = Date.now() / 1000, random: () => number = Math.random): string {
    const used = (s: string): number => this.memory.lastUsed(this.key, s);
    const eligible = this.items.filter(s => now - used(s) >= REUSE_COOLDOWN_SECONDS);
    let pick: string;
    if (eligible.length) {
      // Shuffle first so ties (fresh installs: everything at 0) don't fall
      // back to list order, then lean on the least recently used half to keep
      // rotation pressure without going deterministic.
      for (let i = eligible.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
      }
      eligible.sort((a, b) => used(a) - used(b));
      const pool = eligible.slice(0, Math.max(1, Math.floor((eligible.length + 1) / 2)));
      pick = pool[Math.floor(random() * pool.length)];
    } else {
      if (!this.items.length) throw new RangeError('min() arg is an empty sequence');
      pick = this.items.reduce((best, s) => (used(s) < used(best) ? s : best));
    }
    this.memory.mark(this.key, pick, now);
    return pick;
  }
}

/** One deck per topic, shared by every group of the guild that uses the topic. */
export interface GuildContent {
  memory: ContentMemory;
  nudgeDecks: Record<string, RecencyDeck>;
  factDecks: Record<string, RecencyDeck>;
}

export const buildDecks = (memory: ContentMemory): GuildContent => {
  const nudgeDecks: Record<string, RecencyDeck> = {};
  const factDecks: Record<string, RecencyDeck> = {};
  for (const [topic, pool] of Object.entries(NUDGES)) nudgeDecks[topic] = new RecencyDeck(`${topic}|nudge`, pool, memory);
  for (const [topic, pool] of Object.entries(FACTS)) factDecks[topic] = new RecencyDeck(`${topic}|fact`, pool, memory);
  return {memory, nudgeDecks, factDecks};
};

const guildContent = new Map<string, GuildContent>();

/** The guild's decks, loading its content memory from the database on first use. */
export const contentFor = (guildId: string): GuildContent => {
  let c = guildContent.get(guildId);
  if (!c) {
    const raw = db().getGuildSetting(guildId, MODULE, MEMORY_KEY);
    const memory = new ContentMemory(raw, data => db().setGuildSetting(guildId, MODULE, MEMORY_KEY, data));
    c = buildDecks(memory);
    guildContent.set(guildId, c);
  }
  return c;
};

export const dropContent = (guildId: string): void => {
  guildContent.delete(guildId);
};
