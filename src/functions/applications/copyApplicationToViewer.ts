import { type Client, type TextChannel, type Message } from 'discord.js';
import { getDatabase } from '../../database/database.js';
import { createForumPost } from './createForumPost.js';
import { addOverlordsToThread } from '../addOverlordsToThread.js';
import { logger } from '../../services/logger.js';
import type { ApplicationRow } from '../../types/index.js';

/**
 * Copy the content from a legacy application channel and create a forum post.
 * Used in legacy mode where a 3rd party bot creates application channels.
 */
export async function copyApplicationToViewer(
    client: Client,
    channel: TextChannel,
): Promise<void> {
    try {
        // Fetch recent messages from the channel
        const messages = await channel.messages.fetch({ limit: 50 });
        const sorted = [...messages.values()].sort(
            (a, b) => a.createdTimestamp - b.createdTimestamp,
        );

        if (sorted.length === 0) {
            await logger.debug(`[Applications] No messages in legacy channel #${channel.name}`);
            return;
        }

        // Extract applicant info from the channel
        const applicantName = extractApplicantName(channel.name);
        const applicantId = extractApplicantId(sorted);

        if (!applicantId) {
            await logger.warn(`[Applications] Could not identify applicant from legacy channel #${channel.name}, skipping`);
            return;
        }

        // Check for existing pending application by this user
        const db = getDatabase();
        const existingApp = db
            .prepare("SELECT id FROM applications WHERE user_id = ? AND status = 'pending'")
            .get(applicantId) as ApplicationRow | undefined;
        if (existingApp) {
            await logger.debug(`[Applications] Skipping legacy channel #${channel.name} — user ${applicantId} already has a pending application`);
            return;
        }

        // Build Q&A pairs from the messages
        const questionsAndAnswers = extractQuestionsAndAnswers(sorted);

        // Create forum post
        const forumPost = await createForumPost(
            client,
            applicantId,
            applicantName,
            questionsAndAnswers,
        );

        if (forumPost) {
            await addOverlordsToThread(forumPost);
        }

        // Create application record
        db.prepare(
            "INSERT INTO applications (user_id, channel_id, forum_post_id, status, submitted_at) VALUES (?, ?, ?, 'pending', datetime('now'))",
        ).run(applicantId, channel.id, forumPost?.id ?? null);

        // Create analytics record
        db.prepare(
            "INSERT INTO application_analytics (user_id, submitted_at) VALUES (?, datetime('now'))",
        ).run(applicantId);

        await logger.info(`[Applications] Copied legacy application from #${channel.name}`);
    } catch (error) {
        await logger.error(`[Applications] Failed to copy legacy application from #${channel.name}`, error);
    }
}

/**
 * Extract applicant name from channel name.
 * Channel names are typically like "app-charactername" or "application-charactername".
 */
function extractApplicantName(channelName: string): string {
    return channelName
        .replace(/^(app|application|apply)-?/i, '')
        .replace(/-/g, ' ')
        .trim() || channelName;
}

/**
 * Try to extract the applicant user ID from messages.
 * Looks for mentions or the first non-bot message author.
 * Also parses <@userId> patterns in message/embed text for 3rd party bot formats.
 */
function extractApplicantId(messages: Message[]): string | null {
    // Look for the first non-bot message author
    for (const msg of messages) {
        if (!msg.author.bot) {
            return msg.author.id;
        }
    }

    // Look for user mentions in bot messages
    for (const msg of messages) {
        if (msg.mentions.users.size > 0) {
            const mentioned = msg.mentions.users.first();
            if (mentioned && !mentioned.bot) return mentioned.id;
        }
    }

    // Parse <@userId> from "Name of Applicant:" lines in message/embed text
    // Only match mentions on the applicant metadata line to avoid picking up bot self-mentions
    const applicantLineRegex = /Name of Applicant:.*<@!?(\d+)>/i;
    for (const msg of messages) {
        const textSources = [
            msg.content,
            ...msg.embeds.map((e) => e.description ?? ''),
        ];
        for (const text of textSources) {
            const match = text.match(applicantLineRegex);
            if (match) return match[1];
        }
    }

    return null;
}

/** Lines that are noise (headers, pagination, metadata) — not real Q&A content */
const NOISE_PATTERNS = [
    /^-{5,}/, // ---------- header lines
    /^Page \d+\/\d+$/i, // Page 1/2
    /^\*This application has been split/i, // pagination notice
    /^Date of Application:/i, // metadata
    /^Name of Applicant:/i, // metadata
];

function isNoiseLine(text: string): boolean {
    return NOISE_PATTERNS.some((p) => p.test(text.trim()));
}

/**
 * Extract Q&A pairs from messages.
 * Attempts to parse structured application content from bot messages.
 * Supports:
 *  - **Q1** / **Q2** format
 *  - Numbered "1. " format
 *  - 3rd party bot bold-question format: **Question text** -\nAnswer
 */
function extractQuestionsAndAnswers(
    messages: Message[],
): Array<{ question: string; answer: string }> {
    const result: Array<{ question: string; answer: string }> = [];

    // Concatenate all message content
    const fullContent = messages
        .map((m) => m.content || m.embeds.map((e) => `${e.title ?? ''}\n${e.description ?? ''}`).join('\n'))
        .filter(Boolean)
        .join('\n');

    if (!fullContent.trim()) {
        return [{ question: 'Application Content', answer: 'No content found in the application channel.' }];
    }

    // Try to split by common Q&A patterns (e.g. bold headers, numbered items, bold-question format)
    const qaParts = fullContent.split(/(?=\*\*Q\d+|(?:^|\n)\d+\.\s|\*\*[^*]+\*\*\s*-)/);

    if (qaParts.length > 1) {
        for (const part of qaParts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            if (isNoiseLine(trimmed)) continue;

            const firstNewline = trimmed.indexOf('\n');
            if (firstNewline > 0) {
                const question = trimmed.slice(0, firstNewline)
                    .replace(/\*\*/g, '')
                    .replace(/\s*-\s*$/, '')
                    .trim();
                const answer = trimmed.slice(firstNewline + 1).trim();

                // Skip if extracted question is noise
                if (isNoiseLine(question) || !question) continue;
                // Skip if answer is only noise lines
                const answerLines = answer.split('\n').filter((l) => l.trim() && !isNoiseLine(l));
                if (answerLines.length === 0) continue;

                result.push({ question, answer: answerLines.join('\n').trim() });
            } else {
                if (!isNoiseLine(trimmed)) {
                    result.push({ question: 'Application', answer: trimmed });
                }
            }
        }
    }

    if (result.length === 0) {
        // Couldn't parse structure, dump as single entry
        result.push({ question: 'Application Content', answer: fullContent.slice(0, 4000) });
    }

    return result;
}
