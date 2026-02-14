import {
    type Message,
    type User,
    EmbedBuilder,
    Colors,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { getDatabase } from '../../database/database.js';
import { getActiveQuestions } from './applicationQuestions.js';
import { logger } from '../../services/logger.js';
import type { ApplicationSessionRow } from '../../types/index.js';

/**
 * Get an active application session for a user.
 */
export function getActiveSession(userId: string): ApplicationSessionRow | null {
    const db = getDatabase();
    const session = db
        .prepare("SELECT * FROM application_sessions WHERE user_id = ? AND status = 'in_progress'")
        .get(userId) as ApplicationSessionRow | undefined;
    return session ?? null;
}

/**
 * Handle a DM message from a user who has an active application session.
 * Returns true if the message was handled (user has active session), false otherwise.
 */
export async function handleDmResponse(message: Message): Promise<boolean> {
    const session = getActiveSession(message.author.id);
    if (!session) return false;

    const content = message.content.trim();

    // Handle cancellation
    if (content.toLowerCase() === 'cancel') {
        cancelSession(message.author.id);
        await message.reply('Your application has been cancelled. You can start a new one at any time with `/apply`.');
        await logger.info(`[Applications] ${message.author.tag} cancelled their application`);
        return true;
    }

    // Reject empty messages or attachment-only messages
    if (!content) {
        await message.reply('Please reply with a text answer. Attachments and images are not accepted.');
        return true;
    }

    const questions = getActiveQuestions();
    if (questions.length === 0) {
        cancelSession(message.author.id);
        await message.reply('The application questions are no longer available. Please try again later.');
        return true;
    }

    // Save answer (truncate to safe length for embed display)
    const MAX_ANSWER_LENGTH = 3900;
    const answer = content.length > MAX_ANSWER_LENGTH
        ? content.slice(0, MAX_ANSWER_LENGTH) + '... (truncated)'
        : content;

    let answers: string[];
    try {
        answers = JSON.parse(session.answers);
    } catch {
        cancelSession(message.author.id);
        await message.reply('Your application session was corrupted. Please start a new application with `/apply`.');
        await logger.error(`[Applications] Corrupted session data for ${message.author.id}`);
        return true;
    }
    answers.push(answer);
    const nextQuestion = session.current_question + 1;

    const db = getDatabase();

    // Check if all questions answered
    if (nextQuestion >= questions.length) {
        // All questions answered - show confirmation
        db.prepare(
            'UPDATE application_sessions SET answers = ?, current_question = ? WHERE user_id = ?',
        ).run(JSON.stringify(answers), nextQuestion, message.author.id);

        try {
            await sendConfirmation(message.author, questions.map((q) => q.question_text), answers);
        } catch (error) {
            cancelSession(message.author.id);
            await message.reply('Failed to send your application summary. Your session has been cancelled. Please try again with `/apply`.');
            await logger.warn(`[Applications] Failed to send confirmation to ${message.author.tag}: ${error}`);
        }
        return true;
    }

    // Save and send next question
    db.prepare(
        'UPDATE application_sessions SET answers = ?, current_question = ? WHERE user_id = ?',
    ).run(JSON.stringify(answers), nextQuestion, message.author.id);

    const questionEmbed = new EmbedBuilder()
        .setTitle(`Question ${nextQuestion + 1} of ${questions.length}`)
        .setDescription(questions[nextQuestion].question_text)
        .setColor(Colors.Gold)
        .setFooter({ text: 'Reply with your answer in this DM' });

    await message.reply({ embeds: [questionEmbed] });
    return true;
}

/**
 * Send the confirmation summary with all answers for review before submission.
 */
async function sendConfirmation(user: User, questionTexts: string[], answers: string[]): Promise<void> {
    const summaryParts = questionTexts.map((q, i) =>
        `**Q${i + 1}: ${q}**\n${answers[i]}`,
    );

    // Split into multiple embeds if too long (embed description limit is 4096)
    const embeds: EmbedBuilder[] = [];
    let currentDescription = '';

    for (const part of summaryParts) {
        if (currentDescription.length + part.length + 4 > 4000) {
            embeds.push(
                new EmbedBuilder()
                    .setDescription(currentDescription)
                    .setColor(Colors.Blue),
            );
            currentDescription = part;
        } else {
            currentDescription += (currentDescription ? '\n\n' : '') + part;
        }
    }

    if (currentDescription) {
        embeds.push(
            new EmbedBuilder()
                .setDescription(currentDescription)
                .setColor(Colors.Blue),
        );
    }

    // Title on the first embed
    if (embeds.length > 0) {
        embeds[0].setTitle('Application Review');
    }

    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('application:confirm')
            .setLabel('Submit Application')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('application:cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger),
    );

    await user.send({
        content: 'Please review your application below. Click **Submit Application** to send it, or **Cancel** to discard it.',
        embeds,
        components: [confirmRow],
    });
}

/**
 * Cancel an application session.
 */
export function cancelSession(userId: string): void {
    const db = getDatabase();
    db.prepare('DELETE FROM application_sessions WHERE user_id = ?').run(userId);
}
