import type {Member} from '../../vault/types';
import {displayNameOf} from './match';
import {sanitizeWebhookName, WEBHOOK_NAME_LIMIT} from './text';

export const DEFAULT_FORMAT = '{Name}';
export const FORMAT_MAX_LENGTH = WEBHOOK_NAME_LIMIT;
export const SYS_TAG_MAX = 20;

type FormatTag = 'emoji' | 'name' | 'pronouns' | 'role' | 'systag';

const FORMAT_TAGS: readonly FormatTag[] = ['emoji', 'name', 'pronouns', 'role', 'systag'];

const TAG_RE = /\{(emoji|name|pronouns|role|sys[ _]?tag)\}/gi;

const tagOf = (raw: string): FormatTag | undefined => {
  const key = raw.toLowerCase().replace(/[ _]/g, '');
  return FORMAT_TAGS.find(t => t === key);
};

export const usesSysTag = (template: string): boolean => Array.from(template.matchAll(TAG_RE), m => tagOf(m[1])).includes('systag');

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const tagValues = (m: Member, sysTag: string): Record<FormatTag, string> => ({
  emoji: text(m.emoji),
  name: displayNameOf(m),
  pronouns: text(m.pronouns),
  role: text(m.role),
  systag: text(sysTag),
});

type Atom = {k: 'char'; c: string} | {k: 'value'; s: string} | {k: 'gap'};

const PAIRS: Record<string, string> = {'(': ')', '[': ']', '"': '"'};
const isSpace = (a: Atom): boolean => a.k === 'char' && /\s/.test(a.c);

const dropEmptyPairs = (atoms: Atom[]): Atom[] => {
  for (let changed = true; changed; ) {
    changed = false;
    let quotes = 0;
    for (let a = 0; a < atoms.length; a++) {
      const open = atoms[a];
      if (open.k !== 'char' || !(open.c in PAIRS)) continue;
      const isQuote = open.c === '"';
      if (isQuote) quotes++;
      if (isQuote && quotes % 2 === 0) continue;
      let gaps = 0;
      let b = a + 1;
      while (b < atoms.length && (atoms[b].k === 'gap' || isSpace(atoms[b]))) {
        if (atoms[b].k === 'gap') gaps++;
        b++;
      }
      const close = atoms[b];
      if (gaps && close && close.k === 'char' && close.c === PAIRS[open.c]) {
        atoms.splice(a, b - a + 1, {k: 'gap'});
        changed = true;
        break;
      }
    }
  }
  return atoms;
};

const renderProxyName = (template: string, m: Member, sysTag = ''): string => {
  const values = tagValues(m, sysTag);
  const atoms: Atom[] = [];
  const literal = (s: string): void => {
    for (const c of s) atoms.push({k: 'char', c});
  };
  let at = 0;
  for (const match of template.matchAll(TAG_RE)) {
    const start = match.index ?? 0;
    literal(template.slice(at, start));
    const tag = tagOf(match[1]);
    const value = tag ? values[tag] : '';
    atoms.push(value ? {k: 'value', s: value} : {k: 'gap'});
    at = start + match[0].length;
  }
  literal(template.slice(at));
  return dropEmptyPairs(atoms)
    .map(a => (a.k === 'char' ? a.c : a.k === 'value' ? a.s : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
};

export const proxyNameFor = (m: Member, format: string = DEFAULT_FORMAT, sysTag = ''): string =>
  sanitizeWebhookName(renderProxyName(format, m, sysTag));

export type FormatInput = {kind: 'set'; template: string} | {kind: 'reset'} | {kind: 'error'; message: string};

export const parseFormatInput = (raw: string): FormatInput => {
  const template = raw.trim();
  if (!template) return {kind: 'error', message: 'The template cannot be empty. Use `default` to go back to the default format.'};
  if (/^(default|reset)$/i.test(template)) return {kind: 'reset'};
  if (template.length > FORMAT_MAX_LENGTH) {
    return {kind: 'error', message: `A template can be at most ${FORMAT_MAX_LENGTH} characters; that one has ${template.length}.`};
  }
  return {kind: 'set', template};
};

export type SysTagInput = {kind: 'set'; sysTag: string} | {kind: 'clear'} | {kind: 'error'; message: string};

export const parseSysTagInput = (raw: string): SysTagInput => {
  const sysTag = raw.trim();
  if (!sysTag || /^clear$/i.test(sysTag)) return {kind: 'clear'};
  const length = Array.from(sysTag).length;
  if (length > SYS_TAG_MAX) return {kind: 'error', message: `A Sys Tag can be at most ${SYS_TAG_MAX} characters; that one has ${length}.`};
  return {kind: 'set', sysTag};
};

export type SettingSource = 'memberServer' | 'memberEverywhere' | 'server' | 'everywhere' | 'default';

export interface Resolved {
  value: string;
  source: SettingSource;
}

const stored = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export const resolveSetting = (server: unknown, everywhere: unknown, fallback: string): Resolved => {
  const s = stored(server);
  if (s !== null) return {value: s, source: 'server'};
  const e = stored(everywhere);
  if (e !== null) return {value: e, source: 'everywhere'};
  return {value: fallback, source: 'default'};
};

export const resolveMemberFormat = (server: unknown, everywhere: unknown, general: Resolved): Resolved => {
  const s = stored(server);
  if (s !== null) return {value: s, source: 'memberServer'};
  const e = stored(everywhere);
  if (e !== null) return {value: e, source: 'memberEverywhere'};
  return general;
};
