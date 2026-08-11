import { describe, expect, it } from 'vitest';
import {
  formatQaBlock,
  quoteAnswer,
  splitQaText,
} from '../../src/functions/applications/qaFormat.js';
import { collectCharacterLinkCandidates } from '../../src/functions/applications/characterLinks.js';

describe('quoting an answer', () => {
  it('quotes every line, not just the first', () => {
    const quoted = quoteAnswer('I raided in Method\nthen in Echo\nnow nowhere');

    expect(quoted).toBe('> I raided in Method\n> then in Echo\n> now nowhere');
  });

  it('keeps a blank line inside the answer in the same quote block', () => {
    // A genuinely empty line ENDS a Discord quote block, so a paragraph break in
    // the applicant's answer would drop the rest of it out of the quote and leave
    // it indistinguishable from our own text. A bare `>` holds the block open.
    const quoted = quoteAnswer('First paragraph.\n\nSecond paragraph.');

    expect(quoted).toBe('> First paragraph.\n>\n> Second paragraph.');
    expect(quoted).not.toContain('\n\n');
  });

  it('quotes trailing and leading whitespace-only lines too', () => {
    expect(quoteAnswer('  \nreal answer')).toBe('>\n> real answer');
  });

  it('leaves a URL exactly as the applicant typed it', () => {
    // Embeds are suppressed with a message flag rather than by wrapping the URL,
    // so officers can copy the link straight out of the quote.
    const url = 'https://www.warcraftlogs.com/character/eu/tarren-mill/Braene';

    expect(quoteAnswer(url)).toBe(`> ${url}`);
  });

  it('says so when an answer is empty rather than emitting a hollow quote', () => {
    expect(quoteAnswer('   ')).toBe('> *No answer given.*');
  });
});

describe('quoted answers and the character-link parser', () => {
  it('still finds characters in a quoted answer', () => {
    // refreshLinkedCharacters re-reads the posted channel and thread history, so
    // the quote prefix sits in front of the URLs it parses. If `> ` broke the
    // match, a Refresh would stop finding characters the applicant had linked.
    const block = formatQaBlock(
      0,
      'Link your logs',
      'Main: https://www.warcraftlogs.com/character/eu/tarren-mill/Braene\nAlt: raider.io/characters/eu/silvermoon/Kiuasdk',
    );

    const found = collectCharacterLinkCandidates(block);

    expect(found.map((c) => ('character' in c ? c.character.name : c.wclId))).toEqual([
      'Braene',
      'Kiuasdk',
    ]);
  });
});

describe('a Q&A block', () => {
  it('numbers and bolds the question, then quotes the answer beneath it', () => {
    expect(formatQaBlock(0, 'Why us?', 'Because.')).toBe('**1. Why us?**\n> Because.');
  });

  it('does not quote the question itself', () => {
    const block = formatQaBlock(4, 'Your armory?', 'None');

    expect(block.startsWith('**5. Your armory?**')).toBe(true);
  });
});

describe('splitting the Q&A across messages', () => {
  const block = (n: number, size: number): string =>
    formatQaBlock(n - 1, `Question ${n}`, 'x'.repeat(size));
  const join = (...blocks: string[]): string => blocks.join('\n\n');

  it('returns one message when everything fits', () => {
    const text = join('**Application: Kiuasdk**', block(1, 10), block(2, 10));

    expect(splitQaText(text)).toEqual([text]);
  });

  it('never separates a question from its answer', () => {
    const text = join('**Application: Kiuasdk**', block(1, 600), block(2, 600), block(3, 600));

    const messages = splitQaText(text, 1000);

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      // An answer arriving without its heading is exactly the split we are
      // preventing: a wall of quoted text with no question above it.
      expect(message.startsWith('>')).toBe(false);
    }
  });

  it('keeps every message inside the limit', () => {
    const text = join('**Application: Kiuasdk**', block(1, 600), block(2, 600), block(3, 600));

    for (const message of splitQaText(text, 1000)) {
      expect(message.length).toBeLessThanOrEqual(1000);
    }
  });

  it('still splits a single answer too long to fit on its own', () => {
    // Unavoidable: a 3,000-character answer cannot share a message with its
    // question, and dropping it would be worse than splitting it.
    const messages = splitQaText(block(1, 2500), 1000);

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(1000);
    }
  });

  it('packs as many whole blocks into each message as fit', () => {
    const text = join(block(1, 100), block(2, 100), block(3, 100));

    // All three fit in 1000 characters, so splitting them apart would waste
    // messages and make the thread longer to read.
    expect(splitQaText(text, 1000)).toHaveLength(1);
  });
});
