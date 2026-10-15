// Proxy name format (/proxy format) and Sys Tag (/proxy systag): the template filled from the member's
// profile, input checks and which stored value applies. No Discord or database imports.
import type {Member} from '../../vault/types';
import {displayNameOf} from './match';
import {sanitizeWebhookName, WEBHOOK_NAME_LIMIT} from './text';

/** The format when none is set: the member's name, as proxying has always shown it. */
export const DEFAULT_FORMAT = '{Name}';
/** Longest template, in UTF-16 units as sanitizeWebhookName counts the webhook name. */
export const FORMAT_MAX_LENGTH = WEBHOOK_NAME_LIMIT;
/** Longest Sys Tag, in code points. */
export const SYS_TAG_MAX = 20;

export type FormatTag = 'emoji' | 'name' | 'pronouns' | 'role' | 'systag';

/** {Emoji} {Name} {Pronouns} {Role} {Sys Tag} in any case; Sys Tag also as SysTag or Sys_Tag. */
const TAG_RE = /\{(emoji|name|pronouns|role|sys[ _]?tag)\}/gi;

const tagOf = (raw: string): FormatTag => raw.toLowerCase().replace(/[ _]/g, '') as FormatTag;

/** Whether a template uses {Sys Tag}. */
export const usesSysTag = (template: string): boolean => Array.from(template.matchAll(TAG_RE), m => tagOf(m[1])).includes('systag');

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** What each tag is filled with: the member's profile fields (trimmed) and the user's Sys Tag. */
export const tagValues = (m: Member, sysTag: string): Record<FormatTag, string> => ({
  emoji: text(m.emoji),
  name: displayNameOf(m),
  pronouns: text(m.pronouns),
  role: text(m.role),
  systag: text(sysTag),
});

/** A literal character of the template, a filled tag, or an empty tag (or a bracket pair that held only empty tags). */
type Atom = {k: 'char'; c: string} | {k: 'value'; s: string} | {k: 'gap'};

const PAIRS: Record<string, string> = {'(': ')', '[': ']', '"': '"'};
const isSpace = (a: Atom): boolean => a.k === 'char' && /\s/.test(a.c);

/**
 * Replaces each literal "()", "[]" or "" pair that holds nothing but empty tags (and whitespace) with an
 * empty tag, innermost first, so an enclosing pair that is left empty goes too. Quotes pair up in order
 * (first with second, third with fourth...). Brackets inside filled values are never paired.
 */
const dropEmptyPairs = (atoms: Atom[]): Atom[] => {
  for (let changed = true; changed; ) {
    changed = false;
    let quotes = 0;
    for (let a = 0; a < atoms.length; a++) {
      const open = atoms[a];
      if (open.k !== 'char' || !(open.c in PAIRS)) continue;
      const isQuote = open.c === '"';
      if (isQuote) quotes++;
      // An odd quote opens a pair; an even one closes the pair before it.
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

/**
 * Fills a format template. Tags with an empty value are removed together with a "()", "[]" or "" pair
 * that held only them; whitespace is then collapsed to single spaces and trimmed. Text that is not a
 * tag is kept as written. May return '' (sanitizeWebhookName then falls back).
 */
export const renderProxyName = (template: string, m: Member, sysTag = ''): string => {
  const values = tagValues(m, sysTag);
  const atoms: Atom[] = [];
  const literal = (s: string): void => {
    for (const c of s) atoms.push({k: 'char', c});
  };
  let at = 0;
  for (const match of template.matchAll(TAG_RE)) {
    const start = match.index ?? 0;
    literal(template.slice(at, start));
    const value = values[tagOf(match[1])];
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

/** The webhook username for a member under a format and Sys Tag (sanitizeWebhookName: 80-character clip, never empty). */
export const proxyNameFor = (m: Member, format: string = DEFAULT_FORMAT, sysTag = ''): string =>
  sanitizeWebhookName(renderProxyName(format, m, sysTag));

export type FormatInput = {kind: 'set'; template: string} | {kind: 'reset'} | {kind: 'error'; message: string};

/** A /proxy format template as typed: trimmed; "default" or "reset" (any case) clears it; at most 80 characters. */
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

/** A /proxy systag text as typed: trimmed; empty or "clear" (any case) clears it; at most 20 code points. */
export const parseSysTagInput = (raw: string): SysTagInput => {
  const sysTag = raw.trim();
  if (!sysTag || /^clear$/i.test(sysTag)) return {kind: 'clear'};
  const length = Array.from(sysTag).length;
  if (length > SYS_TAG_MAX) return {kind: 'error', message: `A Sys Tag can be at most ${SYS_TAG_MAX} characters; that one has ${length}.`};
  return {kind: 'set', sysTag};
};

/** Where an effective value comes from: this server's override, the user's global setting, or the built-in default. */
export type SettingSource = 'server' | 'everywhere' | 'default';

export interface Resolved {
  value: string;
  source: SettingSource;
}

const stored = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The guild override when set, else the global value when set, else the built-in default. */
export const resolveSetting = (server: unknown, everywhere: unknown, fallback: string): Resolved => {
  const s = stored(server);
  if (s !== null) return {value: s, source: 'server'};
  const e = stored(everywhere);
  if (e !== null) return {value: e, source: 'everywhere'};
  return {value: fallback, source: 'default'};
};
