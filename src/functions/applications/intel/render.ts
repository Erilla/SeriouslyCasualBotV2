import { isSelfDeclared, type IntelFinding } from './jobStore.js';
import type { BossEvidence } from '../mythic-logs/selectMythicReports.js';
import type { WclZone } from '../mythic-logs/zoneCatalogue.js';

/** Discord embed description limit. */
const EMBED_DESCRIPTION_LIMIT = 4096;
/** Leaves room for the heading and footer we add around the lines. */
const PAGE_BUDGET = 3600;

export interface PauseFooter {
  service: string;
  scanned: number;
  total: number;
  retryAt?: Date;
  abandoned?: boolean;
}

const thousands = (n: number): string => n.toLocaleString('en-GB');

/**
 * The retry time is a Discord relative timestamp so it is correct in every
 * reader's timezone and stays accurate as the wait elapses; a formatted clock
 * time would be neither.
 */
export function renderFooter(f: PauseFooter): string {
  const progress = `${thousands(f.scanned)} of ~${thousands(f.total)} characters scanned`;
  if (f.abandoned) {
    return `*Incomplete — rate limited on ${f.service}, gave up. ${progress}.*`;
  }
  const retry = f.retryAt ? ` Retrying <t:${Math.floor(f.retryAt.getTime() / 1000)}:R>.` : '';
  return `*Rate limited on ${f.service} — ${progress}.${retry}*`;
}

const realmSlug = (realm: string): string => realm.toLowerCase().replace(/\s+/g, '-');

/**
 * Findings store the realm slug-normalised, because `applicant_intel_findings`
 * has a case-sensitive primary key and Blizzard rosters yield slugs
 * (`argent-dawn`) while Raider.IO yields display names (`Argent Dawn`) — without
 * one canonical form the same character inserts twice, bypasses the source-rank
 * guard, and loses its Discord verdict to an exact-match WHERE. That is right for
 * storage and reads badly, so restore a display form here. URLs keep the slug.
 *
 * Idempotent on an already-readable value, which is why the renderer's other
 * tests can keep passing `Draenor`/`Tarren Mill` unchanged. Realms whose real
 * name carries an apostrophe (`Zul'jin`) come back without it — the slug does not
 * record one, and guessing where it belongs would be worse than omitting it.
 */
const displayRealm = (realm: string): string =>
  realm
    .split('-')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');

export function raiderIoProfileUrl(region: string, realm: string, name: string): string {
  return `https://raider.io/characters/${region.toLowerCase()}/${realmSlug(realm)}/${name}`;
}

export function raiderIoGuildUrl(region: string, realm: string, name: string): string {
  return `https://raider.io/guilds/${region.toLowerCase()}/${realmSlug(realm)}/${encodeURIComponent(name)}`;
}

/**
 * A Discord long-date timestamp. Rendered in each reader's own timezone, which a
 * hardcoded `YYYY-MM-DD` is not — and it stays correct as time passes.
 * The full kill timestamp is used, so the date shown is the reader's local date
 * of the kill rather than a UTC midnight that can slip a day.
 */
export function discordDate(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  return `<t:${Math.floor(ms / 1000)}:D>`;
}

function findingLine(
  f: IntelFinding,
  region: string,
  applicantName: string,
  unlinkable: ReadonlySet<string>,
): string {
  // A character Raider.IO cannot resolve gets its name in plain text. It reached
  // the sweep through a WarcraftLogs or Armory link and is swept perfectly well
  // against Blizzard, but a raider.io profile URL for it would 404 — and a
  // reviewer who clicks a dead link reads it as the bot being wrong about the
  // character rather than about the link.
  const label = `${f.name}-${displayRealm(f.realm)}`;
  const link = unlinkable.has(`${f.name}|${f.realm}`.toLowerCase())
    ? label
    : `[${label}](${raiderIoProfileUrl(region, f.realm, f.name)})`;
  const guild = f.guildName
    ? `${f.guildName} (${f.guildRealm ? displayRealm(f.guildRealm) : '?'})`
    : 'No guild';
  const discord =
    f.discordStatus === 'confirmed'
      ? ' · Discord verified'
      : f.discordStatus === 'mismatch'
        ? ` · ⚠ Discord mismatch: ${f.discordProfile ?? 'unknown'}`
        : '';
  // A back-link is a stated fact, not a score, and the claim runs the opposite
  // way to a `declared main` — so it says who names whom rather than showing the
  // flat 100% that a reviewer would read as just a very good fingerprint match.
  const evidence =
    f.source === 'linked'
      ? `linked in the conversation${
          f.confidence === null ? '' : ` · ${Math.round(f.confidence)}% fingerprint confidence`
        }`
      : f.source === 'declared alt'
        ? `names ${applicantName} as their main`
        : `${Math.round(f.confidence ?? 100)}% confidence`;
  const provenance = isSelfDeclared(f.source)
    ? 'from the application'
    : `undeclared (${evidence}${discord})`;
  return `${link} · ${f.className ?? 'Unknown'} · ${guild} — ${provenance}`;
}

/**
 * The found-characters message. Application characters first, then undeclared
 * by descending confidence — a flat list, because guild grouping would fight
 * that ordering, so guild is shown inline instead. Nothing is filtered out.
 */
export function renderFoundCharacters(
  findings: IntelFinding[],
  applicantName: string,
  region: string,
  footer?: PauseFooter,
  /** Keys of characters Raider.IO could not resolve; see findingLine. */
  unlinkable: ReadonlySet<string> = new Set(),
): string[] {
  const heading = `**Found characters** — ${findings.length}`;
  if (findings.length === 0) {
    const empty = `**Found characters**\nNo other characters found for **${applicantName}**.`;
    return [footer ? `${empty}\n\n${renderFooter(footer)}` : empty];
  }

  const sorted = [...findings].sort((a, b) => {
    if (isSelfDeclared(a.source) && !isSelfDeclared(b.source)) return -1;
    if (isSelfDeclared(b.source) && !isSelfDeclared(a.source)) return 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  const pages: string[] = [];
  let current = `${heading}\n\n`;
  for (const f of sorted) {
    const line = `${findingLine(f, region, applicantName, unlinkable)}\n`;
    if (current.length + line.length > PAGE_BUDGET) {
      pages.push(current.trimEnd());
      current = '';
    }
    current += line;
  }
  if (current.trim()) pages.push(current.trimEnd());

  if (footer) {
    const withFooter = `${pages[0]}\n\n${renderFooter(footer)}`;
    pages[0] = withFooter.slice(0, EMBED_DESCRIPTION_LIMIT);
  }
  return pages;
}

export interface GuildStint {
  raidName: string;
  kills: number;
  /** Full ISO timestamps — kept intact so they can render as Discord timestamps. */
  first: string;
  last: string;
  characters: string[];
}

export interface GuildHistoryEntry {
  guildName: string;
  guildRealm: string;
  stints: GuildStint[];
}

/** Same-day spans collapse to one timestamp; ISO strings compare lexicographically. */
const dateRange = (first: string, last: string): string =>
  first.slice(0, 10) === last.slice(0, 10)
    ? discordDate(first)
    : `${discordDate(first)} → ${discordDate(last)}`;

/**
 * Clamp a page to the embed limit without cutting mid-line — a mid-line cut can
 * land inside a markdown link (`[report](https://...` with no closing paren),
 * which Discord renders as broken literal text instead of a link.
 */
function clampPage(page: string): string {
  if (page.length <= EMBED_DESCRIPTION_LIMIT) return page;
  const cut = page.slice(0, EMBED_DESCRIPTION_LIMIT);
  const lastNewline = cut.lastIndexOf('\n');
  return (lastNewline > 0 ? cut.slice(0, lastNewline) : cut).trimEnd();
}

/**
 * Guilds the account has raided with, per tier. Entries arrive most-recent-first.
 *
 * These are EVIDENCE SPANS, not tenures: one tested account has a kill with its
 * old guild in July while other characters were killing with the new one, because
 * different characters sat in different guilds at once. The copy therefore never
 * says "left" or "joined" — only when kills happened.
 */
export function renderGuildHistory(
  entries: GuildHistoryEntry[],
  region: string,
  footer?: PauseFooter,
): string[] {
  if (entries.length === 0) {
    const empty =
      '**Guild history**\nNo guild history found — no Mythic kills recorded with any guild.';
    return [footer ? `${empty}\n\n${renderFooter(footer)}` : empty];
  }

  const heading = `**Guild history** — ${entries.length} guild${entries.length === 1 ? '' : 's'}`;
  const blocks = entries.map((entry) => {
    const first = entry.stints.map((st) => st.first).sort()[0];
    const last = entry.stints
      .map((st) => st.last)
      .sort()
      .slice(-1)[0];
    const link = raiderIoGuildUrl(region, entry.guildRealm, entry.guildName);
    const head = `**[${entry.guildName}](${link})** *(${displayRealm(entry.guildRealm)})* — ${dateRange(first, last)}`;
    const lines = entry.stints.map((st) => {
      const kills = `${st.kills} Mythic kill${st.kills === 1 ? '' : 's'}`;
      return `${st.raidName} · ${kills} · ${dateRange(st.first, st.last)} · ${st.characters.join(', ')}`;
    });
    return `${head}\n${lines.join('\n')}`;
  });

  // Page on guild block boundaries only — splitting a guild's head line from its
  // raid lines would orphan a raid line under no guild heading.
  const pages: string[] = [];
  let current = `${heading}\n\n`;
  let currentHasBlock = false;
  for (const block of blocks) {
    const chunk = `${block}\n\n`;
    if (currentHasBlock && current.length + chunk.length > PAGE_BUDGET) {
      pages.push(current.trimEnd());
      current = '';
    }
    current += chunk;
    currentHasBlock = true;
  }
  if (current.trim()) pages.push(current.trimEnd());

  if (footer) {
    pages[0] = `${pages[0]}\n\n${renderFooter(footer)}`;
  }

  // A single guild block bigger than PAGE_BUDGET still gets its own page (it
  // can't be split), so that page alone can still breach the hard 4096 limit —
  // clamp it, preferring a line boundary over a mid-link cut.
  return pages.map(clampPage);
}

export interface RenderedTier {
  zone: WclZone;
  lines: BossEvidence[];
}

function logLine(entry: BossEvidence, bossCount: number): string {
  const position = `${entry.bossIndex + 1}/${bossCount}`;
  const status =
    entry.kind === 'kill'
      ? entry.date
        ? `first kill ${discordDate(entry.date)}`
        : 'killed'
      : `wiping, best ${(entry.percent ?? 100).toFixed(1)}%`;
  const link = `[report](https://www.warcraftlogs.com/reports/${entry.reportCode})`;
  return `${position} **${entry.bossName}** — ${status} · **${entry.who}** · ${link}`;
}

/**
 * The logs message. Every line names the character the report belongs to: the
 * message pools the applicant's character with their alts, and without the
 * label a reviewer cannot tell a 4/8 applicant from their 9/9 main.
 */
export function renderMythicLogs(
  applicantName: string,
  tiers: RenderedTier[],
  sweptCount: number,
  footer?: PauseFooter,
): string {
  if (tiers.length === 0) {
    const empty = `**Mythic raid logs — ${applicantName}**\nNo Mythic raid logs found for **${applicantName}** in the last 3 expansions.`;
    return footer ? `${empty}\n\n${renderFooter(footer)}` : empty;
  }

  const suffix = sweptCount > 0 ? ` + ${sweptCount} character${sweptCount === 1 ? '' : 's'}` : '';
  const blocks = tiers.map((tier) => {
    const head = `**${tier.zone.name}** *(${tier.zone.expansion})*`;
    const body = tier.lines.map((l) => logLine(l, tier.zone.encounters.length)).join('\n');
    return `${head}\n${body}`;
  });

  const out = `**Mythic raid logs** — ${applicantName}${suffix}\n\n${blocks.join('\n\n')}`;
  const withFooter = footer ? `${out}\n\n${renderFooter(footer)}` : out;
  return withFooter.slice(0, EMBED_DESCRIPTION_LIMIT);
}
