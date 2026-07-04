import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from 'discord.js';
import { ButtonStyle, type APIActionRowComponent, type APIButtonComponent } from 'discord.js';
import { initDatabase, closeDatabase } from '../../src/database/db.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/functions/guild-info/clearGuildInfo.js', () => ({
  getOrCreateGuildInfoChannel: vi.fn(),
}));

import { updateRecruitment } from '../../src/functions/guild-info/updateRecruitment.js';
import { getOrCreateGuildInfoChannel } from '../../src/functions/guild-info/clearGuildInfo.js';

const mockedGetChannel = vi.mocked(getOrCreateGuildInfoChannel);

function makeChannel() {
  return {
    send: vi.fn(async () => ({ id: 'msg-1' })),
  };
}

/** Pull the single button out of the message sent to the channel. */
function sentButton(channel: ReturnType<typeof makeChannel>): APIButtonComponent {
  const arg = channel.send.mock.calls[0]![0] as {
    components: { toJSON(): APIActionRowComponent<APIButtonComponent> }[];
  };
  return arg.components[0]!.toJSON().components[0]!;
}

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe('updateRecruitment — Apply Here button', () => {
  it('posts a custom-id button that starts the application flow, not a link', async () => {
    const channel = makeChannel();
    mockedGetChannel.mockResolvedValue(channel as never);

    await updateRecruitment({} as Client);

    const button = sentButton(channel);
    expect(button.style).toBe(ButtonStyle.Success);
    expect('custom_id' in button && button.custom_id).toBe('application:apply');
    expect('url' in button).toBe(false);
  });

  it('never falls back to a bare discord.com link', async () => {
    const channel = makeChannel();
    mockedGetChannel.mockResolvedValue(channel as never);

    await updateRecruitment({} as Client);

    const button = sentButton(channel);
    expect('url' in button && button.url).not.toBe('https://discord.com');
  });
});
