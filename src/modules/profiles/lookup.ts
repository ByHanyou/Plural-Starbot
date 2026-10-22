import {isRecord} from '../../util';
import type {Member} from '../../vault/types';

export const isShown = (m: unknown): m is Member => isRecord(m) && typeof m.id === 'string' && !!m.id && !m.deleted && !m.archived;

export const visibleMembers = (members: Member[], own: boolean): Member[] => members.filter(m => isShown(m) && (own || m.private !== true));

export const nameKey = (v: unknown): string => (typeof v === 'string' ? v.normalize('NFC').trim().toLowerCase() : '');

export type MemberMatch = {kind: 'found'; member: Member} | {kind: 'none'} | {kind: 'ambiguous'; count: number; prefix: boolean};

export const findByName = (pool: Member[], query: string): MemberMatch => {
  const q = nameKey(query);
  if (!q) return {kind: 'none'};
  const exact = pool.filter(m => nameKey(m.name) === q || nameKey(m.nickname) === q);
  if (exact.length === 1) return {kind: 'found', member: exact[0]};
  if (exact.length > 1) {
    const byName = exact.filter(m => nameKey(m.name) === q);
    if (byName.length === 1) return {kind: 'found', member: byName[0]};
    return {kind: 'ambiguous', count: exact.length, prefix: false};
  }
  const prefixed = pool.filter(m => nameKey(m.name).startsWith(q) || nameKey(m.nickname).startsWith(q));
  if (prefixed.length === 1) return {kind: 'found', member: prefixed[0]};
  if (prefixed.length > 1) return {kind: 'ambiguous', count: prefixed.length, prefix: true};
  return {kind: 'none'};
};

export const nameCandidates = (pool: Member[], query: string): Member[] => {
  const q = nameKey(query);
  if (!q) return [];
  const exact = pool.filter(m => nameKey(m.name) === q || nameKey(m.nickname) === q);
  if (exact.length) return exact;
  return pool.filter(m => nameKey(m.name).startsWith(q) || nameKey(m.nickname).startsWith(q));
};
