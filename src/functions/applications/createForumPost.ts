import {
  type User,
  type ForumChannel,
  type Guild,
  ChannelType,
  ThreadAutoArchiveDuration,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { logger } from '../../services/logger.js';
import { getOrCreateChannel } from '../channels.js';
import { generateVotingEmbed } from './generateVotingEmbed.js';
import { splitMessage } from './splitMessage.js';
import { addOverlordsToThread } from '../raids/overlords.js';
import { resolveApplicationLogCategory } from './applicationLogCategory.js';
import { placeholderEmbed } from './intel/placeholders.js';

export interface CreateForumPostResult {
  forumPost: { id: string };
  threadId: string;
  altsMessageId?: string;
  guildsMessageId?: string;
  logsMessageId?: string;
}

export async function createForumPost(
  guild: Guild,
  characterName: string,
  applicant: User,
  qaText: string,
  applicationId: number,
): Promise<CreateForumPostResult> {
  let forum: ForumChannel;
  try {
    const category = await resolveApplicationLogCategory(guild);
    forum = await getOrCreateChannel(guild, {
      name: 'application-log',
      type: ChannelType.GuildForum,
      categoryName: null,
      configKey: 'application_log_forum_id',
      createOptions: category ? { parent: category.id } : undefined,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(
      `Failed to create application-log forum channel (does the bot have Manage Channels permission?): ${error.message}`,
      { cause: err },
    );
  }

  try {
    const existingTags = forum.availableTags;
    const requiredTags = ['Active', 'Accepted', 'Rejected'];
    const missingTags = requiredTags.filter((tag) => !existingTags.some((t) => t.name === tag));

    if (missingTags.length > 0) {
      const newTags = [...existingTags, ...missingTags.map((name) => ({ name }))];
      await forum.setAvailableTags(newTags);
      const updatedForum = (await forum.fetch()) as ForumChannel;
      forum = updatedForum;
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('Applications', `Failed to set forum tags for application-log: ${error.message}`);
  }

  const activeTag = forum.availableTags.find((t) => t.name === 'Active');

  const messages = splitMessage(qaText);

  // Truncate by code points rather than UTF-16 units so we never slice a surrogate pair.
  const threadName = Array.from(characterName).slice(0, 100).join('');

  let thread;
  try {
    thread = await forum.threads.create({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      message: { content: messages[0] },
      appliedTags: activeTag ? [activeTag.id] : [],
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(`Failed to create forum thread for "${threadName}": ${error.message}`, {
      cause: err,
    });
  }

  for (let i = 1; i < messages.length; i++) {
    await thread.send(messages[i]);
  }

  // Add overlords as members of the post so they see it and can review.
  // (addOverlordsToThread swallows per-overlord errors, so this won't throw.)
  await addOverlordsToThread(thread);

  // Reserve the intel positions before the voting controls, in reading order
  // (characters, then guild history, then logs); the background job edits
  // these in place as each phase completes. Discord cannot insert a message
  // between existing ones, so these three must be posted now even though the
  // sweep itself runs later, in the background.
  let altsMessageId: string | undefined;
  let guildsMessageId: string | undefined;
  let logsMessageId: string | undefined;
  try {
    const altsMessage = await thread.send({ embeds: [placeholderEmbed('alts')] });
    altsMessageId = altsMessage.id;
    const guildsMessage = await thread.send({ embeds: [placeholderEmbed('guilds')] });
    guildsMessageId = guildsMessage.id;
    const logsMessage = await thread.send({ embeds: [placeholderEmbed('logs')] });
    logsMessageId = logsMessage.id;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn(
      'Applications',
      `Failed to post intel placeholders for application #${applicationId}: ${error.message}`,
    );
  }

  try {
    const votingData = generateVotingEmbed(applicationId);
    await thread.send(votingData);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn(
      'Applications',
      `Failed to send voting embed for application #${applicationId}: ${error.message}`,
    );
  }

  try {
    const decisionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`application:accept:${applicationId}`)
        .setLabel('Accept')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`application:reject:${applicationId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
    );
    await thread.send({ components: [decisionRow] });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn(
      'Applications',
      `Failed to send decision buttons for application #${applicationId}: ${error.message}`,
    );
  }

  return {
    forumPost: { id: forum.id },
    threadId: thread.id,
    altsMessageId,
    guildsMessageId,
    logsMessageId,
  };
}
