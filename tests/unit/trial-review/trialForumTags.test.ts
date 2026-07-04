import { describe, it, expect, vi } from 'vitest';
import type { ForumChannel, AnyThreadChannel } from 'discord.js';
import { ensureTrialForumTags, applyTrialTag } from '../../../src/functions/trial-review/trialForumTags.js';

describe('ensureTrialForumTags', () => {
  it('adds the four tags additively, preserving existing tags, and returns the refetched forum', async () => {
    const setAvailableTags = vi.fn(async () => {});
    const refetched = { availableTags: [{ id: 'r', name: 'refetched' }] } as unknown as ForumChannel;
    const forum = {
      availableTags: [{ id: 'x', name: 'Existing' }],
      setAvailableTags,
      fetch: vi.fn(async () => refetched),
    } as unknown as ForumChannel;

    const result = await ensureTrialForumTags(forum);

    expect(setAvailableTags).toHaveBeenCalledOnce();
    expect(setAvailableTags.mock.calls[0][0]).toEqual([
      { id: 'x', name: 'Existing' },
      { name: 'Active' },
      { name: 'To Be Promoted' },
      { name: 'Promoted' },
      { name: 'Failed' },
    ]);
    expect(result).toBe(refetched);
  });

  it('is a no-op when all four tags already exist', async () => {
    const setAvailableTags = vi.fn(async () => {});
    const forum = {
      availableTags: [
        { id: '1', name: 'Active' },
        { id: '2', name: 'To Be Promoted' },
        { id: '3', name: 'Promoted' },
        { id: '4', name: 'Failed' },
      ],
      setAvailableTags,
      fetch: vi.fn(),
    } as unknown as ForumChannel;

    const result = await ensureTrialForumTags(forum);

    expect(setAvailableTags).not.toHaveBeenCalled();
    expect(result).toBe(forum);
  });

  it('returns the original forum without throwing when setAvailableTags fails', async () => {
    const forum = {
      availableTags: [{ id: 'x', name: 'Existing' }],
      setAvailableTags: vi.fn(async () => { throw new Error('rate limited'); }),
      fetch: vi.fn(),
    } as unknown as ForumChannel;

    const result = await ensureTrialForumTags(forum);

    expect(result).toBe(forum);
    expect(forum.fetch).not.toHaveBeenCalled();
  });
});

describe('applyTrialTag', () => {
  it('sets the thread applied tags to the single matching tag id', async () => {
    const setAppliedTags = vi.fn(async () => {});
    const thread = {
      id: 't1',
      parent: { availableTags: [{ id: 'a', name: 'Active' }, { id: 'p', name: 'Promoted' }] },
      setAppliedTags,
    } as unknown as AnyThreadChannel;

    await applyTrialTag(thread, 'Promoted');

    expect(setAppliedTags).toHaveBeenCalledWith(['p']);
  });

  it('no-ops when the tag name is not found on the parent forum', async () => {
    const setAppliedTags = vi.fn(async () => {});
    const thread = {
      id: 't1',
      parent: { availableTags: [{ id: 'a', name: 'Active' }] },
      setAppliedTags,
    } as unknown as AnyThreadChannel;

    await applyTrialTag(thread, 'Nonexistent');

    expect(setAppliedTags).not.toHaveBeenCalled();
  });

  it('no-ops when the thread has no forum parent with availableTags', async () => {
    const setAppliedTags = vi.fn(async () => {});
    const thread = { id: 't1', parent: null, setAppliedTags } as unknown as AnyThreadChannel;

    await applyTrialTag(thread, 'Active');

    expect(setAppliedTags).not.toHaveBeenCalled();
  });
});
