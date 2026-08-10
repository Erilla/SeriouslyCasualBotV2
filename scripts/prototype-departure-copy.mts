/**
 * PROTOTYPE — throwaway. Wipe me once the copy is chosen (ticket #90, map #89).
 *
 * Question: what does the applicant-departure notification actually say?
 *
 * Neither branch of the /prototype skill fits — this is Discord message copy, not
 * a state machine to drive or a UI route to vary. So it follows the pattern this
 * repo already uses for exactly this (scripts/preview-linked-intel.mts): render
 * the real payloads offline and read them.
 *
 * No database, no Discord, no API calls. Every draft is rendered for both
 * surfaces — the application post (pings overlords) and the audit-channel mirror
 * (never pings) — and for the awkward input, an application whose character_name
 * is NULL.
 *
 * Run: npx tsx scripts/prototype-departure-copy.mts
 */
import { EmbedBuilder, Colors, type MessageCreateOptions } from 'discord.js';

// Stand-ins for real ids, so the ping shape is visible in the output.
const OVERLORD_IDS = ['111111111111111111', '222222222222222222'];
const OFFICER_ROLE_ID = '999999999999999999';

interface Departure {
  /** applications.character_name — nullable in the schema. */
  characterName: string | null;
  /** Discord tag of the member who left. */
  applicantTag: string;
  applicantUserId: string;
  applicationId: number;
}

const NORMAL: Departure = {
  characterName: 'Brentpriest',
  applicantTag: 'brent_hs',
  applicantUserId: '333333333333333333',
  applicationId: 42,
};

// A submitted application can still carry a null character_name.
const NAMELESS: Departure = {
  characterName: null,
  applicantTag: 'ghost_user',
  applicantUserId: '444444444444444444',
  applicationId: 43,
};

// Q2: fall back to the Discord tag — the one identifier that always exists.
const who = (d: Departure): string => d.characterName ?? d.applicantTag;
// Q3: mention the applicant, tagged as such. Inert: allowedMentions never lists them.
const applicant = (d: Departure): string => `<@${d.applicantUserId}> (applicant)`;

// ── Draft A — plain line, mirroring buildOverlordNotification exactly ──────────

function draftAPost(d: Departure): MessageCreateOptions {
  const mentions = OVERLORD_IDS.map((id) => `<@${id}>`).join(' ');
  return {
    content:
      `${mentions}\n**${who(d)}** ${applicant(d)} has left the server. ` +
      `Reject the application to close it off.`,
    allowedMentions: { users: OVERLORD_IDS },
  };
}

// ── Draft B — embed, so it reads as a status change rather than chatter ────────

function draftBPost(d: Departure): MessageCreateOptions {
  const mentions = OVERLORD_IDS.map((id) => `<@${id}>`).join(' ');
  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle('Applicant left the server')
    .setDescription(
      `**${who(d)}** ${applicant(d)} is no longer in the Discord.\n` +
        `Reject the application to close it off.`,
    );
  return { content: mentions, embeds: [embed], allowedMentions: { users: OVERLORD_IDS } };
}

// ── Draft C — plain, two lines, ping on its own line, no imperative ───────────

function draftCPost(d: Departure): MessageCreateOptions {
  const mentions = OVERLORD_IDS.map((id) => `<@${id}>`).join(' ');
  return {
    content:
      `${mentions}\n` +
      `**${who(d)}** ${applicant(d)} has left the Discord while this application was ` +
      `awaiting a decision.\nNothing has been changed — use **Reject** above to close it off.`,
    allowedMentions: { users: OVERLORD_IDS },
  };
}

// ── The audit mirror: same facts, no ping, one line ───────────────────────────
// Contrast with alertOfficers(), which prefixes `<@&OFFICER_ROLE_ID>`.

function auditMirror(d: Departure): MessageCreateOptions {
  return {
    content:
      `**Applicant left the server**\n` +
      `${who(d)} ${applicant(d)} — application #${d.applicationId}, user id \`${d.applicantUserId}\``,
    allowedMentions: { parse: [] },
  };
}

function auditMirrorPingingForComparison(d: Departure): MessageCreateOptions {
  return {
    content: `<@&${OFFICER_ROLE_ID}> **Applicant left the server**\n${who(d)} (${d.applicantTag})`,
    allowedMentions: { roles: [OFFICER_ROLE_ID] },
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

const rule = (label: string): void =>
  console.log(`\n${'═'.repeat(78)}\n${label}\n${'═'.repeat(78)}`);

function show(payload: MessageCreateOptions): void {
  if (payload.content) console.log(payload.content);
  for (const embed of payload.embeds ?? []) {
    const json = (embed as EmbedBuilder).toJSON();
    console.log(`  ┌─ embed ── ${json.title ?? ''}`);
    for (const line of (json.description ?? '').split('\n')) console.log(`  │ ${line}`);
    console.log(`  └─ colour: ${json.color}`);
  }
  console.log(`  » allowedMentions: ${JSON.stringify(payload.allowedMentions)}`);
}

const drafts = [
  ['Draft A — plain line, identical shape to the existing new-application ping', draftAPost],
  ['Draft B — embed, red, reads as a status change', draftBPost],
  ['Draft C — plain, explicit that nothing was changed', draftCPost],
] as const;

for (const [label, build] of drafts) {
  rule(label);
  console.log('── in the application log post ──');
  show(build(NORMAL));
  console.log('\n── same draft, application with a NULL character_name ──');
  show(build(NAMELESS));
}

rule('The audit-channel mirror (shared by every draft)');
console.log('── as settled: mirrored, but never pinging ──');
show(auditMirror(NORMAL));
console.log('\n── for contrast, what alertOfficers() would have sent ──');
show(auditMirrorPingingForComparison(NORMAL));
console.log('');
