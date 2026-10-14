// Pure proxy decisions: emoji tag matching, the backslash escape and autoproxy. No Discord or database imports.
import type {AppSettings, FrontState, Member} from '../../vault/types';
import {orderFronters} from '../profiles/frontLogic';

export interface ProxyTag {
  prefix: string;
  suffix: string;
}

const BACKSLASH = 0x5c;

export type AutoproxySetting = {mode: 'front'} | {mode: 'member'; memberId: string};

export interface TagMatch {
  member: Member;
  tag: ProxyTag;
  /** Content to post: the inner text, or the whole message when the member keeps proxy tags. Trimmed. */
  content: string;
}

export type ProxyPlan =
  | {kind: 'none'}
  /** Started with a backslash: never proxied. `content` is the text with one backslash removed. */
  | {kind: 'escaped'; content: string}
  | {kind: 'proxy'; via: 'tag' | 'autoproxy'; member: Member; content: string};

export interface PlanInput {
  content: string;
  hasAttachments: boolean;
  /** Every member record of the sender's own vault (ps:members), unfiltered. */
  members: Member[];
  front: FrontState | null;
  autoproxy: AutoproxySetting | null;
  /** The sender's ps:settings (front sort order for autoproxy by front and for emoji tags several members share). */
  settings?: AppSettings | null;
}

/** Members that can be proxied as: present, not deleted, not archived, not a custom front. Private members are allowed (own vault only). */
export const isProxyable = (m: Member | null | undefined): m is Member =>
  !!m && typeof m === 'object' && typeof m.id === 'string' && !!m.id && !m.deleted && !m.archived && !m.isCustomFront;

/**
 * The text between the tags, or null when the message does not carry the tag.
 * Exact and case-sensitive. A message that is only the tag (spaces inside the
 * tag trimmed away by Discord) matches with empty inner text, for attachment-only messages.
 */
export const innerText = (input: string, tag: ProxyTag): string | null => {
  const {prefix, suffix} = tag;
  if (!prefix && !suffix) return null;
  if (input.length >= prefix.length + suffix.length && input.startsWith(prefix) && input.endsWith(suffix)) {
    return input.slice(prefix.length, input.length - suffix.length);
  }
  const bare = prefix.trimEnd() + suffix.trimStart();
  if (bare && input.trim() === bare) return '';
  return null;
};

/**
 * The members of the primary tier that can be proxied as, in the order the app's Front tab lists them
 * (orderFronters with the system's front sort order).
 */
const primaryFronters = (front: FrontState | null, members: Member[], settings?: AppSettings | null): Member[] => {
  const ids = front?.primary?.memberIds;
  if (!Array.isArray(ids)) return [];
  const byId = new Map<string, Member>();
  for (const m of members) if (m && typeof m.id === 'string') byId.set(m.id, m);
  const custom = Array.isArray(settings?.frontCustomOrder) ? settings.frontCustomOrder : undefined;
  const listed = orderFronters(
    ids.filter(id => byId.has(id)),
    settings?.frontSortMode,
    id => byId.get(id)?.name || '',
    custom,
  );
  const out: Member[] = [];
  for (const id of listed) {
    const m = byId.get(id);
    if (isProxyable(m)) out.push(m);
  }
  return out;
};

/**
 * The first member of the primary tier, as the app's Front tab lists it (orderFronters with the
 * system's front sort order), that can be proxied as.
 */
export const firstPrimaryFronter = (front: FrontState | null, members: Member[], settings?: AppSettings | null): Member | null =>
  primaryFronters(front, members, settings)[0] ?? null;

/** A member's emoji proxy tag: the whole profile Emoji field, trimmed; '' when there is none. */
export const emojiTagOf = (m: Member): string => (typeof m.emoji === 'string' ? m.emoji.trim() : '');

export interface EmojiTagMatch extends TagMatch {
  /** The text without the tag and the whitespace next to it, trimmed; '' when the message is only the tag. */
  inner: string;
}

/**
 * Emoji proxy tags: a member's emoji tag at the start or at the end of the message, each end matched
 * like a prefix-only or suffix-only tag (innerText). The longest matching tag wins; on equal length the
 * one at the start. A tag several members share goes to the first of them in the primary front (as the
 * app's Front tab lists it), or, when none of them is fronting, to the first of them in ps:members.
 */
export const matchEmojiTags = (input: string, members: Member[], front: FrontState | null, settings?: AppSettings | null): EmojiTagMatch | null => {
  const owners = new Map<string, Member[]>();
  for (const member of members) {
    if (!isProxyable(member)) continue;
    const emoji = emojiTagOf(member);
    if (!emoji) continue;
    const list = owners.get(emoji);
    if (list) list.push(member);
    else owners.set(emoji, [member]);
  }
  let best: {emoji: string; tag: ProxyTag; inner: string} | null = null;
  for (const emoji of owners.keys()) {
    // The start is tried first, so a tag at both ends is taken from the start.
    for (const tag of [{prefix: emoji, suffix: ''}, {prefix: '', suffix: emoji}]) {
      const inner = innerText(input, tag);
      if (inner === null) continue;
      const longer = !best || emoji.length > best.emoji.length;
      const startBeatsEnd = !!best && emoji.length === best.emoji.length && tag.prefix !== '' && best.tag.prefix === '';
      if (longer || startBeatsEnd) best = {emoji, tag, inner};
      break;
    }
  }
  if (!best) return null;
  const sharing = owners.get(best.emoji) ?? [];
  const ids = new Set(sharing.map(m => m.id));
  const fronting = sharing.length > 1 ? primaryFronters(front, members, settings).find(m => ids.has(m.id)) : undefined;
  const member = (fronting && sharing.find(m => m.id === fronting.id)) || sharing[0];
  if (!member) return null;
  return {member, tag: best.tag, inner: best.inner.trim(), content: (member.pkKeepProxy === true ? input : best.inner).trim()};
};

/** The member autoproxy sends as right now, or null. */
export const autoproxyMember = (
  setting: AutoproxySetting | null,
  members: Member[],
  front: FrontState | null,
  settings?: AppSettings | null,
): Member | null => {
  if (!setting) return null;
  if (setting.mode === 'front') return firstPrimaryFronter(front, members, settings);
  const m = members.find(x => x && x.id === setting.memberId);
  return isProxyable(m) ? m : null;
};

/**
 * Decides what to do with one message from a linked user.
 * Backslash first (never proxied), then an emoji tag, then autoproxy.
 * Nothing is proxied when there would be neither text nor attachments to post, or when the message is
 * only an emoji tag and has no attachments.
 */
export const planProxy = (i: PlanInput): ProxyPlan => {
  if (i.content.charCodeAt(0) === BACKSLASH) return {kind: 'escaped', content: i.content.slice(1)};
  const emoji = matchEmojiTags(i.content, i.members, i.front, i.settings);
  if (emoji) {
    if (!emoji.inner && !i.hasAttachments) return {kind: 'none'};
    return {kind: 'proxy', via: 'tag', member: emoji.member, content: emoji.content};
  }
  const auto = autoproxyMember(i.autoproxy, i.members, i.front, i.settings);
  if (!auto) return {kind: 'none'};
  const content = i.content.trim();
  if (!content && !i.hasAttachments) return {kind: 'none'};
  return {kind: 'proxy', via: 'autoproxy', member: auto, content};
};

/** Normalises a stored autoproxy value; anything unrecognised is treated as off. */
export const parseAutoproxy = (v: unknown): AutoproxySetting | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as {mode?: unknown; memberId?: unknown};
  if (o.mode === 'front') return {mode: 'front'};
  if (o.mode === 'member' && typeof o.memberId === 'string' && o.memberId) return {mode: 'member', memberId: o.memberId};
  return null;
};

/** The name a member is shown by, as in the app: name, or the nickname only when the name is blank. */
export const displayNameOf = (m: Member): string => {
  const name = String(m.name ?? '').trim();
  if (name) return name;
  return typeof m.nickname === 'string' ? m.nickname.trim() : '';
};

export type MemberLookup = {kind: 'found'; member: Member} | {kind: 'none'} | {kind: 'ambiguous'; count: number};

/**
 * Finds one of the user's proxyable members by vault id, then display name, then name, then nickname
 * (case-insensitive, trimmed). Each step stops at the first that has any match.
 */
export const findMember = (members: Member[], query: string): MemberLookup => {
  const q = query.trim();
  if (!q) return {kind: 'none'};
  const pool = members.filter(isProxyable);
  const byId = pool.find(m => m.id === q);
  if (byId) return {kind: 'found', member: byId};
  const lower = q.toLowerCase();
  const steps: ((m: Member) => string)[] = [displayNameOf, m => String(m.name ?? '').trim(), m => String(m.nickname ?? '').trim()];
  for (const key of steps) {
    const hits = pool.filter(m => key(m).toLowerCase() === lower);
    if (hits.length === 1) return {kind: 'found', member: hits[0]};
    if (hits.length > 1) return {kind: 'ambiguous', count: hits.length};
  }
  return {kind: 'none'};
};
