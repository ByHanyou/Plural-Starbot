import type {Client, Interaction, Message, MessageReaction, PartialMessageReaction, RESTPostAPIApplicationCommandsJSONBody, User} from 'discord.js';

/** A command as a builder (anything with toJSON(), e.g. SlashCommandBuilder) or as raw JSON. */
export type CommandData = RESTPostAPIApplicationCommandsJSONBody | {toJSON(): RESTPostAPIApplicationCommandsJSONBody};

/**
 * A feature module. src/modules/index.ts lists them in a fixed order.
 *
 * Registration: a command whose JSON allows the bot-DM context (contexts includes
 * InteractionContextType.BotDM, or dm_permission: true) is registered globally;
 * every other command is registered per guild.
 *
 * Dispatch: slash/context-menu commands and autocomplete go only to the module that
 * declares the command name. Buttons, select menus and modal submits go to every module
 * in order, so each module must ignore custom ids that are not its own (prefix them
 * with the module name, e.g. "proxy:edit").
 * Reactions arrive with partials already fetched. Fetching costs REST calls, so a module with
 * onReactionAdd may also give wantsReaction: a cheap test on the (possibly partial) reaction;
 * when no module wants a reaction, nothing is fetched.
 */
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
