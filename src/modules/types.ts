import type {Client, Interaction, Message, MessageReaction, PartialMessageReaction, RESTPostAPIApplicationCommandsJSONBody, User} from 'discord.js';

export type CommandData = RESTPostAPIApplicationCommandsJSONBody | {toJSON(): RESTPostAPIApplicationCommandsJSONBody};

export interface BotModule {
  name: string;
  commands: CommandData[];
  onInteraction(interaction: Interaction): Promise<void> | void;
  onMessage?(message: Message): Promise<void> | void;
  onReactionAdd?(reaction: MessageReaction, user: User): Promise<void> | void;
  wantsReaction?(reaction: MessageReaction | PartialMessageReaction): boolean;
  onReady?(client: Client<true>): Promise<void> | void;
}

export const commandJSON = (c: CommandData): RESTPostAPIApplicationCommandsJSONBody =>
  'toJSON' in c && typeof c.toJSON === 'function' ? c.toJSON() : (c as RESTPostAPIApplicationCommandsJSONBody);
