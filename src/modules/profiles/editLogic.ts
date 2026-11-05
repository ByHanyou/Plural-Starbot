import {isRecord} from '../../util';
import {parseFieldDate, parseFieldRange} from '../../vault/fieldDates';
import {type CustomFieldDef, MEDIA_KEYS} from '../../vault/types';
import {nameKey} from './lookup';

export type TextField = 'name' | 'nickname' | 'pronouns' | 'role' | 'color' | 'emoji' | 'description';
export type ImageField = 'avatar' | 'banner';
export type SystemTextField = 'name' | 'description';
export type FieldValue = string | number | boolean;

export type MemberField = {kind: 'text'; field: TextField} | {kind: 'image'; field: ImageField} | {kind: 'custom'; def: CustomFieldDef};
export type FieldMatch = MemberField | {kind: 'none'} | {kind: 'ambiguous'; names: string[]};

export const TEXT_FIELDS: readonly TextField[] = ['name', 'nickname', 'pronouns', 'role', 'color', 'emoji', 'description'];
export const IMAGE_FIELDS: readonly ImageField[] = ['avatar', 'banner'];

const ALIASES: Record<string, TextField | ImageField> = {
  name: 'name',
  nickname: 'nickname',
  displayname: 'nickname',
  nick: 'nickname',
  pronouns: 'pronouns',
  role: 'role',
  color: 'color',
  colour: 'color',
  emoji: 'emoji',
  description: 'description',
  desc: 'description',
  bio: 'description',
  avatar: 'avatar',
  pfp: 'avatar',
  banner: 'banner',
};

const OPTIONAL_TEXT = new Set<TextField>(['nickname', 'emoji']);
const DATE_TYPES = new Set(['date', 'month', 'year', 'monthYear', 'timestamp', 'monthDay']);
const COLOR_RE = /^#?([0-9a-fA-F]{6})$/;

const isImageField = (f: TextField | ImageField): f is ImageField => f === 'avatar' || f === 'banner';

const validDefs = (defs: CustomFieldDef[]): CustomFieldDef[] => defs.filter(d => isRecord(d) && typeof d.id === 'string' && typeof d.name === 'string');

export const resolveMemberField = (raw: string, defs: CustomFieldDef[]): FieldMatch => {
  const q = nameKey(raw);
  if (!q) return {kind: 'none'};
  const builtin = ALIASES[q.replace(/[\s_-]+/g, '')];
  if (builtin) return isImageField(builtin) ? {kind: 'image', field: builtin} : {kind: 'text', field: builtin};
  const pool = validDefs(defs);
  const exact = pool.filter(d => nameKey(d.name) === q);
  if (exact.length === 1) return {kind: 'custom', def: exact[0]};
  if (exact.length > 1) return {kind: 'ambiguous', names: exact.map(d => d.name)};
  const prefixed = pool.filter(d => nameKey(d.name).startsWith(q));
  if (prefixed.length === 1) return {kind: 'custom', def: prefixed[0]};
  if (prefixed.length > 1) return {kind: 'ambiguous', names: prefixed.map(d => d.name)};
  return {kind: 'none'};
};

export const fieldNames = (defs: CustomFieldDef[]): string[] => [...TEXT_FIELDS, ...IMAGE_FIELDS, ...validDefs(defs).map(d => d.name.trim()).filter(Boolean)];

export const fieldLabel = (f: MemberField): string => (f.kind === 'custom' ? f.def.name.trim() || f.def.id : f.field);

export const isImageTarget = (f: MemberField): boolean => f.kind === 'image' || (f.kind === 'custom' && f.def.type === 'image');

export const mediaKeyOf = (f: MemberField, memberId: string): string | null => {
  if (f.kind === 'image') return f.field === 'avatar' ? MEDIA_KEYS.memberAvatar(memberId) : MEDIA_KEYS.memberBanner(memberId);
  if (f.kind === 'custom' && f.def.type === 'image') return MEDIA_KEYS.customField(memberId, f.def.id);
  return null;
};

export const imageKindOf = (f: MemberField): 'avatar' | 'banner' | 'field' => (f.kind === 'image' ? f.field : 'field');

export const systemMediaKey = (field: ImageField): string => (field === 'avatar' ? MEDIA_KEYS.systemAvatar : MEDIA_KEYS.systemBanner);

export const parseColor = (raw: string): string | null => {
  const m = COLOR_RE.exec(raw.trim());
  return m ? `#${m[1].toUpperCase()}` : null;
};

export type ParsedValue = {ok: true; value: FieldValue} | {ok: false; error: string};

const bad = (error: string): ParsedValue => ({ok: false, error});

const parseToggle = (value: string): boolean | null => {
  const v = value.toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(v)) return true;
  if (['false', 'no', 'off', '0'].includes(v)) return false;
  return null;
};

export const parseFieldValue = (f: MemberField, raw: string): ParsedValue => {
  const value = raw.trim();
  if (!value) return bad('Give a value, or `clear`.');
  if (f.kind === 'image') return bad(`${f.field} is an image. Attach one or give a link to one.`);
  if (f.kind === 'text') {
    if (f.field !== 'color') return {ok: true, value};
    const color = parseColor(value);
    return color ? {ok: true, value: color} : bad('A color is six hex digits, like `#7B61FF`.');
  }
  const name = fieldLabel(f);
  switch (f.def.type) {
    case 'image':
      return bad(`${name} is an image field. Attach an image or give a link to one.`);
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? {ok: true, value: n} : bad(`${name} takes a number.`);
    }
    case 'toggle': {
      const t = parseToggle(value);
      return t === null ? bad(`${name} takes true or false.`) : {ok: true, value: t};
    }
    case 'color': {
      const color = parseColor(value);
      return color ? {ok: true, value: color} : bad(`${name} takes a color: six hex digits, like \`#7B61FF\`.`);
    }
    case 'dateRange':
      return parseFieldRange(value) ? {ok: true, value} : bad(`${name} takes a date range: a start and an end separated by |, like \`2020-01-01|2021-06-30\`.`);
    default:
      if (DATE_TYPES.has(f.def.type)) return parseFieldDate(value) ? {ok: true, value} : bad(`${name} takes a date, like \`2020-06-15\`, \`2020-06\` or \`2020\`.`);
      return {ok: true, value};
  }
};

const parseList = (raw: string): unknown[] | null => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

const parseObject = (raw: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
};

const memberRecord = (list: unknown[], memberId: string): Record<string, unknown> | null => {
  const m = list.find(x => isRecord(x) && x.id === memberId);
  return isRecord(m) ? m : null;
};

export const withMemberField = (raw: string, memberId: string, f: MemberField, value: FieldValue | null): unknown[] | null => {
  const list = parseList(raw);
  const m = list ? memberRecord(list, memberId) : null;
  if (!list || !m || f.kind === 'image') return null;
  if (f.kind === 'text') {
    if (value !== null) m[f.field] = value;
    else if (OPTIONAL_TEXT.has(f.field)) delete m[f.field];
    else m[f.field] = '';
    return list;
  }
  const fields: unknown[] = Array.isArray(m.customFields) ? m.customFields : [];
  const at = fields.findIndex(c => isRecord(c) && c.fieldId === f.def.id);
  const next = value === null ? '' : value;
  const current = at >= 0 ? fields[at] : null;
  if (isRecord(current)) fields[at] = {...current, value: next};
  else fields.push({fieldId: f.def.id, value: next});
  m.customFields = fields;
  return list;
};

export type EntryOutcome = {kind: 'missing'} | {kind: 'present'} | {kind: 'added'; list: unknown[]};

export const withCustomEntry = (raw: string, memberId: string, fieldId: string): EntryOutcome => {
  const list = parseList(raw);
  const m = list ? memberRecord(list, memberId) : null;
  if (!list || !m) return {kind: 'missing'};
  const fields: unknown[] = Array.isArray(m.customFields) ? m.customFields : [];
  if (fields.some(c => isRecord(c) && c.fieldId === fieldId)) return {kind: 'present'};
  fields.push({fieldId, value: ''});
  m.customFields = fields;
  return {kind: 'added', list};
};

export const withSystemField = (raw: string, field: SystemTextField, value: string | null): Record<string, unknown> | null => {
  const sys = parseObject(raw);
  if (!sys) return null;
  sys[field] = value ?? '';
  return sys;
};
