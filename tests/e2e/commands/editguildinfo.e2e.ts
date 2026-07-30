import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  TextBasedChannel,
} from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { getReadonlyTestDb } from '../setup/db.js';
import { resetAndSeed } from '../setup/baseline.js';
import { fakeChatInput, fakeModalSubmit, type FakeChatInput } from '../setup/synthesizer.js';
import guildinfoCmd from '../../../src/commands/guildinfo.js';
import editGuildInfoCmd from '../../../src/commands/editguildinfo.js';
import { dispatch, modalHandlers } from '../../../src/interactions/registry.js';

function storedId(key: string): string | undefined {
  return (
    getReadonlyTestDb()
      .prepare('SELECT message_id FROM guild_info_messages WHERE key = ?')
      .get(key) as { message_id: string } | undefined
  )?.message_id;
}

function contentRow(key: string): { title: string | null; content: string } | undefined {
  return getReadonlyTestDb()
    .prepare('SELECT title, content FROM guild_info_content WHERE key = ?')
    .get(key) as { title: string | null; content: string } | undefined;
}

function raiderIoLinkRow(): { id: number; label: string; url: string } | undefined {
  return getReadonlyTestDb()
    .prepare('SELECT id, label, url FROM guild_info_links ORDER BY id LIMIT 1')
    .get() as { id: number; label: string; url: string } | undefined;
}

async function fetchStoredMessage(key: string) {
  const messageId = storedId(key);
  if (!messageId) throw new Error(`No stored Guild Info message ID for ${key}`);

  const channelRow = getReadonlyTestDb()
    .prepare("SELECT value FROM config WHERE key = 'guild_info_channel_id'")
    .get() as { value: string } | undefined;
  if (!channelRow) throw new Error('No configured Guild Info channel ID');

  const channel = await getE2EContext().guild.channels.fetch(channelRow.value);
  if (!channel?.isTextBased()) throw new Error('Guild Info channel is not text-based');

  return channel.messages.fetch(messageId);
}

function editInteraction(subcommand: string, options: Record<string, string> = {}): FakeChatInput {
  const ctx = getE2EContext();
  return fakeChatInput({
    client: ctx.client,
    guild: ctx.guild,
    channel: ctx.guild.systemChannel as TextBasedChannel,
    member: ctx.officer,
    user: ctx.officer.user,
    commandName: 'editguildinfo',
    subcommand,
    options,
  });
}

function refreshInteraction(): FakeChatInput {
  const ctx = getE2EContext();
  return fakeChatInput({
    client: ctx.client,
    guild: ctx.guild,
    channel: ctx.guild.systemChannel as TextBasedChannel,
    member: ctx.officer,
    user: ctx.officer.user,
    commandName: 'guildinfo',
  });
}

function aboutModal(title: string, content: string) {
  const ctx = getE2EContext();
  return fakeModalSubmit({
    client: ctx.client,
    guild: ctx.guild,
    channel: ctx.guild.systemChannel as TextBasedChannel,
    member: ctx.officer,
    user: ctx.officer.user,
    customId: 'guildinfo-edit:about',
    fields: { title, content },
  });
}

function invalidLinkModal() {
  const ctx = getE2EContext();
  return fakeModalSubmit({
    client: ctx.client,
    guild: ctx.guild,
    channel: ctx.guild.systemChannel as TextBasedChannel,
    member: ctx.officer,
    user: ctx.officer.user,
    customId: 'guildinfo-edit:link:raiderio',
    fields: { label: 'Raider.IO', url: 'javascript:alert(1)' },
  });
}

function inputValue(interaction: FakeChatInput, customId: string): string | undefined {
  const modal = interaction.__modalShown?.toJSON();
  return modal?.components
    .flatMap((row) => row.components)
    .find((input) => input.custom_id === customId)?.value;
}

describe('/editguildinfo', () => {
  beforeEach(async () => {
    await resetAndSeed({ discord: true });
  });

  it('edits About Us through a prefilled modal without changing its message ID', async () => {
    await guildinfoCmd.execute(refreshInteraction() as unknown as ChatInputCommandInteraction);
    const before = storedId('aboutus');
    expect(before).toBeDefined();

    const edit = editInteraction('about');
    await editGuildInfoCmd.execute(edit as unknown as ChatInputCommandInteraction);
    expect(inputValue(edit, 'content')).toContain('two-day Alliance');

    await dispatch(
      modalHandlers,
      'modal',
      aboutModal('Updated About Us', 'A changed body') as unknown as ModalSubmitInteraction,
      'guildinfo-edit:about',
    );

    expect(contentRow('aboutus')).toEqual({
      title: 'Updated About Us',
      content: 'A changed body',
    });
    expect(storedId('aboutus')).toBe(before);

    const storedMessage = await fetchStoredMessage('aboutus');
    expect(storedMessage.embeds[0]?.title).toBe('Updated About Us');
    expect(storedMessage.embeds[0]?.description).toBe('A changed body');
  });

  it('rejects an invalid link without changing its row or the About Us message ID', async () => {
    await guildinfoCmd.execute(refreshInteraction() as unknown as ChatInputCommandInteraction);
    const beforeLink = raiderIoLinkRow();
    const beforeAboutUsId = storedId('aboutus');
    expect(beforeLink).toBeDefined();
    expect(beforeAboutUsId).toBeDefined();

    await dispatch(
      modalHandlers,
      'modal',
      invalidLinkModal() as unknown as ModalSubmitInteraction,
      'guildinfo-edit:link:raiderio',
    );

    expect(raiderIoLinkRow()).toEqual(beforeLink);
    expect(storedId('aboutus')).toBe(beforeAboutUsId);
  });
});
