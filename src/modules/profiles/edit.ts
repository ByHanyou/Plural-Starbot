import {type Attachment, MessageFlags} from 'discord.js';
import {CLOUD_OBJECT_MAX_MB} from '../../cloud/cloudKeys';
import type {Command, CommandContext} from '../../discord/commands';
import {type EncodedImage, encodeImage, fetchImage, IMAGE_MAX_BYTES, ImageError, type ImageKind} from '../../images';
import {log} from '../../log';
import {errorText} from '../../util';
import type {PushResult, VaultSession} from '../../vault/session';
import {VAULT_KEYS} from '../../vault/types';
import {ambiguous, bold, KEEPS_TRYING, NOT_LOADED, noMember, ownInMemory, say, targetOf} from './commands';
import {
  fieldLabel,
  fieldNames,
  type FieldValue,
  imageKindOf,
  isImageTarget,
  mediaKeyOf,
  parseFieldValue,
  resolveMemberField,
  systemMediaKey,
  withCustomEntry,
  withMemberField,
  withSystemField,
} from './editLogic';
import {findByName, nameCandidates, visibleMembers} from './lookup';

const CLEAR = 'clear';
const NO_VALUE = 'Give a value, or `clear`.';
const NO_SOURCE = 'Attach an image, give a link to one, or say `clear`.';
const EMPTY_SYSTEM = '{"name":"","description":""}';

type Source = {kind: 'clear'} | {kind: 'none'} | {kind: 'url'; url: string} | {kind: 'error'; error: string};

interface ImageTexts {
  set: string;
  cleared: string;
  none: string;
  what: string;
}

const imageSource = (value: string, attachment: Attachment | null): Source => {
  if (attachment) {
    if (attachment.contentType && !attachment.contentType.toLowerCase().startsWith('image/')) return {kind: 'error', error: 'The attached file is not an image.'};
    if (attachment.size > IMAGE_MAX_BYTES) return {kind: 'error', error: `The attached file is larger than ${CLOUD_OBJECT_MAX_MB} MB.`};
    return {kind: 'url', url: attachment.url};
  }
  if (!value) return {kind: 'none'};
  if (value.toLowerCase() === CLEAR) return {kind: 'clear'};
  return {kind: 'url', url: value};
};

const loadImage = async (url: string, kind: ImageKind, transparent: boolean): Promise<EncodedImage | string> => {
  try {
    return await encodeImage(kind, await fetchImage(url), transparent);
  } catch (e) {
    if (e instanceof ImageError) return `❌ ${e.message}`;
    log.warn('Image processing failed: %s', errorText(e));
    return `❌ Could not process that image: ${errorText(e)}`;
  }
};

const outcome = (r: PushResult, done: string, what: string): string => {
  if (r.ok) return done;
  if (r.reason === 'conflict') return `⚠️ Your ${what} changed on another device at the same moment, so this change was not saved. Run the command again.`;
  const why = r.reason === 'pending' ? 'saving is taking longer than usual' : r.error || 'the Plural Star cloud could not be reached';
  return `⚠️ The change is made here, but it is not saved to your vault yet (${why}). ${KEEPS_TRYING}`;
};

const shown = (v: FieldValue): string => (typeof v === 'string' ? bold(v) : `**${String(v)}**`);

const tell = (ctx: CommandContext, content: string): Promise<void> => say(ctx, {content});

const applyImage = async (ctx: CommandContext, s: VaultSession, key: string, kind: ImageKind, transparent: boolean, source: Source, texts: ImageTexts): Promise<void> => {
  if (source.kind === 'error') {
    await tell(ctx, `❌ ${source.error}`);
    return;
  }
  if (source.kind === 'none') {
    await tell(ctx, NO_SOURCE);
    return;
  }
  if (source.kind === 'clear') {
    if (!s.mediaObjectId(key) && s.platform.get(key) === undefined) {
      await tell(ctx, texts.none);
      return;
    }
    let pushed: PushResult;
    try {
      pushed = await s.clearMedia(key);
    } catch (e) {
      await tell(ctx, `❌ Could not clear it: ${errorText(e)}`);
      return;
    }
    await tell(ctx, outcome(pushed, texts.cleared, texts.what));
    return;
  }
  const image = await loadImage(source.url, kind, transparent);
  if (typeof image === 'string') {
    await tell(ctx, image);
    return;
  }
  let pushed: PushResult;
  try {
    pushed = await s.setMedia(key, image.mime, image.bytes);
  } catch (e) {
    await tell(ctx, `❌ Could not save it: ${errorText(e)}`);
    return;
  }
  await tell(ctx, outcome(pushed, texts.set, texts.what));
};

const editMember = async (ctx: CommandContext): Promise<void> => {
  const query = ctx.options.getString('member', true);
  const fieldRaw = ctx.options.getString('field', true);
  const value = (ctx.options.getString('value') ?? '').trim();
  const attachment = ctx.options.getAttachment('image');
  const pre = ownInMemory(ctx);
  const onlyCaller = !pre || nameCandidates(visibleMembers(pre.members(), true), query).some(m => m.private === true);
  await ctx.deferReply(onlyCaller ? {flags: MessageFlags.Ephemeral} : {});
  const t = await targetOf(ctx, ctx.user, 0);
  if (!t) return;
  const s = t.session;

  const found = findByName(visibleMembers(s.members(), true), query);
  if (found.kind === 'none') {
    await tell(ctx, noMember(query));
    return;
  }
  if (found.kind === 'ambiguous') {
    await tell(ctx, ambiguous(query, found.count, found.prefix));
    return;
  }
  const member = found.member;
  const who = bold(member.name);
  const defs = s.customFieldDefs();
  const field = resolveMemberField(fieldRaw, defs);
  if (field.kind === 'none') {
    await tell(ctx, `No field called ${bold(fieldRaw)}. Fields: ${fieldNames(defs).map(n => `\`${n}\``).join(', ')}.`);
    return;
  }
  if (field.kind === 'ambiguous') {
    await tell(ctx, `${field.names.length} custom fields start with ${bold(fieldRaw)}: ${field.names.map(n => `\`${n}\``).join(', ')}. Type more of the name.`);
    return;
  }
  const label = fieldLabel(field);

  if (isImageTarget(field)) {
    const key = mediaKeyOf(field, member.id);
    if (!key) return;
    const source = imageSource(value, attachment);
    if (field.kind === 'custom' && source.kind === 'url') {
      const raw = s.platform.get(VAULT_KEYS.members);
      const entry = raw === undefined ? {kind: 'missing' as const} : withCustomEntry(raw, member.id, field.def.id);
      if (entry.kind === 'missing') {
        await tell(ctx, NOT_LOADED);
        return;
      }
      if (entry.kind === 'added') {
        let pushed: PushResult;
        try {
          pushed = await s.writeAndPush({[VAULT_KEYS.members]: entry.list});
        } catch (e) {
          await tell(ctx, `❌ Could not change ${who}: ${errorText(e)}`);
          return;
        }
        if (!pushed.ok) {
          await tell(ctx, outcome(pushed, '', 'members'));
          return;
        }
      }
    }
    const transparent = field.kind === 'image' && field.field === 'avatar' && member.avatarTransparent === true;
    await applyImage(ctx, s, key, imageKindOf(field), transparent, source, {
      set: `✅ ${who}'s ${label} is updated.`,
      cleared: `✅ Cleared ${who}'s ${label}.`,
      none: `${who} has no ${label}.`,
      what: `${label} of ${member.name}`,
    });
    return;
  }

  if (!value) {
    await tell(ctx, NO_VALUE);
    return;
  }
  const clearing = value.toLowerCase() === CLEAR;
  if (clearing && field.kind === 'text' && field.field === 'name') {
    await tell(ctx, 'A member needs a name. Give a new one instead of clearing it.');
    return;
  }
  let next: FieldValue | null = null;
  if (!clearing) {
    const parsed = parseFieldValue(field, value);
    if (!parsed.ok) {
      await tell(ctx, `❌ ${parsed.error}`);
      return;
    }
    next = parsed.value;
  }
  const raw = s.platform.get(VAULT_KEYS.members);
  const list = raw === undefined ? null : withMemberField(raw, member.id, field, next);
  if (!list) {
    await tell(ctx, NOT_LOADED);
    return;
  }
  let pushed: PushResult;
  try {
    pushed = await s.writeAndPush({[VAULT_KEYS.members]: list});
  } catch (e) {
    log.warn('Member edit for user %s failed: %s', ctx.userId, errorText(e));
    await tell(ctx, `❌ Could not change ${who}: ${errorText(e)}`);
    return;
  }
  const done = next === null ? `✅ Cleared ${who}'s ${label}.` : `✅ ${who}'s ${label} is now ${shown(next)}.`;
  await tell(ctx, outcome(pushed, done, 'members'));
};

const editSystem = async (ctx: CommandContext): Promise<void> => {
  const field = ctx.options.getString('field', true);
  const value = (ctx.options.getString('value') ?? '').trim();
  const attachment = ctx.options.getAttachment('image');
  await ctx.deferReply();
  const t = await targetOf(ctx, ctx.user, 0);
  if (!t) return;
  const s = t.session;

  if (field === 'avatar' || field === 'banner') {
    await applyImage(ctx, s, systemMediaKey(field), field, false, imageSource(value, attachment), {
      set: `✅ Your system ${field} is updated.`,
      cleared: `✅ Cleared your system ${field}.`,
      none: `Your system has no ${field}.`,
      what: `system ${field}`,
    });
    return;
  }
  if (field !== 'name' && field !== 'description') return;
  if (!value) {
    await tell(ctx, NO_VALUE);
    return;
  }
  const clearing = value.toLowerCase() === CLEAR;
  const sys = withSystemField(s.platform.get(VAULT_KEYS.system) ?? EMPTY_SYSTEM, field, clearing ? null : value);
  if (!sys) {
    await tell(ctx, NOT_LOADED);
    return;
  }
  let pushed: PushResult;
  try {
    pushed = await s.writeAndPush({[VAULT_KEYS.system]: sys});
  } catch (e) {
    log.warn('System edit for user %s failed: %s', ctx.userId, errorText(e));
    await tell(ctx, `❌ Could not change your system: ${errorText(e)}`);
    return;
  }
  const done = clearing ? `✅ Cleared your system ${field}.` : `✅ Your system ${field} is now ${shown(value)}.`;
  await tell(ctx, outcome(pushed, done, 'system'));
};

const handleEdit = async (ctx: CommandContext): Promise<void> => {
  const sub = ctx.options.getSubcommand();
  if (sub === 'member') await editMember(ctx);
  else if (sub === 'system') await editSystem(ctx);
};

const SYSTEM_FIELDS = [
  {name: 'name', value: 'name'},
  {name: 'description', value: 'description'},
  {name: 'avatar', value: 'avatar'},
  {name: 'banner', value: 'banner'},
] as const;

export const editCommand: Command = {
  def: {
    name: 'edit',
    description: 'Change your own members or system from here',
    dm: true,
    subcommands: [
      {
        name: 'member',
        description: 'Change one field of one of your members',
        positional: true,
        options: [
          {name: 'member', description: 'Member name or nickname', type: 'string', required: true, maxLength: 100},
          {
            name: 'field',
            description: 'name, nickname, pronouns, role, color, emoji, description, avatar, banner, or a custom field',
            type: 'string',
            required: true,
            maxLength: 100,
          },
          {name: 'value', description: 'The new value, a link to an image, or clear', type: 'string', maxLength: 2000},
          {name: 'image', description: 'The new avatar, banner or image field, as a file', type: 'attachment'},
        ],
      },
      {
        name: 'system',
        description: 'Change your system name, description, avatar or banner',
        positional: true,
        options: [
          {name: 'field', description: 'What to change', type: 'string', required: true, choices: SYSTEM_FIELDS},
          {name: 'value', description: 'The new value, a link to an image, or clear', type: 'string', maxLength: 2000},
          {name: 'image', description: 'The new avatar or banner, as a file', type: 'attachment'},
        ],
      },
    ],
  },
  run: handleEdit,
};
