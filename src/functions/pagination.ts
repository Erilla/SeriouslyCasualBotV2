import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { createEmbed } from '../utils.js';

const DEFAULT_MAX_CHARS = 1800;

/**
 * Split an array of lines into pages that each fit within maxChars.
 * Returns ['No results.'] for empty input.
 */
export function paginateLines(lines: string[], maxChars = DEFAULT_MAX_CHARS): string[] {
  if (lines.length === 0) return ['No results.'];

  const pages: string[] = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length > maxChars) {
      if (current) pages.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) pages.push(current);
  return pages;
}

/**
 * Build a standard green embed for one page of results.
 * Adds "Page X/Y" footer text when totalPages > 1.
 */
export function buildPageEmbed(
  title: string,
  content: string,
  page: number,
  totalPages: number,
): EmbedBuilder {
  const embed = createEmbed(title).setDescription(content);
  if (totalPages > 1) {
    embed.setFooter({ text: `Page ${page}/${totalPages} | SeriouslyCasualBot` });
  }
  return embed;
}

/**
 * Build Previous/Next navigation buttons for paginated results.
 * Custom IDs follow the pattern: page:{commandName}:{targetPage}:{totalPages}
 * Returns null when totalPages <= 1 (no navigation needed).
 */
export function buildPageButtons(
  commandName: string,
  currentPage: number,
  totalPages: number,
): ActionRowBuilder<MessageActionRowComponentBuilder> | null {
  if (totalPages <= 1) return null;

  const prevPage = currentPage - 1;
  const nextPage = currentPage + 1;

  const prevButton = new ButtonBuilder()
    .setCustomId(`page:${commandName}:${prevPage}:${totalPages}`)
    .setLabel('Previous')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage <= 1);

  const nextButton = new ButtonBuilder()
    .setCustomId(`page:${commandName}:${nextPage}:${totalPages}`)
    .setLabel('Next')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage >= totalPages);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    prevButton,
    nextButton,
  );
}

/** Shape of a cached pagination entry. */
interface CacheEntry {
  title: string;
  pages: string[];
  expiresAt: number;
}

const paginationCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Store paginated data in the in-memory cache with a 5-minute TTL.
 */
export function cachePaginatedData(key: string, title: string, pages: string[]): void {
  paginationCache.set(key, {
    title,
    pages,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Retrieve a page from the cache.
 * Returns null if the entry has expired, the key does not exist, or the page is out of range.
 * Pages are 1-indexed.
 */
export function getCachedPage(
  key: string,
  page: number,
): { title: string; content: string; totalPages: number } | null {
  const entry = paginationCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    paginationCache.delete(key);
    return null;
  }
  const index = page - 1;
  if (index < 0 || index >= entry.pages.length) return null;
  return {
    title: entry.title,
    content: entry.pages[index],
    totalPages: entry.pages.length,
  };
}
