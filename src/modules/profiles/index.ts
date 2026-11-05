import type {Interaction} from 'discord.js';
import type {BotModule} from '../types';
import {MEMBER_PAGE_ID} from './cards';
import {frontCommand, handleMemberPage, memberCommand, systemCommand} from './commands';
import {editCommand} from './edit';

const profiles: BotModule = {
  name: 'profiles',
  commands: [memberCommand, systemCommand, frontCommand, editCommand],

  async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton() && interaction.customId.startsWith(MEMBER_PAGE_ID)) await handleMemberPage(interaction);
  },
};

export default profiles;
