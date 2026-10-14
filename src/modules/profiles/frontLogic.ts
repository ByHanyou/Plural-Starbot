// Front logic ported from the Plural Star app. Pure: no Discord, database or session imports.
// Sources: src/store/actions.ts (updateFront, quickAddToFront, removeFromFront), src/utils.ts
// (withMemberSince, frontSessionStart, frontToHistoryEntry, migrateFrontState, fmtDur, orderFronters,
// translateMood, mood lists) and src/modals/SetFrontModal.tsx (how Set Front builds its tiers).
import type {FrontSortMode, FrontState, FrontTier, FrontTierKey, HistoryChangeType, HistoryEntry} from '../../vault/types';

/** The app's tier order. */
export const TIER_ORDER: readonly FrontTierKey[] = ['primary', 'coFront', 'coConscious'];

/** The app's EMPTY_TIER. */
export const emptyTier = (): FrontTier => ({memberIds: [], note: ''});

/** The app's migrateFrontState: a stored ps:front, upgrading the old single-tier shape. */
export const migrateFrontState = (raw: any): FrontState | null => {
  if (!raw) return null;
  if (raw.primary) return raw as FrontState;
  return {
    primary: {memberIds: raw.memberIds || [], mood: raw.mood, note: raw.note || '', location: raw.location},
    coFront: {memberIds: [], note: ''},
    coConscious: {memberIds: [], note: ''},
    startTime: raw.startTime || Date.now(),
  };
};

/**
 * ps:front as the app holds it in memory (migrateFrontState). A tier that is missing or has no
 * memberIds array (which would crash the app) is read as empty; well-formed tiers are left as they are.
 */
export const readFront = (raw: unknown): FrontState | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const f = migrateFrontState(raw);
  if (!f) return null;
  let fixed: FrontState | null = null;
  for (const k of TIER_ORDER) {
    const t = f[k] as FrontTier | undefined;
    if (t && typeof t === 'object' && Array.isArray(t.memberIds)) continue;
    fixed = fixed || {...f};
    fixed[k] = t && typeof t === 'object' ? {...t, memberIds: []} : emptyTier();
  }
  return fixed || f;
};

export const allFrontMemberIds = (f: FrontState | null): string[] =>
  f ? [...f.primary.memberIds, ...f.coFront.memberIds, ...f.coConscious.memberIds] : [];

export const isFrontEmpty = (f: FrontState | null): boolean =>
  !f || (f.primary.memberIds.length === 0 && f.coFront.memberIds.length === 0 && f.coConscious.memberIds.length === 0);

export const withMemberSince = (next: FrontState | null, prev: FrontState | null, now: number): FrontState | null => {
  if (!next) return next;
  const prevSince = prev?.memberSince || {};
  const prevIds = new Set(prev ? allFrontMemberIds(prev) : []);
  const since: Record<string, number> = {};
  for (const id of allFrontMemberIds(next)) {
    since[id] = prevIds.has(id) ? (prevSince[id] ?? prev?.startTime ?? now) : now;
  }
  return {...next, memberSince: since};
};

/** When the current front session started: the earliest memberSince in the first non-empty tier (optionally only counting some members). */
export const frontSessionStart = (f: FrontState, include?: (id: string) => boolean): number => {
  const any = f as any;
  const since: Record<string, number> = any?.memberSince || {};
  const segment = typeof any?.startTime === 'number' && any.startTime > 0 ? any.startTime : 0;
  for (const key of ['primary', 'coFront', 'coConscious']) {
    const tier = any?.[key];
    const ids: string[] = tier && Array.isArray(tier.memberIds) ? tier.memberIds.filter((id: string) => !include || include(id)) : [];
    if (ids.length === 0) continue;
    let earliest = segment;
    for (const id of ids) {
      const at = since[id];
      if (typeof at === 'number' && Number.isFinite(at) && at > 0 && (earliest === 0 || at < earliest)) earliest = at;
    }
    return earliest || f.startTime;
  }
  return f.startTime;
};

export const frontToHistoryEntry = (f: FrontState, endTime: number | null, changeType: HistoryChangeType = 'front', changeTier?: FrontTierKey): HistoryEntry => ({
  memberIds: f.primary.memberIds,
  startTime: f.startTime,
  endTime,
  note: f.primary.note,
  mood: f.primary.mood,
  location: f.primary.location,
  energyLevel: f.primary.energyLevel,
  coFrontIds: f.coFront.memberIds.length > 0 ? f.coFront.memberIds : undefined,
  coFrontMood: f.coFront.mood,
  coFrontNote: f.coFront.note || undefined,
  coFrontEnergy: f.coFront.energyLevel,
  coFrontLocation: f.coFront.location || undefined,
  coConsciousIds: f.coConscious.memberIds.length > 0 ? f.coConscious.memberIds : undefined,
  coConsciousMood: f.coConscious.mood,
  coConsciousNote: f.coConscious.note || undefined,
  coConsciousEnergy: f.coConscious.energyLevel,
  coConsciousLocation: f.coConscious.location || undefined,
  changeType,
  changeTime: changeType !== 'front' ? Date.now() : undefined,
  changeTier,
});

/** The values updateFront writes: ps:front (null when nobody fronts) and the whole ps:history. */
export interface FrontWrite {
  front: FrontState | null;
  history: HistoryEntry[];
}

/**
 * The app's updateFront, without the noteboard alert, GPS and last-location tail.
 * Takes the current front and history (the app's store state) and returns what the app writes
 * to KEYS.front and (through saveHistory) KEYS.history.
 */
export const updateFront = (
  front: FrontState | null,
  history: HistoryEntry[],
  primary: FrontTier,
  coFront: FrontTier,
  coConscious: FrontTier,
  now: number = Date.now(),
): FrontWrite => {
  const cleanTier = (tier: FrontTier): FrontTier =>
    tier.memberIds.length === 0
      ? {memberIds: [], mood: undefined, note: '', location: undefined, energyLevel: undefined}
      : tier;
  const cleanPrimary = cleanTier(primary);
  const cleanCoFront = cleanTier(coFront);
  const cleanCoConscious = cleanTier(coConscious);
  const isEmpty = cleanPrimary.memberIds.length === 0 && cleanCoFront.memberIds.length === 0 && cleanCoConscious.memberIds.length === 0;

  const sameMembers = (a: string[] = [], b: string[] = []) =>
    a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
  const continuing = !!front && !isEmpty
    && sameMembers(front.primary.memberIds, cleanPrimary.memberIds)
    && sameMembers(front.coFront.memberIds, cleanCoFront.memberIds)
    && sameMembers(front.coConscious.memberIds, cleanCoConscious.memberIds);

  const explicitLocation = cleanPrimary.location?.trim() || undefined;
  const nf: FrontState | null = isEmpty ? null : withMemberSince({primary: {...cleanPrimary, location: explicitLocation}, coFront: cleanCoFront, coConscious: cleanCoConscious, startTime: continuing ? front!.startTime : now}, front, now);

  let newHistory = [...history];
  if (front && !continuing) {
    newHistory = newHistory.map(e =>
      e.endTime === null && e.startTime === front.startTime && (!e.changeType || e.changeType === 'front') ? {...e, endTime: now} : e);
  }

  let finalFront = nf;
  if (nf) {
    if (continuing) {
      const extras: HistoryEntry[] = [];
      const moodChanged = (nf.primary.mood || undefined) !== (front!.primary.mood || undefined);
      const locChanged = (nf.primary.location || undefined) !== (front!.primary.location || undefined);
      const noteChanged = (nf.primary.note || undefined) !== (front!.primary.note || undefined);
      if (moodChanged || locChanged) {
        const entry = frontToHistoryEntry(nf, null, moodChanged ? 'mood' : 'location');
        entry.changeTime = now;
        extras.push(entry);
      }
      if (noteChanged) {
        const entry = frontToHistoryEntry(nf, null, 'note');
        entry.changeTime = now + 1;
        extras.push(entry);
      }
      const tierTracked = (a: FrontTier, b: FrontTier) =>
        (a.mood || undefined) !== (b.mood || undefined) || (a.energyLevel ?? undefined) !== (b.energyLevel ?? undefined);
      const segment = tierTracked(nf.primary, front!.primary) || tierTracked(nf.coFront, front!.coFront)
        || tierTracked(nf.coConscious, front!.coConscious) || locChanged;
      if (segment) {
        finalFront = {...nf, startTime: now};
        const segEntry = frontToHistoryEntry(finalFront, null, 'front');
        newHistory = newHistory.map(e =>
          e.endTime === null && e.startTime === front!.startTime && (!e.changeType || e.changeType === 'front') ? {...e, endTime: now} : e);
        newHistory = [segEntry, ...extras, ...newHistory];
      } else {
        const frontEntry = frontToHistoryEntry(nf, null, 'front');
        newHistory = newHistory.map(e =>
          e.endTime === null && e.startTime === front!.startTime && (!e.changeType || e.changeType === 'front') ? frontEntry : e);
        newHistory = [...extras, ...newHistory];
      }
    } else {
      const frontEntry = frontToHistoryEntry(nf, null, 'front');
      newHistory = [frontEntry, ...newHistory];
    }
  }

  return {front: finalFront, history: newHistory};
};

// ---- building the three tiers for a change ------------------------------------

export type FrontTiers = Record<FrontTierKey, FrontTier>;

const MOOD_DELIMITER = ', ';
export const parseMoodList = (mood: string | undefined): string[] =>
  (mood || '').split(',').map(s => s.trim()).filter(Boolean);
export const serializeMoodList = (moods: string[]): string =>
  moods.filter(Boolean).map(s => s.trim()).filter(Boolean).join(MOOD_DELIMITER);

/** SetFrontModal's resolveMood with no custom mood typed in. */
const resolveMood = (mood: string): string | undefined => serializeMoodList(parseMoodList(mood)) || undefined;

/**
 * Set Front (SetFrontModal): tiers seeded from the current front (each member in one tier only),
 * the chosen tier replaced by `ids` (which leave the other tiers), saved the way handleSave does.
 * GPS seeding of the primary location is not part of the bot.
 */
export const setFrontTiers = (current: FrontState | null, tier: FrontTierKey, ids: string[]): FrontTiers => {
  const c = current;
  const seedP = new Set<string>(c?.primary?.memberIds || []);
  const seedCf = new Set<string>((c?.coFront?.memberIds || []).filter((id: string) => !seedP.has(id)));
  const seedCc = new Set<string>((c?.coConscious?.memberIds || []).filter((id: string) => !seedP.has(id) && !seedCf.has(id)));
  const sets: Record<FrontTierKey, Set<string>> = {primary: seedP, coFront: seedCf, coConscious: seedCc};
  const chosen = new Set(ids);
  for (const key of TIER_ORDER) {
    if (key === tier) continue;
    const cleaned = new Set(sets[key]);
    let changed = false;
    chosen.forEach(id => {
      if (cleaned.delete(id)) changed = true;
    });
    if (changed) sets[key] = cleaned;
  }
  sets[tier] = chosen;
  const build = (key: FrontTierKey): FrontTier => ({
    memberIds: [...sets[key]],
    mood: resolveMood(c?.[key]?.mood || ''),
    note: c?.[key]?.note || '',
    location: (c?.[key]?.location || '') || undefined,
    energyLevel: c?.[key]?.energyLevel,
  });
  return {primary: build('primary'), coFront: build('coFront'), coConscious: build('coConscious')};
};

/** The app's quickAddToFront: the member leaves every tier and is appended to `tierKey`. */
export const quickAddTiers = (front: FrontState | null, id: string, tierKey: FrontTierKey): FrontTiers => {
  const strip = (tier: FrontTier): FrontTier => ({...tier, memberIds: tier.memberIds.filter(x => x !== id)});
  const tiers: FrontTiers = {
    primary: front ? strip(front.primary) : {memberIds: [], note: ''},
    coFront: front ? strip(front.coFront) : {memberIds: [], note: ''},
    coConscious: front ? strip(front.coConscious) : {memberIds: [], note: ''},
  };
  tiers[tierKey] = {...tiers[tierKey], memberIds: [...tiers[tierKey].memberIds, id]};
  return tiers;
};

/** The app's removeFromFront: the member leaves every tier. Null when there is no front (the app does nothing). */
export const removeTiers = (front: FrontState | null, id: string): FrontTiers | null => {
  if (!front) return null;
  return {
    primary: {...front.primary, memberIds: front.primary.memberIds.filter(x => x !== id)},
    coFront: {...front.coFront, memberIds: front.coFront.memberIds.filter(x => x !== id)},
    coConscious: {...front.coConscious, memberIds: front.coConscious.memberIds.filter(x => x !== id)},
  };
};

/** Clear in SetFrontModal: every tier EMPTY_TIER. */
export const clearTiers = (): FrontTiers => ({primary: emptyTier(), coFront: emptyTier(), coConscious: emptyTier()});

// ---- display ----------------------------------------------------------------

/** The app's fmtDur with its English strings ("Xd Yh", "Xh Ym", "Xm", "<1m"). */
export const fmtDur = (start: number, end?: number | null): string => {
  const ms = (end ?? Date.now()) - start;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m` : '<1m';
};

let collator: Intl.Collator | null = null;
/** The app's nameCompare, in the English locale. */
export const nameCompare = (a: unknown, b: unknown): number => {
  if (!collator) collator = new Intl.Collator('en-US');
  return collator.compare(String(a ?? ''), String(b ?? ''));
};

/** The app's orderFronters (how the Front tab orders members inside a tier). */
export const orderFronters = (ids: string[], mode: FrontSortMode | undefined, nameOf: (id: string) => string, custom?: string[]): string[] => {
  if (mode === 'az') return [...ids].sort((a, b) => nameCompare(nameOf(a), nameOf(b)));
  if (mode === 'za') return [...ids].sort((a, b) => nameCompare(nameOf(b), nameOf(a)));
  if (mode === 'custom' && custom && custom.length > 0) {
    const rank = new Map(custom.map((id, i) => [id, i]));
    return ids
      .map((id, i) => ({id, key: rank.get(id) ?? custom.length + i}))
      .sort((a, b) => a.key - b.key)
      .map(x => x.id);
  }
  return ids;
};

const DEFAULT_MOODS = ['Calm', 'Happy', 'Anxious', 'Tired', 'Energetic', 'Dissociated', 'Grounded', 'Irritable', 'Sad', 'Focused'];

/** The app's translateMood in English: built-in moods in their canonical spelling, joined with ", ". */
export const translateMood = (mood: string): string => {
  if (!mood) return '';
  const parts = mood.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.map(one => DEFAULT_MOODS.find(d => d.toLowerCase() === one.toLowerCase()) || one).join(', ');
};

const DEFAULT_TIER_NAMES: Record<FrontTierKey, string> = {
  primary: 'Primary Front',
  coFront: 'Co-Front',
  coConscious: 'Co-Conscious',
};

/** A tier's name as the app shows it: the system's own name from ps:settings.tierNames, else the default. */
export const tierName = (key: FrontTierKey, tierNames?: Record<string, string> | null): string => {
  const own = tierNames && typeof tierNames[key] === 'string' ? tierNames[key].trim() : '';
  return own || DEFAULT_TIER_NAMES[key];
};
