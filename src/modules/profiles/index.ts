import type {Interaction} from 'discord.js';
import type {BotModule} from '../types';
import {MEMBER_PAGE_ID} from './cards';
import {frontCommand, handleFront, handleMember, handleMemberPage, handleSystem, memberCommand, systemCommand} from './commands';

const profiles: BotModule = {
  name: 'profiles',
  commands: [memberCommand, systemCommand, frontCommand],

  async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton() && interaction.customId.startsWith(MEMBER_PAGE_ID)) {
      await handleMemberPage(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'member') await handleMember(interaction);
    else if (interaction.commandName === 'system') await handleSystem(interaction);
    else if (interaction.commandName === 'front') await handleFront(interaction);
  },
};

export default profiles;
