import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { getDatabase } from '../database/db.js';
import { requireOfficer } from '../utils.js';
import { audit } from '../services/auditLog.js';

type ConfigurableChannelType =
  | ChannelType.GuildText
  | ChannelType.GuildForum
  | ChannelType.GuildCategory;

const CHANNEL_CONFIG: Record<string, { label: string; type: ConfigurableChannelType }> = {
  guild_info_channel_id: { label: 'Guild Info', type: ChannelType.GuildText },
  bot_logs_channel_id: { label: 'Bot Logs', type: ChannelType.GuildText },
  bot_audit_channel_id: { label: 'Bot Audit', type: ChannelType.GuildText },
  raider_setup_channel_id: { label: 'Raider Setup', type: ChannelType.GuildText },
  weekly_check_channel_id: { label: 'Weekly Check', type: ChannelType.GuildText },
  epgp_rankings_channel_id: { label: 'EPGP Rankings', type: ChannelType.GuildText },
  loot_channel_id: { label: 'Loot', type: ChannelType.GuildText },
  raiders_lounge_channel_id: { label: 'Raiders Lounge', type: ChannelType.GuildText },
  application_log_forum_id: { label: 'Application Log Forum', type: ChannelType.GuildForum },
  trial_reviews_forum_id: { label: 'Trial Reviews Forum', type: ChannelType.GuildForum },
  applications_category_id: { label: 'Applications Category', type: ChannelType.GuildCategory },
};

const ROLE_CONFIG: Record<string, { label: string }> = {
  officer_role_id: { label: 'Officer' },
  raider_role_id: { label: 'Raider' },
};

// Build the set of keys get_config already renders explicitly once, at module
// load, rather than on every invocation.
const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(CHANNEL_CONFIG),
  ...Object.keys(ROLE_CONFIG),
]);

// Discord rejects message content over 2000 chars. get_config renders a fixed
// number of known rows plus any stale/legacy keys from the config table, so
// long values or many unknown keys can push us close. Guard with room to
// spare for the truncation notice itself.
const DISCORD_MESSAGE_LIMIT = 2000;

function channelTypeLabel(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildText: return 'text channel';
    case ChannelType.GuildForum: return 'forum channel';
    case ChannelType.GuildCategory: return 'category';
    default: return 'different channel type';
  }
}

const CHANNEL_CHOICES = Object.entries(CHANNEL_CONFIG).map(([value, { label }]) => ({
  name: label,
  value,
}));

const ALLOWED_CHANNEL_TYPES = [
  ...new Set(Object.values(CHANNEL_CONFIG).map((c) => c.type)),
];

// Discord caps slash-command choices at 25 per option. Fail fast at module load
// rather than at command registration if CHANNEL_CONFIG grows past that.
if (CHANNEL_CHOICES.length > 25) {
  throw new Error(
    `CHANNEL_CONFIG has ${CHANNEL_CHOICES.length} entries but Discord allows max 25 choices per option; switch to autocomplete.`,
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure bot channels and roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('set_channel')
        .setDescription('Set a channel for a specific purpose')
        .addStringOption((opt) =>
          opt
            .setName('key')
            .setDescription('Channel purpose')
            .setRequired(true)
            .addChoices(...CHANNEL_CHOICES),
        )
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The channel')
            .setRequired(true)
            .addChannelTypes(...ALLOWED_CHANNEL_TYPES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set_role')
        .setDescription('Set a role for a specific purpose')
        .addStringOption((opt) =>
          opt
            .setName('key')
            .setDescription('Role purpose')
            .setRequired(true)
            .addChoices(
              ...Object.entries(ROLE_CONFIG).map(([value, { label }]) => ({ name: label, value })),
            ),
        )
        .addRoleOption((opt) => opt.setName('role').setDescription('The role').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('get_config').setDescription('View all configured channels and roles')),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const db = getDatabase();
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'set_channel') {
      const key = interaction.options.getString('key', true);
      const channel = interaction.options.getChannel('channel', true);
      const expected = CHANNEL_CONFIG[key];

      // Discord validates `key` against CHANNEL_CHOICES (derived from CHANNEL_CONFIG),
      // so `expected` is structurally non-undefined. Guard anyway in case registration
      // ever drifts (e.g. partial redeploy).
      if (!expected) {
        await interaction.reply({
          content: 'Invalid configuration key.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (channel.type !== expected.type) {
        await interaction.reply({
          content: `**${expected.label}** must be a ${channelTypeLabel(expected.type)}, but ${channel} is a ${channelTypeLabel(channel.type)}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, channel.id);
      await audit(interaction.user, 'configured channel', `${key} = #${channel.name}`);
      await interaction.reply({ content: `Set **${key}** to ${channel}`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'set_role') {
      const key = interaction.options.getString('key', true);
      const role = interaction.options.getRole('role', true);

      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, role.id);
      await audit(interaction.user, 'configured role', `${key} = @${role.name}`);
      await interaction.reply({ content: `Set **${key}** to ${role}`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'get_config') {
      // ORDER BY key keeps the "Other (unknown keys)" section deterministic
      // when we iterate `rows` below. Known keys are rendered in CHANNEL_CONFIG
      // / ROLE_CONFIG insertion order, independent of this ordering.
      const rows = db
        .prepare('SELECT key, value FROM config ORDER BY key')
        .all() as { key: string; value: string }[];
      const byKey = new Map(rows.map((r) => [r.key, r.value]));

      const renderEntry = (key: string, label: string, mentionPrefix: '#' | '@&'): string => {
        const value = byKey.get(key);
        return value
          ? `- **${label}** (${key}): <${mentionPrefix}${value}>`
          : `- **${label}** (${key}): *(not set)*`;
      };

      const channelLines = Object.entries(CHANNEL_CONFIG).map(([k, { label }]) => renderEntry(k, label, '#'));
      const roleLines = Object.entries(ROLE_CONFIG).map(([k, { label }]) => renderEntry(k, label, '@&'));
      const unknownLines = rows
        .filter((r) => !KNOWN_CONFIG_KEYS.has(r.key))
        .map((r) => `- **${r.key}**: \`${r.value}\``);

      const sections = [
        `**Channels**\n${channelLines.join('\n')}`,
        `**Roles**\n${roleLines.join('\n')}`,
      ];
      if (unknownLines.length > 0) {
        sections.push(`**Other (unknown keys)**\n${unknownLines.join('\n')}`);
      }

      let content = `**Bot Configuration**\n\n${sections.join('\n\n')}`;
      if (content.length > DISCORD_MESSAGE_LIMIT) {
        const truncationNotice = '\n\n_…output truncated; see \`bot_config\` table directly._';
        content = content.slice(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
      }

      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  },
};
