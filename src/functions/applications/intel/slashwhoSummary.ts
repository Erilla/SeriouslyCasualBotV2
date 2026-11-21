import { foldRealmKey, raiderIoRealmSlug } from '../../../services/blizzard.js';
import type {
  DossierCharacter,
  DossierKey,
  DossierLimitation,
  DossierSummary,
} from '../../../services/slashwho.js';
import type { LinkedCharacter } from '../../../types/index.js';
import type { RaiderIoCharacter } from '../characterLinks.js';
import { isSelfDeclared, type FindingSource, type IntelFinding } from './jobStore.js';
import {
  discordDate,
  displayRealm,
  findingLine,
  raiderIoGuildUrl,
  type GuildHistoryEntry,
} from './render.js';

/**
 * Pure adapters between SlashWho's chat-sized dossier summary and the bot's
 * own applicant-intel shapes, plus the one compact summary embed officers read
 * when the SlashWho runner is selected. No database or network here: the
 * runner (slashwhoJob.ts) does the writes, so every mapping rule is testable
 * on plain data.
 */

const EMBED_DESCRIPTION_LIMIT = 4096;
/** Bounded so the embed never needs paging; the rest is behind the dossier link. */
export const MAX_CHARACTER_LINES = 8;
const MAX_GUILD_LINES = 3;
const MAX_RAID_LINES = 3;
const MAX_LIMITATION_LINES = 4;

/** One spelling of a character every vocabulary agrees on, for matching only. */
export function characterIdentity(c: { region: string; realm: string; name: string }): string {
  return `${c.region.toLowerCase()}/${foldRealmKey(c.realm)}/${c.name.trim().normalize('NFC').toLowerCase()}`;
}

/** The `region/realm/name` strings SlashWho uses inside per-guild and per-boss lists. */
function identityFromPath(path: string): string | null {
  const [region, realm, name] = path.split('/');
  return region && realm && name ? characterIdentity({ region, realm, name }) : null;
}

// ─── Findings ───────────────────────────────────────────────

/** A finding the runner should write, in order. Declared characters come first. */
export interface MirroredFinding extends IntelFinding {
  /** Whether this row is a declared character that already had a seed row. */
  declared: boolean;
}

function sourceFor(c: DossierCharacter): { source: FindingSource; confidence: number | null } {
  switch (c.source) {
    // A Raider.IO-declared alt is a stated fact; the legacy sweep records it at 100.
    case 'raiderio_declared':
      return { source: 'raider.io', confidence: 100 };
    // SlashWho keeps no fingerprint score (always null in v1). Carried as-is so
    // the renderer shows "no score" rather than inventing one.
    case 'fingerprint_derived':
      return { source: 'fingerprint', confidence: c.confidence };
    // Reviewer links, bot links, and a submitted character this job did not
    // declare: all are links somebody made, not the applicant's own declaration.
    case 'manually_added':
    case 'submitted':
      return { source: 'linked', confidence: null };
  }
}

/**
 * Map the summary's characters onto findings.
 *
 * - a character this job declared stays `application`, spelled as declared, so
 *   it lands on the row seeded before SlashWho answered;
 * - `raiderio_declared` → `raider.io`, `fingerprint_derived` → `fingerprint`,
 *   `manually_added` (and any `submitted` character not declared here) → `linked`.
 *
 * `addFinding`'s SOURCE_RANK guard then keeps a declared character highest even
 * if a later row disagrees.
 */
export function mirrorFindings(
  summary: DossierSummary,
  declared: RaiderIoCharacter[],
  linked: LinkedCharacter[],
): MirroredFinding[] {
  const declaredById = new Map(declared.map((c) => [characterIdentity(c), c]));
  const linkedById = new Map(linked.map((c) => [characterIdentity(c), c]));
  const out: MirroredFinding[] = [];
  for (const c of summary.characters) {
    const id = characterIdentity(c.key);
    const own = declaredById.get(id);
    const guild = {
      guildName: c.guild?.name ?? null,
      guildRealm: c.guild ? raiderIoRealmSlug(c.guild.realm) : null,
    };
    if (own) {
      out.push({
        name: own.name,
        realm: raiderIoRealmSlug(own.realm),
        className: c.className,
        ...guild,
        source: 'application',
        confidence: null,
        discordStatus: null,
        discordProfile: null,
        declared: true,
      });
      continue;
    }
    const spelled = linkedById.get(id);
    out.push({
      name: spelled?.name ?? c.displayName,
      realm: raiderIoRealmSlug(spelled?.realm ?? c.key.realm),
      className: c.className,
      ...guild,
      ...sourceFor(c),
      discordStatus: null,
      discordProfile: null,
      declared: false,
    });
  }
  return out.sort((a, b) => Number(b.declared) - Number(a.declared));
}

// ─── Guild history ──────────────────────────────────────────

/**
 * Map the summary's guild spans onto the bot's stored guild-history shape, so
 * `applicant_intel_*` stays the source of truth even though the compact embed
 * renders from the summary. Character identities become display names.
 *
 * `cuttingEdge` is left unset: SlashWho's Cutting Edge list is account-wide and
 * keyed by achievement, not by raid, and an absent marker means "not judged".
 */
export function mirrorGuildHistory(summary: DossierSummary): GuildHistoryEntry[] {
  const names = new Map(summary.characters.map((c) => [characterIdentity(c.key), c.displayName]));
  const display = (path: string): string => {
    const id = identityFromPath(path);
    return (id && names.get(id)) ?? path.split('/').pop() ?? path;
  };
  return summary.guildHistory.map((g) => ({
    guildName: g.guild.name,
    guildRealm: raiderIoRealmSlug(g.guild.realm),
    stints: g.raids.map((r) => ({
      raidName: r.raidName,
      kills: r.kills,
      first: r.firstKillAt,
      last: r.lastKillAt,
      characters: r.characters.map(display),
    })),
  }));
}

// ─── Rendering ──────────────────────────────────────────────

export type SummaryOutcome =
  /** Interim copy while the dossier collects; replaced by a terminal body. */
  | 'collecting'
  | 'published'
  /** The deadline passed while SlashWho was still collecting. */
  | 'deadline'
  /** Rate limited; the job resumes on its own. */
  | 'paused'
  /** Rate limited too many times; nothing will retry. */
  | 'abandoned'
  /** SlashWho could not research this applicant. */
  | 'unavailable';

export interface SummaryInput {
  applicantName: string;
  region: string;
  /** Local findings, after mirroring and the Discord pass. */
  findings: IntelFinding[];
  unlinkable?: ReadonlySet<string>;
  summary: DossierSummary | null;
  dossierUrl: string | null;
  outcome: SummaryOutcome;
  retryAt?: Date;
  /** Officer-readable reason, for `unavailable`. */
  reason?: string;
  deadlineMs?: number;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function charactersSection(input: SummaryInput): string {
  const { findings } = input;
  if (findings.length === 0) return `**Characters**\nNo characters found.`;
  const sorted = [...findings].sort((a, b) => {
    if (isSelfDeclared(a.source) !== isSelfDeclared(b.source)) {
      return isSelfDeclared(a.source) ? -1 : 1;
    }
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
  const lines = sorted
    .slice(0, MAX_CHARACTER_LINES)
    .map((f) => findingLine(f, input.region, input.applicantName, input.unlinkable ?? new Set()));
  const more = sorted.length - MAX_CHARACTER_LINES;
  if (more > 0) lines.push(`…and ${more} more in the dossier.`);
  return `**Characters** — ${findings.length}\n${lines.join('\n')}`;
}

function guildsSection(summary: DossierSummary, region: string): string {
  if (summary.guildHistory.length === 0) {
    return '**Guilds**\nNo guild raid nights recorded yet.';
  }
  const recent = [...summary.guildHistory].sort((a, b) => b.lastNight.localeCompare(a.lastNight));
  const lines = recent.slice(0, MAX_GUILD_LINES).map((g, i) => {
    const link = raiderIoGuildUrl(region, raiderIoRealmSlug(g.guild.realm), g.guild.name);
    const span =
      g.firstNight === g.lastNight
        ? discordDate(`${g.firstNight}T12:00:00Z`)
        : `${discordDate(`${g.firstNight}T12:00:00Z`)} → ${discordDate(`${g.lastNight}T12:00:00Z`)}`;
    const label = i === 0 ? ' — most recent' : '';
    return `**[${g.guild.name}](${link})** *(${displayRealm(raiderIoRealmSlug(g.guild.realm))})*${label} · ${plural(g.raidNights, 'raid night')} · ${span}`;
  });
  const more = recent.length - MAX_GUILD_LINES;
  if (more > 0) lines.push(`…and ${more} more in the dossier.`);
  return `**Guilds** — ${summary.guildHistory.length}\n${lines.join('\n')}`;
}

function raidsSection(summary: DossierSummary): string {
  if (summary.raids.length === 0) return '**Mythic progression**\nNo Mythic kills recorded yet.';
  const lines = summary.raids.slice(0, MAX_RAID_LINES).map((raid) => {
    const kills = raid.bosses.filter((b) => b.state === 'kill');
    const wipes = raid.bosses.filter((b) => b.state === 'wipe');
    const parts = [`${plural(kills.length, 'boss', 'bosses')} killed`];
    if (wipes.length > 0) parts.push(`wiping on ${wipes.map((w) => w.bossName).join(', ')}`);
    const ranks = kills.map((k) => k.worldRank).filter((r): r is number => r !== null);
    if (ranks.length > 0)
      parts.push(`best world rank #${Math.min(...ranks).toLocaleString('en-GB')}`);
    const latest = kills
      .map((k) => k.firstKilledAt)
      .filter((d): d is string => d !== null)
      .sort()
      .pop();
    if (latest) parts.push(`latest first kill ${discordDate(latest)}`);
    return `**${raid.raidName}** — ${parts.join(' · ')}`;
  });
  const hidden = summary.raids.length - MAX_RAID_LINES;
  if (hidden > 0 || summary.raidsTruncated) lines.push('Older raids are in the dossier.');
  return `**Mythic progression**\n${lines.join('\n')}`;
}

function cuttingEdgeSection(summary: DossierSummary): string {
  const count = summary.cuttingEdges.length;
  // `cuttingEdgesRestored: false` means the list is incomplete, never "none earned".
  const caveat = summary.cuttingEdgesRestored
    ? ''
    : ' *(not collected for every character, so there may be more)*';
  if (count === 0) {
    return `**Cutting Edge** — ${summary.cuttingEdgesRestored ? 'none' : 'none found yet'}${caveat}`;
  }
  const names = [...summary.cuttingEdges]
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    .slice(0, 3)
    .map((ce) => ce.achievementName.replace(/^Cutting Edge:\s*/i, ''));
  const more = count > names.length ? `, +${count - names.length} more` : '';
  return `**Cutting Edge** — ${count} (${names.join(', ')}${more})${caveat}`;
}

const LIMITATION_TEXT: Record<string, string> = {
  not_found: 'not found',
  private: 'profile is private',
  privacy_hidden: 'hidden by privacy settings',
  rate_limited: 'a provider rate-limited the collection',
  points_budget_low: 'Warcraft Logs budget ran low',
  collection_failed: 'collection failed',
  request_cap: 'request cap reached',
  history_limit: 'older history not collected',
  unavailable: 'a provider was unavailable',
  parse_private: 'parses are private',
  parse_rate_limited: 'parses were rate limited',
};

const AFFECTS_TEXT: Record<string, string> = {
  kill_history: 'kill history',
  parses: 'parses',
  world_ranks: 'world ranks',
  cutting_edge: 'Cutting Edge',
  hidden_kills: 'hidden kills',
  linked_characters: 'linked characters',
};

const humanise = (code: string): string => code.replace(/_/g, ' ');

function limitationLine(l: DossierLimitation, names: Map<string, string>): string {
  const what = LIMITATION_TEXT[l.code] ?? humanise(l.code);
  const affects = AFFECTS_TEXT[l.affects] ?? humanise(l.affects);
  const who = l.character ? (names.get(characterIdentity(l.character)) ?? l.character.name) : null;
  return `· ${who ? `${who}: ` : ''}${what} — affects ${affects}`;
}

function limitationsSection(summary: DossierSummary): string | null {
  if (summary.limitations.length === 0) return null;
  const names = new Map(summary.characters.map((c) => [characterIdentity(c.key), c.displayName]));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const l of summary.limitations) {
    const line = limitationLine(l, names);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const shown = lines.slice(0, MAX_LIMITATION_LINES);
  if (lines.length > shown.length)
    shown.push(`…and ${lines.length - shown.length} more in the dossier.`);
  return `**Limitations**\n${shown.join('\n')}`;
}

function statusNote(input: SummaryInput): string | null {
  switch (input.outcome) {
    case 'collecting':
      return '*SlashWho is collecting — this summary updates when the dossier is ready.*';
    case 'published':
      return input.summary?.state === 'partial'
        ? '*Partial — SlashWho could not collect everything; see Limitations.*'
        : null;
    case 'deadline': {
      const minutes = Math.round((input.deadlineMs ?? 0) / 60_000);
      const after = minutes > 0 ? ` after ${plural(minutes, 'minute')}` : '';
      return `*Still collecting${after} — this is what SlashWho had so far. The dossier link shows the latest.*`;
    }
    case 'paused': {
      const retry = input.retryAt
        ? ` Retrying <t:${Math.floor(input.retryAt.getTime() / 1000)}:R>.`
        : '';
      return `*Rate limited on SlashWho.${retry}*`;
    }
    case 'abandoned':
      return '*Incomplete — rate limited on SlashWho too many times, gave up.*';
    case 'unavailable':
      return null;
  }
}

/** Trim to the embed limit on a line boundary, never inside a markdown link. */
function clamp(body: string): string {
  if (body.length <= EMBED_DESCRIPTION_LIMIT) return body;
  const cut = body.slice(0, EMBED_DESCRIPTION_LIMIT);
  const lastNewline = cut.lastIndexOf('\n');
  return (lastNewline > 0 ? cut.slice(0, lastNewline) : cut).trimEnd();
}

/**
 * The one compact summary embed: who the characters are, where they raided,
 * what they killed, and a link to the full dossier for everything else.
 * Bounded by construction (capped sections), so it is never paged.
 */
export function renderSlashWhoSummary(input: SummaryInput): string {
  const sections: string[] = [];
  if (input.outcome === 'unavailable') {
    sections.push(
      `**Applicant research unavailable** — ${input.applicantName}\n` +
        `SlashWho could not research this applicant${input.reason ? `: ${input.reason}` : ''}. ` +
        'Only the characters named in the application are listed; nothing else was checked.',
    );
  } else {
    sections.push(`**Applicant summary** — ${input.applicantName}`);
  }
  if (input.dossierUrl) {
    sections.push(
      `[Open the full SlashWho dossier](${input.dossierUrl}) — rosters, parses, world ranks and older raids.`,
    );
  }
  sections.push(charactersSection(input));
  if (input.summary && input.outcome !== 'unavailable') {
    sections.push(guildsSection(input.summary, input.region));
    sections.push(raidsSection(input.summary));
    sections.push(cuttingEdgeSection(input.summary));
    const limits = limitationsSection(input.summary);
    if (limits) sections.push(limits);
  }
  const note = statusNote(input);
  if (note) sections.push(note);
  return clamp(sections.join('\n\n'));
}

/**
 * The bodies for the guild-history and logs positions when the SlashWho runner
 * is selected. Both live in the one summary embed now, so these point at it —
 * and never say "searching…" once nothing will revisit them.
 */
export function renderPointer(
  kind: 'guilds' | 'logs',
  outcome: SummaryOutcome,
  dossierUrl: string | null,
): string {
  const heading = kind === 'guilds' ? '**Guild history**' : '**Mythic raid logs**';
  const dossier = dossierUrl ? ` and the [full dossier](${dossierUrl})` : '';
  switch (outcome) {
    case 'collecting':
      return `${heading} — SlashWho is collecting; it will appear in the summary above.`;
    case 'paused':
      return `${heading} — waiting on SlashWho (rate limited); it will appear in the summary above.`;
    case 'unavailable':
      return `${heading} — not checked: SlashWho research was unavailable.`;
    case 'abandoned':
      return `${heading} — incomplete: SlashWho stayed rate limited.${dossierUrl ? ` See the [full dossier](${dossierUrl}).` : ''}`;
    case 'published':
    case 'deadline':
      return `${heading} — in the summary above${dossier}.`;
  }
}

/** Whether a dossier key names the same character as a bot character. */
export function sameCharacter(
  a: DossierKey | RaiderIoCharacter,
  b: DossierKey | RaiderIoCharacter,
): boolean {
  return characterIdentity(a) === characterIdentity(b);
}
