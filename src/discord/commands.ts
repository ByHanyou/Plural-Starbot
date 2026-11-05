import {
  ApplicationIntegrationType,
  Attachment,
  type BaseMessageOptions,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  type DMChannel,
  Guild,
  GuildMember,
  InteractionContextType,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  MessageFlags,
  NewsChannel,
  PermissionsBitField,
  type RESTPostAPIApplicationCommandsJSONBody,
  Role,
  type SendableChannels,
  SlashCommandAttachmentOption,
  SlashCommandBooleanOption,
  SlashCommandBuilder,
  SlashCommandChannelOption,
  SlashCommandIntegerOption,
  SlashCommandRoleOption,
  SlashCommandStringOption,
  SlashCommandUserOption,
  type TextBasedChannel,
  TextChannel,
  User,
} from 'discord.js';
import {config} from '../config';
import {log} from '../log';
import {errorText, orNull} from '../util';

export type OptionType = 'string' | 'integer' | 'boolean' | 'user' | 'channel' | 'role' | 'attachment';

export interface Choice {
  readonly name: string;
  readonly value: string;
}

export interface OptionDef {
  name: string;
  description: string;
  type: OptionType;
  required?: boolean;
  choices?: readonly Choice[];
  maxLength?: number;
  autocomplete?: boolean;
}

export interface SubcommandDef {
  name: string;
  description: string;
  options?: OptionDef[];
  positional?: boolean;
}

export interface CommandDef {
  name: string;
  description: string;
  dm?: boolean;
  permissions?: bigint;
  options?: OptionDef[];
  subcommands?: SubcommandDef[];
  positional?: boolean;
}

export type ChannelOption = TextChannel | NewsChannel;

type OptionValue = string | number | boolean | User | ChannelOption | Role | Attachment;

export interface Command {
  def: CommandDef;
  run(ctx: CommandContext): Promise<void>;
}

const SNOWFLAKE_RE = /^\d{15,25}$/;
const USER_RE = /^<@!?(\d{15,25})>$/;
const CHANNEL_RE = /^<#(\d{15,25})>$/;
const ROLE_RE = /^<@&(\d{15,25})>$/;
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

const isChannelOption = (c: unknown): c is ChannelOption => c instanceof TextChannel || c instanceof NewsChannel;

export class CommandOptions {
  constructor(
    private readonly sub: string | null,
    private readonly values: Map<string, OptionValue>,
  ) {}

  getSubcommand(): string {
    return this.sub ?? '';
  }

  private value(name: string, required: boolean): OptionValue | null {
    const v = this.values.get(name);
    if (v === undefined) {
      if (required) throw new Error(`required option '${name}' is missing`);
      return null;
    }
    return v;
  }

  getString(name: string, required: true): string;
  getString(name: string, required?: boolean): string | null;
  getString(name: string, required = false): string | null {
    const v = this.value(name, required);
    return typeof v === 'string' ? v : null;
  }

  getInteger(name: string, required: true): number;
  getInteger(name: string, required?: boolean): number | null;
  getInteger(name: string, required = false): number | null {
    const v = this.value(name, required);
    return typeof v === 'number' ? v : null;
  }

  getBoolean(name: string): boolean | null {
    const v = this.value(name, false);
    return typeof v === 'boolean' ? v : null;
  }

  getUser(name: string): User | null {
    const v = this.value(name, false);
    return v instanceof User ? v : null;
  }

  getChannel(name: string, required: true): ChannelOption;
  getChannel(name: string, required?: boolean): ChannelOption | null;
  getChannel(name: string, required = false): ChannelOption | null {
    const v = this.value(name, required);
    return isChannelOption(v) ? v : null;
  }

  getRole(name: string, required: true): Role;
  getRole(name: string, required?: boolean): Role | null;
  getRole(name: string, required = false): Role | null {
    const v = this.value(name, required);
    return v instanceof Role ? v : null;
  }

  getAttachment(name: string): Attachment | null {
    const v = this.value(name, false);
    return v instanceof Attachment ? v : null;
  }
}

export const prefix = (): string => config().commandPrefix;

const typeHint = (o: OptionDef): string => {
  if (o.choices?.length) return o.choices.map(c => c.value).join('|');
  switch (o.type) {
    case 'user':
      return '@user';
    case 'channel':
      return '#channel';
    case 'role':
      return '@role';
    case 'integer':
      return 'number';
    case 'boolean':
      return 'true|false';
    case 'attachment':
      return 'attached file';
    default:
      return 'text';
  }
};

const optionUsage = (o: OptionDef, positional: boolean): string => {
  const body = positional ? `<${o.name}>` : `${o.name}:<${typeHint(o)}>`;
  return o.required ? body : `[${body}]`;
};

export const usageOf = (def: CommandDef, sub?: SubcommandDef | null): string => {
  const head = `${prefix()}${def.name}${sub ? ` ${sub.name}` : ''}`;
  const opts = ((sub ? sub.options : def.options) ?? []).filter(o => o.type !== 'attachment');
  const positional = sub ? !!sub.positional : !!def.positional;
  return [head, ...opts.map(o => optionUsage(o, positional))].join(' ');
};

const subcommandList = (def: CommandDef): string => (def.subcommands ?? []).map(s => `\`${prefix()}${def.name} ${s.name}\``).join(', ');

export interface MatchedCommand {
  command: Command;
  args: string;
}

export const matchCommand = (content: string, commands: Map<string, Command>): MatchedCommand | null => {
  const p = prefix();
  const text = content.trimStart();
  if (!text.startsWith(p)) return null;
  const m = /^([a-z][a-z0-9_-]*)(?=\s|$)/i.exec(text.slice(p.length));
  if (!m) return null;
  const command = commands.get(m[1].toLowerCase());
  if (!command) return null;
  return {command, args: text.slice(p.length + m[0].length).trim()};
};

interface OptionHost {
  addStringOption(input: (o: SlashCommandStringOption) => SlashCommandStringOption): unknown;
  addIntegerOption(input: (o: SlashCommandIntegerOption) => SlashCommandIntegerOption): unknown;
  addBooleanOption(input: (o: SlashCommandBooleanOption) => SlashCommandBooleanOption): unknown;
  addUserOption(input: (o: SlashCommandUserOption) => SlashCommandUserOption): unknown;
  addChannelOption(input: (o: SlashCommandChannelOption) => SlashCommandChannelOption): unknown;
  addRoleOption(input: (o: SlashCommandRoleOption) => SlashCommandRoleOption): unknown;
  addAttachmentOption(input: (o: SlashCommandAttachmentOption) => SlashCommandAttachmentOption): unknown;
}

interface NamedOption {
  setName(name: string): this;
  setDescription(description: string): this;
  setRequired(required: boolean): this;
}

const addOptions = (host: OptionHost, options: OptionDef[] | undefined): void => {
  for (const o of options ?? []) {
    const base = <T extends NamedOption>(b: T): T => b.setName(o.name).setDescription(o.description).setRequired(!!o.required);
    switch (o.type) {
      case 'string':
        host.addStringOption(b => {
          base(b);
          if (o.maxLength) b.setMaxLength(o.maxLength);
          if (o.choices?.length) b.addChoices(...o.choices.map(c => ({name: c.name, value: c.value})));
          if (o.autocomplete) b.setAutocomplete(true);
          return b;
        });
        break;
      case 'integer':
        host.addIntegerOption(b => base(b));
        break;
      case 'boolean':
        host.addBooleanOption(b => base(b));
        break;
      case 'user':
        host.addUserOption(b => base(b));
        break;
      case 'channel':
        host.addChannelOption(b => base(b).addChannelTypes(...CHANNEL_TYPES));
        break;
      case 'role':
        host.addRoleOption(b => base(b));
        break;
      case 'attachment':
        host.addAttachmentOption(b => base(b));
        break;
    }
  }
};

export const commandJSON = (def: CommandDef): RESTPostAPIApplicationCommandsJSONBody => {
  const b = new SlashCommandBuilder().setName(def.name).setDescription(def.description).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  b.setContexts(...(def.dm ? [InteractionContextType.Guild, InteractionContextType.BotDM] : [InteractionContextType.Guild]));
  if (def.permissions !== undefined) b.setDefaultMemberPermissions(def.permissions);
  if (def.subcommands?.length) {
    for (const s of def.subcommands) {
      b.addSubcommand(sb => {
        sb.setName(s.name).setDescription(s.description);
        addOptions(sb, s.options);
        return sb;
      });
    }
  } else {
    addOptions(b, def.options);
  }
  return b.toJSON();
};

const normalizeChoice = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const pickChoice = (choices: readonly Choice[], raw: string): string | null => {
  const key = normalizeChoice(raw);
  if (!key) return null;
  const hit =
    choices.find(c => normalizeChoice(c.value) === key) ??
    choices.find(c => normalizeChoice(c.name) === key) ??
    choices.find(c => normalizeChoice(c.name.replace(/\(.*\)/, '')) === key);
  return hit ? hit.value : null;
};

const splitNamed = (text: string, names: string[]): {lead: string; named: [string, string][]} => {
  if (!names.length) return {lead: text.trim(), named: []};
  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(^|\\s)(${escaped.join('|')}):`, 'gi');
  const hits: {name: string; start: number; end: number}[] = [];
  for (const m of text.matchAll(re)) {
    const at = (m.index ?? 0) + m[1].length;
    hits.push({name: m[2].toLowerCase(), start: at, end: at + m[2].length + 1});
  }
  const lead = (hits.length ? text.slice(0, hits[0].start) : text).trim();
  const named = hits.map((h, k): [string, string] => [h.name, text.slice(h.end, k + 1 < hits.length ? hits[k + 1].start : text.length).trim()]);
  return {lead, named};
};

interface Token {
  value: string;
  start: number;
}

const TOKEN_RE = /"((?:[^"\\]|\\.)*)"|“([^”]*)”|(\S+)/g;

const tokenize = (text: string): Token[] => {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const value = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3];
    out.push({value, start: m.index ?? 0});
  }
  return out;
};

export interface ParseEnv {
  client: Client<true>;
  guild: Guild | null;
}

type Parsed = {ok: true; sub: SubcommandDef | null; options: CommandOptions} | {ok: false; error: string; sub: SubcommandDef | null};

const resolveUser = async (env: ParseEnv, raw: string): Promise<User | null> => {
  const id = USER_RE.exec(raw)?.[1] ?? (SNOWFLAKE_RE.test(raw) ? raw : null);
  if (!id) return null;
  return env.client.users.cache.get(id) ?? (await orNull(env.client.users.fetch(id), `Fetching user ${id}`));
};

const channelById = async (guild: Guild, id: string): Promise<ChannelOption | null> => {
  const channel = guild.channels.cache.get(id) ?? (await orNull(guild.channels.fetch(id), `Fetching channel ${id}`));
  return isChannelOption(channel) ? channel : null;
};

const roleById = async (guild: Guild, id: string): Promise<Role | null> => {
  if (id === guild.id) return guild.roles.everyone;
  return guild.roles.cache.get(id) ?? (await orNull(guild.roles.fetch(id), `Fetching role ${id}`));
};

const resolveChannel = async (env: ParseEnv, raw: string): Promise<ChannelOption | null> => {
  const guild = env.guild;
  if (!guild) return null;
  const id = CHANNEL_RE.exec(raw)?.[1] ?? (SNOWFLAKE_RE.test(raw) ? raw : null);
  if (id) return channelById(guild, id);
  const name = raw.replace(/^#/, '').trim().toLowerCase();
  const found = guild.channels.cache.find(c => isChannelOption(c) && c.name.toLowerCase() === name);
  return isChannelOption(found) ? found : null;
};

const resolveRole = async (env: ParseEnv, raw: string): Promise<Role | null> => {
  const guild = env.guild;
  if (!guild) return null;
  if (/^@?everyone$/i.test(raw)) return guild.roles.everyone;
  const id = ROLE_RE.exec(raw)?.[1] ?? (SNOWFLAKE_RE.test(raw) ? raw : null);
  if (id) return roleById(guild, id);
  const name = raw.replace(/^@/, '').trim().toLowerCase();
  return guild.roles.cache.find(r => r.name.toLowerCase() === name) ?? null;
};

const convert = async (env: ParseEnv, o: OptionDef, raw: string): Promise<{ok: true; value: OptionValue} | {ok: false; error: string}> => {
  const fail = (error: string) => ({ok: false as const, error});
  if (!raw) return fail(`\`${o.name}\` needs a value.`);
  if (o.choices?.length) {
    const picked = pickChoice(o.choices, raw);
    return picked === null ? fail(`\`${o.name}\` must be one of: ${o.choices.map(c => `\`${c.value}\``).join(', ')}.`) : {ok: true, value: picked};
  }
  switch (o.type) {
    case 'string':
      if (o.maxLength && raw.length > o.maxLength) return fail(`\`${o.name}\` can be at most ${o.maxLength} characters; that one has ${raw.length}.`);
      return {ok: true, value: raw};
    case 'integer':
      return /^-?\d+$/.test(raw) ? {ok: true, value: Number(raw)} : fail(`\`${o.name}\` must be a whole number.`);
    case 'boolean': {
      const v = raw.toLowerCase();
      if (['true', 'yes', 'on', '1'].includes(v)) return {ok: true, value: true};
      if (['false', 'no', 'off', '0'].includes(v)) return {ok: true, value: false};
      return fail(`\`${o.name}\` must be true or false.`);
    }
    case 'user': {
      const user = await resolveUser(env, raw);
      return user ? {ok: true, value: user} : fail(`\`${o.name}\` must be a user mention, like @name.`);
    }
    case 'channel': {
      const channel = await resolveChannel(env, raw);
      return channel ? {ok: true, value: channel} : fail(`\`${o.name}\` must be a text or announcement channel in this server, like #channel.`);
    }
    case 'role': {
      const role = await resolveRole(env, raw);
      return role ? {ok: true, value: role} : fail(`\`${o.name}\` must be a role in this server, like @role.`);
    }
    case 'attachment':
      return fail(`\`${o.name}\` must be a file attached to the message.`);
  }
};

export const parseArgs = async (def: CommandDef, args: string, env: ParseEnv, attachment: Attachment | null = null): Promise<Parsed> => {
  let sub: SubcommandDef | null = null;
  let rest = args;
  if (def.subcommands?.length) {
    const m = /^(\S+)\s*/.exec(rest);
    const name = m?.[1].toLowerCase() ?? '';
    sub = def.subcommands.find(s => s.name === name) ?? null;
    if (!sub) return {ok: false, sub: null, error: `Pick one of: ${subcommandList(def)}.`};
    rest = rest.slice(m?.[0].length ?? 0);
  }
  const defs = ((sub ? sub.options : def.options) ?? []).filter(o => o.type !== 'attachment');
  const positional = sub ? !!sub.positional : !!def.positional;
  const raw = new Map<string, string>();
  if (positional) {
    const lead = rest.trim();
    const toks = tokenize(lead);
    if (!defs.length && lead) return {ok: false, sub, error: `I don't know what to do with “${lead}”.`};
    defs.forEach((o, idx) => {
      if (idx >= toks.length) return;
      const last = idx === defs.length - 1;
      raw.set(o.name, last && toks.length > defs.length ? lead.slice(toks[idx].start).trim() : toks[idx].value);
    });
  } else {
    const {lead, named} = splitNamed(rest, defs.map(o => o.name));
    for (const [name, value] of named) {
      if (raw.has(name)) return {ok: false, sub, error: `\`${name}\` is given twice.`};
      raw.set(name, value);
    }
    if (lead) {
      const first = defs.find(o => !raw.has(o.name));
      if (!first) return {ok: false, sub, error: `I don't know what to do with “${lead}”.`};
      raw.set(first.name, lead);
    }
  }
  const values = new Map<string, OptionValue>();
  for (const o of defs) {
    const given = raw.get(o.name);
    if (given === undefined) {
      if (o.required) return {ok: false, sub, error: `\`${o.name}\` is required.`};
      continue;
    }
    const converted = await convert(env, o, given);
    if (!converted.ok) return {ok: false, sub, error: converted.error};
    values.set(o.name, converted.value);
  }
  for (const o of (sub ? sub.options : def.options) ?? []) {
    if (o.type !== 'attachment') continue;
    if (attachment) values.set(o.name, attachment);
    else if (o.required) return {ok: false, sub, error: `Attach a file for \`${o.name}\`.`};
  }
  return {ok: true, sub, options: new CommandOptions(sub?.name ?? null, values)};
};

export const usageError = (def: CommandDef, sub: SubcommandDef | null, error: string): string =>
  `❌ ${error}\nUsage: \`${usageOf(def, sub)}\``;

export interface Payload {
  content?: string;
  embeds?: BaseMessageOptions['embeds'];
  components?: BaseMessageOptions['components'];
  files?: BaseMessageOptions['files'];
  allowedMentions?: BaseMessageOptions['allowedMentions'];
  flags?: number;
}

export interface DeferOptions {
  flags?: number;
}

type ReplyFlag = 'Ephemeral' | 'SuppressEmbeds' | 'SuppressNotifications' | 'IsComponentsV2';
type SendFlag = Exclude<ReplyFlag, 'Ephemeral'>;
type EditFlag = 'SuppressEmbeds' | 'IsComponentsV2';

const FLAG_NAMES: readonly [number, ReplyFlag][] = [
  [MessageFlags.Ephemeral, 'Ephemeral'],
  [MessageFlags.SuppressEmbeds, 'SuppressEmbeds'],
  [MessageFlags.SuppressNotifications, 'SuppressNotifications'],
  [MessageFlags.IsComponentsV2, 'IsComponentsV2'],
];

const replyFlags = (flags: number): ReplyFlag[] => FLAG_NAMES.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
const sendFlags = (flags: number): SendFlag[] => replyFlags(flags).filter((f): f is SendFlag => f !== 'Ephemeral');
const editFlags = (flags: number): EditFlag[] => replyFlags(flags).filter((f): f is EditFlag => f === 'SuppressEmbeds' || f === 'IsComponentsV2');
const isEphemeral = (flags: number): boolean => (flags & MessageFlags.Ephemeral) !== 0;
const isV2 = (flags: number): boolean => (flags & MessageFlags.IsComponentsV2) !== 0;

const DM_FAILED = "❌ I couldn't send you a direct message. Allow direct messages from server members, then run the command again.";

const DEFAULT_MENTIONS: BaseMessageOptions['allowedMentions'] = {parse: ['users', 'roles', 'everyone']};

interface ContextInit {
  client: Client<true>;
  user: User;
  guildId: string | null;
  guild: Guild | null;
  channelId: string;
  channel: TextBasedChannel | null;
  member: GuildMember | null;
  memberPermissions: Readonly<PermissionsBitField> | null;
  commandName: string;
  options: CommandOptions;
  interaction: ChatInputCommandInteraction | null;
  message: Message | null;
}

export interface GuildContext extends CommandContext {
  readonly guildId: string;
  readonly guild: Guild;
  readonly memberPermissions: Readonly<PermissionsBitField>;
}

export class CommandContext {
  readonly client: Client<true>;
  readonly user: User;
  readonly guildId: string | null;
  readonly guild: Guild | null;
  readonly channelId: string;
  readonly channel: TextBasedChannel | null;
  readonly member: GuildMember | null;
  readonly memberPermissions: Readonly<PermissionsBitField> | null;
  readonly commandName: string;
  readonly options: CommandOptions;
  readonly interaction: ChatInputCommandInteraction | null;
  readonly message: Message | null;
  deferred = false;
  replied = false;
  private ephemeral = false;
  private invocationDeleted = false;
  private reply_: {message: Message; v2: boolean} | null = null;
  private dm: DMChannel | null = null;

  private constructor(init: ContextInit) {
    this.client = init.client;
    this.user = init.user;
    this.guildId = init.guildId;
    this.guild = init.guild;
    this.channelId = init.channelId;
    this.channel = init.channel;
    this.member = init.member;
    this.memberPermissions = init.memberPermissions;
    this.commandName = init.commandName;
    this.options = init.options;
    this.interaction = init.interaction;
    this.message = init.message;
  }

  static async fromInteraction(i: ChatInputCommandInteraction, def: CommandDef): Promise<CommandContext> {
    const guild = i.guild;
    const sub = def.subcommands?.length ? i.options.getSubcommand(false) : null;
    const defs = (sub ? def.subcommands?.find(s => s.name === sub)?.options : def.options) ?? [];
    const values = new Map<string, OptionValue>();
    for (const o of defs) {
      const opt = i.options.get(o.name);
      if (!opt) continue;
      switch (o.type) {
        case 'string':
          if (typeof opt.value === 'string') values.set(o.name, opt.value);
          break;
        case 'integer':
          if (typeof opt.value === 'number') values.set(o.name, opt.value);
          break;
        case 'boolean':
          if (typeof opt.value === 'boolean') values.set(o.name, opt.value);
          break;
        case 'user':
          if (opt.user) values.set(o.name, opt.user);
          break;
        case 'channel': {
          const id = opt.channel?.id ?? (typeof opt.value === 'string' ? opt.value : '');
          const channel = guild && id ? await channelById(guild, id) : null;
          if (channel) values.set(o.name, channel);
          break;
        }
        case 'role': {
          const id = opt.role?.id ?? (typeof opt.value === 'string' ? opt.value : '');
          const role = guild && id ? await roleById(guild, id) : null;
          if (role) values.set(o.name, role);
          break;
        }
        case 'attachment':
          if (opt.attachment) values.set(o.name, opt.attachment);
          break;
      }
    }
    return new CommandContext({
      client: i.client,
      user: i.user,
      guildId: i.guildId,
      guild,
      channelId: i.channelId,
      channel: i.channel,
      member: i.member instanceof GuildMember ? i.member : null,
      memberPermissions: i.memberPermissions,
      commandName: i.commandName,
      options: new CommandOptions(sub, values),
      interaction: i,
      message: null,
    });
  }

  static async fromMessage(message: Message, def: CommandDef, options: CommandOptions): Promise<CommandContext> {
    const guild = message.guild;
    let member = message.member;
    if (guild && !member) member = await orNull(guild.members.fetch(message.author.id), `Fetching server member ${message.author.id}`);
    return new CommandContext({
      client: message.client,
      user: message.author,
      guildId: message.guildId,
      guild,
      channelId: message.channelId,
      channel: message.channel,
      member,
      memberPermissions: guild ? (member?.permissions ?? new PermissionsBitField()) : null,
      commandName: def.name,
      options,
      interaction: null,
      message,
    });
  }

  get userId(): string {
    return this.user.id;
  }

  inGuild(): this is GuildContext {
    return this.guildId !== null;
  }

  inCachedGuild(): this is GuildContext {
    return this.guild !== null;
  }

  private async target(): Promise<SendableChannels | null> {
    if (this.ephemeral && this.guildId) {
      if (this.dm) return this.dm;
      try {
        this.dm = this.user.dmChannel ?? (await this.user.createDM());
        return this.dm;
      } catch (e) {
        log.debug('Could not open a DM with %s: %s', this.userId, errorText(e));
        return null;
      }
    }
    const channel = this.channel;
    return channel && channel.isSendable() ? channel : null;
  }

  private async hideInvocation(): Promise<void> {
    if (!this.message || !this.ephemeral || !this.guildId || this.invocationDeleted) return;
    this.invocationDeleted = true;
    await orNull(this.message.delete(), `Deleting command message ${this.message.id}`);
  }

  private interactionBody(p: Payload): InteractionReplyOptions {
    const flags = replyFlags(p.flags ?? 0);
    return {
      content: p.content,
      embeds: p.embeds,
      components: p.components,
      files: p.files,
      allowedMentions: p.allowedMentions,
      ...(flags.length ? {flags} : {}),
    };
  }

  private editBody(p: Payload): InteractionEditReplyOptions {
    const flags = editFlags(p.flags ?? 0);
    return {
      content: p.content,
      embeds: p.embeds,
      components: p.components,
      files: p.files,
      allowedMentions: p.allowedMentions,
      ...(flags.length ? {flags} : {}),
    };
  }

  private async send(p: Payload): Promise<Message | null> {
    const channel = await this.target();
    if (!channel) {
      const here = this.channel;
      if (here && here.isSendable()) {
        try {
          await here.send({content: DM_FAILED});
        } catch (e) {
          log.debug('Could not report a failed DM to %s: %s', this.userId, errorText(e));
        }
      }
      return null;
    }
    const flags = sendFlags(p.flags ?? 0);
    const body: MessageCreateOptions = {
      content: p.content,
      embeds: p.embeds,
      components: p.components,
      files: p.files,
      allowedMentions: p.allowedMentions,
      ...(flags.length ? {flags} : {}),
    };
    if (this.message && !this.ephemeral && channel.id === this.channelId && !this.invocationDeleted) {
      body.reply = {messageReference: this.message.id, failIfNotExists: false};
      body.allowedMentions = {...(p.allowedMentions ?? DEFAULT_MENTIONS), repliedUser: false};
    }
    return channel.send(body);
  }

  async deferReply(opts: DeferOptions = {}): Promise<void> {
    if (this.deferred || this.replied) return;
    this.ephemeral = isEphemeral(opts.flags ?? 0);
    this.deferred = true;
    if (this.interaction) {
      await this.interaction.deferReply(this.ephemeral ? {flags: MessageFlags.Ephemeral} : {});
      return;
    }
    await this.hideInvocation();
    const channel = await this.target();
    if (channel) await orNull(channel.sendTyping(), 'Typing indicator');
  }

  async reply(p: Payload): Promise<void> {
    if (this.deferred || this.replied) {
      await this.editReply(p);
      return;
    }
    this.ephemeral = isEphemeral(p.flags ?? 0);
    this.replied = true;
    if (this.interaction) {
      await this.interaction.reply(this.interactionBody(p));
      return;
    }
    await this.hideInvocation();
    const sent = await this.send(p);
    if (sent) this.reply_ = {message: sent, v2: isV2(p.flags ?? 0)};
  }

  async editReply(p: Payload): Promise<void> {
    this.replied = true;
    if (this.interaction) {
      await this.interaction.editReply(this.editBody(p));
      return;
    }
    const prev = this.reply_;
    const v2 = isV2(p.flags ?? 0);
    if (prev && prev.v2 === v2) {
      const flags = editFlags(p.flags ?? 0);
      const body: MessageEditOptions = v2
        ? {components: p.components ?? [], allowedMentions: p.allowedMentions, ...(flags.length ? {flags} : {})}
        : {content: p.content ?? null, embeds: p.embeds ?? [], components: p.components ?? [], allowedMentions: p.allowedMentions, ...(p.files ? {files: p.files} : {})};
      await prev.message.edit(body);
      return;
    }
    if (prev) await orNull(prev.message.delete(), `Replacing reply ${prev.message.id}`);
    const sent = await this.send(p);
    this.reply_ = sent ? {message: sent, v2} : null;
  }

  async followUp(p: Payload): Promise<void> {
    if (this.interaction) {
      await this.interaction.followUp(this.interactionBody(p));
      return;
    }
    await this.send(p);
  }
}
