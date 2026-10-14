// Vault record shapes, copied from the Plural Star app (src/utils.ts) as plain types.
// Keep in step with the app; nothing here imports app code.

export interface SystemInfo {
  name: string;
  description: string;
  journalPassword?: string;
  avatar?: string;
  banner?: string;
}

export type GroupNodeKind = 'group' | 'subsystem';

export interface MemberGroup {
  id: string;
  name: string;
  color?: string;
  kind?: GroupNodeKind;
  parentId?: string | null;
  sortOrder?: number;
  sourceId?: string;
  description?: string;
  linkedMemberId?: string;
}

export type CustomFieldType = 'text' | 'markdown' | 'date' | 'dateRange' | 'number' | 'toggle' | 'color' | 'month' | 'year' | 'monthYear' | 'timestamp' | 'monthDay' | 'image';

export interface CustomFieldDef {
  id: string;
  name: string;
  type: CustomFieldType;
  sortOrder?: number;
  markdown?: boolean;
}

export interface CustomFieldValue {
  fieldId: string;
  value: string | number | boolean | null;
}

export type MemberSortMode = 'alphabetical' | 'reverse-alphabetical' | 'age' | 'color' | 'role' | 'manual';
export type FrontSortMode = 'added' | 'az' | 'za' | 'custom';

export interface Member {
  id: string;
  name: string;
  pronouns: string;
  role: string;
  color: string;
  emoji?: string;
  description: string;
  tags?: string[];
  groupIds?: string[];
  archived?: boolean;
  deleted?: boolean;
  avatar?: string;
  avatarTransparent?: boolean;
  profileBg?: boolean;
  private?: boolean;
  banner?: string;
  customFields?: CustomFieldValue[];
  sortOrder?: number;
  createdAt?: number;
  sourceId?: string;
  isCustomFront?: boolean;
  isFacet?: boolean;
  nickname?: string;
  mailboxPassword?: string;
  pkProxyTags?: {prefix?: string | null; suffix?: string | null}[];
  pkAvatarUrl?: string;
  pkBannerUrl?: string;
  pkKeepProxy?: boolean;
}

export type HistoryChangeType = 'front' | 'mood' | 'location' | 'note';
export type FrontTierKey = 'primary' | 'coFront' | 'coConscious';

export interface FrontTier {
  memberIds: string[];
  mood?: string;
  note: string;
  location?: string;
  energyLevel?: number;
}

export interface FrontState {
  primary: FrontTier;
  coFront: FrontTier;
  coConscious: FrontTier;
  startTime: number;
  memberSince?: Record<string, number>;
}

export interface HistoryEntry {
  memberIds: string[];
  startTime: number;
  endTime: number | null;
  note: string;
  mood?: string;
  location?: string;
  energyLevel?: number;
  coFrontIds?: string[];
  coFrontMood?: string;
  coFrontNote?: string;
  coFrontEnergy?: number;
  coFrontLocation?: string;
  coConsciousIds?: string[];
  coConsciousMood?: string;
  coConsciousNote?: string;
  coConsciousEnergy?: number;
  coConsciousLocation?: string;
  changeType?: HistoryChangeType;
  changeTime?: number;
  changeTier?: FrontTierKey;
}

export type TextScale = 1.0 | 1.25 | 1.5;

export type AccountMode = 'system' | 'singlet';

/** The app's SUPPORTED_LANGUAGES (src/i18n/i18n.ts). */
export type SupportedLanguage =
  | 'en' | 'es' | 'fr' | 'de' | 'nl' | 'pt' | 'fi' | 'sv' | 'nb' | 'is' | 'it' | 'pl'
  | 'tr' | 'ms' | 'vi' | 'th' | 'hi' | 'af' | 'zh' | 'zhHant' | 'ja' | 'ko' | 'ru' | 'uk';

/** The app's FontChoice (src/theme.ts). */
export type FontChoice = 'default' | 'opendyslexic' | 'atkinson' | 'lexend' | 'comicneue' | 'cause' | 'gelasio' | 'anton';

export interface AppSettings {
  accountMode?: AccountMode;
  selfMemberId?: string;
  locations: string[];
  customMoods: string[];
  lightMode: boolean;
  gpsEnabled: boolean;
  filesEnabled: boolean;
  language: SupportedLanguage;
  notificationsEnabled: boolean;
  notificationRefreshMinutes?: number;
  terminology?: Record<string, string>;
  tierNames?: Record<string, string>;
  persistentFrontNotif?: boolean;
  activePaletteId: string;
  textScale: TextScale;
  memberSortMode?: MemberSortMode;
  groupSortMode?: MemberSortMode;
  frontSortMode?: FrontSortMode;
  frontCustomOrder?: string[];
  frontCheckInterval?: number;
  noteboardNotifications?: boolean;
  appLockPassword?: string;
  useDyslexicFont?: boolean;
  fontChoice?: FontChoice;
  customFrontsSeeded?: boolean;
  memberListFields?: {groups?: boolean; descriptions?: boolean; pronouns?: boolean; roles?: boolean; count?: boolean; background?: 'plain' | 'color' | 'banner'; browse?: boolean};
}

/** Vault storage keys, as in the app's KEYS (src/storage.ts). */
export const VAULT_KEYS = {
  system: 'ps:system',
  members: 'ps:members',
  front: 'ps:front',
  history: 'ps:history',
  settings: 'ps:settings',
  groups: 'ps:groups',
  customFieldDefs: 'ps:customFieldDefs',
} as const;

/** Media keys (values are data URIs after a pull). */
export const MEDIA_KEYS = {
  memberAvatar: (memberId: string): string => `ps:media:av:${memberId}`,
  memberBanner: (memberId: string): string => `ps:media:bn:${memberId}`,
  systemAvatar: 'ps:media:sysav',
  systemBanner: 'ps:media:sysbn',
} as const;

/** Keys the avatar server may serve publicly (avatars and banners only). */
export const isPublicImageKey = (key: string): boolean =>
  key.startsWith('ps:media:av:') || key.startsWith('ps:media:bn:') || key === MEDIA_KEYS.systemAvatar || key === MEDIA_KEYS.systemBanner;
