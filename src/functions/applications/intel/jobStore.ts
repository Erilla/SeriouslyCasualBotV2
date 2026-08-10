import { getDatabase } from '../../../database/db.js';
import { decodeFingerprint, encodeFingerprint } from '../../../services/blizzard.js';
import type {
  ApplicantIntelAnchorFingerprint,
  ApplicantIntelTopUpResult,
  ApplicantIntelTopUpState,
  IntelJobRow,
} from '../../../types/index.js';
import type { RaiderIoCharacter } from '../characterLinks.js';
import type { GuildHistoryEntry } from './render.js';

export type JobPhase = 'logs' | 'alt_sources' | 'fingerprint' | 'alt_logs' | 'done';
export type JobStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed';
export type FindingSource =
  | 'application'
  | 'linked'
  | 'raider.io'
  | 'declared main'
  | 'declared alt'
  | 'fingerprint';

export type DiscordStatus = 'confirmed' | 'mismatch';

export interface IntelFinding {
  name: string;
  realm: string;
  className: string | null;
  guildName: string | null;
  guildRealm: string | null;
  source: FindingSource;
  confidence: number | null;
  /** Set by the Discord confirmation pass; null means no information. */
  discordStatus: DiscordStatus | null;
  /** The handle observed on the character — shown when it contradicts. */
  discordProfile: string | null;
}

/** Strongest-first: a later fingerprint hit must never downgrade a Raider.IO
 *  fact, and nothing outranks a character the applicant named themselves.
 *
 *  `declared alt` is the mirror of `declared main` — the claim recorded on the
 *  ALT ("my main is <applicant>") rather than on the applicant — and is the same
 *  self-assertion by the same account owner, so it ranks with it. */
const SOURCE_RANK: Record<FindingSource, number> = {
  application: 40,
  linked: 30,
  'raider.io': 20,
  'declared main': 20,
  'declared alt': 20,
  fingerprint: 10,
};

/** Only characters explicitly entered in the application form are self-declared. */
export function isSelfDeclared(source: FindingSource): boolean {
  return source === 'application';
}

/** Every inferred or conversation-linked character should receive the confirmation pass. */
export function needsDiscordConfirmation(source: FindingSource): boolean {
  return !isSelfDeclared(source);
}

function touch(id: number): void {
  getDatabase()
    .prepare("UPDATE applicant_intel_jobs SET updated_at = datetime('now') WHERE id = ?")
    .run(id);
}

export function createJob(input: {
  applicationId: number | null;
  targetChannelId: string;
  character: RaiderIoCharacter;
  /** Discord username of the applicant, for the confirmation pass. */
  applicantDiscord?: string | null;
}): number {
  const result = getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_jobs
         (application_id, target_channel_id, character_name, character_realm, character_region,
          applicant_discord)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.applicationId,
      input.targetChannelId,
      input.character.name,
      input.character.realm,
      input.character.region,
      input.applicantDiscord ?? null,
    );
  return result.lastInsertRowid as number;
}

export function getJob(id: number): IntelJobRow | undefined {
  return getDatabase().prepare('SELECT * FROM applicant_intel_jobs WHERE id = ?').get(id) as
    | IntelJobRow
    | undefined;
}

export function setPhase(id: number, phase: JobPhase): void {
  getDatabase().prepare('UPDATE applicant_intel_jobs SET phase = ? WHERE id = ?').run(phase, id);
  touch(id);
}

export function setStatus(id: number, status: JobStatus): void {
  getDatabase()
    .prepare(
      `UPDATE applicant_intel_jobs
         SET status = ?, resume_after = NULL, paused_service = NULL
       WHERE id = ?`,
    )
    .run(status, id);
  touch(id);
}

export function pauseJob(id: number, service: string, resumeAfterMs: number): void {
  const resumeAt = new Date(Date.now() + resumeAfterMs).toISOString();
  getDatabase()
    .prepare(
      `UPDATE applicant_intel_jobs
         SET status = 'paused', paused_service = ?, resume_after = ?, attempts = attempts + 1
       WHERE id = ?`,
    )
    .run(service, resumeAt, id);
  touch(id);
}

/** Pending jobs, plus paused jobs whose wait has elapsed. */
export function dueJobs(nowIso: string): IntelJobRow[] {
  return getDatabase()
    .prepare(
      `SELECT * FROM applicant_intel_jobs
        WHERE status = 'pending'
           OR (status = 'paused' AND resume_after IS NOT NULL AND resume_after <= ?)
        ORDER BY id`,
    )
    .all(nowIso) as IntelJobRow[];
}

/** A job left 'running' by a crash can never resume itself; reset it. */
export function resetRunningJobs(): number {
  return getDatabase()
    .prepare("UPDATE applicant_intel_jobs SET status = 'pending' WHERE status = 'running'")
    .run().changes;
}

export function setMessageIds(
  id: number,
  ids: { alts?: string; guilds?: string; logs?: string },
): void {
  const db = getDatabase();
  if (ids.guilds !== undefined) {
    db.prepare('UPDATE applicant_intel_jobs SET guilds_message_id = ? WHERE id = ?').run(
      ids.guilds,
      id,
    );
  }
  if (ids.alts !== undefined) {
    db.prepare('UPDATE applicant_intel_jobs SET alts_message_id = ? WHERE id = ?').run(
      ids.alts,
      id,
    );
  }
  if (ids.logs !== undefined) {
    db.prepare('UPDATE applicant_intel_jobs SET logs_message_id = ? WHERE id = ?').run(
      ids.logs,
      id,
    );
  }
  touch(id);
}

/**
 * The characters the applicant named themselves. An application — or a /test
 * invocation — can name several, so the set lives in the queue rather than on
 * the job row; the row's character_* columns hold the primary for identity only.
 */
export function setApplicantCharacters(jobId: number, characters: RaiderIoCharacter[]): void {
  for (const c of characters) {
    enqueue(jobId, 'applicant', `${c.name}-${c.realm}`.toLowerCase(), c);
  }
}

export function getApplicantCharacters(jobId: number): RaiderIoCharacter[] {
  return getDatabase()
    .prepare(
      "SELECT payload FROM applicant_intel_queue WHERE job_id = ? AND kind = 'applicant' ORDER BY rowid",
    )
    .all(jobId)
    .map((r) => JSON.parse((r as { payload: string }).payload) as RaiderIoCharacter);
}

function characterIdentityKey(character: RaiderIoCharacter): string {
  const normalize = (value: string): string => value.trim().normalize('NFC').toLowerCase();
  return [character.region, character.realm, character.name].map(normalize).join('/');
}

/** Canonical characters harvested from links, kept separate from self-declared applicants. */
export function setLinkedCharacters(jobId: number, characters: RaiderIoCharacter[]): void {
  for (const character of characters) {
    enqueue(jobId, 'linked', characterIdentityKey(character), character);
  }
}

export function getLinkedCharacters(jobId: number): RaiderIoCharacter[] {
  return getDatabase()
    .prepare(
      "SELECT payload FROM applicant_intel_queue WHERE job_id = ? AND kind = 'linked' ORDER BY rowid",
    )
    .all(jobId)
    .map((row) => JSON.parse((row as { payload: string }).payload) as RaiderIoCharacter);
}

export function enqueue(jobId: number, kind: string, key: string, payload?: unknown): void {
  getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_queue (job_id, kind, key, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id, kind, key) DO NOTHING`,
    )
    .run(jobId, kind, key, payload === undefined ? null : JSON.stringify(payload));
}

interface StoredAnchorFingerprint extends Omit<ApplicantIntelAnchorFingerprint, 'entries'> {
  entries: string;
}

/** Persist the successful primary fingerprint; null is deliberately not negative-cached. */
export function setAnchorFingerprint(
  jobId: number,
  anchor: ApplicantIntelAnchorFingerprint | null,
): void {
  if (!anchor) return;

  const stored: StoredAnchorFingerprint = {
    ...anchor,
    entries: encodeFingerprint(anchor.entries),
  };
  getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_queue (job_id, kind, key, payload)
       VALUES (?, 'fingerprint', 'anchor', ?)
       ON CONFLICT(job_id, kind, key) DO UPDATE SET payload = excluded.payload, done = 0`,
    )
    .run(jobId, JSON.stringify(stored));
}

export function getAnchorFingerprint(jobId: number): ApplicantIntelAnchorFingerprint | null {
  const row = getDatabase()
    .prepare(
      "SELECT payload FROM applicant_intel_queue WHERE job_id = ? AND kind = 'fingerprint' AND key = 'anchor'",
    )
    .get(jobId) as { payload: string | null } | undefined;
  if (!row?.payload) return null;

  const stored = JSON.parse(row.payload) as StoredAnchorFingerprint;
  return { ...stored, entries: decodeFingerprint(stored.entries) };
}

export function getTopUpState(jobId: number): ApplicantIntelTopUpState | null {
  const row = getDatabase()
    .prepare(
      "SELECT payload FROM applicant_intel_queue WHERE job_id = ? AND kind = 'topup' AND key = 'state'",
    )
    .get(jobId) as { payload: string | null } | undefined;
  return row?.payload ? (JSON.parse(row.payload) as ApplicantIntelTopUpState) : null;
}

function setTopUpState(jobId: number, state: ApplicantIntelTopUpState): void {
  getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_queue (job_id, kind, key, payload)
       VALUES (?, 'topup', 'state', ?)
       ON CONFLICT(job_id, kind, key) DO UPDATE SET payload = excluded.payload, done = 0`,
    )
    .run(jobId, JSON.stringify(state));
}

/** Request another pass without disturbing an active run or rate-limit pause. */
export function requestTopUp(jobId: number): ApplicantIntelTopUpResult {
  const db = getDatabase();
  return db.transaction(() => {
    const job = db.prepare('SELECT status FROM applicant_intel_jobs WHERE id = ?').get(jobId) as
      | { status: JobStatus }
      | undefined;
    if (!job) throw new Error(`Applicant intel job ${jobId} does not exist`);

    const reopened = job.status === 'done' || job.status === 'failed';
    const previous = getTopUpState(jobId);
    setTopUpState(jobId, {
      requested: true,
      reopenedAt: reopened ? new Date().toISOString() : (previous?.reopenedAt ?? null),
    });

    if (reopened) {
      db.prepare(
        `UPDATE applicant_intel_jobs
           SET status = 'pending', attempts = 0, resume_after = NULL, paused_service = NULL,
               updated_at = datetime('now')
         WHERE id = ?`,
      ).run(jobId);
      return 'reopened';
    }

    return 'queued';
  })();
}

export function topUpRequested(jobId: number): boolean {
  return getTopUpState(jobId)?.requested ?? false;
}

/** Clear at run start so a later request remains visible as a fresh wakeup. */
export function consumeTopUpRequest(jobId: number): boolean {
  const state = getTopUpState(jobId);
  if (!state?.requested) return false;
  setTopUpState(jobId, { ...state, requested: false });
  return true;
}

/**
 * The aggregated guild history is a single row per job (kind 'guild_history',
 * key 'entries'), not a work queue — but `enqueue` is
 * `ON CONFLICT DO NOTHING`, so a resumed job whose earlier attempt already
 * wrote this row would keep that attempt's data forever. That is not an edge
 * case: the `logs` phase pause happens strictly after this write (so the
 * common resume path always re-enters here), and `getMythicKillDates`
 * swallowing a 429 can make a later attempt compute an empty history with no
 * pause to explain it. `upsertGuildHistory` therefore replaces the row on
 * every write, so the database always reflects the most recent computation —
 * exactly what a reader rebuilding a page on demand needs.
 */
/**
 * The log-sweep candidate list, persisted so a resumed attempt does not
 * re-enumerate it.
 *
 * Building it costs one `getRaidReports` (up to 6 paginated WarcraftLogs queries)
 * plus one `getMythicKillCount` per discovered character. With 24 findings that is
 * ~100 WCL queries burned before a resumed attempt does any new work — and WCL
 * bills by points, so the job could re-exhaust its budget on re-enumeration alone
 * and abandon without progressing. Callers extend this incrementally, so a
 * character discovered on a later attempt is still enumerated exactly once.
 */
export function setSweepCandidates(jobId: number, candidates: unknown[]): void {
  getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_queue (job_id, kind, key, payload)
       VALUES (?, 'candidates', 'list', ?)
       ON CONFLICT(job_id, kind, key) DO UPDATE SET payload = excluded.payload, done = 0`,
    )
    .run(jobId, JSON.stringify(candidates));
}

export function getSweepCandidates<T>(jobId: number): T[] {
  const row = getDatabase()
    .prepare(
      "SELECT payload FROM applicant_intel_queue WHERE job_id = ? AND kind = 'candidates' AND key = 'list'",
    )
    .get(jobId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T[]) : [];
}

export function setGuildHistory(jobId: number, entries: GuildHistoryEntry[]): void {
  getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_queue (job_id, kind, key, payload)
       VALUES (?, 'guild_history', 'entries', ?)
       ON CONFLICT(job_id, kind, key) DO UPDATE SET payload = excluded.payload, done = 0`,
    )
    .run(jobId, JSON.stringify(entries));
}

export function getGuildHistory(jobId: number): GuildHistoryEntry[] {
  const row = getDatabase()
    .prepare(
      "SELECT payload FROM applicant_intel_queue WHERE job_id = ? AND kind = 'guild_history' AND key = 'entries'",
    )
    .get(jobId) as { payload: string | null } | undefined;
  return row?.payload ? (JSON.parse(row.payload) as GuildHistoryEntry[]) : [];
}

/**
 * Whether the alt sweep left work undone. Persisted for the same reason the
 * guild history is: the found-characters embed is PAGED, and a reviewer
 * clicking Next then Previous rebuilds page 1 from the database days later —
 * so a note that only ever existed in the message runJob happened to write
 * would silently disappear on the way back. Stored, like the guild history, as
 * a single upserted row so a later attempt's verdict replaces an earlier one
 * (a resumed run that completes must be able to clear the note).
 */
export function setSweepTruncated(jobId: number, truncated: boolean): void {
  getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_queue (job_id, kind, key, payload)
       VALUES (?, 'sweep', 'truncated', ?)
       ON CONFLICT(job_id, kind, key) DO UPDATE SET payload = excluded.payload, done = 0`,
    )
    .run(jobId, JSON.stringify(truncated));
}

export function getSweepTruncated(jobId: number): boolean {
  const row = getDatabase()
    .prepare(
      "SELECT payload FROM applicant_intel_queue WHERE job_id = ? AND kind = 'sweep' AND key = 'truncated'",
    )
    .get(jobId) as { payload: string | null } | undefined;
  return row?.payload ? (JSON.parse(row.payload) as boolean) : false;
}

export function pendingQueue(jobId: number, kind: string): { key: string; payload: unknown }[] {
  const rows = getDatabase()
    .prepare(
      'SELECT key, payload FROM applicant_intel_queue WHERE job_id = ? AND kind = ? AND done = 0 ORDER BY rowid',
    )
    .all(jobId, kind) as { key: string; payload: string | null }[];
  return rows.map((r) => ({ key: r.key, payload: r.payload ? JSON.parse(r.payload) : null }));
}

export function markQueueDone(jobId: number, kind: string, key: string): void {
  getDatabase()
    .prepare('UPDATE applicant_intel_queue SET done = 1 WHERE job_id = ? AND kind = ? AND key = ?')
    .run(jobId, kind, key);
}

export function markScanned(jobId: number, characterKey: string): void {
  getDatabase()
    .prepare(
      'INSERT INTO applicant_intel_scanned (job_id, character_key) VALUES (?, ?) ON CONFLICT DO NOTHING',
    )
    .run(jobId, characterKey.toLowerCase());
}

export function isScanned(jobId: number, characterKey: string): boolean {
  return Boolean(
    getDatabase()
      .prepare(
        'SELECT 1 AS hit FROM applicant_intel_scanned WHERE job_id = ? AND character_key = ?',
      )
      .get(jobId, characterKey.toLowerCase()),
  );
}

export function scannedCount(jobId: number): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM applicant_intel_scanned WHERE job_id = ?')
    .get(jobId) as { n: number };
  return row.n;
}

export function addFinding(jobId: number, f: IntelFinding): void {
  const db = getDatabase();
  const existing = db
    .prepare(
      'SELECT source FROM applicant_intel_findings WHERE job_id = ? AND name = ? AND realm = ?',
    )
    .get(jobId, f.name, f.realm) as { source: FindingSource } | undefined;
  if (existing && SOURCE_RANK[existing.source] >= SOURCE_RANK[f.source]) return;

  db.prepare(
    `INSERT INTO applicant_intel_findings
       (job_id, name, realm, class, guild_name, guild_realm, source, confidence,
        discord_status, discord_profile)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, name, realm) DO UPDATE SET
       class = excluded.class,
       guild_name = excluded.guild_name,
       guild_realm = excluded.guild_realm,
       source = excluded.source,
       confidence = COALESCE(excluded.confidence, applicant_intel_findings.confidence),
       -- A later, weaker source must never erase a Discord verdict already recorded.
       discord_status = COALESCE(excluded.discord_status, applicant_intel_findings.discord_status),
       discord_profile = COALESCE(excluded.discord_profile, applicant_intel_findings.discord_profile)`,
  ).run(
    jobId,
    f.name,
    f.realm,
    f.className,
    f.guildName,
    f.guildRealm,
    f.source,
    f.confidence,
    f.discordStatus,
    f.discordProfile,
  );
}

/** Record the outcome of the Discord confirmation pass for one character. */
export function setDiscordStatus(
  jobId: number,
  name: string,
  realm: string,
  status: DiscordStatus,
  profile: string | null,
): void {
  getDatabase()
    .prepare(
      `UPDATE applicant_intel_findings
         SET discord_status = ?, discord_profile = ?
       WHERE job_id = ? AND name = ? AND realm = ?`,
    )
    .run(status, profile, jobId, name, realm);
}

export function getFindings(jobId: number): IntelFinding[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM applicant_intel_findings WHERE job_id = ? ORDER BY rowid')
    .all(jobId) as {
    name: string;
    realm: string;
    class: string | null;
    guild_name: string | null;
    guild_realm: string | null;
    source: FindingSource;
    confidence: number | null;
    discord_status: DiscordStatus | null;
    discord_profile: string | null;
  }[];
  return rows.map((r) => ({
    name: r.name,
    realm: r.realm,
    className: r.class,
    guildName: r.guild_name,
    guildRealm: r.guild_realm,
    source: r.source,
    confidence: r.confidence,
    discordStatus: r.discord_status,
    discordProfile: r.discord_profile,
  }));
}
