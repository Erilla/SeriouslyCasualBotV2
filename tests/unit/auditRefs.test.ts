import { describe, it, expect } from 'vitest';
import { trialRef, applicationRef, dateRef } from '../../src/services/auditRefs.js';

describe('trialRef', () => {
  it('includes name, id, and a thread link when thread_id is set', () => {
    expect(trialRef({ character_name: 'Sploboss', id: 3, thread_id: '123' })).toBe(
      '**Sploboss** (#3) — <#123>',
    );
  });

  it('omits the thread link when thread_id is null', () => {
    expect(trialRef({ character_name: 'Sploboss', id: 3, thread_id: null })).toBe(
      '**Sploboss** (#3)',
    );
  });
});

describe('applicationRef', () => {
  it('links the applicant and prefers forum_post_id for the post link', () => {
    expect(
      applicationRef({
        character_name: 'Sploboss',
        applicant_user_id: '456',
        thread_id: '999',
        forum_post_id: '789',
      }),
    ).toBe('**Sploboss** (<@456>) — <#789>');
  });

  it('falls back to thread_id when forum_post_id is null', () => {
    expect(
      applicationRef({
        character_name: 'Sploboss',
        applicant_user_id: '456',
        thread_id: '999',
        forum_post_id: null,
      }),
    ).toBe('**Sploboss** (<@456>) — <#999>');
  });

  it('omits the post link when both post ids are null', () => {
    expect(
      applicationRef({
        character_name: 'Sploboss',
        applicant_user_id: '456',
        thread_id: null,
        forum_post_id: null,
      }),
    ).toBe('**Sploboss** (<@456>)');
  });

  it('shows Unknown when character_name is null', () => {
    expect(
      applicationRef({
        character_name: null,
        applicant_user_id: '456',
        thread_id: null,
        forum_post_id: null,
      }),
    ).toBe('**Unknown** (<@456>)');
  });
});

describe('dateRef', () => {
  it('renders a YYYY-MM-DD date as a long-date Discord timestamp', () => {
    // 2026-04-20 UTC midnight = 1776643200 seconds
    expect(dateRef('2026-04-20')).toBe('<t:1776643200:D>');
  });

  it('returns the raw string when the date is unparseable', () => {
    expect(dateRef('not-a-date')).toBe('not-a-date');
  });
});
