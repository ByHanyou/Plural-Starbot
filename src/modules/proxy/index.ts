import {Client, Events, Interaction} from 'discord.js';
import {db} from '../../db';
import {log} from '../../log';
import type {BotModule} from '../types';
import {
  autocompleteAutoproxy,
  autocompleteProxy,
  autoproxyCommand,
  handleAutoproxy,
  handleProxy,
  handleProxylog,
  proxyCommand,
  proxylogCommand,
} from './commands';
import {handleMessage} from './proxy';
import {handleReaction, wantsReaction} from './reactions';
import {forgetWebhook} from './webhooks';

const forgetDeleted = (ids: Iterable<string>): void => {
  try {
    for (const id of ids) db().deleteProxied(id);
  } catch (e) {
    log.exception(e, 'Could not remove deleted proxied-message records.');
  }
};

const proxy: BotModule = {
  name: 'proxy',
  commands: [autoproxyCommand, proxyCommand, proxylogCommand],

  async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'autoproxy') await autocompleteAutoproxy(interaction);
      else if (interaction.commandName === 'proxy') await autocompleteProxy(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'autoproxy') await handleAutoproxy(interaction);
    else if (interaction.commandName === 'proxy') await handleProxy(interaction);
    else if (interaction.commandName === 'proxylog') await handleProxylog(interaction);
  },

  onMessage: handleMessage,

  wantsReaction,

  onReactionAdd: handleReaction,

  onReady(client: Client<true>): void {
    client.on(Events.MessageDelete, m => forgetDeleted([m.id]));
    client.on(Events.MessageBulkDelete, ms => forgetDeleted(ms.keys()));
    client.on(Events.ChannelDelete, c => forgetWebhook(c.id));
  },
};

export default proxy;
