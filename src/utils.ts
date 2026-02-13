import { type Channel, type TextBasedChannel, PartialGroupDMChannel } from 'discord.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
