import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Interaction,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {CloudError} from '../../cloud/cloudTypes';
import {log} from '../../log';
import {dropSession, getSession, hasStoredLink, peekSession} from '../../vault/registry';
import {LINK_BROKEN_TEXT, type LinkStage} from '../../vault/session';
import {linkAttempts} from '../../vault/throttle';
import {forgetNameSettings} from '../proxy/settings';
import type {BotModule} from '../types';

const MODAL_ID = 'link:password';
const PASSWORD_FIELD = 'password';
const UNLINK_CONFIRM = 'link:unlink-confirm';
const UNLINK_CANCEL = 'link:unlink-cancel';

/** True only in the bot's DM (Discord's interaction context; older payloads without one: no guild). */
const inBotDm = (i: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction): boolean =>
  i.context !== null && i.context !== undefined ? i.context === InteractionContextType.BotDM : !i.inGuild();

const dmOnly = (command: string): string =>
  `For your safety, \`/${command}\` only works in a direct message with me. Open a DM with Plural Starbot (click my name, then **Message**) and run \`/${command}\` there.`;

const linkCommand = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Link your Plural Star cloud vault (works in a DM with the bot)')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

const unlinkCommand = new SlashCommandBuilder()
  .setName('unlink')
  .setDescription('Unlink your Plural Star cloud vault from the bot (works in a DM with the bot)')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

const STAGE_TEXT: Record<LinkStage, string> = {
  queued: '⏳ Other vaults are being linked right now; yours starts in a moment…',
  deriving: '🔑 Deriving your vault key from the password. This takes several seconds…',
  'looking-up': '🔎 Looking for your vault…',
  opening: '🔐 Vault found. Opening it with your password; this takes several seconds again…',
  importing: '📥 Reading your vault…',
};

const systemLabel = (name: string): string => (name.trim() ? `**${name.trim()}**` : 'your system');

/** The reply when a vault is already linked; says so when that link no longer opens the vault. */
const alreadyLinked = (userId: string, name: string): string =>
  peekSession(userId)?.linkProblem()
    ? `A vault is linked to your Discord account, but ${LINK_BROKEN_TEXT}`
    : `A vault (${systemLabel(name)}) is already linked to your Discord account. Run \`/unlink\` first to link a different one.`;

const minutes = (ms: number): string => {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return `${m} minute${m === 1 ? '' : 's'}`;
};

const tooManyAttempts = (ms: number): string =>
  `You have tried to link ${linkAttempts.limit} times in the last ${Math.round(linkAttempts.windowMs / 60000)} minutes. Try again in ${minutes(ms)}.`;

/** Error text for the user. Engine errors carry their own wording (e.g. the 'bad password' message). */
const errorText = (e: unknown): string => {
  if (e instanceof CloudError) {
    if (e.status === 429) {
      const wait = e.retryAfterSeconds ? ` Try again in ${Math.ceil(e.retryAfterSeconds)} seconds.` : ' Try again in a little while.';
      return `The Plural Star cloud node is limiting link attempts right now.${wait}`;
    }
    return e.message;
  }
  if (e instanceof Error) return `Could not reach the Plural Star cloud node (${e.message}).`;
  return String(e);
};

const handleLink = async (i: ChatInputCommandInteraction): Promise<void> => {
  if (!inBotDm(i)) {
    await i.reply({content: dmOnly('link'), flags: MessageFlags.Ephemeral});
    return;
  }
  if (hasStoredLink(i.user.id)) {
    await i.reply({content: alreadyLinked(i.user.id, peekSession(i.user.id)?.system()?.name || '')});
    return;
  }
  const wait = linkAttempts.retryInMs(i.user.id);
  if (wait > 0) {
    await i.reply({content: tooManyAttempts(wait)});
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle('Link your Plural Star vault')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(PASSWORD_FIELD)
          .setLabel('Plural Star cloud password')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(256),
      ),
    );
  await i.showModal(modal);
};

const handlePasswordModal = async (i: ModalSubmitInteraction): Promise<void> => {
  if (!inBotDm(i)) {
    await i.reply({content: dmOnly('link'), flags: MessageFlags.Ephemeral});
    return;
  }
  const password = i.fields.getTextInputValue(PASSWORD_FIELD);
  const wait = linkAttempts.retryInMs(i.user.id);
  if (wait > 0) {
    await i.reply({content: tooManyAttempts(wait)});
    return;
  }
  await i.deferReply();
  const say = async (content: string): Promise<void> => {
    try {
      await i.editReply({content});
    } catch (e) {
      log.warn('Could not update the /link reply for user %s: %s', i.user.id, e instanceof Error ? e.message : String(e));
    }
  };
  try {
    const session = await getSession(i.user.id);
    if (session.isLinked()) {
      await say(alreadyLinked(i.user.id, session.system()?.name || ''));
      return;
    }
    if (session.isLinking()) {
      await say('Linking is already in progress for your account. Wait for it to finish.');
      return;
    }
    linkAttempts.note(i.user.id);
    const result = await session.linkWithPassword(password, stage => say(STAGE_TEXT[stage]));
    if (result.kind === 'not-found') {
      await say('No vault found for that password. Check the password you use for Plural Star cloud and run `/link` again.');
      return;
    }
    log.info('User %s linked a vault (%d member(s)).', i.user.id, result.memberCount);
    await say(
      `✅ Linked to ${systemLabel(result.systemName)} with ${result.memberCount} member${result.memberCount === 1 ? '' : 's'}. ` +
        'Plural Starbot is now a device on your vault. Use `/unlink` to remove it.',
    );
  } catch (e) {
    if (!(e instanceof CloudError)) log.exception(e, 'Linking failed for user %s.', i.user.id);
    await say(`❌ Linking failed: ${errorText(e)}`);
  } finally {
    // A session that did not end up linked is not kept in memory.
    const s = peekSession(i.user.id);
    if (s && !s.isLinked() && !s.isLinking()) dropSession(i.user.id);
  }
};

const unlinkButtons = (): ActionRowBuilder<ButtonBuilder> =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(UNLINK_CONFIRM).setLabel('Unlink').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(UNLINK_CANCEL).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

const handleUnlink = async (i: ChatInputCommandInteraction): Promise<void> => {
  if (!inBotDm(i)) {
    await i.reply({content: dmOnly('unlink'), flags: MessageFlags.Ephemeral});
    return;
  }
  if (!hasStoredLink(i.user.id)) {
    await i.reply({content: 'No vault is linked to your Discord account.'});
    return;
  }
  const name = peekSession(i.user.id)?.system()?.name || '';
  await i.reply({
    content:
      `Unlink ${systemLabel(name)}? This removes the Plural Starbot device from your vault and deletes the key the bot holds for you. ` +
      'Proxying, profiles and front commands stop working until you link again.',
    components: [unlinkButtons()],
  });
};

const handleUnlinkButton = async (i: ButtonInteraction): Promise<void> => {
  if (!inBotDm(i)) {
    await i.reply({content: dmOnly('unlink'), flags: MessageFlags.Ephemeral});
    return;
  }
  if (i.customId === UNLINK_CANCEL) {
    await i.update({content: 'Cancelled. Your vault stays linked.', components: []});
    return;
  }
  await i.update({content: 'Unlinking…', components: []});
  try {
    if (!hasStoredLink(i.user.id) && !peekSession(i.user.id)?.isLinked()) {
      await i.editReply({content: 'No vault is linked to your Discord account.'});
      return;
    }
    const session = await getSession(i.user.id);
    const result = await session.unlink();
    dropSession(i.user.id);
    forgetNameSettings(i.user.id);
    log.info('User %s unlinked their vault%s.', i.user.id, result.deviceRemoved ? '' : ' (device removal failed)');
    await i.editReply({
      content: result.deviceRemoved
        ? '✅ Unlinked. The Plural Starbot device was removed from your vault and the key the bot held was deleted.'
        : `Unlinked here and the key the bot held was deleted, but removing the device from your vault failed (${result.error}). ` +
          'You can remove "Plural Starbot" from the device list in the Plural Star app.',
    });
  } catch (e) {
    log.exception(e, 'Unlinking failed for user %s.', i.user.id);
    await i.editReply({content: `❌ Unlinking failed: ${errorText(e)}`});
  }
};

const link: BotModule = {
  name: 'link',
  commands: [linkCommand, unlinkCommand],
  async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'link') await handleLink(interaction);
      else if (interaction.commandName === 'unlink') await handleUnlink(interaction);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId === MODAL_ID) {
      await handlePasswordModal(interaction);
      return;
    }
    if (interaction.isButton() && (interaction.customId === UNLINK_CONFIRM || interaction.customId === UNLINK_CANCEL)) {
      await handleUnlinkButton(interaction);
    }
  },
};

export default link;
