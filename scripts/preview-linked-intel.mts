/**
 * Print the found-characters embed the linked-character feature will actually
 * produce, for every state that is awkward to reach on a live bot.
 *
 * Offline and deterministic: an in-memory database, no Discord, no API calls. It
 * exercises the real jobStore and the real renderer, so what it prints is what a
 * reviewer sees in the thread — this is the cheap way to check a copy or link
 * change before deploying to the test bot.
 *
 * Run: npm run preview:intel
 */
import { getDatabase, closeDatabase } from '../src/database/db.js';
import { createTables } from '../src/database/schema.js';
import {
  addFinding,
  createJob,
  getFindings,
  getJob,
  getLinkedCharacters,
  getUnverifiedLinkedKeys,
  requestTopUp,
  setJobPrimary,
  setLinkedCharacters,
  type FindingSource,
  type IntelFinding,
} from '../src/functions/applications/intel/jobStore.js';
import { renderFoundCharacters } from '../src/functions/applications/intel/render.js';
import {
  idlePlaceholderEmbed,
  intelRefreshRow,
  placeholderEmbed,
} from '../src/functions/applications/intel/placeholders.js';

const REGION = 'eu';

const heading = (label: string): void => {
  console.log(`\n${'─'.repeat(78)}\n${label}\n${'─'.repeat(78)}`);
};

const finding = (over: Partial<IntelFinding> & { name: string; realm: string }): IntelFinding => ({
  className: 'Priest',
  guildName: null,
  guildRealm: null,
  source: 'linked' as FindingSource,
  confidence: null,
  discordStatus: null,
  discordProfile: null,
  ...over,
});

function freshJob(characters: { region: string; realm: string; name: string }[]): number {
  createTables(getDatabase(':memory:'));
  return createJob({
    applicationId: 1,
    targetChannelId: 'thread',
    character: characters[0] ?? { region: '', realm: '', name: '' },
    status: characters.length > 0 ? 'pending' : 'idle',
  });
}

// ── 1. What an application that named nobody looks like before any link ────────
heading('1. Reserved but idle — application answers contained no character URL');
for (const kind of ['alts', 'guilds', 'logs'] as const) {
  console.log(idlePlaceholderEmbed(kind).toJSON().description);
}
console.log(
  `[button] ${JSON.stringify(intelRefreshRow(1, 'idle').toJSON().components[0], null, 0)}`,
);

heading('2. The same three positions when a sweep IS queued');
for (const kind of ['alts', 'guilds', 'logs'] as const) {
  console.log(placeholderEmbed(kind).toJSON().description);
}
console.log(
  `[button] ${JSON.stringify(intelRefreshRow(1, 'running').toJSON().components[0], null, 0)}`,
);

// ── 3. The mixed-provenance embed, which is the thing worth eyeballing ─────────
heading('3. Found characters — application URL, plus two links pasted in the thread');
{
  const applicant = { region: REGION, realm: 'draenor', name: 'Brentpriest' };
  const jobId = freshJob([applicant]);

  addFinding(
    jobId,
    finding({
      name: 'Brentpriest',
      realm: 'draenor',
      guildName: 'Rancour',
      guildRealm: 'draenor',
      source: 'application',
    }),
  );
  // A WarcraftLogs link for a different character Raider.IO does know.
  addFinding(
    jobId,
    finding({
      name: 'Brenthunter',
      realm: 'tarren-mill',
      className: 'Hunter',
      guildName: 'Vanquish',
      guildRealm: 'tarren-mill',
      confidence: 87,
    }),
  );
  // A WarcraftLogs link for a character Raider.IO has never indexed.
  addFinding(jobId, finding({ name: 'Wclonlyalt', realm: 'azjol-nerub', className: 'Mage' }));
  // An alt found by fingerprint, for contrast with the linked rows.
  addFinding(
    jobId,
    finding({
      name: 'Brentmage',
      realm: 'draenor',
      className: 'Mage',
      source: 'fingerprint',
      confidence: 94,
    }),
  );

  setLinkedCharacters(jobId, [
    { region: REGION, realm: 'tarren-mill', name: 'Brenthunter', raiderIoVerified: true },
    { region: REGION, realm: 'azjol-nerub', name: 'Wclonlyalt', raiderIoVerified: false },
  ]);

  console.log(
    renderFoundCharacters(
      getFindings(jobId),
      'Brentpriest',
      REGION,
      undefined,
      getUnverifiedLinkedKeys(jobId),
    )[0],
  );
  console.log(
    `\n(unlinked because Raider.IO could not resolve them: ${JSON.stringify([...getUnverifiedLinkedKeys(jobId)])})`,
  );
}

// ── 4. The rescue path's effect on the job row ─────────────────────────────────
heading('4. Rescue — an idle job gains a primary and becomes due');
{
  const jobId = freshJob([]);
  const before = getJob(jobId)!;
  console.log(
    `before: status=${before.status} character_name=${JSON.stringify(before.character_name)}`,
  );

  setLinkedCharacters(jobId, [
    { region: REGION, realm: 'draenor', name: 'Brentpriest', raiderIoVerified: true },
  ]);
  setJobPrimary(jobId, { region: REGION, realm: 'draenor', name: 'Brentpriest' });
  requestTopUp(jobId);

  const after = getJob(jobId)!;
  console.log(
    `after:  status=${after.status} character_name=${JSON.stringify(after.character_name)}`,
  );
  console.log(
    `linked: ${getLinkedCharacters(jobId)
      .map((c) => `${c.name}-${c.realm}`)
      .join(', ')}`,
  );

  // Proves provenance: a rescued primary must NOT be labelled self-declared.
  addFinding(jobId, finding({ name: 'Brentpriest', realm: 'draenor', source: 'linked' }));
  console.log(`\n${renderFoundCharacters(getFindings(jobId), 'Brentpriest', REGION)[0]}`);
}

closeDatabase();
console.log('');
