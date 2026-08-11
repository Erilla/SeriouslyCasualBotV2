import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder } from 'discord.js';

/**
 * The officer Accept/Reject controls, under their own embed.
 *
 * The embed is what keeps these buttons apart from the voting row. This message
 * follows the voting embed immediately, and Discord draws a component-only
 * message flush against the one above it — so Accept sat directly beneath For,
 * both green, and Reject directly beneath Against, both red. Two adjacent rows of
 * identically-coloured buttons, one recording an opinion and one ending the
 * application, was a misclick waiting to happen.
 *
 * A titled embed gives the row a coloured divider bar, a heading and vertical
 * space, which no arrangement of buttons alone can do: Discord has no spacer
 * component, and a disabled filler button would just add another thing to click.
 */
export function buildDecisionMessage(applicationId: number): {
  embeds: [EmbedBuilder];
  components: [ActionRowBuilder<ButtonBuilder>];
} {
  const embed = new EmbedBuilder()
    .setTitle('Decision')
    // Blurple rather than the voting embed's green: the colour bar is the first
    // thing that distinguishes the two messages at a glance.
    .setColor(Colors.Blurple)
    .setDescription('Accept or reject this applicant. This closes the application.');

  const decisionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`application:accept:${applicationId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`application:reject:${applicationId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [decisionRow] };
}
