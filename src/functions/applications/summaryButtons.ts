import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

/**
 * The Edit/Confirm/Cancel row shown under the application summary DM.
 *
 * One builder produces both the live and the spent version so the two can't
 * drift apart. Disabling is presentation only — Discord still routes clicks
 * from any copy of the message the applicant scrolls back to, so the handlers
 * check the application's state as well.
 */
export function buildSummaryRow(
  applicationId: number,
  { disabled = false }: { disabled?: boolean } = {},
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`application:edit:${applicationId}`)
      .setLabel('Edit Answer')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`application:confirm:${applicationId}`)
      .setLabel('Confirm & Submit')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`application:cancel:${applicationId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}
