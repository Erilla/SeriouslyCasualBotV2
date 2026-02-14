import { type Client, type User } from 'discord.js';
import { getDatabase } from '../../database/database.js';
import { getActiveQuestions } from './applicationQuestions.js';
import { createApplicationChannel } from './createApplicationChannel.js';
import { createForumPost } from './createForumPost.js';
import { addOverlordsToThread } from '../addOverlordsToThread.js';
import { logger } from '../../services/logger.js';
import type { ApplicationSessionRow } from '../../types/index.js';

/**
 * Submit a completed application.
 * Creates the application channel, forum post, and database records.
 * Returns an error message string on failure, or null on success.
 */
export async function submitApplication(client: Client, user: User): Promise<string | null> {
    const db = getDatabase();

    // Get session
    const session = db
        .prepare("SELECT * FROM application_sessions WHERE user_id = ? AND status = 'in_progress'")
        .get(user.id) as ApplicationSessionRow | undefined;

    if (!session) {
        return 'No active application session found.';
    }

    const questions = getActiveQuestions();
    const answers: string[] = JSON.parse(session.answers);

    if (answers.length < questions.length) {
        return 'Your application is not yet complete. Please answer all questions.';
    }

    // Build Q&A pairs
    const questionsAndAnswers = questions.map((q, i) => ({
        question: q.question_text,
        answer: answers[i] ?? 'No answer provided',
    }));

    // Create application channel
    const channel = await createApplicationChannel(
        client,
        user.id,
        user.displayName,
        questionsAndAnswers,
    );

    // Create forum post
    const forumPost = await createForumPost(
        client,
        user.id,
        user.displayName,
        questionsAndAnswers,
    );

    // Add overlords to the forum thread
    if (forumPost) {
        await addOverlordsToThread(forumPost);
    }

    // Create application record
    db.prepare(
        'INSERT INTO applications (user_id, channel_id, forum_post_id, status, submitted_at) VALUES (?, ?, ?, ?, datetime(\'now\'))',
    ).run(
        user.id,
        channel?.id ?? null,
        forumPost?.id ?? null,
        'pending',
    );

    // Create analytics record
    db.prepare(
        'INSERT INTO application_analytics (user_id, submitted_at) VALUES (?, datetime(\'now\'))',
    ).run(user.id);

    // Clean up session
    db.prepare('DELETE FROM application_sessions WHERE user_id = ?').run(user.id);

    // DM applicant with confirmation
    try {
        await user.send(
            'Your application has been submitted! An officer will review it soon. ' +
            (channel ? `You can also chat in <#${channel.id}>.` : ''),
        );
    } catch {
        await logger.warn(`[Applications] Failed to DM confirmation to ${user.tag}`);
    }

    await logger.info(
        `[Applications] Application submitted by ${user.tag} — ` +
        `channel: ${channel?.id ?? 'none'}, forum: ${forumPost?.id ?? 'none'}`,
    );

    return null;
}
