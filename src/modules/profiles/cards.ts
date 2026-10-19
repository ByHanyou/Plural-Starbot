import {ActionRowBuilder, type APIEmbed, type APIEmbedField, ButtonBuilder, ButtonStyle, ContainerBuilder} from 'discord.js';
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

const notShown = (dropped: number): string => (dropped ? `${dropped} more field${dropped === 1 ? '' : 's'} not shown` : '');

const bannerEmbed = (url: string, color: number | null): APIEmbed => (color !== null ? {color, image: {url}} : {image: {url}});

const chip = (s: string): string => (s.includes('`') ? escapeText(s) : '`' + s + '`');

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

const groupChip = (g: MemberGroup): string => `${groupKind(g) === 'subsystem' ? '■' : '●'} ${escapeText(str(g.name) || '-')}`;

const linkedSubsystemsOf = (groups: MemberGroup[], memberId: string): MemberGroup[] =>
  memberId ? groups.filter(g => groupKind(g) === 'subsystem' && g.linkedMemberId === memberId) : [];

type DateMode = 'date' | 'datetime' | 'monthYear' | 'month' | 'year' | 'monthDay';
const DATE_MODES: Record<string, DateMode> = {date: 'date', timestamp: 'datetime', monthYear: 'monthYear', month: 'month', year: 'year', monthDay: 'monthDay'};
const LOCALE = 'en-US';

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

export interface MemberCardNav {
  ownerId: string;
  privateView: boolean;
}

export interface MemberPageRef extends MemberCardNav {
  page: number;
  ownerView: boolean;
  memberId: string;
}

export type CardComponents = (ContainerBuilder | ActionRowBuilder<ButtonBuilder>)[];

export interface MemberCardInput {
  member: Member;
  groups: MemberGroup[];
  fieldDefs: CustomFieldDef[];
  names?: MentionNames;
  avatarUrl?: string;
  bannerUrl?: string;
  fieldImageUrl?: (fieldId: string) => string | undefined;
  ownerView?: boolean;
  page?: number;
  nav?: MemberCardNav;
}

const LINKED_SUBSYSTEMS = '**Linked Sub-systems**';
const DESCRIPTION_BIO = '**Description / Bio**';
const CUSTOM_FIELDS = '**Custom Fields**';
const IMAGE_NOT_SYNCED = '-# (image not in the cloud: turn on “Include full-size images” in the app)';

interface CustomItem {
  text: string;
  imageUrl?: string;
}

export const MEMBER_PAGE_ID = 'profiles:member-page:';
const PAGE_LABEL_ID = 'profiles:member-page-label';
const V2_LIMIT = {components: 40, text: 4000, customId: 100};
const FIELD_PAGE_FRAME = 6;

const memberPageId = (page: number, nav: MemberCardNav, ownerView: boolean, memberId: string): string =>
  `${MEMBER_PAGE_ID}${page}:${nav.ownerId}:${nav.privateView ? 1 : 0}:${ownerView ? 1 : 0}:${memberId}`;

export const parseMemberPageId = (customId: string): MemberPageRef | null => {
  if (!customId.startsWith(MEMBER_PAGE_ID)) return null;
  const m = /^(\d{1,4}):(\d{1,20}):([01]):([01]):(.+)$/.exec(customId.slice(MEMBER_PAGE_ID.length));
  return m ? {page: Number(m[1]), ownerId: m[2], privateView: m[3] === '1', ownerView: m[4] === '1', memberId: m[5]} : null;
};

const heading = (name: string): string => `## ${escapeText(ellipsize(name, LIMIT.title))}`;

const textLength = (parts: string[]): number => parts.reduce((n, s) => n + s.length, 0);

const fitTexts = (parts: string[], max: number): string[] => {
  const out = [...parts];
  let over = textLength(out) - max;
  while (over > 0) {
    let k = 0;
    for (let j = 1; j < out.length; j++) if (out[j].length > out[k].length) k = j;
    const room = out[k].length - over;
    out[k] = room < 2 ? '' : capText(out[k], room);
    over = textLength(out) - max;
  }
  return out;
};

const addText = (box: ContainerBuilder, text: string): void => {
  if (text) box.addTextDisplayComponents(t => t.setContent(text));
};

const addHeader = (box: ContainerBuilder, text: string, avatarUrl: string | undefined): void => {
  if (!text) return;
  if (!avatarUrl) {
    addText(box, text);
    return;
  }
  const url = avatarUrl;
  box.addSectionComponents(s => s.addTextDisplayComponents(t => t.setContent(text)).setThumbnailAccessory(a => a.setURL(url)));
};

const addBanner = (box: ContainerBuilder, bannerUrl: string | undefined): void => {
  if (!bannerUrl) return;
  const url = bannerUrl;
  box.addMediaGalleryComponents(g => g.addItems(item => item.setURL(url)));
};

const pageFields = (items: CustomItem[]): CustomItem[][] => {
  const perPage = V2_LIMIT.components - FIELD_PAGE_FRAME;
  const budget = V2_LIMIT.text - CUSTOM_FIELDS.length;
  const pages: CustomItem[][] = [];
  let page: CustomItem[] = [];
  let used = 0;
  let slots = 0;
  for (const item of items) {
    const text = capText(item.text, budget);
    const need = item.imageUrl ? 2 : 1;
    if (page.length && (slots + need > perPage || used + text.length > budget)) {
      pages.push(page);
      page = [];
      used = 0;
      slots = 0;
    }
    page.push({text, imageUrl: item.imageUrl});
    used += text.length;
    slots += need;
  }
  if (page.length) pages.push(page);
  return pages;
};

const navRow = (
  memberId: string,
  page: number,
  pages: number,
  nav: MemberCardNav | undefined,
  ownerView: boolean,
): ActionRowBuilder<ButtonBuilder> | null => {
  if (!nav || pages < 2) return null;
  const prev = memberPageId(Math.max(0, page - 1), nav, ownerView, memberId);
  const next = memberPageId(Math.min(pages - 1, page + 1), nav, ownerView, memberId);
  if (prev.length > V2_LIMIT.customId || next.length > V2_LIMIT.customId) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(prev).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(PAGE_LABEL_ID).setLabel(`Page ${page + 1} of ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(next).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
  );
};

export const memberCard = (i: MemberCardInput): CardComponents => {
  const m = i.member;
  const name = str(m.name) || 'Member';
  const color = embedColor(m.color);
  const box = new ContainerBuilder();
  if (color !== null) box.setAccentColor(color);

  if (m.isCustomFront) {
    const [title, desc] = fitTexts([heading(name), descriptionToDiscord(m.description, i.names)], V2_LIMIT.text);
    addText(box, title);
    addText(box, desc);
    return [box];
  }

  const head: string[] = [heading(name)];
  if (str(m.pronouns)) head.push(escapeText(str(m.pronouns)));
  if (str(m.role)) head.push(`*${escapeText(str(m.role))}*`);
  const chips: string[] = [];
  if (str(m.color)) chips.push(chip(str(m.color)));
  if (str(m.emoji)) chips.push(str(m.emoji));
  const badges: string[] = [];
  if (chips.length) badges.push(chips.join(' · '));
  const tags = Array.isArray(m.tags) ? m.tags.map(str).filter(Boolean) : [];
  if (tags.length) badges.push(tags.map(chip).join(' '));
  const allGroups = (Array.isArray(i.groups) ? i.groups : []).filter(g => g && typeof g === 'object' && typeof g.id === 'string');
  const mine = Array.isArray(m.groupIds) ? m.groupIds : [];
  const active = sortGroupsForDisplay(allGroups.filter(g => mine.includes(g.id)), allGroups);
  if (active.length) badges.push(active.map(groupChip).join(' '));

  let linked = '';
  if (i.ownerView) {
    const linkedSubs = sortGroupsForDisplay(linkedSubsystemsOf(allGroups, m.id), allGroups);
    if (linkedSubs.length) linked = `${LINKED_SUBSYSTEMS}\n${linkedSubs.map(groupChip).join(' ')}`;
  }
  const bio = descriptionToDiscord(m.description, i.names);

  const custom: CustomItem[] = [];
  const values = Array.isArray(m.customFields) ? m.customFields : [];
  for (const fd of Array.isArray(i.fieldDefs) ? i.fieldDefs : []) {
    if (!fd || typeof fd !== 'object' || typeof fd.id !== 'string') continue;
    const value = values.find(v => v && v.fieldId === fd.id)?.value;
    const label = `**${escapeText(ellipsize(str(fd.name) || '-', LIMIT.fieldName))}**`;
    if (fd.type === 'image') {
      if (value === undefined || value === null || value === '') continue;
      const url = i.fieldImageUrl?.(fd.id);
      custom.push(url ? {text: label, imageUrl: url} : {text: `${label}\n${IMAGE_NOT_SYNCED}`});
      continue;
    }
    const text = customFieldText(fd, value, i.names);
    if (text && text.trim()) custom.push({text: `${label}\n${text}`});
  }

  const fieldPages = pageFields(custom);
  const pages = 1 + fieldPages.length;
  const asked = Math.min(Math.max(i.page ?? 0, 0), pages - 1);
  const nav = navRow(m.id, asked, pages, i.nav, i.ownerView === true);
  const page = nav ? asked : 0;

  if (page > 0) {
    addText(box, CUSTOM_FIELDS);
    for (const item of fieldPages[page - 1]) {
      addText(box, item.text);
      addBanner(box, item.imageUrl);
    }
  } else {
    const footer = [m.isFacet ? 'Facet' : '', nav ? '' : notShown(custom.length)].filter(Boolean).join(' · ');
    const [top, middle, subs, about, foot] = fitTexts(
      [head.join('\n'), badges.join('\n'), linked, bio ? `${DESCRIPTION_BIO}\n${bio}` : '', footer ? `-# ${footer}` : ''],
      V2_LIMIT.text,
    );
    addBanner(box, i.bannerUrl);
    addHeader(box, top, i.avatarUrl);
    addText(box, middle);
    addText(box, subs);
    addText(box, about);
    addText(box, foot);
  }
  return nav ? [box, nav] : [box];
};

export interface SystemCardInput {
  system: SystemInfo | null;
  members: Member[];
  discordUserId: string;
  names?: MentionNames;
  avatarUrl?: string;
  bannerUrl?: string;
}

export const publicRosterCount = (members: Member[]): number =>
  visibleMembers(members, false).filter(isRosterMember).length;

export const systemCard = (i: SystemCardInput): CardComponents => {
  const box = new ContainerBuilder();
  const [top, about, facts] = fitTexts(
    [
      heading(str(i.system?.name) || 'Unnamed System'),
      descriptionToDiscord(i.system?.description, i.names) || '*No description yet.*',
      `**Members:** ${publicRosterCount(i.members)}\n**Linked Discord account:** <@${i.discordUserId}>`,
    ],
    V2_LIMIT.text,
  );
  addBanner(box, i.bannerUrl);
  addHeader(box, top, i.avatarUrl);
  addText(box, about);
  addText(box, facts);
  return [box];
};

export interface FrontViewInput {
  front: FrontState | null;
  members: Member[];
  own: boolean;
  ownerView?: boolean;
  settings: AppSettings | null;
  systemName: string;
  systemAvatarUrl?: string;
  now?: number;
}

export interface FrontView {
  embed: APIEmbed | null;
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

const energyOf = (tier: FrontTier | undefined): string => {
  const n: unknown = tier?.energyLevel;
  if (typeof n === 'number' && Number.isFinite(n) && n) return `${n}/10`;
  if (typeof n === 'string' && n.trim()) return `${escapeText(n.trim())}/10`;
  return '';
};

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
