// Member, system and front embeds, laid out like the app's read-mode profile (MemberModal readOnly),
// SystemProfileCard and the Front tab. Pure: builds plain embed JSON; no Discord runtime imports.
import type {APIEmbed, APIEmbedField} from 'discord.js';
import type {AppSettings, CustomFieldDef, FrontState, FrontTier, Member, MemberGroup, SystemInfo} from '../../vault/types';
import {ellipsize, embedColor} from '../proxy/text';
import {fmtDur, frontSessionStart, nameCompare, orderFronters, tierName, TIER_ORDER, translateMood} from './frontLogic';
import {isRosterMember, visibleMembers} from './lookup';
import {capText, descriptionToDiscord, escapeText, MentionNames} from './richText';

const LIMIT = {title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, total: 6000};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const field = (name: string, value: string, inline = false): APIEmbedField | null => {
  if (!value.trim()) return null;
  return {name: ellipsize(name.trim() || '-', LIMIT.fieldName), value: capText(value, LIMIT.fieldValue), inline};
};

const embedLength = (e: APIEmbed): number =>
  (e.title?.length || 0) +
  (e.description?.length || 0) +
  (e.footer?.text.length || 0) +
  (e.author?.name.length || 0) +
  (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/**
 * Drops fields from the end until the embed fits Discord's limits (25 fields, 6000 characters), keeping
 * the last `keepLast` fields until nothing else is left to drop. Returns how many were dropped.
 */
const fitFields = (e: APIEmbed, reserve = 0, keepLast = 0): number => {
  const fields = e.fields || [];
  let dropped = 0;
  while (fields.length && (fields.length > LIMIT.fields || embedLength(e) + reserve > LIMIT.total)) {
    fields.splice(fields.length > keepLast ? fields.length - 1 - keepLast : fields.length - 1, 1);
    dropped++;
  }
  if (!fields.length) delete e.fields;
  return dropped;
};

/** Footer note for fields left out to fit Discord's limits. */
const notShown = (dropped: number): string => (dropped ? `${dropped} more field${dropped === 1 ? '' : 's'} not shown` : '');

/**
 * A banner as an embed of its own, sent above the card: the app shows the banner at the top of a
 * profile, and an embed's image always sits at its bottom.
 */
const bannerEmbed = (url: string, color: number | null): APIEmbed => (color !== null ? {color, image: {url}} : {image: {url}});

/** A chip shown as inline code (the app's chips), or escaped text when the value holds a backtick. */
const chip = (s: string): string => (s.includes('`') ? escapeText(s) : '`' + s + '`');

// ---- groups (src/utils.ts: groupKind, childrenOf, sortGroupsForDisplay) ----------------

const groupKind = (g: MemberGroup): 'group' | 'subsystem' => (g.kind === 'subsystem' ? 'subsystem' : 'group');
const groupParent = (g: MemberGroup): string | null => g.parentId ?? null;

const childrenOf = (nodes: MemberGroup[], parentId: string | null): MemberGroup[] =>
  nodes
    .filter(n => groupParent(n) === parentId)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || nameCompare(a.name, b.name));

const groupDisplayOrder = (nodes: MemberGroup[]): Map<string, number> => {
  const order = new Map<string, number>();
  const walk = (parentId: string | null): void => {
    for (const g of childrenOf(nodes, parentId)) {
      if (order.has(g.id)) continue;
      order.set(g.id, order.size);
      walk(g.id);
    }
  };
  walk(null);
  for (const g of nodes) {
    if (!order.has(g.id)) order.set(g.id, order.size);
  }
  return order;
};

const sortGroupsForDisplay = (list: MemberGroup[], all: MemberGroup[]): MemberGroup[] => {
  const order = groupDisplayOrder(all);
  return [...list].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
};

/** The app marks a group with a round dot and a sub-system with a square one. */
const groupChip = (g: MemberGroup): string => `${groupKind(g) === 'subsystem' ? '■' : '●'} ${escapeText(str(g.name) || '-')}`;

/** The app's linkedSubsystemsOf: sub-systems whose linked member is this one. */
const linkedSubsystemsOf = (groups: MemberGroup[], memberId: string): MemberGroup[] =>
  memberId ? groups.filter(g => groupKind(g) === 'subsystem' && g.linkedMemberId === memberId) : [];

// ---- custom fields (MemberModal's read-mode Custom Fields section) --------------------

type DateMode = 'date' | 'datetime' | 'monthYear' | 'month' | 'year' | 'monthDay';
const DATE_MODES: Record<string, DateMode> = {date: 'date', timestamp: 'datetime', monthYear: 'monthYear', month: 'month', year: 'year', monthDay: 'monthDay'};
const LOCALE = 'en-US';

/**
 * The Date MemberModal derives from a stored date-type value, and whether the value was an instant
 * (epoch milliseconds, which the app's date editor stores) rather than a calendar date the app builds
 * from its parts (a bare year, "YYYY-MM-DD", other date text).
 */
const dateOf = (val: unknown): {date: Date; instant: boolean} => {
  const bareNum = typeof val === 'number' ? val : typeof val === 'string' && val.trim() && Number.isFinite(Number(val)) ? Number(val) : NaN;
  if (!Number.isNaN(bareNum) && Number.isInteger(bareNum) && bareNum >= 1000 && bareNum <= 9999) return {date: new Date(bareNum, 0, 1), instant: false};
  if (typeof val === 'number' && Number.isFinite(val)) return {date: new Date(val), instant: true};
  if (typeof val === 'string' && val) {
    const asNum = Number(val);
    const isoDate = val.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00(?::00(?:\.\d+)?)?Z?)?$/);
    if (Number.isFinite(asNum) && asNum !== 0) return {date: new Date(asNum), instant: true};
    if (isoDate) return {date: new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3])), instant: false};
    const parsed = Date.parse(val);
    return {date: Number.isFinite(parsed) ? new Date(parsed) : new Date(), instant: false};
  }
  return {date: new Date(), instant: false};
};

/**
 * DateTimeEditor's read-only summary in English. The app formats in the device's time zone, so an
 * instant shown as a date, and a date and time, become Discord timestamps (each viewer's time zone);
 * a calendar date is formatted from its own parts.
 */
const fmtDate = (date: Date, mode: DateMode, instant: boolean): string => {
  if (Number.isNaN(date.getTime())) return '';
  if (mode === 'year') return String(date.getFullYear());
  if (mode === 'month') return date.toLocaleDateString(LOCALE, {month: 'long'});
  if (mode === 'monthYear') return date.toLocaleDateString(LOCALE, {month: 'short', year: 'numeric'});
  if (mode === 'monthDay') return date.toLocaleDateString(LOCALE, {month: 'short', day: 'numeric'});
  if (mode === 'date') {
    if (instant) return `<t:${Math.floor(date.getTime() / 1000)}:D>`;
    return date.toLocaleDateString(LOCALE, {month: 'short', day: 'numeric', year: 'numeric'});
  }
  return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
};

/** A custom field value as text, or null when the app shows nothing for it. */
export const customFieldText = (fd: CustomFieldDef, val: unknown, names?: MentionNames): string | null => {
  if (val === undefined || val === null || val === '') return null;
  const mode = DATE_MODES[fd.type];
  if (mode) {
    const d = dateOf(val);
    return fmtDate(d.date, mode, d.instant) || null;
  }
  if (fd.type === 'dateRange') {
    let range = {start: Date.now(), end: Date.now()};
    if (typeof val === 'string' && val) {
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed.start === 'number' && typeof parsed.end === 'number') range = parsed;
      } catch {}
    }
    return `Start: ${fmtDate(new Date(range.start), 'date', true)}\nEnd: ${fmtDate(new Date(range.end), 'date', true)}`;
  }
  if (fd.type === 'toggle') return val ? 'On' : 'Off';
  if (fd.type === 'image') return '(image)';
  if (fd.type === 'markdown' || (fd.type === 'text' && fd.markdown)) return descriptionToDiscord(String(val), names) || null;
  if (fd.type === 'number') return escapeText(String(val));
  return escapeText(String(val || '')) || null;
};

// ---- member -------------------------------------------------------------------------

export interface MemberCardInput {
  member: Member;
  groups: MemberGroup[];
  fieldDefs: CustomFieldDef[];
  /** Names for description mentions (only members the viewer may see). */
  names?: MentionNames;
  avatarUrl?: string;
  bannerUrl?: string;
  /**
   * The viewer is the vault's own user. Linked Sub-systems are shown only then: the app hides them on
   * someone else's member (MirrorScreen opens it with lockRead).
   */
  ownerView?: boolean;
}

const LINKED_SUBSYSTEMS = '**Linked Sub-systems**';
const DESCRIPTION_BIO = '**Description / Bio**';
const CUSTOM_FIELDS = '**Custom Fields**';

/**
 * The read-mode profile (MemberModal readOnly). The banner, when there is one, is an embed of its own
 * above the card. The card: avatar and name; then in the description, in the app's order, pronouns,
 * role, the colour and emoji chips, tags, groups, Linked Sub-systems (vault owner only),
 * "Description / Bio" with the bio (up to Discord's 4096 characters), and the "Custom Fields" heading;
 * the custom fields follow as fields in the system's field order. A custom front is a status card
 * (name, colour, description); a facet is labelled "Facet".
 */
export const memberCard = (i: MemberCardInput): APIEmbed[] => {
  const m = i.member;
  const name = str(m.name) || 'Member';
  const color = embedColor(m.color);
  const e: APIEmbed = {};
  if (color !== null) e.color = color;

  if (m.isCustomFront) {
    e.title = ellipsize(name, LIMIT.title);
    const desc = capText(descriptionToDiscord(m.description, i.names), LIMIT.description);
    if (desc) e.description = desc;
    return [e];
  }

  e.title = ellipsize(name, LIMIT.title);
  if (i.avatarUrl) e.thumbnail = {url: i.avatarUrl};

  const head: string[] = [];
  if (str(m.pronouns)) head.push(escapeText(str(m.pronouns)));
  if (str(m.role)) head.push(`*${escapeText(str(m.role))}*`);
  // The app's colour chip is a swatch and the hex value; the swatch is the embed's colour bar here.
  const chips: string[] = [];
  if (str(m.color)) chips.push(chip(str(m.color)));
  if (str(m.emoji)) chips.push(str(m.emoji));
  if (chips.length) head.push(chips.join(' · '));
  const tags = Array.isArray(m.tags) ? m.tags.map(str).filter(Boolean) : [];
  if (tags.length) head.push(tags.map(chip).join(' '));
  const allGroups = (Array.isArray(i.groups) ? i.groups : []).filter(g => g && typeof g === 'object' && typeof g.id === 'string');
  const mine = Array.isArray(m.groupIds) ? m.groupIds : [];
  const active = sortGroupsForDisplay(allGroups.filter(g => mine.includes(g.id)), allGroups);
  if (active.length) head.push(active.map(groupChip).join(' '));

  const sections: string[] = [];
  if (head.length) sections.push(head.join('\n'));
  if (i.ownerView) {
    const linkedSubs = sortGroupsForDisplay(linkedSubsystemsOf(allGroups, m.id), allGroups);
    if (linkedSubs.length) sections.push(`${LINKED_SUBSYSTEMS}\n${linkedSubs.map(groupChip).join(' ')}`);
  }
  const bio = descriptionToDiscord(m.description, i.names);
  if (bio) sections.push(`${DESCRIPTION_BIO}\n${bio}`);

  const custom: APIEmbedField[] = [];
  const values = Array.isArray(m.customFields) ? m.customFields : [];
  for (const fd of Array.isArray(i.fieldDefs) ? i.fieldDefs : []) {
    if (!fd || typeof fd !== 'object' || typeof fd.id !== 'string') continue;
    const text = customFieldText(fd, values.find(v => v && v.fieldId === fd.id)?.value, i.names);
    const f = text ? field(str(fd.name) || '-', text) : null;
    if (f) custom.push(f);
  }

  const heading = custom.length ? CUSTOM_FIELDS : '';
  const body = capText(sections.join('\n\n'), LIMIT.description - (heading ? heading.length + 2 : 0));
  const description = [body, heading].filter(Boolean).join('\n\n');
  if (description) e.description = description;

  e.fields = [...custom];
  const footer = m.isFacet ? 'Facet' : '';
  const dropped = fitFields(e, footer.length + 40);
  if (heading && !(e.fields || []).some(f => custom.includes(f))) {
    // Every custom field had to be left out: no heading over nothing.
    if (body) e.description = body;
    else delete e.description;
  }
  const footerText = [footer, notShown(dropped)].filter(Boolean).join(' · ');
  if (footerText) e.footer = {text: footerText};
  return i.bannerUrl ? [bannerEmbed(i.bannerUrl, color), e] : [e];
};

// ---- system -------------------------------------------------------------------------

export interface SystemCardInput {
  system: SystemInfo | null;
  members: Member[];
  discordUserId: string;
  names?: MentionNames;
  avatarUrl?: string;
  bannerUrl?: string;
}

/** Members counted on the system card: roster members that are not private, deleted or archived. */
export const publicRosterCount = (members: Member[]): number =>
  visibleMembers(members, false).filter(isRosterMember).length;

/**
 * SystemProfileCard: the banner (an embed of its own above the card, as the app shows it at the top),
 * then avatar, name, description, plus the member count and the linked account.
 */
export const systemCard = (i: SystemCardInput): APIEmbed[] => {
  const e: APIEmbed = {title: ellipsize(str(i.system?.name) || 'Unnamed System', LIMIT.title)};
  if (i.avatarUrl) e.thumbnail = {url: i.avatarUrl};
  e.description = capText(descriptionToDiscord(i.system?.description, i.names), LIMIT.description) || '*No description yet.*';
  e.fields = [
    {name: 'Members', value: String(publicRosterCount(i.members)), inline: true},
    {name: 'Linked Discord account', value: `<@${i.discordUserId}>`, inline: true},
  ];
  return i.bannerUrl ? [bannerEmbed(i.bannerUrl, null), e] : [e];
};

// ---- front --------------------------------------------------------------------------

export interface FrontViewInput {
  front: FrontState | null;
  /** Every member record of the vault (ps:members). */
  members: Member[];
  /** Whether private members are shown (only ever for the vault's own user). */
  own: boolean;
  /**
   * The viewer is the vault's own user: each tier shows its mood, location, energy and note, as the
   * app's Front tab does. Anyone else sees the primary tier's mood, location and note only, as the app
   * shares a front (buildFrontShare). Defaults to `own`.
   */
  ownerView?: boolean;
  settings: AppSettings | null;
  systemName: string;
  systemAvatarUrl?: string;
  now?: number;
}

export interface FrontView {
  /** Null when nobody the viewer may see is fronting. */
  embed: APIEmbed | null;
  /** True when the embed names a private member (only ever for the vault's own user). */
  showsPrivate: boolean;
}

const capLines = (lines: string[], max: number): string => {
  const out: string[] = [];
  let used = 0;
  for (let k = 0; k < lines.length; k++) {
    const more = `…and ${lines.length - k} more`;
    const add = (out.length ? 1 : 0) + lines[k].length;
    const tail = k < lines.length - 1 ? 1 + more.length : 0;
    if (used + add + tail > max) {
      out.push(more);
      break;
    }
    out.push(lines[k]);
    used += add;
  }
  return out.join('\n');
};

/** A tier's energy as the Front tab shows it ("7/10"), or '' when it has none. */
const energyOf = (tier: FrontTier | undefined): string => {
  const n: unknown = tier?.energyLevel;
  if (typeof n === 'number' && Number.isFinite(n) && n) return `${n}/10`;
  if (typeof n === 'string' && n.trim()) return `${escapeText(n.trim())}/10`;
  return '';
};

/**
 * The Front tab: each tier in order with its members and how long each has fronted, and the tier's
 * mood, location, energy and note (for anyone but the vault's own user, the primary tier's mood,
 * location and note only).
 */
export const frontView = (i: FrontViewInput): FrontView => {
  const front = i.front;
  if (!front) return {embed: null, showsPrivate: false};
  const now = i.now ?? Date.now();
  const allDetails = i.ownerView ?? i.own;
  const byId = new Map(visibleMembers(i.members, i.own).map(m => [m.id, m] as const));
  const sortMode = i.settings?.frontSortMode;
  const customOrder = Array.isArray(i.settings?.frontCustomOrder) ? i.settings!.frontCustomOrder : undefined;
  const tiers = TIER_ORDER.map(key => {
    const tier = front[key];
    const ids = Array.isArray(tier?.memberIds) ? tier.memberIds.filter(id => byId.has(id)) : [];
    const ordered = orderFronters(ids, sortMode, id => byId.get(id)?.name || '', customOrder);
    return {key, tier, members: ordered.map(id => byId.get(id)!)};
  });
  if (tiers.every(t => t.members.length === 0)) return {embed: null, showsPrivate: false};

  const since = (id: string): number => front.memberSince?.[id] ?? front.startTime;
  const fields: APIEmbedField[] = [];
  let showsPrivate = false;
  for (const t of tiers) {
    if (!t.members.length) continue;
    if (t.members.some(m => m.private === true)) showsPrivate = true;
    const lines = t.members.map(m => `**${escapeText(str(m.name) || '?')}** · for ${fmtDur(since(m.id), now)}`);
    fields.push({name: ellipsize(tierName(t.key, i.settings?.tierNames), LIMIT.fieldName), value: capLines(lines, LIMIT.fieldValue)});
    if (!allDetails && t.key !== 'primary') continue;
    const mood = translateMood(str(t.tier?.mood));
    const location = str(t.tier?.location);
    const energy = allDetails ? energyOf(t.tier) : '';
    const note = str(t.tier?.note);
    if (mood) fields.push({name: 'Mood', value: capText(escapeText(mood), LIMIT.fieldValue), inline: true});
    if (location) fields.push({name: 'Location', value: capText(escapeText(location), LIMIT.fieldValue), inline: true});
    if (energy) fields.push({name: 'Energy', value: capText(energy, LIMIT.fieldValue), inline: true});
    if (note) fields.push({name: 'Note', value: capText(escapeText(note), LIMIT.fieldValue)});
  }

  const start = frontSessionStart(front, i.own ? undefined : id => byId.has(id));
  const e: APIEmbed = {
    author: {name: ellipsize(str(i.systemName) || 'Unnamed System', LIMIT.author), ...(i.systemAvatarUrl ? {icon_url: i.systemAvatarUrl} : {})},
    title: 'Currently Fronting',
    fields,
  };
  if (typeof start === 'number' && Number.isFinite(start) && start > 0) {
    e.description = `Fronting for ${fmtDur(start, now)} · since <t:${Math.floor(start / 1000)}:f>`;
  }
  const dropped = fitFields(e, 40);
  if (dropped) e.footer = {text: notShown(dropped)};
  return {embed: e, showsPrivate};
};
