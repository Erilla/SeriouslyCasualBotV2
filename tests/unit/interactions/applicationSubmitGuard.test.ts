import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';
import { closeDatabase, getDatabase } from '../../../src/database/db.js';
import { createTables } from '../../../src/database/schema.js';

const { mockedSubmitApplication, mockedClearSession } = vi.hoisted(() => ({
  mockedSubmitApplication: vi.fn(),
  mockedClearSession: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({ config: {} }));
vi.mock('../../../src/services/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/services/auditLog.js', () => ({
  audit: vi.fn(async () => undefined),
  alertOfficers: vi.fn(async () => undefined),
}));
vi.mock('../../../src/functions/applications/submitApplication.js', () => ({
  submitApplication: mockedSubmitApplication,
}));
vi.mock('../../../src/functions/applications/dmQuestionnaire.js', () => ({
  activeSessions: new Map(),
  enterEditMode: vi.fn(),
  startSessionTimeout: vi.fn(),
  clearSession: mockedClearSession,
}));

import { buttons } from '../../../src/interactions/application.js';
import { enterEditMode } from '../../../src/functions/applications/dmQuestionnaire.js';

function getHandler(prefix: string) {
  const handler = buttons.find((b) => b.prefix === prefix);
  if (!handler) throw new Error(`${prefix} handler not registered`);
  return handler.handle;
}

function stubInteraction() {
  const messageEdit = vi.fn(async () => undefined);
  return {
    interaction: {
      user: { id: 'U1', tag: 'App#0001', send: vi.fn(async () => undefined) },
      client: {},
      message: { edit: messageEdit, components: [] },
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
    } as unknown as ButtonInteraction,
    messageEdit,
  };
}

function seedApplication(status: string, submittedAt: string | null = null): number {
  return Number(
    getDatabase()
      .prepare(
        'INSERT INTO applications (applicant_user_id, status, submitted_at) VALUES (?, ?, ?)',
      )
      .run('U1', status, submittedAt).lastInsertRowid,
  );
}

/** Every button in every action row the handler wrote back to the message. */
function editedButtons(messageEdit: ReturnType<typeof vi.fn>) {
  const payload = messageEdit.mock.calls[0]?.[0] as
    | { components?: Array<{ toJSON(): { components: Array<{ disabled?: boolean }> } }> }
    | undefined;
  if (!payload?.components) return [];
  return payload.components.flatMap((row) => row.toJSON().components);
}

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe('application:confirm button', () => {
  it('tells the applicant the application is already submitted instead of reporting an error', async () => {
    const applicationId = seedApplication('active');
    mockedSubmitApplication.mockResolvedValue('already_submitted');
    const { interaction } = stubInteraction();

    await getHandler('application:confirm')(interaction, [String(applicationId)]);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Application already submitted.' }),
    );
  });

  it('disables the summary buttons after a successful submission', async () => {
    const applicationId = seedApplication('in_progress');
    mockedSubmitApplication.mockResolvedValue('submitted');
    const { interaction, messageEdit } = stubInteraction();

    await getHandler('application:confirm')(interaction, [String(applicationId)]);

    const rendered = editedButtons(messageEdit);
    expect(rendered).toHaveLength(3);
    expect(rendered.every((b) => b.disabled === true)).toBe(true);
  });

  it('disables the summary buttons when the click was a duplicate', async () => {
    const applicationId = seedApplication('active');
    mockedSubmitApplication.mockResolvedValue('already_submitted');
    const { interaction, messageEdit } = stubInteraction();

    await getHandler('application:confirm')(interaction, [String(applicationId)]);

    const rendered = editedButtons(messageEdit);
    expect(rendered).toHaveLength(3);
    expect(rendered.every((b) => b.disabled === true)).toBe(true);
  });

  it('clears the DM session so its inactivity timeout cannot abandon the live application', async () => {
    // Edit Answer arms a 30-minute timeout that flips the row to 'abandoned'.
    // Clicking Confirm instead of answering left that timer running, so a
    // successfully submitted application quietly went 'abandoned' half an hour
    // later while its channel and forum thread stayed up.
    const applicationId = seedApplication('in_progress');
    mockedSubmitApplication.mockResolvedValue('submitted');
    const { interaction } = stubInteraction();

    await getHandler('application:confirm')(interaction, [String(applicationId)]);

    expect(mockedClearSession).toHaveBeenCalledWith('U1');
  });

  it('leaves the buttons active when submission fails so the applicant can retry', async () => {
    const applicationId = seedApplication('in_progress');
    mockedSubmitApplication.mockRejectedValue(new Error('Missing Permissions'));
    const { interaction, messageEdit } = stubInteraction();

    await getHandler('application:confirm')(interaction, [String(applicationId)]);

    expect(messageEdit).not.toHaveBeenCalled();
  });
});

describe('application:cancel button', () => {
  it('refuses to abandon an application that has already been submitted', async () => {
    // Cancel used to flip status to 'abandoned' unconditionally, which would
    // retire a live application officers were already voting on while leaving
    // its channel and forum thread in place.
    const applicationId = seedApplication('active');
    const { interaction } = stubInteraction();

    await getHandler('application:cancel')(interaction, [String(applicationId)]);

    const row = getDatabase()
      .prepare('SELECT status FROM applications WHERE id = ?')
      .get(applicationId) as { status: string };
    expect(row.status).toBe('active');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Application already submitted.' }),
    );
  });

  it('refuses to cancel while a submission is in flight', async () => {
    // The claim leaves status='in_progress' for the several seconds the Discord
    // work takes. A status-only guard let Cancel through that window: the row
    // went to 'abandoned', then Step 3 set it back to 'active' — the applicant
    // was told they had cancelled while officers got a live application.
    const applicationId = seedApplication('in_progress', '2026-08-09 11:00:00');
    const { interaction } = stubInteraction();

    await getHandler('application:cancel')(interaction, [String(applicationId)]);

    const row = getDatabase()
      .prepare('SELECT status FROM applications WHERE id = ?')
      .get(applicationId) as { status: string };
    expect(row.status).toBe('in_progress');
  });

  it('still cancels an application that has not been submitted', async () => {
    const applicationId = seedApplication('in_progress');
    const { interaction } = stubInteraction();

    await getHandler('application:cancel')(interaction, [String(applicationId)]);

    const row = getDatabase()
      .prepare('SELECT status FROM applications WHERE id = ?')
      .get(applicationId) as { status: string };
    expect(row.status).toBe('abandoned');
  });
});

describe('summary button wording', () => {
  it('tells an applicant whose application lapsed to start again, not that it was submitted', async () => {
    // 'abandoned' is not 'submitted'. Reporting it as such left the applicant
    // believing officers had their application and steered them away from the
    // /apply retry that would actually fix it.
    const applicationId = seedApplication('abandoned');
    const { interaction } = stubInteraction();

    await getHandler('application:cancel')(interaction, [String(applicationId)]);

    const content = vi.mocked(interaction.reply).mock.calls[0]![0] as { content: string };
    expect(content.content).not.toContain('already submitted');
    expect(content.content).toMatch(/\/apply/);
  });

  it('still reports a genuinely submitted application as already submitted', async () => {
    const applicationId = seedApplication('active');
    const { interaction } = stubInteraction();

    await getHandler('application:cancel')(interaction, [String(applicationId)]);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Application already submitted.' }),
    );
  });
});

describe('application:edit button', () => {
  it('refuses to reopen editing once the application has been submitted', async () => {
    // Editing after submission rewrote application_answers while the posted Q&A
    // stayed a stale snapshot, and handed back a fresh Confirm & Submit button —
    // the loop that produced the duplicate submission.
    const applicationId = seedApplication('active');
    const { interaction } = stubInteraction();

    await getHandler('application:edit')(interaction, [String(applicationId)]);

    expect(enterEditMode).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Application already submitted.' }),
    );
  });

  it('still opens editing for an application that has not been submitted', async () => {
    const applicationId = seedApplication('in_progress');
    const { interaction } = stubInteraction();

    await getHandler('application:edit')(interaction, [String(applicationId)]);

    expect(enterEditMode).toHaveBeenCalledWith('U1', applicationId);
  });
});
