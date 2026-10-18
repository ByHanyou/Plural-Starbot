import {createHash} from 'node:crypto';
import {db} from '../../db';
import {log} from '../../log';
import {FACTS, NUDGES} from './content';
import {MODULE} from './settings';

export const REUSE_COOLDOWN_SECONDS = 2 * 24 * 60 * 60;
const MEMORY_KEY = 'content_memory';

export type MemoryData = Record<string, Record<string, number>>;

export const lineKey = (text: string): string => createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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

  prune(deckKey: string, texts: readonly string[]): void {
    const keep = new Set(texts.map(lineKey));
    const bucket = Object.hasOwn(this.data, deckKey) ? this.data[deckKey] : undefined;
    if (bucket && Object.keys(bucket).length) {
      for (const k of Object.keys(bucket)) if (!keep.has(k)) delete bucket[k];
    }
  }

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

  draw(now: number = Date.now() / 1000, random: () => number = Math.random): string {
    const used = (s: string): number => this.memory.lastUsed(this.key, s);
    const eligible = this.items.filter(s => now - used(s) >= REUSE_COOLDOWN_SECONDS);
    let pick: string;
    if (eligible.length) {
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
