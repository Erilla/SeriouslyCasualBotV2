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
 * Creates the DB record first, then Discord resources, then updates the record.
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
    let answers: string[];
    try {
        answers = JSON.parse(session.answers);
    } catch {
        db.prepare('DELETE FROM application_sessions WHERE user_id = ?').run(user.id);
        return 'Your application session was corrupted. Please start a new application with `/apply`.';
    }

    if (answers.length < questions.length) {
        return 'Your application is not yet complete. Please answer all questions.';
    }

    // Build Q&A pairs
    const questionsAndAnswers = questions.map((q, i) => ({
        question: q.question_text,
        answer: answers[i] ?? 'No answer provided',
    }));

    // Create application record FIRST to ensure DB consistency
    const insertResult = db.prepare(
        "INSERT INTO applications (user_id, status, submitted_at) VALUES (?, 'pending', datetime('now'))",
    ).run(user.id);
    const appId = Number(insertResult.lastInsertRowid);

    // Create analytics record
    db.prepare(
        "INSERT INTO application_analytics (user_id, submitted_at) VALUES (?, datetime('now'))",
    ).run(user.id);

    // Clean up session
    db.prepare('DELETE FROM application_sessions WHERE user_id = ?').run(user.id);

    // Create Discord resources (channel + forum post)
    const channel = await createApplicationChannel(
        client,
        user.id,
        user.displayName,
        questionsAndAnswers,
    );

    const forumPost = await createForumPost(
        client,
        user.id,
        user.displayName,
        questionsAndAnswers,
    );

    if (forumPost) {
        await addOverlordsToThread(forumPost);
    }

    // Update application record with Discord resource IDs
    db.prepare(
        'UPDATE applications SET channel_id = ?, forum_post_id = ? WHERE id = ?',
    ).run(channel?.id ?? null, forumPost?.id ?? null, appId);

    // Warn if both Discord resources failed
    if (!channel && !forumPost) {
        await logger.error(`[Applications] Both channel and forum post creation failed for ${user.tag}`);
    }

    // DM applicant with confirmation
    try {
        let msg = 'Your application has been submitted! An officer will review it soon.';
        if (channel) msg += ` You can also chat in <#${channel.id}>.`;
        if (!channel && !forumPost) msg += ' Note: there was an issue posting your application. An admin has been notified.';
        await user.send(msg);
    } catch {
        await logger.warn(`[Applications] Failed to DM confirmation to ${user.tag}`);
    }

    await logger.info(
        `[Applications] Application submitted by ${user.tag} — ` +
        `channel: ${channel?.id ?? 'none'}, forum: ${forumPost?.id ?? 'none'}`,
    );

    return null;
}
