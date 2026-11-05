import type {Client, Interaction, Message, MessageReaction, PartialMessageReaction, User} from 'discord.js';
import type {Command} from '../discord/commands';

export interface BotModule {
  name: string;
  commands: Command[];
  onInteraction?(interaction: Interaction): Promise<void> | void;
  onMessage?(message: Message): Promise<void> | void;
  onReactionAdd?(reaction: MessageReaction, user: User): Promise<void> | void;
  wantsReaction?(reaction: MessageReaction | PartialMessageReaction): boolean;
  onReady?(client: Client<true>): Promise<void> | void;
}
