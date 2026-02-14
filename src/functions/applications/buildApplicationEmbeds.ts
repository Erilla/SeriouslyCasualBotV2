import { EmbedBuilder, Colors } from 'discord.js';

/**
 * Discord limits: 4096 chars per embed description, 6000 chars total per message.
 * Build embeds from Q&A pairs, grouped into batches that fit in a single message.
 * Returns an array of batches, where each batch is an array of embeds safe to send together.
 */
export function buildApplicationEmbedBatches(
    title: string,
    applicantMention: string | null,
    questionsAndAnswers: Array<{ question: string; answer: string }>,
): EmbedBuilder[][] {
    const parts = questionsAndAnswers.map(
        (qa, i) => `**Q${i + 1}: ${qa.question}**\n${qa.answer}`,
    );

    // Build individual embeds, each under 4000 chars
    const allEmbeds: EmbedBuilder[] = [];
    let currentDescription = '';

    for (const part of parts) {
        if (currentDescription.length + part.length + 4 > 4000) {
            allEmbeds.push(
                new EmbedBuilder().setDescription(currentDescription).setColor(Colors.Blue),
            );
            currentDescription = part;
        } else {
            currentDescription += (currentDescription ? '\n\n' : '') + part;
        }
    }

    if (currentDescription) {
        allEmbeds.push(
            new EmbedBuilder().setDescription(currentDescription).setColor(Colors.Blue),
        );
    }

    if (allEmbeds.length === 0) {
        allEmbeds.push(
            new EmbedBuilder().setDescription('No answers provided.').setColor(Colors.Blue),
        );
    }

    // Add header to first embed
    const header = new EmbedBuilder()
        .setTitle(title)
        .setColor(Colors.Blue)
        .setTimestamp();
    if (applicantMention) header.setDescription(`Applicant: ${applicantMention}`);

    // Group into message batches under 5800 total chars
    const MESSAGE_CHAR_LIMIT = 5800;
    const batches: EmbedBuilder[][] = [];
    let currentBatch: EmbedBuilder[] = [header];
    let currentBatchSize = (header.data.title?.length ?? 0) + (header.data.description?.length ?? 0);

    for (const embed of allEmbeds) {
        const embedSize = (embed.data.description?.length ?? 0);
        if (currentBatchSize + embedSize > MESSAGE_CHAR_LIMIT && currentBatch.length > 1) {
            batches.push(currentBatch);
            currentBatch = [embed];
            currentBatchSize = embedSize;
        } else {
            currentBatch.push(embed);
            currentBatchSize += embedSize;
        }
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}
