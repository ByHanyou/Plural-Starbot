// Which members a viewer may see, and finding one by name. Pure: no Discord imports.
import type {Member} from '../../vault/types';

/** A usable member record that is not deleted or archived (those are never shown or proxied). */
export const isShown = (m: unknown): m is Member => {
  if (!m || typeof m !== 'object') return false;
  const r = m as Member;
  return typeof r.id === 'string' && !!r.id && !r.deleted && !r.archived;
};

/** Members a viewer may see: own vault, everything shown; someone else's, private members left out. */
export const visibleMembers = (members: Member[], own: boolean): Member[] => members.filter(m => isShown(m) && (own || m.private !== true));

/** The app's isRosterMember (counted as members: not custom fronts, not facets, not deleted). */
export const isRosterMember = (m: Member): boolean => !m.isCustomFront && !m.isFacet && !m.deleted;

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export type MemberMatch = {kind: 'found'; member: Member} | {kind: 'none'} | {kind: 'ambiguous'; count: number; prefix: boolean};

/**
 * Finds a member by name or nickname, case-insensitively: an exact match first (a name match wins
 * over a nickname match when several are exact), then a prefix that only one member has.
 */
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

/**
 * Every member findByName chooses among for this query: the exact name or nickname matches, or when
 * there are none, the prefix matches. Whatever findByName answers (the member found, or how many are
 * ambiguous) comes from these members only.
 */
export const nameCandidates = (pool: Member[], query: string): Member[] => {
  const q = norm(query);
  if (!q) return [];
  const exact = pool.filter(m => norm(m.name) === q || norm(m.nickname) === q);
  if (exact.length) return exact;
  return pool.filter(m => norm(m.name).startsWith(q) || norm(m.nickname).startsWith(q));
};
