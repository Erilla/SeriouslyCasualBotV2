import { MessageFlags, EmbedBuilder, Colors } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { ButtonHandler } from './registry.js';
import { getFindings, getGuildHistory, getJob } from '../functions/applications/intel/jobStore.js';
import {
  renderFoundCharacters,
  renderGuildHistory,
} from '../functions/applications/intel/render.js';
import { buildPageButtons } from '../functions/pagination.js';

/**
 * Pages are rebuilt from applicant_intel_findings on demand rather than from
 * the 5-minute in-memory cache behind the generic `page:` handler: an
 * application thread is read days later, and "run the command again" is not
 * something a reviewer can act on there.
 */
export function buildIntelPage(
  jobId: number,
  page: number,
  applicantName: string,
  region: string,
): { description: string; page: number; totalPages: number } | null {
  const findings = getFindings(jobId);
  if (findings.length === 0) return null;
  const pages = renderFoundCharacters(findings, applicantName, region);
  const index = page - 1;
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) return null;
  return { description: pages[index], page, totalPages: pages.length };
}

/**
 * The guild-history counterpart of buildIntelPage. Reads from
 * getGuildHistory (an upsert-backed single row), not the `enqueue`-based work
 * queue used elsewhere in this job store — `enqueue` is
 * ON CONFLICT DO NOTHING, so a resumed job's later, more-accurate (or
 * intentionally empty) computation would never overwrite a first attempt.
 * See jobStore.ts's setGuildHistory for the fix this reader depends on.
 */
export function buildGuildHistoryPage(
  jobId: number,
  page: number,
  region: string,
): { description: string; page: number; totalPages: number } | null {
  const job = getJob(jobId);
  if (!job) return null;
  const entries = getGuildHistory(jobId);
  const pages = renderGuildHistory(entries, region);
  const index = page - 1;
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) return null;
  return { description: pages[index], page, totalPages: pages.length };
}

async function handleIntelPage(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: intelpage:{jobId}:{page}
  const jobId = Number(params[0]);
  const page = Number(params[1]);
  const job = Number.isInteger(jobId) ? getJob(jobId) : undefined;
  const built = job ? buildIntelPage(jobId, page, job.character_name, job.character_region) : null;

  if (!built) {
    await interaction.reply({
      content: 'That character list is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder().setColor(Colors.Green).setDescription(built.description);
  if (built.totalPages > 1) {
    embed.setFooter({ text: `Page ${built.page}/${built.totalPages}` });
  }
  const buttonsRow = buildPageButtons(`intelpage:${jobId}`, built.page, built.totalPages);
  await interaction.update({ embeds: [embed], components: buttonsRow ? [buttonsRow] : [] });
}

async function handleIntelGuildPage(
  interaction: ButtonInteraction,
  params: string[],
): Promise<void> {
  // customId: intelguildpage:{jobId}:{page}
  const jobId = Number(params[0]);
  const page = Number(params[1]);
  const job = Number.isInteger(jobId) ? getJob(jobId) : undefined;
  const built = job ? buildGuildHistoryPage(jobId, page, job.character_region) : null;

  if (!built) {
    await interaction.reply({
      content: 'That guild history is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder().setColor(Colors.Green).setDescription(built.description);
  if (built.totalPages > 1) {
    embed.setFooter({ text: `Page ${built.page}/${built.totalPages}` });
  }
  const buttonsRow = buildPageButtons(`intelguildpage:${jobId}`, built.page, built.totalPages);
  await interaction.update({ embeds: [embed], components: buttonsRow ? [buttonsRow] : [] });
}

export const buttons: ButtonHandler[] = [
  { prefix: 'intelpage', handle: handleIntelPage },
  { prefix: 'intelguildpage', handle: handleIntelGuildPage },
];
