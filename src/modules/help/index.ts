import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type {BotModule} from '../types';

const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Every Plural Starbot command, with what it does')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

interface Row {
  command: string;
  options: string;
  does: string;
  where: string;
  who: string;
}

interface Page {
  title: string;
  rows: Row[];
  notes: string[];
}

const PAGE_ID = 'help:page:';
const PAGE_LABEL_ID = 'help:page-label';

const PAGES: Page[] = [
  {
    title: 'Linking, profiles and front',
    rows: [
      {command: '`/help`', options: 'None', does: 'Lists every command. Only you see it.', where: 'Server, DM', who: 'Anyone'},
      {command: '`/link`', options: 'Password, asked in a pop-up', does: 'Links your Plural Star cloud vault to your Discord account. It never creates a vault.', where: 'DM only', who: 'Anyone'},
      {command: '`/unlink`', options: 'None. Confirm with **Unlink** or **Cancel**', does: 'Removes the bot from your vault and deletes its key and your bot settings (format, Sys Tag, member formats).', where: 'DM only', who: 'Anyone'},
      {command: '`/member`', options: '`name` (required: name or nickname) · `user` (optional)', does: 'Member card. Page 1 is the profile; Custom Fields follow on more pages with **Previous** / **Next** buttons.', where: 'Server', who: 'Anyone. Anyone can turn pages'},
      {command: '`/system`', options: '`user` (optional)', does: 'System card: banner, name, avatar, description, count of non-private members, and the linked Discord account.', where: 'Server', who: 'Anyone'},
      {command: '`/front show`', options: '`user` (optional)', does: 'Who is fronting, by tier, with how long.', where: 'Server', who: 'Anyone'},
      {command: '`/front set`', options: '`member` (required: one, or several separated by commas) · `tier` (optional)', does: 'Adds members to a tier and keeps whoever is already there.', where: 'Server', who: 'Your own front'},
      {command: '`/front add`', options: '`member` (required) · `tier` (optional)', does: 'Adds one member to a tier.', where: 'Server', who: 'Your own front'},
      {command: '`/front remove`', options: '`member` (required)', does: 'Takes a member off the front.', where: 'Server', who: 'Your own front'},
      {command: '`/front clear`', options: 'None', does: 'Clears every tier.', where: 'Server', who: 'Your own front'},
    ],
    notes: ['**`tier`:** Primary (default), Co-Front, Co-Conscious.'],
  },
  {
    title: 'Proxying',
    rows: [
      {command: '`/autoproxy off`', options: 'None', does: 'Turns autoproxy off in this server.', where: 'Server', who: 'Linked users'},
      {command: '`/autoproxy front`', options: 'None', does: 'Proxies as the first listed primary fronter.', where: 'Server', who: 'Linked users'},
      {command: '`/autoproxy member`', options: '`name` (required, with suggestions)', does: 'Proxies as one fixed member.', where: 'Server', who: 'Linked users'},
      {command: '`/autoproxy latch`', options: 'None', does: 'Proxies as the member of your last proxied message in this server, for up to 6 hours.', where: 'Server', who: 'Linked users'},
      {command: '`/proxy format`', options: '`member` (optional: emoji or name, with suggestions) · `template` (optional, 80 max) · `scope` (optional)', does: 'With no template, shows the current format and a preview. With a template, sets it. With a member, sets that member\'s own format, which beats yours. `default` or `reset` clears it.', where: 'Server, DM', who: 'Linked users'},
      {command: '`/proxy systag`', options: '`text` (optional, 20 max; `clear` removes it) · `scope` (optional)', does: 'Sets or shows the Sys Tag that `{Sys Tag}` fills in.', where: 'Server, DM', who: 'Linked users'},
      {command: '`/proxy edit`', options: '`text` (required, 2000 max) · `message_id` (optional)', does: 'Edits your last proxied message in this channel, or the one you name.', where: 'Server', who: 'Your own messages'},
      {command: '`<emoji> text` or `text <emoji>`', options: 'The member\'s profile Emoji field', does: 'Posts the message as that member. Works for facets, not custom fronts.', where: 'Server', who: 'Linked users'},
      {command: '`\\text`', options: 'Starts with a backslash', does: 'Sends that one message unproxied.', where: 'Server', who: 'Linked users'},
      {command: 'React ❌', options: 'On a proxied message', does: 'Deletes it.', where: 'Server', who: 'Only the sender'},
      {command: 'React ❓', options: 'On a proxied message', does: 'DMs you who sent it.', where: 'Server', who: 'Anyone'},
    ],
    notes: [
      '**`scope`:** everywhere (default) or this server. "This server" is refused in a DM.',
      '**Format tags:** `{Emoji}` `{Name}` `{Pronouns}` `{Role}` `{Sys Tag}`. Format order, first match wins: member format for this server, member format everywhere, your format for this server, your format everywhere, then `{Name}`.',
    ],
  },
  {
    title: 'Moderation and health reminders',
    rows: [
      {command: '`/proxylog channel`', options: '`channel` (required: text or announcement)', does: 'Logs every proxied message with its sender.', where: 'Server', who: 'Manage Server'},
      {command: '`/proxylog off`', options: 'None', does: 'Stops logging.', where: 'Server', who: 'Manage Server'},
      {command: '`/health show`', options: 'None', does: 'Current settings and ping times.', where: 'Server', who: 'Manage Server'},
      {command: '`/health channel`', options: '`channel` (required)', does: 'Sets the channel the reminders post in.', where: 'Server', who: 'Manage Server'},
      {command: '`/health role`', options: '`group` (required) · `role` (required)', does: 'Sets the role pinged for a reminder group.', where: 'Server', who: 'Manage Server'},
      {command: '`/health starttime`', options: '`time` (required, 24-hour HH:MM)', does: 'Sets the shared schedule\'s first ping of the day.', where: 'Server', who: 'Manage Server'},
      {command: '`/health interval`', options: '`hours` (required: 1, 2, 3, 4, 6, 8, 12 or 24)', does: 'Sets the shared schedule\'s hours between pings.', where: 'Server', who: 'Manage Server'},
      {command: '`/health groupschedule`', options: '`group` (required) · `time` (optional) · `hours` (optional) · `shared` (optional: true puts the group back on the shared schedule)', does: 'Gives one group its own schedule, or puts it back on the shared one.', where: 'Server', who: 'Manage Server'},
      {command: '`/health timezone`', options: '`name` (required, IANA name such as `America/New_York`)', does: 'Sets the timezone.', where: 'Server', who: 'Manage Server'},
      {command: '`/health enable`', options: 'None', does: 'Turns scheduled reminders on.', where: 'Server', who: 'Manage Server'},
      {command: '`/health disable`', options: 'None', does: 'Pauses scheduled reminders.', where: 'Server', who: 'Manage Server'},
      {command: '`/health test`', options: 'None', does: 'Sends one round of reminders now.', where: 'Server', who: 'Manage Server'},
    ],
    notes: ['**`group`:** Nutrition, Medicine, Activity, Eye Strain, Hygiene, Kindness.'],
  },
];

const rowText = (r: Row): string =>
  [`**${r.command}**`, `**Options:** ${r.options}`, `**Does:** ${r.does}`, `**Where:** ${r.where} · **Who:** ${r.who}`].join('\n');

const helpCard = (page: number): (ContainerBuilder | ActionRowBuilder<ButtonBuilder>)[] => {
  const p = PAGES[page];
  const box = new ContainerBuilder();
  box.addTextDisplayComponents(t => t.setContent(`## Plural Starbot commands\n### ${p.title}`));
  for (const r of p.rows) {
    box.addSeparatorComponents(s => s);
    box.addTextDisplayComponents(t => t.setContent(rowText(r)));
  }
  box.addSeparatorComponents(s => s);
  box.addTextDisplayComponents(t =>
    t.setContent([...p.notes, '-# Private members in Plural Star are only ever shown to their own system.'].join('\n')),
  );
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PAGE_ID}${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(PAGE_LABEL_ID).setLabel(`Page ${page + 1} of ${PAGES.length}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`${PAGE_ID}${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === PAGES.length - 1),
  );
  return [box, nav];
};

const onHelp = async (i: ChatInputCommandInteraction): Promise<void> => {
  await i.reply({components: helpCard(0), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2});
};

const onPage = async (i: ButtonInteraction): Promise<void> => {
  const page = Number(i.customId.slice(PAGE_ID.length));
  if (!Number.isInteger(page) || page < 0 || page >= PAGES.length) {
    await i.deferUpdate();
    return;
  }
  await i.update({components: helpCard(page), flags: MessageFlags.IsComponentsV2});
};

const help: BotModule = {
  name: 'help',
  commands: [helpCommand],
  async onInteraction(interaction: Interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === 'help') await onHelp(interaction);
    else if (interaction.isButton() && interaction.customId.startsWith(PAGE_ID)) await onPage(interaction);
  },
};

export default help;
