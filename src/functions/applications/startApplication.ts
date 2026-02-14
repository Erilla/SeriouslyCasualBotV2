import { type User, EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getDatabase } from '../../database/database.js';
import { getActiveQuestions } from './applicationQuestions.js';
import { logger } from '../../services/logger.js';
import type { ApplicationRow, ApplicationSessionRow } from '../../types/index.js';

/**
 * Start a new application session for a user via DM.
 * Returns an error message string if the application cannot start, or null on success.
 */
export async function startApplication(user: User): Promise<string | null> {
    const db = getDatabase();

    // Check for existing pending application
    const existing = db
        .prepare("SELECT * FROM applications WHERE user_id = ? AND status = 'pending'")
        .get(user.id) as ApplicationRow | undefined;
    if (existing) {
        return 'You already have a pending application. Please wait for it to be reviewed.';
    }

    // Check for existing in-progress session
    const existingSession = db
        .prepare("SELECT * FROM application_sessions WHERE user_id = ? AND status = 'in_progress'")
        .get(user.id) as ApplicationSessionRow | undefined;
    if (existingSession) {
        return 'You already have an application in progress. Please check your DMs to continue.';
    }

    // Get active questions
    const questions = getActiveQuestions();
    if (questions.length === 0) {
        return 'The application system is not yet configured. Please try again later.';
    }

    // Create session
    db.prepare(
        "INSERT INTO application_sessions (user_id, status, current_question, answers) VALUES (?, 'in_progress', 0, '[]')",
    ).run(user.id);

    // Send first question via DM
    const embed = new EmbedBuilder()
        .setTitle('SeriouslyCasual Application')
        .setDescription(
            'Welcome! You\'re about to apply to **SeriouslyCasual**.\n\n' +
            'I\'ll ask you a series of questions one at a time. Simply reply with your answer.\n\n' +
            'You can type `cancel` at any time to cancel your application.',
        )
        .setColor(Colors.Blue);

    const questionEmbed = new EmbedBuilder()
        .setTitle(`Question 1 of ${questions.length}`)
        .setDescription(questions[0].question_text)
        .setColor(Colors.Gold)
        .setFooter({ text: 'Reply with your answer in this DM' });

    try {
        await user.send({ embeds: [embed, questionEmbed] });
    } catch (error) {
        // Clean up session if DM fails
        db.prepare('DELETE FROM application_sessions WHERE user_id = ?').run(user.id);
        await logger.warn(`[Applications] Failed to DM ${user.tag}: ${error}`);
        return 'I couldn\'t send you a DM. Please make sure your DMs are open and try again.';
    }

    await logger.info(`[Applications] Started application session for ${user.tag}`);
    return null;
}

/**
 * Build the "Apply Now" button for embedding in channels.
 */
export function buildApplyButton(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('application:apply')
            .setLabel('Apply Now')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📝'),
    );
}
