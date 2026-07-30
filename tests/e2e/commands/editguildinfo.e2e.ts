import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatInputCommandInteraction, ModalSubmitInteraction, TextBasedChannel } from 'discord.js';
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

function aboutModal(content: string) {
  const ctx = getE2EContext();
  return fakeModalSubmit({
    client: ctx.client,
    guild: ctx.guild,
    channel: ctx.guild.systemChannel as TextBasedChannel,
    member: ctx.officer,
    user: ctx.officer.user,
    customId: 'guildinfo-edit:about',
    fields: { title: 'About Us', content },
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
      aboutModal('A changed body') as unknown as ModalSubmitInteraction,
      'guildinfo-edit:about',
    );

    expect(contentRow('aboutus')?.content).toBe('A changed body');
    expect(storedId('aboutus')).toBe(before);
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
