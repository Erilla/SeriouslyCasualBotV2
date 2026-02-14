import { type Channel, type Client, type TextBasedChannel, type TextChannel, type BaseMessageOptions, PartialGroupDMChannel } from 'discord.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { getChannel } from './functions/setup/getChannel.js';
import { logger } from './services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);

/**
 * Narrows a channel to a sendable type, excluding PartialGroupDMChannel
 * which doesn't have a .send() method in Discord.js v14.
 */
export function asSendable(channel: Channel | null): TextBasedChannel | null {
    if (!channel || channel instanceof PartialGroupDMChannel) return null;
    if ('send' in channel) return channel as TextBasedChannel;
    return null;
}

/**
 * Loads a JSON file relative to the project root.
 * Example: loadJson('data/aboutus.json')
 */
export function loadJson<T>(relativePath: string): T {
    const fullPath = path.resolve(PROJECT_ROOT, relativePath);
    return require(fullPath) as T;
}

/**
 * Fetch a configured text channel by config key.
 * Returns null (with a warning log) if the channel is not configured, not found, or not sendable.
 */
export async function fetchTextChannel(client: Client, configKey: string): Promise<TextChannel | null> {
    const channelId = getChannel(configKey);
    if (!channelId) return null;
    try {
        const channel = await client.channels.fetch(channelId);
        const sendable = asSendable(channel);
        return (sendable as TextChannel) ?? null;
    } catch (error) {
        logger.warn(`Failed to fetch channel for "${configKey}" (${channelId}): ${error}`).catch(() => {});
        return null;
    }
}

/**
 * Split a long message into chunks that fit within Discord's 2000-char limit.
 * Prefers splitting at newlines to avoid breaking lines.
 */
export function chunkMessage(text: string, maxLength = 2000): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        let splitAt = remaining.lastIndexOf('\n', maxLength);
        if (splitAt <= 0) splitAt = maxLength;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
    return chunks;
}

/**
 * Send multiple Discord messages in parallel batches to respect rate limits.
 * Sends up to `batchSize` messages concurrently, then waits before the next batch.
 */
export async function sendInBatches(
    channel: TextChannel,
    payloads: BaseMessageOptions[],
    batchSize = 3,
): Promise<void> {
    for (let i = 0; i < payloads.length; i += batchSize) {
        const batch = payloads.slice(i, i + batchSize);
        await Promise.all(batch.map((p) => channel.send(p)));
    }
}
