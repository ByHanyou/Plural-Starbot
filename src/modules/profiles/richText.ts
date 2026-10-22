import {truncateUnits} from '../proxy/text';
import {Block, Inline, isSafeHref, parseRichText} from '../../markdown/parse';

export type MentionNames = (memberId: string) => string | undefined;

const URL_RE = /https?:\/\/[^\s<]+/g;

const escapeRun = (s: string): string => s.replace(/[\\*_~`[\]<>#|-]/g, '\\$&').replace(/(\d)\.(?=\s|$)/g, '$1\\.');

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

const wrapLines = (s: string, mark: string): string =>
  s.replace(/[^\n]+/g, piece => {
    const body = piece.trim();
    if (!body) return piece;
    const lead = piece.length - piece.trimStart().length;
    return piece.slice(0, lead) + mark + body + mark + piece.slice(lead + body.length);
  });

const linkTarget = (href: string): string | null => {
  if (!isSafeHref(href)) return null;
  return href.trim().replace(/[\s()<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
};

const oneLine = (s: string): string => s.replace(/\n+/g, ' ').trim();

const inlineToDiscord = (nodes: Inline[], names?: MentionNames): string =>
  nodes.map(n => {
    switch (n.kind) {
      case 'text': return escapeText(n.text);
      case 'break': return '\n';
      case 'mention': return '@' + escapeText(names?.(n.memberId) || n.name);
      case 'code': return n.text.includes('`') ? escapeText(n.text) : '`' + n.text + '`';
      case 'bold': return wrapLines(inlineToDiscord(n.children, names), '**');
      case 'italic': return wrapLines(inlineToDiscord(n.children, names), '*');
      case 'boldItalic': return wrapLines(inlineToDiscord(n.children, names), '***');
      case 'underline': return wrapLines(inlineToDiscord(n.children, names), '__');
      case 'strike': return wrapLines(inlineToDiscord(n.children, names), '~~');
      case 'spoiler': return wrapLines(inlineToDiscord(n.children, names), '||');
      case 'image': return '';
      case 'link': {
        const inner = oneLine(inlineToDiscord(n.children, names));
        const target = linkTarget(n.href);
        if (!target) return inner;
        if (!inner || inner === escapeText(n.href) || inner === n.href) return target;
        return `[${inner}](${target})`;
      }
    }
  }).join('');

const blockToDiscord = (b: Block, names?: MentionNames): string => {
  switch (b.kind) {
    case 'paragraph': return inlineToDiscord(b.children, names);
    case 'heading': return '#'.repeat(b.level) + ' ' + oneLine(inlineToDiscord(b.children, names));
    case 'quote': return inlineToDiscord(b.children, names).split('\n').map(line => '> ' + line).join('\n');
    case 'list':
      return b.items
        .map(item => '  '.repeat(item.depth) + (item.ordered ? `${item.n}. ` : '• ') + oneLine(inlineToDiscord(item.children, names)))
        .join('\n');
    case 'code': return '```\n' + b.text.replace(/```/g, '`\u200b``') + '\n```';
    case 'aside': return b.children.map(c => blockToDiscord(c, names)).filter(Boolean).join('\n');
    case 'rule':
    case 'blank':
    case 'image':
      return '';
  }
};

const finish = (s: string): string =>
  s
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const descriptionToDiscord = (text: unknown, names?: MentionNames): string => {
  if (typeof text !== 'string' || !text.trim()) return '';
  return finish(parseRichText(text).map(b => blockToDiscord(b, names)).join('\n'));
};

export const capText = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return truncateUnits(s, max - 1).trimEnd() + '…';
};
