export const MESSAGE_LIMIT = 2000;
export const WEBHOOK_NAME_LIMIT = 80;
export const EMBED_LIMIT = {title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, total: 6000};
const MIB = 1024 * 1024;

export const uploadLimitBytes = (premiumTier: number): number => (premiumTier >= 3 ? 100 * MIB : premiumTier === 2 ? 50 * MIB : 10 * MIB);
const HAIR_SPACE = String.fromCharCode(0x200a);
const SINGLE_CHARACTER_PAD = String.fromCharCode(0x17b5);

const FALLBACK_MEMBER_NAME = 'Plural Star member';

export const truncateUnits = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let cut = Math.max(0, max);
  const c = s.charCodeAt(cut - 1);
  if (cut > 0 && c >= 0xd800 && c <= 0xdbff) cut--;
  return s.slice(0, cut);
};

export const ellipsize = (s: string, max: number): string => (s.length <= max ? s : truncateUnits(s, max - 1) + '…');

const lastWhitespaceAtOrBefore = (s: string, end: number): number => {
  for (let k = Math.min(end, s.length - 1); k > 0; k--) if (/\s/.test(s[k])) return k;
  return -1;
};

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

export const sanitizeWebhookName = (raw: string, fallback = FALLBACK_MEMBER_NAME): string => {
  let name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/(c)(lyde)/gi, `$1${HAIR_SPACE}$2`).replace(/(d)(iscord)/gi, `$1${HAIR_SPACE}$2`);
  name = truncateUnits(name, WEBHOOK_NAME_LIMIT).trim() || fallback;
  return name.length === 1 ? name + SINGLE_CHARACTER_PAD : name;
};

const count = (s: string, needle: string): number => s.split(needle).length - 1;

export const replyQuote = (content: string, hasAttachments: boolean, jumpUrl: string): string => {
  const text = content.trim();
  if (!text) return `*[(click to see attachment)](${jumpUrl})*`;
  const chars = Array.from(text);
  let msg = text;
  if (chars.length > 100) {
    msg = chars.slice(0, 100).join('');
    if (count(msg, '||') % 2 === 1 && count(text, '||') % 2 === 0) msg += '||';
    msg += '…';
  }
  return `**[Reply to:](${jumpUrl})** ${msg}${hasAttachments ? ' 📎' : ''}`;
};

export interface LogFooterInput {
  messageId: string;
  originalId: string;
}

export const logFooter = (o: LogFooterInput): string =>
  ellipsize(`Message ID: ${o.messageId} | Original Message ID: ${o.originalId}`, EMBED_LIMIT.footer);

export const logSender = (senderId: string): string => `<@${senderId}>`;

export const jumpUrl = (guildId: string | null, channelId: string, messageId: string): string =>
  `https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${messageId}`;

export type MentionKind = 'users' | 'roles' | 'everyone';

export interface AllowedMentions {
  parse: MentionKind[];
  roles?: string[];
}

export const allowedMentionsFor = (content: string, canMentionEveryone: boolean, isMentionable: (roleId: string) => boolean): AllowedMentions => {
  if (canMentionEveryone) return {parse: ['users', 'roles', 'everyone']};
  const ids = [...new Set(Array.from(content.matchAll(/<@&(\d{15,25})>/g), m => m[1]))].filter(isMentionable).slice(0, 100);
  return ids.length ? {parse: ['users'], roles: ids} : {parse: ['users']};
};

export interface AttachmentInfo {
  name: string;
  size: number;
}

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

const megabytes = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MB`;

export const tooLargeNote = (a: AttachmentInfo): string =>
  `-# 📎 \`${a.name.replace(/`/g, "'")}\` (${Number.isFinite(a.size) ? megabytes(a.size) : 'unknown size'}) was too large to carry over.`;

export const embedColor = (color: unknown): number | null => {
  if (typeof color !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  return m ? parseInt(m[1], 16) : null;
};
