import type { TextChannel, Message, Collection } from 'discord.js';
import { logger } from '../../services/logger.js';

/**
 * Generate a text transcript of all messages in a channel.
 * Returns both the transcript string and a Buffer for file attachment.
 */
export async function generateTranscript(
  channel: TextChannel,
): Promise<{ text: string; buffer: Buffer }> {
  const allMessages: Message[] = [];

  try {
    let lastMessageId: string | undefined;

    // Paginate through all messages (100 per fetch)
    while (true) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastMessageId) {
        options.before = lastMessageId;
      }

      const batch: Collection<string, Message> = await channel.messages.fetch(options);
      if (batch.size === 0) break;

      allMessages.push(...batch.values());
      lastMessageId = batch.lastKey();

      // Safety valve: cap at 5000 messages
      if (allMessages.length >= 5000) {
        logger.warn('Applications', `Transcript capped at 5000 messages for channel ${channel.id}`);
        break;
      }
    }
  } catch (error) {
    logger.warn(
      'Applications',
      `Failed to fetch some messages for transcript in channel ${channel.id}: ${error}`,
    );
  }

  // Sort by timestamp ascending (oldest first)
  allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // Format each message
  const lines: string[] = [];

  for (const msg of allMessages) {
    const timestamp = msg.createdAt.toISOString();
    const author = msg.author.displayName ?? msg.author.username;
    let line = `[${timestamp}] ${author}: ${msg.content}`;

    // Include attachment URLs
    if (msg.attachments.size > 0) {
      const attachmentUrls = msg.attachments.map((a) => a.url).join(', ');
      line += `\n  Attachments: ${attachmentUrls}`;
    }

    // Include embed descriptions for context
    if (msg.embeds.length > 0) {
      for (const embed of msg.embeds) {
        if (embed.title) {
          line += `\n  [Embed: ${embed.title}]`;
        }
        if (embed.description) {
          line += `\n  ${embed.description}`;
        }
      }
    }

    lines.push(line);
  }

  const text = lines.join('\n');
  const buffer = Buffer.from(text, 'utf-8');

  logger.info('Applications', `Transcript generated for channel ${channel.id}: ${allMessages.length} messages, ${buffer.length} bytes`);

  return { text, buffer };
}
