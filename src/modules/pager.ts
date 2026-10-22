import {ActionRowBuilder, ButtonBuilder, ButtonStyle} from 'discord.js';

export const pagerRow = (ids: {prev: string; label: string; next: string}, page: number, pages: number): ActionRowBuilder<ButtonBuilder> =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.prev).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(ids.label).setLabel(`Page ${page + 1} of ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(ids.next).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
  );
