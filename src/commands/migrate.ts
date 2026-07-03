import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import Database from 'better-sqlite3';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDatabase } from '../database/db.js';
import { requireOfficer } from '../utils.js';
import { audit } from '../services/auditLog.js';
import { logger } from '../services/logger.js';
import { parseV1Export } from '../functions/migrate/parseV1Export.js';
import {
  importIdentityMap,
  importOverlords,
  importIgnored,
  backfillRaiderLinks,
} from '../functions/migrate/importData.js';
import { recreateLootPosts } from '../functions/migrate/recreateLootPosts.js';

const MAX_BYTES = 52_428_800; // 50 MB

export default {
  data: new SlashCommandBuilder()
    .setName('migrate')
    .setDescription('Import data from a V1 database')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addAttachmentOption((opt) =>
      opt.setName('db_file').setDescription('The V1 db.sqlite file').setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const attachment = interaction.options.getAttachment('db_file', true);

    const name = attachment.name ?? '';
    if (!/\.(sqlite|db)$/i.test(name)) {
      await interaction.reply({
        content: 'Please upload a V1 `.sqlite` (or `.db`) database file.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (attachment.size > MAX_BYTES) {
      await interaction.reply({
        content: `That file is too large (${attachment.size} bytes; limit ${MAX_BYTES}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const tempPath = join(tmpdir(), `v1-migrate-${interaction.id}.sqlite`);
    let v1Db: Database.Database | null = null;

    try {
      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      writeFileSync(tempPath, Buffer.from(await res.arrayBuffer()));

      v1Db = new Database(tempPath, { readonly: true });
      const hasKeyv = v1Db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='keyv'")
        .get();
      if (!hasKeyv) throw new Error('This does not look like a V1 database (no `keyv` table).');

      const parsed = parseV1Export(v1Db);

      const db = getDatabase();
      const dbCounts = db.transaction(() => ({
        identity: importIdentityMap(db, parsed.identityMap),
        backfilled: backfillRaiderLinks(db, parsed.identityMap),
        overlords: importOverlords(db, parsed.overlords),
        ignored: importIgnored(db, parsed.ignored),
      }))();

      const loot = await recreateLootPosts(interaction.client, parsed.lootPosts);

      const summary =
        `**V1 migration complete**\n` +
        `• Identity map: ${dbCounts.identity.inserted} added, ${dbCounts.identity.skipped} already present\n` +
        `• Existing raiders re-linked: ${dbCounts.backfilled}\n` +
        `• Overlords: ${dbCounts.overlords.inserted} added, ${dbCounts.overlords.skipped} already present\n` +
        `• Ignored characters: ${dbCounts.ignored.inserted} added, ${dbCounts.ignored.skipped} already present\n` +
        `• Loot posts: ${loot.created} created, ${loot.skipped} skipped, ${loot.failed} failed\n` +
        `_(Loot posts show real names once roster sync + identity linking has run.)_`;

      await audit(interaction.user, 'ran V1 migration', summary.replace(/\n/g, ' '));
      await interaction.editReply({ content: summary });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Migrate', 'V1 migration failed', err);
      await interaction.editReply({ content: `Migration failed: ${err.message}` });
    } finally {
      if (v1Db) {
        try { v1Db.close(); } catch { /* already closed */ }
      }
      try { unlinkSync(tempPath); } catch { /* no temp file to remove */ }
    }
  },
};
