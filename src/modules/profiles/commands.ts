// /member, /system and /front.
import {APIEmbed, ChatInputCommandInteraction, escapeMarkdown, MessageFlags, SlashCommandBuilder, User} from 'discord.js';
import {avatarUrlFor} from '../../avatars';
import {CloudError} from '../../cloud/cloudTypes';
import {log} from '../../log';
import {linkedSession, peekSession} from '../../vault/registry';
import {LINK_BROKEN_TEXT, type PushResult, type VaultSession} from '../../vault/session';
import {FrontState, FrontTierKey, MEDIA_KEYS, Member, VAULT_KEYS} from '../../vault/types';
import {frontView, memberCard, systemCard} from './cards';
import {allFrontMemberIds, clearTiers, FrontTiers, quickAddTiers, readFront, removeTiers, setFrontTiers, updateFront} from './frontLogic';
import {findByName, isShown, nameCandidates, visibleMembers} from './lookup';
import type {MentionNames} from './richText';

const NOT_LINKED = 'Link your vault first: DM me /link';
const SERVER_ONLY = 'This command only works in a server.';
const NOT_LOADED = 'That vault could not be read just now. Try again in a minute.';
const NOBODY = 'Nobody is fronting.';

const TIER_CHOICES = [
  {name: 'Primary', value: 'primary'},
  {name: 'Co-Front', value: 'cofront'},
  {name: 'Co-Conscious', value: 'coconscious'},
] as const;
const TIER_OF: Record<string, FrontTierKey> = {primary: 'primary', cofront: 'coFront', coconscious: 'coConscious'};

export const memberCommand = new SlashCommandBuilder()
  .setName('member')
  .setDescription("Show a member's profile")
  .addStringOption(o => o.setName('name').setDescription('Member name or nickname').setRequired(true).setMaxLength(100))
  .addUserOption(o => o.setName('user').setDescription('Whose system (default: yours)'));

export const systemCommand = new SlashCommandBuilder()
  .setName('system')
  .setDescription("Show a system's profile")
  .addUserOption(o => o.setName('user').setDescription('Whose system (default: yours)'));

export const frontCommand = new SlashCommandBuilder()
  .setName('front')
  .setDescription('Who is fronting, or change the front')
  .addSubcommand(s =>
    s
      .setName('show')
      .setDescription('Who is fronting, by tier, with how long')
      .addUserOption(o => o.setName('user').setDescription('Whose system (default: yours)')),
  )
  .addSubcommand(s =>
    s
      .setName('set')
      .setDescription('Set who fronts in a tier, like Set Front in the app')
      .addStringOption(o => o.setName('member').setDescription('Member name, or several separated by commas').setRequired(true).setMaxLength(1000))
      .addStringOption(o => o.setName('tier').setDescription('Tier (default: primary)').addChoices(...TIER_CHOICES)),
  )
  .addSubcommand(s =>
    s
      .setName('add')
      .setDescription('Add a member to the front')
      .addStringOption(o => o.setName('member').setDescription('Member name').setRequired(true).setMaxLength(100))
      .addStringOption(o => o.setName('tier').setDescription('Tier (default: primary)').addChoices(...TIER_CHOICES)),
  )
  .addSubcommand(s =>
    s
      .setName('remove')
      .setDescription('Take a member off the front')
      .addStringOption(o => o.setName('member').setDescription('Member name').setRequired(true).setMaxLength(100)),
  )
  .addSubcommand(s => s.setName('clear').setDescription('Clear the front (every tier)'));

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- replying --------------------------------------------------------------------
//
// Private members are shown only to their own user, in a reply only that user sees. Discord fixes a
// deferred reply's visibility when it is deferred, so each command decides up front, from the vault
// already in memory, whether its answer could name a private member (or count one among the members
// a name matches). When the caller's own vault is not in memory yet there is nothing to decide from,
// so the reply goes to the caller only. A public reply never names a private member: it is rendered
// as everyone else would see it.

interface Payload {
  content?: string;
  embeds?: APIEmbed[];
}

const defer = (i: ChatInputCommandInteraction, onlyCaller: boolean): Promise<unknown> =>
  i.deferReply(onlyCaller ? {flags: MessageFlags.Ephemeral} : {});

const say = async (i: ChatInputCommandInteraction, p: Payload): Promise<void> => {
  await i.editReply({content: p.content ?? '', embeds: p.embeds ?? [], allowedMentions: {parse: []}});
};

const guildOnly = async (i: ChatInputCommandInteraction): Promise<boolean> => {
  if (i.inGuild()) return true;
  await i.reply({content: SERVER_ONLY, flags: MessageFlags.Ephemeral});
  return false;
};

/** The caller's own linked session when its vault is already in memory (no loading, no network). */
const ownInMemory = (i: ChatInputCommandInteraction): VaultSession | null => {
  const s = peekSession(i.user.id);
  return s?.isLinked() && s.isLoaded() ? s : null;
};

/** Whether the session holds these vault keys in memory (every one the cloud has has been pulled). */
const holds = (s: VaultSession, keys: string[]): boolean => {
  const known = s.platform.link()?.known || {};
  return keys.every(k => s.platform.get(k) !== undefined || !known[k]);
};

interface Target {
  session: VaultSession;
  user: User;
  own: boolean;
}

/**
 * The linked, freshened session of `user` (checked first when the last check is older than
 * `maxAgeMs`, by default 30 s). Null after telling the caller why not.
 */
const targetOf = async (i: ChatInputCommandInteraction, user: User, maxAgeMs?: number): Promise<Target | null> => {
  const own = user.id === i.user.id;
  let session: VaultSession | null;
  try {
    session = await linkedSession(user.id);
  } catch (e) {
    if (!(e instanceof CloudError)) log.exception(e, 'Could not open the vault session for %s.', user.id);
    await say(i, {content: `❌ Could not open ${own ? 'your' : 'that'} vault: ${errorText(e)}`});
    return null;
  }
  if (!session) {
    await say(i, {content: own ? NOT_LINKED : `${user} has not linked a Plural Star vault.`});
    return null;
  }
  try {
    await session.freshen(maxAgeMs);
  } catch (e) {
    const broken = e instanceof CloudError && e.code === 'link broken';
    if (!(e instanceof CloudError)) log.exception(e, 'Could not read the vault of %s.', user.id);
    await say(i, {content: broken && own ? `❌ ${LINK_BROKEN_TEXT}` : NOT_LOADED});
    return null;
  }
  if (!holds(session, [VAULT_KEYS.members, VAULT_KEYS.front, VAULT_KEYS.history, VAULT_KEYS.system])) {
    await say(i, {content: NOT_LOADED});
    return null;
  }
  return {session, user, own};
};

const KEEPS_TRYING = 'Plural Starbot keeps trying; if the bot restarts before it gets through, the change is lost.';

/**
 * What the reply says above the front when the change did not fully reach the vault. The vault
 * settles ps:front and ps:history each on its own, so another device's change can win one of them.
 */
const pushProblem = (r: PushResult): string | null => {
  if (r.ok) return null;
  if (r.reason === 'conflict') {
    if (r.replaced.includes(VAULT_KEYS.front)) {
      return '⚠️ The front was changed on another device at the same moment, so this change was not saved. This is the front in your vault now:';
    }
    if (r.saved.includes(VAULT_KEYS.front)) {
      return (
        '⚠️ The front was saved, but the front history was changed on another device at the same moment, ' +
        'so this change has no entry in the front history. This is the front in your vault now:'
      );
    }
    return (
      '⚠️ The front history was changed on another device at the same moment, so this change has no entry in the ' +
      `front history, and the front is not saved to your vault yet. ${KEEPS_TRYING}`
    );
  }
  const why = r.reason === 'pending' ? 'saving is taking longer than usual' : r.error || 'the Plural Star cloud could not be reached';
  return `⚠️ The front changed here, but it is not saved to your vault yet (${why}). ${KEEPS_TRYING}`;
};

/** Mention names in descriptions: members the reader may see; anyone else keeps the name stored in the text. */
const mentionNames = (members: Member[], showPrivate: boolean): MentionNames => {
  const byId = new Map(visibleMembers(members, showPrivate).map(m => [m.id, m] as const));
  return id => {
    const n = byId.get(id)?.name;
    return typeof n === 'string' && n.trim() ? n.trim() : undefined;
  };
};

const bold = (s: string): string => `**${escapeMarkdown(s.trim())}**`;
const noMember = (name: string): string => `No member named ${bold(name)}.`;
const ambiguous = (name: string, count: number, prefix: boolean): string =>
  prefix ? `${count} members start with ${bold(name)}. Type more of the name.` : `${count} members are called ${bold(name)}.`;

/** ps:front as the app reads it; undefined when it holds something unreadable. */
const currentFront = (s: VaultSession): FrontState | null | undefined => {
  const raw = s.platform.get(VAULT_KEYS.front);
  if (raw === undefined) return null;
  const parsed = safeParse(raw);
  if (parsed === null) return null;
  return readFront(parsed) ?? undefined;
};

const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

// ---- /member -------------------------------------------------------------------------

export const handleMember = async (i: ChatInputCommandInteraction): Promise<void> => {
  if (!(await guildOnly(i))) return;
  const query = i.options.getString('name', true);
  const user = i.options.getUser('user') ?? i.user;
  const own = user.id === i.user.id;
  const pre = own ? ownInMemory(i) : null;
  // Own vault: the answer goes to the caller only when any member the name matches is private.
  const onlyCaller = own && (!pre || nameCandidates(visibleMembers(pre.members(), true), query).some(m => m.private === true));
  await defer(i, onlyCaller);

  const t = await targetOf(i, user);
  if (!t) return;
  const showPrivate = t.own && onlyCaller;
  const all = t.session.members();
  // Someone else's private member gets the same answer as a name that does not exist.
  const found = findByName(visibleMembers(all, showPrivate), query);
  if (found.kind === 'none') {
    await say(i, {content: noMember(query)});
    return;
  }
  if (found.kind === 'ambiguous') {
    await say(i, {content: ambiguous(query, found.count, found.prefix)});
    return;
  }
  const m = found.member;
  const embeds = memberCard({
    member: m,
    groups: t.session.groups(),
    fieldDefs: t.session.customFieldDefs(),
    names: mentionNames(all, showPrivate),
    avatarUrl: avatarUrlFor(t.session, MEDIA_KEYS.memberAvatar(m.id)),
    bannerUrl: avatarUrlFor(t.session, MEDIA_KEYS.memberBanner(m.id)),
    ownerView: t.own,
  });
  await say(i, {embeds});
};

// ---- /system -------------------------------------------------------------------------

export const handleSystem = async (i: ChatInputCommandInteraction): Promise<void> => {
  if (!(await guildOnly(i))) return;
  const user = i.options.getUser('user') ?? i.user;
  await defer(i, false);
  const t = await targetOf(i, user);
  if (!t) return;
  const members = t.session.members();
  const embeds = systemCard({
    system: t.session.system(),
    members,
    discordUserId: t.user.id,
    names: mentionNames(members, false),
    avatarUrl: avatarUrlFor(t.session, MEDIA_KEYS.systemAvatar),
    bannerUrl: avatarUrlFor(t.session, MEDIA_KEYS.systemBanner),
  });
  await say(i, {embeds});
};

// ---- /front --------------------------------------------------------------------------

const showFront = async (i: ChatInputCommandInteraction, t: Target, showPrivate: boolean, note: string | null = null): Promise<void> => {
  const view = frontView({
    front: currentFront(t.session) ?? null,
    members: t.session.members(),
    own: t.own && showPrivate,
    ownerView: t.own,
    settings: t.session.settings(),
    systemName: t.session.system()?.name || '',
    systemAvatarUrl: avatarUrlFor(t.session, MEDIA_KEYS.systemAvatar),
  });
  if (view.embed) await say(i, note ? {content: note, embeds: [view.embed]} : {embeds: [view.embed]});
  else await say(i, {content: note ? `${note}\n${NOBODY}` : NOBODY});
};

const handleShow = async (i: ChatInputCommandInteraction): Promise<void> => {
  const user = i.options.getUser('user') ?? i.user;
  const own = user.id === i.user.id;
  const pre = own ? ownInMemory(i) : null;
  const onlyCaller =
    own &&
    (!pre ||
      frontView({front: currentFront(pre) ?? null, members: pre.members(), own: true, settings: pre.settings(), systemName: ''}).showsPrivate);
  await defer(i, onlyCaller);
  const t = await targetOf(i, user);
  if (!t) return;
  await showFront(i, t, onlyCaller);
};

const namesOf = (i: ChatInputCommandInteraction, sub: string): string[] => {
  if (sub === 'clear') return [];
  const raw = i.options.getString('member', true);
  const list = sub === 'set' ? raw.split(',') : [raw];
  return list.map(n => n.trim()).filter(Boolean);
};

/**
 * Whether the reply to this change could name a private member, or count one among the members a name
 * matches (from the vault in memory; errs towards private).
 */
const changeShowsPrivate = (s: VaultSession, sub: string, names: string[]): boolean => {
  if (sub === 'clear') return false;
  const pool = s.members().filter(isShown);
  const byId = new Map(pool.map(m => [m.id, m] as const));
  const named = names.flatMap(n => nameCandidates(pool, n));
  const fronting = allFrontMemberIds(currentFront(s) ?? null);
  return named.some(m => m.private === true) || fronting.some(id => byId.get(id)?.private === true);
};

const changeFront = async (i: ChatInputCommandInteraction, sub: string): Promise<void> => {
  const names = namesOf(i, sub);
  const pre = ownInMemory(i);
  const onlyCaller = !pre || changeShowsPrivate(pre, sub, names);
  await defer(i, onlyCaller);
  // Check the vault right before changing it, so the change starts from what other devices wrote last.
  const t = await targetOf(i, i.user, 0);
  if (!t) return;
  const s = t.session;

  const front = currentFront(s);
  const rawHistory = s.platform.get(VAULT_KEYS.history);
  if (front === undefined || (rawHistory !== undefined && !Array.isArray(safeParse(rawHistory)))) {
    await say(i, {content: 'The front or front history in your vault could not be read, so the front was not changed.'});
    return;
  }
  const pool = s.members().filter(isShown);
  const resolve = async (name: string): Promise<Member | null> => {
    const found = findByName(pool, name);
    if (found.kind === 'found') return found.member;
    await say(i, {content: found.kind === 'none' ? noMember(name) : ambiguous(name, found.count, found.prefix)});
    return null;
  };

  let tiers: FrontTiers | null;
  if (sub === 'clear') {
    tiers = clearTiers();
  } else if (sub === 'set') {
    if (!names.length) {
      await say(i, {content: 'Name at least one member.'});
      return;
    }
    const ids: string[] = [];
    for (const name of names) {
      const m = await resolve(name);
      if (!m) return;
      if (!ids.includes(m.id)) ids.push(m.id);
    }
    tiers = setFrontTiers(front, TIER_OF[i.options.getString('tier') ?? 'primary'] ?? 'primary', ids);
  } else {
    const m = await resolve(names[0] ?? '');
    if (!m) return;
    if (sub === 'add') {
      tiers = quickAddTiers(front, m.id, TIER_OF[i.options.getString('tier') ?? 'primary'] ?? 'primary');
    } else {
      tiers = allFrontMemberIds(front).includes(m.id) ? removeTiers(front, m.id) : null;
      if (!tiers) {
        await say(i, {content: `${bold(names[0] ?? '')} is not fronting.`});
        return;
      }
    }
  }

  const next = updateFront(front, s.history(), tiers.primary, tiers.coFront, tiers.coConscious);
  let pushed: PushResult;
  try {
    pushed = await s.writeAndPush({[VAULT_KEYS.front]: next.front, [VAULT_KEYS.history]: next.history});
  } catch (e) {
    log.warn('Front change for user %s failed: %s', i.user.id, errorText(e));
    await say(i, {content: `❌ Could not change the front: ${errorText(e)}`});
    return;
  }
  const problem = pushProblem(pushed);
  if (problem) log.warn('Front change for user %s not saved to the vault: %s', i.user.id, pushed.ok ? '' : pushed.reason);
  await showFront(i, t, onlyCaller, problem);
};

export const handleFront = async (i: ChatInputCommandInteraction): Promise<void> => {
  if (!(await guildOnly(i))) return;
  const sub = i.options.getSubcommand();
  if (sub === 'show') await handleShow(i);
  else if (sub === 'set' || sub === 'add' || sub === 'remove' || sub === 'clear') await changeFront(i, sub);
};
