import {tunables} from '../../config';
import {isRecord} from '../../util';
import type {AppSettings, FrontState, Member} from '../../vault/types';
import {orderFronters} from '../profiles/frontLogic';
import {nameKey} from '../profiles/lookup';

export interface ProxyTag {
  prefix: string;
  suffix: string;
}

const BACKSLASH = 0x5c;

export type AutoproxySetting = {mode: 'front'} | {mode: 'member'; memberId: string} | {mode: 'latch'};

export interface LatchRecord {
  memberId: string;
  timestamp: number;
}

export interface TagMatch {
  member: Member;
  tag: ProxyTag;
  content: string;
}

export type ProxyPlan =
  | {kind: 'none'}
  | {kind: 'escaped'; content: string}
  | {kind: 'proxy'; via: 'tag' | 'autoproxy'; member: Member; content: string};

export interface PlanInput {
  content: string;
  hasAttachments: boolean;
  members: Member[];
  front: FrontState | null;
  autoproxy: AutoproxySetting | null;
  settings?: AppSettings | null;
  latch?: LatchRecord | null;
  now?: number;
}

export const isProxyable = (m: Member | null | undefined): m is Member =>
  !!m && typeof m === 'object' && typeof m.id === 'string' && !!m.id && !m.deleted && !m.archived && !m.isCustomFront;

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

export const firstPrimaryFronter = (front: FrontState | null, members: Member[], settings?: AppSettings | null): Member | null =>
  primaryFronters(front, members, settings)[0] ?? null;

export const emojiTagOf = (m: Member): string => (typeof m.emoji === 'string' ? m.emoji.trim() : '');

const EMOJI_GLUE = /[\uFE0E\uFE0F\u200D]/gu;
export const emojiTagKey = (tag: string): string => tag.replace(EMOJI_GLUE, '');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GLUE = '[\uFE0E\uFE0F\u200D]*';
const CONTINUES = '[\uFE0E\uFE0F\u200D\u20E3\u{1F3FB}-\u{1F3FF}]';

const emojiTagInner = (input: string, key: string, at: 'start' | 'end'): string | null => {
  const body = Array.from(key).map(escapeRe).join(GLUE);
  if (at === 'start') {
    const m = new RegExp(`^${body}[\uFE0E\uFE0F]*(?!${CONTINUES})`, 'u').exec(input);
    return m ? input.slice(m[0].length) : null;
  }
  const m = new RegExp(`(?<!\u200D)${body}[\uFE0E\uFE0F]*$`, 'u').exec(input);
  return m ? input.slice(0, m.index) : null;
};

export interface EmojiTagMatch extends TagMatch {
  inner: string;
}

const matchEmojiTags = (input: string, members: Member[], front: FrontState | null, settings?: AppSettings | null): EmojiTagMatch | null => {
  const owners = new Map<string, Member[]>();
  for (const member of members) {
    if (!isProxyable(member)) continue;
    const key = emojiTagKey(emojiTagOf(member));
    if (!key) continue;
    const list = owners.get(key);
    if (list) list.push(member);
    else owners.set(key, [member]);
  }
  let best: {key: string; size: number; tag: ProxyTag; inner: string} | null = null;
  for (const key of owners.keys()) {
    const size = Array.from(key).length;
    for (const at of ['start', 'end'] as const) {
      const inner = emojiTagInner(input, key, at);
      if (inner === null) continue;
      const tag: ProxyTag = at === 'start' ? {prefix: key, suffix: ''} : {prefix: '', suffix: key};
      const longer = !best || size > best.size;
      const startBeatsEnd = !!best && size === best.size && at === 'start' && best.tag.prefix === '';
      if (longer || startBeatsEnd) best = {key, size, tag, inner};
      break;
    }
  }
  if (!best) return null;
  const sharing = owners.get(best.key) ?? [];
  const ids = new Set(sharing.map(m => m.id));
  const fronting = sharing.length > 1 ? primaryFronters(front, members, settings).find(m => ids.has(m.id)) : undefined;
  const member = (fronting && sharing.find(m => m.id === fronting.id)) || sharing[0];
  if (!member) return null;
  return {member, tag: best.tag, inner: best.inner.trim(), content: (member.pkKeepProxy === true ? input : best.inner).trim()};
};

export const latchMember = (last: LatchRecord | null | undefined, members: Member[], now: number = Date.now()): Member | null => {
  if (!last || now - last.timestamp > tunables().latchHours * 60 * 60 * 1000) return null;
  const m = members.find(x => x && x.id === last.memberId);
  return isProxyable(m) ? m : null;
};

const autoproxyMember = (
  setting: AutoproxySetting | null,
  members: Member[],
  front: FrontState | null,
  settings?: AppSettings | null,
  latch?: LatchRecord | null,
  now: number = Date.now(),
): Member | null => {
  if (!setting) return null;
  if (setting.mode === 'front') return firstPrimaryFronter(front, members, settings);
  if (setting.mode === 'latch') return latchMember(latch, members, now);
  const m = members.find(x => x && x.id === setting.memberId);
  return isProxyable(m) ? m : null;
};

export const planProxy = (i: PlanInput): ProxyPlan => {
  if (i.content.charCodeAt(0) === BACKSLASH) return {kind: 'escaped', content: i.content.slice(1)};
  const emoji = matchEmojiTags(i.content, i.members, i.front, i.settings);
  if (emoji) {
    if (!emoji.inner && !i.hasAttachments) return {kind: 'none'};
    return {kind: 'proxy', via: 'tag', member: emoji.member, content: emoji.content};
  }
  const auto = autoproxyMember(i.autoproxy, i.members, i.front, i.settings, i.latch, i.now);
  if (!auto) return {kind: 'none'};
  const content = i.content.trim();
  if (!content && !i.hasAttachments) return {kind: 'none'};
  return {kind: 'proxy', via: 'autoproxy', member: auto, content};
};

export const parseAutoproxy = (v: unknown): AutoproxySetting | null => {
  if (!isRecord(v)) return null;
  if (v.mode === 'front') return {mode: 'front'};
  if (v.mode === 'latch') return {mode: 'latch'};
  if (v.mode === 'member' && typeof v.memberId === 'string' && v.memberId) return {mode: 'member', memberId: v.memberId};
  return null;
};

export const displayNameOf = (m: Member): string => {
  const name = String(m.name ?? '').trim();
  if (name) return name;
  return typeof m.nickname === 'string' ? m.nickname.trim() : '';
};

export type MemberLookup = {kind: 'found'; member: Member} | {kind: 'none'} | {kind: 'ambiguous'; count: number};

export const findMember = (members: Member[], query: string): MemberLookup => {
  const q = query.trim();
  if (!q) return {kind: 'none'};
  const pool = members.filter(isProxyable);
  const byId = pool.find(m => m.id === q);
  if (byId) return {kind: 'found', member: byId};
  const lower = nameKey(q);
  const steps: ((m: Member) => string)[] = [displayNameOf, m => String(m.name ?? '').trim(), m => String(m.nickname ?? '').trim()];
  for (const key of steps) {
    const hits = pool.filter(m => nameKey(key(m)) === lower);
    if (hits.length === 1) return {kind: 'found', member: hits[0]};
    if (hits.length > 1) return {kind: 'ambiguous', count: hits.length};
  }
  return {kind: 'none'};
};

export const findMemberByEmoji = (members: Member[], query: string): MemberLookup => {
  const key = emojiTagKey(query.trim());
  if (!key) return {kind: 'none'};
  const hits = members.filter(isProxyable).filter(m => emojiTagKey(emojiTagOf(m)) === key);
  if (hits.length === 1) return {kind: 'found', member: hits[0]};
  if (hits.length > 1) return {kind: 'ambiguous', count: hits.length};
  return {kind: 'none'};
};
