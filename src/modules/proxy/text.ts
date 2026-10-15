// Pure text helpers for proxying: message splitting, webhook names, reply quotes, log footer,
// allowed mentions and the attachment budget. No Discord or database imports.

export const MESSAGE_LIMIT = 2000;
export const WEBHOOK_NAME_LIMIT = 80;
const MIB = 1024 * 1024;

/** Discord's upload limit in a server by boost tier (0 and 1: 10 MiB, 2: 50 MiB, 3: 100 MiB). */
export const uploadLimitBytes = (premiumTier: number): number => (premiumTier >= 3 ? 100 * MIB : premiumTier === 2 ? 50 * MIB : 10 * MIB);
/** U+200A, put inside "clyde" and "discord" so Discord accepts the name. */
const HAIR_SPACE = String.fromCharCode(0x200a);
/** U+17B5, appended to a one-character name so Discord accepts it (PluralKit's FixSingleCharacterName). */
const SINGLE_CHARACTER_PAD = String.fromCharCode(0x17b5);

/** Used when a member's display name is empty after sanitising. */
export const FALLBACK_MEMBER_NAME = 'Plural Star member';

/** Cuts a string to at most `max` UTF-16 units without splitting a surrogate pair. */
export const truncateUnits = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let cut = Math.max(0, max);
  const c = s.charCodeAt(cut - 1);
  if (cut > 0 && c >= 0xd800 && c <= 0xdbff) cut--;
  return s.slice(0, cut);
};

/** Like truncateUnits, ending with '…' when anything was cut. */
export const ellipsize = (s: string, max: number): string => (s.length <= max ? s : truncateUnits(s, max - 1) + '…');

const lastWhitespaceAtOrBefore = (s: string, end: number): number => {
  for (let k = Math.min(end, s.length - 1); k > 0; k--) if (/\s/.test(s[k])) return k;
  return -1;
};

/**
 * Splits text into pieces of at most `limit` characters, preferring line breaks, then other
 * whitespace, then a hard cut. The break character itself is dropped; empty pieces are skipped.
 */
export const splitContent = (text: string, limit = MESSAGE_LIMIT): string[] => {
  const out: string[] = [];
  const push = (piece: string): void => {
    if (piece.trim()) out.push(piece);
  };
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    let skip = 1;
    if (cut <= 0) cut = lastWhitespaceAtOrBefore(rest, limit);
    if (cut <= 0) {
      cut = truncateUnits(rest, limit).length;
      skip = 0;
    }
    push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  push(rest);
  return out;
};

/**
 * A webhook username Discord accepts: whitespace collapsed and trimmed, the substrings
 * "clyde" and "discord" broken with a hair space (as PluralKit does), at most 80 characters,
 * never empty, and a one-character name (one UTF-16 unit) padded with U+17B5 as PluralKit does.
 */
export const sanitizeWebhookName = (raw: string, fallback = FALLBACK_MEMBER_NAME): string => {
  let name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/(c)(lyde)/gi, `$1${HAIR_SPACE}$2`).replace(/(d)(iscord)/gi, `$1${HAIR_SPACE}$2`);
  name = truncateUnits(name, WEBHOOK_NAME_LIMIT).trim() || fallback;
  return name.length === 1 ? name + SINGLE_CHARACTER_PAD : name;
};

const count = (s: string, needle: string): number => s.split(needle).length - 1;

/**
 * PluralKit-style reply quote: "**[Reply to:](link)** first 100 characters…", a paperclip when the
 * replied-to message had attachments, or "(click to see attachment)" when it had no text.
 */
export const replyQuote = (content: string, hasAttachments: boolean, jumpUrl: string): string => {
  const text = content.trim();
  if (!text) return `*[(click to see attachment)](${jumpUrl})*`;
  const chars = Array.from(text);
  let msg = text;
  if (chars.length > 100) {
    msg = chars.slice(0, 100).join('');
    // Do not leave a spoiler open that the full message closes.
    if (count(msg, '||') % 2 === 1 && count(text, '||') % 2 === 0) msg += '||';
    msg += '…';
  }
  return `**[Reply to:](${jumpUrl})** ${msg}${hasAttachments ? ' 📎' : ''}`;
};

export interface LogFooterInput {
  messageId: string;
  originalId: string;
}

/**
 * The PluralKit log footer without its system and member IDs: the message IDs. The sender is a
 * clickable mention in a Sender field instead, because Discord does not render mentions in footers.
 */
export const logFooter = (o: LogFooterInput): string =>
  ellipsize(`Message ID: ${o.messageId} | Original Message ID: ${o.originalId}`, 2048);

/** The Sender field of a log entry: a clickable mention of the Discord user who sent the original message. */
export const logSender = (senderId: string): string => `<@${senderId}>`;

export type MentionKind = 'users' | 'roles' | 'everyone';

export interface AllowedMentions {
  parse: MentionKind[];
  roles?: string[];
}

/**
 * What the proxied message may ping: everything when the sender has Mention Everyone in the channel,
 * otherwise users plus only the mentioned roles that are mentionable by anyone.
 */
export const allowedMentionsFor = (content: string, canMentionEveryone: boolean, isMentionable: (roleId: string) => boolean): AllowedMentions => {
  if (canMentionEveryone) return {parse: ['users', 'roles', 'everyone']};
  const ids = [...new Set(Array.from(content.matchAll(/<@&(\d{15,25})>/g), m => m[1]))].filter(isMentionable).slice(0, 100);
  return ids.length ? {parse: ['users'], roles: ids} : {parse: ['users']};
};

export interface AttachmentInfo {
  name: string;
  size: number;
}

/** Which attachments fit in one upload (in order, total within the limit); the rest are skipped. */
export const planAttachments = (items: AttachmentInfo[], limit = uploadLimitBytes(0)): {keep: number[]; skipped: AttachmentInfo[]} => {
  const keep: number[] = [];
  const skipped: AttachmentInfo[] = [];
  let total = 0;
  items.forEach((a, i) => {
    const size = Number.isFinite(a.size) && a.size >= 0 ? a.size : Infinity;
    if (total + size > limit) {
      skipped.push(a);
      return;
    }
    keep.push(i);
    total += size;
  });
  return {keep, skipped};
};

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The note added to a proxied message for an attachment that was too large to re-upload. */
export const tooLargeNote = (a: AttachmentInfo): string =>
  `-# 📎 \`${a.name.replace(/`/g, "'")}\` (${Number.isFinite(a.size) ? megabytes(a.size) : 'unknown size'}) was too large to carry over.`;

/** A member colour ('#rrggbb' or 'rrggbb') as an embed colour, or null. */
export const embedColor = (color: unknown): number | null => {
  if (typeof color !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  return m ? parseInt(m[1], 16) : null;
};
