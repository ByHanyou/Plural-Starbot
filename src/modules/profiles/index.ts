// Profiles and front: /member, /system and /front, read from (and for /front changes, written to) the vault.
import type {Interaction} from 'discord.js';
import type {BotModule} from '../types';
import {frontCommand, handleFront, handleMember, handleSystem, memberCommand, systemCommand} from './commands';

const profiles: BotModule = {
  name: 'profiles',
  commands: [memberCommand, systemCommand, frontCommand],

  async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'member') await handleMember(interaction);
    else if (interaction.commandName === 'system') await handleSystem(interaction);
    else if (interaction.commandName === 'front') await handleFront(interaction);
  },
};

export default profiles;
