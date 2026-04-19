import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer } from '../utils.js';
import { audit } from '../services/auditLog.js';
import { logger } from '../services/logger.js';
import { getDatabase } from '../database/db.js';

// Scheduled / background handlers we want manual triggers for (#35).
import { syncRaiders } from '../functions/raids/syncRaiders.js';
import { refreshLinkingMessages } from '../functions/raids/refreshLinkingMessages.js';
import { alertSignups } from '../functions/raids/alertSignups.js';
import { alertHighestMythicPlusDone } from '../functions/raids/alertHighestMythicPlusDone.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';
import { updateAboutUs } from '../functions/guild-info/updateAboutUs.js';
import { updateSchedule } from '../functions/guild-info/updateSchedule.js';
import { updateRecruitment } from '../functions/guild-info/updateRecruitment.js';
import { updateTrialLogs } from '../functions/trial-review/updateTrialLogs.js';
import { rescheduleAllAlerts, fireTrialAlertsNow } from '../functions/trial-review/scheduleTrialAlerts.js';
import { resumeSessions } from '../functions/applications/resumeSessions.js';
import { dailyBackup } from '../functions/backups/dailyBackup.js';
import { deployCommands } from '../deploy-commands.js';
import { checkRaidExpansions } from '../functions/loot/checkRaidExpansions.js';

// External service probes (no side effects — used to verify credentials/endpoints).
import { getUpcomingRaids } from '../services/wowaudit.js';
import { getGuildRoster } from '../services/raiderio.js';
import { getTrialLogs } from '../services/warcraftlogs.js';

interface TriggerDef {
  label: string;
  description: string;
  // Returns a one-line status suffix (optional detail). Errors thrown here are
  // caught by the command wrapper and reported to the invoker.
  handler: (client: Client) => Promise<string | void>;
}

// The `value` is the choice key Discord sends back to us.
// Keep under 25 (Discord's hard limit on choice count per option).
const TRIGGERS: Record<string, TriggerDef> = {
  // ─── Scheduled intervals ───────────────────────────────────
  syncRaiders: {
    label: 'Interval: syncRaiders (10 min)',
    description: 'Full roster sync from wowaudit into the raiders table.',
    handler: async (client) => { await syncRaiders(client); },
  },
  refreshLinkingMessages: {
    label: 'Interval: refreshLinkingMessages (10 min)',
    description: 'Re-post stale linking messages in #raider-setup.',
    handler: async (client) => { await refreshLinkingMessages(client); },
  },
  updateAchievements: {
    label: 'Interval: updateAchievements (30 min)',
    description: 'Recompute and re-post the achievements embed.',
    handler: async (client) => { await updateAchievements(client); },
  },
  updateTrialLogs: {
    label: 'Interval: updateTrialLogs (1 hour)',
    description: 'Regenerate logs for each active trial thread.',
    handler: async (client) => { await updateTrialLogs(client); },
  },

  // ─── Scheduled crons ───────────────────────────────────────
  alertSignups: {
    label: 'Cron: alertSignups (Mon/Tue/Fri/Sat 19:00)',
    description: 'Ping raiders who haven\'t signed up yet for the next raid.',
    handler: async (client) => { await alertSignups(client); },
  },
  weeklyReports: {
    label: 'Cron: weeklyReports (Wed 12:00)',
    description: 'Post the weekly M+ / Great Vault report.',
    handler: async (client) => { await alertHighestMythicPlusDone(client); },
  },
  dailyBackup: {
    label: 'Cron: dailyBackup (daily 04:00)',
    description: 'Snapshot the SQLite DB to the backups folder.',
    handler: async () => { await dailyBackup(); },
  },

  // ─── Dynamic / startup work ────────────────────────────────
  rescheduleAllAlerts: {
    label: 'Startup: rescheduleAllAlerts',
    // rescheduleAllAlerts is synchronous but kicks off past-due alert fires
    // in the background via void fireAlert(...). Flag that in the reply so
    // the reported duration isn't mistaken for actual work done.
    description: 'Rebuild in-memory timers for pending trial alerts. Past-due alerts fire asynchronously — the reported duration covers scheduling only.',
    handler: async (client) => {
      rescheduleAllAlerts(client);
      return 'timers rebuilt; any past-due alerts are firing in the background';
    },
  },
  resumeSessions: {
    label: 'Startup: resumeSessions',
    description: 'Re-enter DM questionnaire state for in-progress applications.',
    handler: async (client) => { await resumeSessions(client); },
  },
  deployCommands: {
    label: 'Startup: deployCommands',
    description: 'Re-register all slash commands with Discord.',
    handler: async () => { await deployCommands(); },
  },

  // ─── Guild info (individual updaters, complement /guildinfo) ──
  updateAboutUs: {
    label: 'Guild info: updateAboutUs',
    description: 'Post / refresh the About Us embed only.',
    handler: async (client) => { await updateAboutUs(client); },
  },
  updateSchedule: {
    label: 'Guild info: updateSchedule',
    description: 'Post / refresh the Schedule embed only.',
    handler: async (client) => { await updateSchedule(client); },
  },
  updateRecruitment: {
    label: 'Guild info: updateRecruitment',
    description: 'Post / refresh the Recruitment embed only.',
    handler: async (client) => { await updateRecruitment(client); },
  },

  // ─── Loot maintenance ──────────────────────────────────────
  checkRaidExpansions: {
    label: 'Loot: checkRaidExpansions',
    description: 'Ensure a loot post exists for every boss of the current tier.',
    handler: async (client) => { await checkRaidExpansions(client); },
  },

  // ─── External service probes ───────────────────────────────
  wowauditPing: {
    label: 'Probe: wowaudit',
    description: 'Fetch upcoming raids from wowaudit to verify credentials/endpoint.',
    handler: async () => {
      const raids = await getUpcomingRaids();
      return `ok (${raids.length} upcoming raid(s))`;
    },
  },
  raiderioPing: {
    label: 'Probe: raiderio',
    description: 'Fetch the guild roster from raider.io to verify endpoint.',
    handler: async () => {
      const roster = await getGuildRoster();
      return `ok (${roster.length} member(s))`;
    },
  },
  warcraftlogsPing: {
    label: 'Probe: warcraftlogs',
    description: 'Fetch logs for an existing raider to verify credentials/endpoint. Requires at least one raider in the DB.',
    handler: async () => {
      const db = getDatabase();
      const row = db
        .prepare(`SELECT character_name FROM raiders LIMIT 1`)
        .get() as { character_name: string } | undefined;
      if (!row) {
        // Probing with a fabricated name exercises auth but floods logs with
        // "character not found" noise. Surface the empty state instead.
        throw new Error('No raiders in DB to probe with — seed one first');
      }
      const logs = await getTrialLogs(row.character_name);
      return `ok (${logs.length} report(s) for ${row.character_name})`;
    },
  },
};

// Build the choice list with graceful degradation. Each TRIGGERS entry must
// satisfy Discord's constraints: name ≤ 100 chars, names unique, and ≤ 25
// choices total. Previously the module threw on a violation, which crashed
// the whole bot on startup for a single bad trigger. Now we warn and skip
// the offending entry so the rest of the command still registers. Developers
// see the warn and fix the TRIGGERS map; users see the still-working command.
const TRIGGER_CHOICES: { name: string; value: string }[] = [];
{
  const seenNames = new Set<string>();
  for (const [key, def] of Object.entries(TRIGGERS)) {
    if (def.label.length > 100) {
      logger.warn(
        'TestTrigger',
        `Skipping trigger "${key}": label is ${def.label.length} chars (Discord max 100). Shorten the label to register it.`,
      );
      continue;
    }
    if (seenNames.has(def.label)) {
      logger.warn(
        'TestTrigger',
        `Skipping trigger "${key}": duplicate label "${def.label}". Tighten labels in TRIGGERS.`,
      );
      continue;
    }
    if (TRIGGER_CHOICES.length >= 25) {
      logger.warn(
        'TestTrigger',
        `Skipping trigger "${key}": Discord allows max 25 choices; switch to autocomplete instead of the choice list.`,
      );
      continue;
    }
    seenNames.add(def.label);
    TRIGGER_CHOICES.push({ name: def.label, value: key });
  }
}

// Zero-width space between the three backticks neutralizes a triple-backtick
// sequence inside an error message without visually mangling it the way
// replacing with ''' does. The code block closes cleanly.
const ZWSP = '\u200B';
function sanitizeForCodeBlock(text: string): string {
  return text.replace(/```/g, `\`\`${ZWSP}\``);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(2);
  return `${s}s`;
}

export default {
  devOnly: true,
  data: new SlashCommandBuilder()
    .setName('test')
    .setDescription('Dev-only: manually trigger scheduled actions and background work')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('trigger')
        .setDescription('Fire a scheduled or background action immediately')
        .addStringOption((opt) =>
          opt
            .setName('action')
            .setDescription('The action to trigger')
            .setRequired(true)
            .addChoices(...TRIGGER_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('fire_trial_alert')
        .setDescription('Fire every pending review alert for a specific trial immediately')
        .addIntegerOption((opt) =>
          opt.setName('trial_id').setDescription('Trial ID').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List every available trigger (for discovery)'),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireOfficer(interaction))) return;

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      // Use an embed so we can keep adding triggers without bumping into
      // Discord's 2000-char message limit. Embed description caps at 4096.
      const lines = Object.values(TRIGGERS).map((t) => `- **${t.label}** — ${t.description}`);
      lines.push(
        '',
        `**/test fire_trial_alert trial_id:<n>** — fire pending review alerts for trial #n immediately.`,
      );
      let description = lines.join('\n');
      const EMBED_DESC_LIMIT = 4096;
      if (description.length > EMBED_DESC_LIMIT) {
        // Walk lines and stop before overflow; no mid-line slice possible.
        // The `action` option uses a static choice list (capped at 25), so a
        // trigger missing from this description is also missing from the
        // dropdown — point the user at the source for the full set.
        const notice = '\n\n_…list truncated; see TRIGGERS in `src/commands/test.ts` for the full set._';
        const budget = EMBED_DESC_LIMIT - notice.length;
        let truncated = '';
        for (const line of lines) {
          const candidate = truncated ? `${truncated}\n${line}` : line;
          if (candidate.length > budget) break;
          truncated = candidate;
        }
        description = truncated + notice;
      }
      const embed = new EmbedBuilder()
        .setTitle(`Available triggers (${Object.keys(TRIGGERS).length})`)
        .setDescription(description);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'trigger') {
      const action = interaction.options.getString('action', true);
      const def = TRIGGERS[action];
      if (!def) {
        await interaction.editReply({ content: `Unknown action: \`${action}\`.` });
        return;
      }

      const started = Date.now();
      try {
        const detail = await def.handler(interaction.client);
        const elapsed = formatDuration(Date.now() - started);
        const detailSuffix = typeof detail === 'string' && detail.length > 0 ? ` — ${detail}` : '';
        const message = `✓ **${def.label}** ran in ${elapsed}${detailSuffix}.`;
        logger.info('TestTrigger', `${action} ok (${elapsed})`);
        await audit(interaction.user, 'triggered test action', action);
        await interaction.editReply({ content: message });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const elapsed = formatDuration(Date.now() - started);
        logger.error('TestTrigger', `${action} failed after ${elapsed}: ${error.message}`, error);
        await interaction.editReply({
          content: `✗ **${def.label}** failed after ${elapsed}.\n\`\`\`\n${sanitizeForCodeBlock(error.message).slice(0, 1500)}\n\`\`\``,
        });
      }
      return;
    }

    if (sub === 'fire_trial_alert') {
      const trialId = interaction.options.getInteger('trial_id', true);
      const db = getDatabase();
      const trial = db
        .prepare(`SELECT id, character_name, status FROM trials WHERE id = ?`)
        .get(trialId) as { id: number; character_name: string; status: string } | undefined;
      if (!trial) {
        await interaction.editReply({ content: `No trial with id \`${trialId}\`.` });
        return;
      }

      const started = Date.now();
      try {
        const result = await fireTrialAlertsNow(interaction.client, trialId);
        const elapsed = formatDuration(Date.now() - started);
        await audit(interaction.user, 'fired trial alerts', `#${trialId} (${trial.character_name})`);
        const parts = [
          `✓ Fired **${result.fired}** pending alert(s) for trial #${trialId} (${trial.character_name}) in ${elapsed}.`,
        ];
        if (result.alreadyFired > 0) {
          parts.push(`_${result.alreadyFired} alert(s) had already fired previously and were not re-sent._`);
        }
        if (trial.status !== 'active') {
          parts.push(`_Note: trial status is \`${trial.status}\`; fireAlert short-circuits for non-active trials, so most alerts were likely no-ops._`);
        }
        await interaction.editReply({ content: parts.join('\n') });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const elapsed = formatDuration(Date.now() - started);
        logger.error('TestTrigger', `fire_trial_alert ${trialId} failed after ${elapsed}: ${error.message}`, error);
        await interaction.editReply({
          content: `✗ fire_trial_alert #${trialId} failed after ${elapsed}.\n\`\`\`\n${sanitizeForCodeBlock(error.message).slice(0, 1500)}\n\`\`\``,
        });
      }
      return;
    }
  },
};
