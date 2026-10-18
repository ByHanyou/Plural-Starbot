import type {Member} from '../../vault/types';

export const isShown = (m: unknown): m is Member => {
  if (!m || typeof m !== 'object') return false;
  const r = m as Member;
  return typeof r.id === 'string' && !!r.id && !r.deleted && !r.archived;
};

export const visibleMembers = (members: Member[], own: boolean): Member[] => members.filter(m => isShown(m) && (own || m.private !== true));

export const isRosterMember = (m: Member): boolean => !m.isCustomFront && !m.isFacet && !m.deleted;

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export type MemberMatch = {kind: 'found'; member: Member} | {kind: 'none'} | {kind: 'ambiguous'; count: number; prefix: boolean};

export const findByName = (pool: Member[], query: string): MemberMatch => {
  const q = norm(query);
  if (!q) return {kind: 'none'};
  const exact = pool.filter(m => norm(m.name) === q || norm(m.nickname) === q);
  if (exact.length === 1) return {kind: 'found', member: exact[0]};
  if (exact.length > 1) {
    const byName = exact.filter(m => norm(m.name) === q);
    if (byName.length === 1) return {kind: 'found', member: byName[0]};
    return {kind: 'ambiguous', count: exact.length, prefix: false};
  }
  const prefixed = pool.filter(m => norm(m.name).startsWith(q) || norm(m.nickname).startsWith(q));
  if (prefixed.length === 1) return {kind: 'found', member: prefixed[0]};
  if (prefixed.length > 1) return {kind: 'ambiguous', count: prefixed.length, prefix: true};
  return {kind: 'none'};
};

export const nameCandidates = (pool: Member[], query: string): Member[] => {
  const q = norm(query);
  if (!q) return [];
  const exact = pool.filter(m => norm(m.name) === q || norm(m.nickname) === q);
  if (exact.length) return exact;
  return pool.filter(m => norm(m.name).startsWith(q) || norm(m.nickname).startsWith(q));
};
