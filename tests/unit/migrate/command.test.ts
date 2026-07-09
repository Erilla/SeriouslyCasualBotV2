import { describe, it, expect, vi } from 'vitest';

// config.js throws at import if env vars are unset; migrate.ts pulls it in transitively.
vi.mock('../../../src/config.js', () => ({ config: { guildId: 'guild-1' } }));
vi.mock('../../../src/utils.js', () => ({ requireOfficer: vi.fn(async () => true) }));
vi.mock('../../../src/services/auditLog.js', () => ({ audit: vi.fn(async () => {}) }));

import migrate from '../../../src/commands/migrate.js';

function fakeInteraction(fileName: string, size: number) {
  const replies: unknown[] = [];
  return {
    replies,
    id: 'interaction-1',
    user: { id: 'admin' },
    options: { getAttachment: () => ({ name: fileName, size, url: 'https://example/db' }) },
    reply: vi.fn(async (m: unknown) => {
      replies.push(m);
    }),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (m: unknown) => {
      replies.push(m);
    }),
  };
}

describe('/migrate validation', () => {
  it('rejects a non-sqlite attachment', async () => {
    const interaction = fakeInteraction('notes.txt', 1000);
    await migrate.execute(interaction as never);
    const text = JSON.stringify(interaction.replies);
    expect(text).toMatch(/\.sqlite|\.db/i);
  });

  it('rejects an oversized attachment', async () => {
    const interaction = fakeInteraction('db.sqlite', 60 * 1024 * 1024);
    await migrate.execute(interaction as never);
    const text = JSON.stringify(interaction.replies);
    expect(text).toMatch(/too large|size/i);
  });
});
