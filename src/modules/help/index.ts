import {
  ApplicationIntegrationType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type {BotModule} from '../types';

const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Every Plural Starbot command, with what it does')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

const LINKING = [
  'DM the bot for these two.',
  '`/link` – Link your Plural Star cloud vault (enter your cloud password)',
  '`/unlink` – Remove the bot from your vault and delete its key',
].join('\n');

const PROXYING = [
  'Your members come from your vault; there is nothing to register.',
  '`<emoji> text` or `text <emoji>` – Post as the member whose profile Emoji that is',
  '`\\text` – Send one message unproxied',
  '`/autoproxy off` – Stop autoproxying in this server',
  '`/autoproxy front` – Post as whoever is first in your primary front',
  '`/autoproxy member <name>` – Post as one fixed member',
  '`/autoproxy latch` – Post as the member you last proxied as (6 h timeout)',
  '`/proxy format <template>` – Name on your proxied messages; tags `{Emoji}` `{Name}` `{Pronouns}` `{Role}` `{Sys Tag}`',
  '`/proxy format` – Show the current format and a preview',
  '`/proxy systag <text>` – Set your Sys Tag (20 characters max); `clear` removes it',
  '  `scope` on both: everywhere, or this server only',
  '`/proxy edit <text>` – Edit your last proxied message in this channel',
  'React ❌ – Delete your proxied message · React ❓ – See who sent one (by DM)',
].join('\n');

const PROFILES = [
  'Your own vault by default; add `@user` to view someone else\'s.',
  '`/member <name>` – Member card: pronouns, role, colour, emoji, groups, description, custom fields',
  '`/system` – System card: name, description, member count',
  '`/front show` – Who is fronting, by tier, with how long',
  '`/front set <members> [tier]` – Add members to a tier, keeping who is already there',
  '`/front add <member> [tier]` – Add a member to a tier',
  '`/front remove <member>` – Take a member out of the front',
  '`/front clear` – Clear the whole front',
  '  `tier`: primary, cofront or coconscious (default primary)',
].join('\n');

const HEALTH = [
  'Requires Manage Server.',
  '`/health channel` – Channel the reminders post in',
  '`/health role` – Role to ping for a group (six groups)',
  '`/health starttime` / `/health interval` – Shared schedule: first ping (HH:MM) and hours between pings',
  '`/health groupschedule` – Give one group its own start time and interval',
  '`/health timezone` – IANA timezone, e.g. America/New_York',
  '`/health test` – Send one round now',
  '`/health show` – Current settings and ping times',
  '`/health enable` / `/health disable` – Turn the schedule on or off',
].join('\n');

const MODERATION = [
  'Requires Manage Server.',
  '`/proxylog channel #channel` – Log every proxied message with its sender',
  '`/proxylog off` – Stop logging',
].join('\n');

const buildHelp = (): EmbedBuilder =>
  new EmbedBuilder()
    .setTitle('Plural Starbot commands')
    .addFields(
      {name: 'Linking', value: LINKING},
      {name: 'Proxying', value: PROXYING},
      {name: 'Profiles & front', value: PROFILES},
      {name: 'Health reminders', value: HEALTH},
      {name: 'Moderation', value: MODERATION},
    )
    .setFooter({text: 'Private members in Plural Star are only ever shown to their own system.'});

const onHelp = async (i: ChatInputCommandInteraction): Promise<void> => {
  await i.reply({embeds: [buildHelp()], flags: MessageFlags.Ephemeral});
};

const help: BotModule = {
  name: 'help',
  commands: [helpCommand],
  async onInteraction(interaction: Interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === 'help') await onHelp(interaction);
  },
};

export default help;
