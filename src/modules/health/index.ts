import {Client, Events, Interaction} from 'discord.js';
import {log} from '../../log';
import type {BotModule} from '../types';
import {dropContent} from './memory';
import {dropSettings, guildsWithStoredSettings} from './settings';
import {ensureLoop, forgetRolelessWarnings, stopLoop} from './delivery';
import {handleHealth, healthCommand} from './commands';

const health: BotModule = {
  name: 'health',
  commands: [healthCommand],

  async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'health') return;
    await handleHealth(interaction);
  },

  onReady(client: Client<true>): void {
    for (const guildId of guildsWithStoredSettings()) {
      if (client.guilds.cache.has(guildId)) ensureLoop(client, guildId);
    }
    client.on(Events.GuildCreate, guild => {
      try {
        if (guildsWithStoredSettings().includes(guild.id)) ensureLoop(client, guild.id);
      } catch (e) {
        log.exception(e, "Could not start reminders for server '%s'.", guild.name);
      }
    });
    client.on(Events.GuildDelete, guild => {
      stopLoop(guild.id);
      dropSettings(guild.id);
      dropContent(guild.id);
      forgetRolelessWarnings(guild.id);
    });
  },
};

export default health;
