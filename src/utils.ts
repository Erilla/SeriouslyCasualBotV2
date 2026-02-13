import { type Channel, type TextBasedChannel, PartialGroupDMChannel } from 'discord.js';
import { createRequire } from 'node:module';

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
 * Loads a JSON file using createRequire for ESM compatibility.
 * Node16 module resolution doesn't support `import ... with { type: 'json' }`.
 */
export function loadJson<T>(relativePath: string): T {
    return require(relativePath) as T;
}
