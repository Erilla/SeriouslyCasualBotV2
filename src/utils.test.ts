import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSendable, chunkMessage } from './utils.js';

// Mock getChannel (used by fetchTextChannel internally)
const mockGetChannel = vi.fn();
vi.mock('./functions/setup/getChannel.js', () => ({
    getChannel: (...args: unknown[]) => mockGetChannel(...args),
}));

// Mock logger
vi.mock('./services/logger.js', () => ({
    logger: { warn: vi.fn().mockResolvedValue(undefined) },
}));

import { fetchTextChannel } from './utils.js';

describe('asSendable', () => {
    it('returns null for null input', () => {
        expect(asSendable(null)).toBeNull();
    });
});

describe('chunkMessage', () => {
    it('returns single-element array for short text', () => {
        const result = chunkMessage('Hello world');
        expect(result).toEqual(['Hello world']);
    });

    it('returns single-element for text exactly at limit', () => {
        const text = 'a'.repeat(2000);
        const result = chunkMessage(text);
        expect(result).toEqual([text]);
    });

    it('splits long text at newline boundaries', () => {
        const line = 'a'.repeat(100);
        // 25 lines of 100 chars + newlines = 2525 chars total
        const text = Array(25).fill(line).join('\n');
        const result = chunkMessage(text);
        expect(result.length).toBeGreaterThan(1);
        for (const chunk of result) {
            expect(chunk.length).toBeLessThanOrEqual(2000);
        }
    });

    it('handles text with no newlines (forced split at maxLength)', () => {
        const text = 'a'.repeat(5000);
        const result = chunkMessage(text);
        expect(result.length).toBe(3);
        expect(result[0].length).toBe(2000);
        expect(result[1].length).toBe(2000);
        expect(result[2].length).toBe(1000);
    });

    it('respects custom maxLength parameter', () => {
        const text = 'a'.repeat(30);
        const result = chunkMessage(text, 10);
        expect(result.length).toBe(3);
        for (const chunk of result) {
            expect(chunk.length).toBeLessThanOrEqual(10);
        }
    });

    it('returns array with empty string for empty input', () => {
        const result = chunkMessage('');
        expect(result).toEqual(['']);
    });
});

describe('fetchTextChannel', () => {
    beforeEach(() => {
        mockGetChannel.mockReset();
    });

    it('returns TextChannel on success', async () => {
        mockGetChannel.mockReturnValue('123');
        const mockChannel = { id: '123', send: vi.fn() };
        const mockClient = {
            channels: { fetch: vi.fn().mockResolvedValue(mockChannel) },
        } as any;

        const result = await fetchTextChannel(mockClient, 'guild_info');
        expect(result).toBe(mockChannel);
    });

    it('returns null when config key not set', async () => {
        mockGetChannel.mockReturnValue(null);
        const mockClient = { channels: { fetch: vi.fn() } } as any;

        const result = await fetchTextChannel(mockClient, 'guild_info');
        expect(result).toBeNull();
        expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });

    it('returns null when fetch throws', async () => {
        mockGetChannel.mockReturnValue('123');
        const mockClient = {
            channels: { fetch: vi.fn().mockRejectedValue(new Error('Not found')) },
        } as any;

        const result = await fetchTextChannel(mockClient, 'guild_info');
        expect(result).toBeNull();
    });

    it('returns null for non-sendable channel', async () => {
        mockGetChannel.mockReturnValue('123');
        // Channel with no send method
        const mockChannel = { id: '123' };
        const mockClient = {
            channels: { fetch: vi.fn().mockResolvedValue(mockChannel) },
        } as any;

        const result = await fetchTextChannel(mockClient, 'guild_info');
        expect(result).toBeNull();
    });
});
