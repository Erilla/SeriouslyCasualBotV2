import { describe, it, expect } from 'vitest';
import { paginateLines, buildPageEmbed, buildPageButtons } from '../../src/functions/pagination.js';

describe('paginateLines', () => {
  it('returns ["No results."] for empty input', () => {
    const result = paginateLines([]);
    expect(result).toEqual(['No results.']);
  });

  it('returns single page when all lines fit within maxChars', () => {
    const lines = ['line one', 'line two', 'line three'];
    const result = paginateLines(lines);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('line one\nline two\nline three');
  });

  it('splits into multiple pages when lines exceed maxChars', () => {
    // Each line is 100 chars, maxChars is 250 - so 2 lines fit per page, 3rd starts new page
    const longLine = 'A'.repeat(100);
    const lines = [longLine, longLine, longLine, longLine, longLine];
    const result = paginateLines(lines, 250);
    expect(result.length).toBeGreaterThan(1);
  });

  it('respects custom maxChars parameter', () => {
    const lines = ['short', 'short', 'short'];
    // With maxChars=10, only one "short" fits per page (5 chars + newline)
    const result = paginateLines(lines, 10);
    expect(result.length).toBeGreaterThan(1);
  });

  it('each page does not exceed maxChars', () => {
    const longLine = 'X'.repeat(200);
    const lines = Array.from({ length: 20 }, () => longLine);
    const maxChars = 1800;
    const result = paginateLines(lines, maxChars);
    for (const page of result) {
      expect(page.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it('puts all lines on one page if total is exactly maxChars', () => {
    // 3 lines of 5 chars each + 2 newlines = 17 chars total
    const lines = ['12345', '12345', '12345'];
    const result = paginateLines(lines, 17);
    expect(result).toHaveLength(1);
  });

  it('handles a single line that fits on a page', () => {
    const result = paginateLines(['hello world']);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('hello world');
  });
});

describe('buildPageEmbed', () => {
  it('sets the title on the embed', () => {
    const embed = buildPageEmbed('My Title', 'content here', 1, 1);
    expect(embed.data.title).toBe('My Title');
  });

  it('sets the description to the content', () => {
    const embed = buildPageEmbed('Title', 'page content', 1, 1);
    expect(embed.data.description).toBe('page content');
  });

  it('does not add page footer for single-page results', () => {
    const embed = buildPageEmbed('Title', 'content', 1, 1);
    // Should have the standard SeriouslyCasualBot footer, not "Page X/Y"
    expect(embed.data.footer?.text).not.toMatch(/Page \d+\/\d+/);
  });

  it('adds Page X/Y footer for multi-page results', () => {
    const embed = buildPageEmbed('Title', 'content', 2, 5);
    expect(embed.data.footer?.text).toContain('Page 2/5');
  });

  it('has a green color (Colors.Green = 5763719)', () => {
    const embed = buildPageEmbed('Title', 'content', 1, 3);
    expect(embed.data.color).toBe(5763719);
  });

  it('has a timestamp', () => {
    const embed = buildPageEmbed('Title', 'content', 1, 1);
    expect(embed.data.timestamp).toBeDefined();
  });
});

describe('buildPageButtons', () => {
  it('returns null when totalPages is 1', () => {
    const result = buildPageButtons('raiders', 1, 1);
    expect(result).toBeNull();
  });

  it('returns null when totalPages is 0', () => {
    const result = buildPageButtons('raiders', 1, 0);
    expect(result).toBeNull();
  });

  it('returns an action row with 2 buttons for multi-page', () => {
    const row = buildPageButtons('raiders', 1, 3);
    expect(row).not.toBeNull();
    expect(row!.components).toHaveLength(2);
  });

  it('uses correct custom IDs with page target and total', () => {
    const row = buildPageButtons('raiders', 2, 5);
    const [prev, next] = row!.components;
    expect(prev.data).toMatchObject({ custom_id: 'page:raiders:1:5' });
    expect(next.data).toMatchObject({ custom_id: 'page:raiders:3:5' });
  });

  it('disables Previous button on first page', () => {
    const row = buildPageButtons('mycommand', 1, 3);
    const [prev] = row!.components;
    expect(prev.data).toMatchObject({ disabled: true });
  });

  it('disables Next button on last page', () => {
    const row = buildPageButtons('mycommand', 3, 3);
    const [, next] = row!.components;
    expect(next.data).toMatchObject({ disabled: true });
  });

  it('enables both buttons on a middle page', () => {
    const row = buildPageButtons('mycommand', 2, 4);
    const [prev, next] = row!.components;
    expect(prev.data).toMatchObject({ disabled: false });
    expect(next.data).toMatchObject({ disabled: false });
  });

  it('labels buttons as Previous and Next', () => {
    const row = buildPageButtons('test', 2, 3);
    const [prev, next] = row!.components;
    expect(prev.data).toMatchObject({ label: 'Previous' });
    expect(next.data).toMatchObject({ label: 'Next' });
  });
});
