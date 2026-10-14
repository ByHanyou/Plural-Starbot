// Descriptions as Discord markdown. Pure: no Discord imports.
// A description is HTML (the app's rich text editor) or markdown (older text, imports); the app tells
// them apart with isHTML (src/components/MarkdownRenderer.tsx), and so does this file.

import {truncateUnits} from '../proxy/text';

/** Resolves a member id from a description mention to the name to show, or undefined to keep the stored one. */
export type MentionNames = (memberId: string) => string | undefined;

const MENTION_RE = /@\[([^\]]+)\]\(member:([a-zA-Z0-9_-]+)\)/g;
const URL_RE = /https?:\/\/[^\s<]+/g;

/** The app's isHTML. */
export const isHTML = (text: string): boolean => {
  const t = text.trim();
  if (/^<(?:img|br)\b/i.test(t)) {
    return /<(?:p|h[1-6]|div|ul|ol|blockquote|pre|hr|strong|em|b|i|s|del|code|a)\b/i.test(t);
  }
  return /<(?:p|h[1-6]|div|ul|ol|blockquote|pre|hr|strong|em|b|i|s|del|code|a)\b/i.test(t);
};

const NAMED_ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
      return cp === 0xa0 ? ' ' : String.fromCodePoint(cp);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });

const escapeRun = (s: string): string => s.replace(/[\\*_~`[\]<>#-]/g, '\\$&').replace(/(\d)\.(?=\s|$)/g, '$1\\.');

/**
 * Escapes Discord markdown in plain text so it shows literally (as the app shows it).
 * URLs are left alone so Discord still links them; "||spoiler||" is left working, as in the app.
 */
export const escapeText = (s: string): string => {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    out += escapeRun(s.slice(last, at)) + m[0];
    last = at + m[0].length;
  }
  return out + escapeRun(s.slice(last));
};

/** "@[Name](member:id)" -> "@Name" (the member's current name when known, as the app shows it). Other text through `plain`. */
const withMentions = (text: string, names: MentionNames | undefined, plain: (s: string) => string): string => {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const at = m.index ?? 0;
    out += plain(text.slice(last, at));
    out += '@' + escapeText(names?.(m[2]) || m[1]);
    last = at + m[0].length;
  }
  return out + plain(text.slice(last));
};

// ---- HTML ---------------------------------------------------------------------

interface El {
  tag: string;
  attrs: string;
  children: Node[];
}
type Node = string | El;

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'wbr', 'col', 'area', 'base', 'source', 'track', 'embed', 'param']);
const DROP = new Set(['script', 'style', 'head', 'title', 'template']);
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li', 'hr', 'table', 'tr', 'section', 'article', 'header', 'footer']);
const MARK: Record<string, string> = {b: '**', strong: '**', i: '*', em: '*', u: '__', ins: '__', s: '~~', strike: '~~', del: '~~'};

/** A tolerant tag tree: stray closing tags are ignored, unclosed tags close at the end. */
const parseHtml = (html: string): El => {
  const root: El = {tag: '#root', attrs: '', children: []};
  const stack: El[] = [root];
  const top = (): El => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  for (const m of html.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) top().children.push(html.slice(last, at));
    last = at + m[0].length;
    if (m[0].startsWith('<!--')) continue;
    const tag = m[1].toLowerCase();
    if (m[0][1] === '/') {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const el: El = {tag, attrs: m[2] || '', children: []};
    top().children.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(el.attrs)) stack.push(el);
  }
  if (last < html.length) top().children.push(html.slice(last));
  return root;
};

/** Soft break: a block boundary. Runs of soft breaks and hard line breaks are resolved in finish(). */
const SOFT = String.fromCharCode(0);
const BREAKS = new RegExp(`[${SOFT}\\n]+`, 'g');
const EDGE_BREAKS = new RegExp(`^[${SOFT}\\n]+|[${SOFT}\\n]+$`, 'g');

interface Ctx {
  names?: MentionNames;
  lists: {ordered: boolean; n: number}[];
}

const attr = (attrs: string, name: string): string => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return decodeEntities(m ? (m[1] ?? m[2] ?? m[3] ?? '') : '').trim();
};

/** Puts `mark` around each line's text, keeping surrounding whitespace outside (Discord ignores "** x**"). */
const wrapLines = (s: string, mark: string): string =>
  s.replace(/[^\n\u0000]+/g, piece => {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece)!;
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : piece;
  });

const linkTarget = (href: string): string | null => {
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return null;
  return href.replace(/[\s()<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
};

const renderChildren = (el: El, ctx: Ctx): string => el.children.map(c => renderNode(c, ctx)).join('');

const renderNode = (node: Node, ctx: Ctx): string => {
  if (typeof node === 'string') return withMentions(decodeEntities(node), ctx.names, escapeText);
  const tag = node.tag;
  if (DROP.has(tag)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'img') return '';
  if (tag === 'hr') return SOFT;
  if (tag === 'td' || tag === 'th') return ' ' + renderChildren(node, ctx) + ' ';
  const mark = MARK[tag];
  if (mark) return wrapLines(renderChildren(node, ctx), mark);
  if (tag === 'a') {
    const inner = renderChildren(node, ctx).replace(BREAKS, ' ').trim();
    const href = attr(node.attrs, 'href');
    const target = linkTarget(href);
    if (!target) return inner;
    if (!inner || inner === escapeText(href) || inner === href) return target;
    return `[${inner}](${target})`;
  }
  if (tag === 'ul' || tag === 'ol') {
    ctx.lists.push({ordered: tag === 'ol', n: 0});
    const body = renderChildren(node, ctx);
    ctx.lists.pop();
    return SOFT + body + SOFT;
  }
  if (tag === 'li') {
    const list = ctx.lists[ctx.lists.length - 1];
    const depth = Math.max(0, ctx.lists.length - 1);
    let bullet = '• ';
    if (list?.ordered) bullet = `${++list.n}. `;
    return SOFT + '  '.repeat(depth) + bullet + renderChildren(node, ctx).replace(EDGE_BREAKS, '') + SOFT;
  }
  if (BLOCK.has(tag)) return SOFT + renderChildren(node, ctx) + SOFT;
  return renderChildren(node, ctx);
};

/** Resolves break runs: hard breaks count, block boundaries add one line; at most one blank line in a row. */
const finish = (s: string): string =>
  s
    .replace(EDGE_BREAKS, '')
    .replace(BREAKS, run => {
      const hard = run.split('\n').length - 1;
      const soft = run.length - hard;
      const lines = soft > 0 ? Math.max(1, hard + 1) : hard;
      return '\n'.repeat(Math.min(2, lines));
    })
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();

/** HTML from the rich text editor as Discord markdown: bold, italic, underline, strike, links, line breaks and lists; other tags dropped. */
export const htmlToMarkdown = (html: string, names?: MentionNames): string =>
  finish(renderNode(parseHtml(html.replace(/[\r\n]/g, '')), {names, lists: []}));

// ---- markdown -------------------------------------------------------------------

/** The app's markdown is close to Discord's: mentions become names, images are dropped, the rest is kept. */
export const markdownToDiscord = (text: string, names?: MentionNames): string =>
  withMentions(
    text
      .replace(/<img\s[^>]*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/\r\n?|\u2028|\u2029/g, '\n')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ''),
    names,
    s => s,
  )
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** A description (HTML or markdown) as Discord markdown. */
export const descriptionToDiscord = (text: unknown, names?: MentionNames): string => {
  if (typeof text !== 'string' || !text.trim()) return '';
  return isHTML(text) ? htmlToMarkdown(text, names) : markdownToDiscord(text, names);
};

/** At most `max` characters, ending in "…" when cut. */
export const capText = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return truncateUnits(s, max - 1).trimEnd() + '…';
};
