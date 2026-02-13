import {
    type ChatInputCommandInteraction,
    type ButtonInteraction,
    type EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags,
} from 'discord.js';

export interface PaginationOptions {
    embeds: EmbedBuilder[];
    interaction: ChatInputCommandInteraction;
    ephemeral?: boolean;
    timeout?: number; // ms, default 120000 (2 min)
}

/**
 * Send a paginated embed response with Previous/Next buttons.
 * If there's only one page, no buttons are shown.
 */
export async function paginate(options: PaginationOptions): Promise<void> {
    const { embeds, interaction, ephemeral = false, timeout = 120_000 } = options;

    if (embeds.length === 0) {
        await interaction.reply({ content: 'No results to display.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (embeds.length === 1) {
        await interaction.reply({ embeds: [embeds[0]], flags: ephemeral ? MessageFlags.Ephemeral : undefined });
        return;
    }

    let currentPage = 0;

    const getRow = () => {
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('pagination_prev')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0),
            new ButtonBuilder()
                .setCustomId('pagination_page')
                .setLabel(`${currentPage + 1} / ${embeds.length}`)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId('pagination_next')
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === embeds.length - 1)
        );
    };

    const message = await interaction.reply({
        embeds: [embeds[currentPage]],
        components: [getRow()],
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        fetchReply: true,
    });

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (i: ButtonInteraction) => i.user.id === interaction.user.id,
        time: timeout,
    });

    collector.on('collect', async (i: ButtonInteraction) => {
        if (i.customId === 'pagination_prev') {
            currentPage = Math.max(0, currentPage - 1);
        } else if (i.customId === 'pagination_next') {
            currentPage = Math.min(embeds.length - 1, currentPage + 1);
        }

        await i.update({
            embeds: [embeds[currentPage]],
            components: [getRow()],
        });
    });

    collector.on('end', async () => {
        try {
            await message.edit({ components: [] });
        } catch {
            // Message may have been deleted
        }
    });
}
