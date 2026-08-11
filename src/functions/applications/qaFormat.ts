import { splitMessage } from './splitMessage.js';

/**
 * Wrap an applicant's answer in a Discord block quote.
 *
 * Every line is prefixed, not just the first: a quote only covers the line it
 * starts on, so a multi-line answer used to fall out of the quote halfway
 * through and read as though the bot were speaking. Whitespace-only lines
 * become a bare `>` because a genuinely empty line CLOSES the block, which
 * would split one answer into two quotes with our text apparently in between.
 *
 * The answer is otherwise passed through verbatim — URLs included, so a reviewer
 * can copy a link straight out. Link previews are suppressed with a message flag
 * at the send sites instead of by wrapping each URL in angle brackets.
 */
export function quoteAnswer(answer: string): string {
  if (answer.trim() === '') return '> *No answer given.*';

  return answer
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** One numbered question with its quoted answer. `index` is zero-based. */
export function formatQaBlock(index: number, question: string, answer: string): string {
  return `**${index + 1}. ${question}**\n${quoteAnswer(answer)}`;
}

/**
 * A Q&A block starts at a bold, numbered heading after a blank line. Quoting is
 * what makes this reliable: every line of an answer now begins with `>`, so a
 * blank line can only be a gap BETWEEN blocks, never one inside an answer.
 */
const QA_BLOCK_BOUNDARY = /\n\n(?=\*\*\d+\. )/;

/**
 * Split the Q&A into messages along block boundaries, keeping each question with
 * its answer.
 *
 * The generic `splitMessage` breaks at the last newline before the limit, which
 * is usually in the middle of an answer — the reviewer then sees a heading and
 * half its answer, with the rest opening the next message under no heading at
 * all. Here a block is the unit: blocks are packed greedily so short answers
 * still share a message, and only an answer too long to fit on its own falls
 * back to a mid-answer split, which no arrangement can avoid.
 */
export function splitQaText(content: string, maxLength = 2000): string[] {
  const blocks = content
    .split(QA_BLOCK_BOUNDARY)
    .map((block) => block.trimEnd())
    .filter((block) => block.length > 0);

  const messages: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current !== '') messages.push(current);
    current = '';
  };

  for (const block of blocks) {
    if (block.length > maxLength) {
      flush();
      messages.push(...splitMessage(block, maxLength));
      continue;
    }

    const candidate = current === '' ? block : `${current}\n\n${block}`;
    if (candidate.length > maxLength) {
      flush();
      current = block;
    } else {
      current = candidate;
    }
  }

  flush();
  return messages;
}
