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

const CHANNEL_TYPE_LABEL: Partial<Record<ChannelType, string>> = {
  [ChannelType.GuildText]: 'text channel',
  [ChannelType.GuildForum]: 'forum channel',
  [ChannelType.GuildCategory]: 'category',
};

const CHANNEL_CHOICES = Object.entries(CHANNEL_CONFIG).map(([value, { label }]) => ({
  name: label,
  value,
}));

const ALLOWED_CHANNEL_TYPES = [
  ...new Set(Object.values(CHANNEL_CONFIG).map((c) => c.type)),
];

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
              { name: 'Officer', value: 'officer_role_id' },
              { name: 'Raider', value: 'raider_role_id' },
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

      if (channel.type !== expected.type) {
        await interaction.reply({
          content: `**${expected.label}** must be a ${CHANNEL_TYPE_LABEL[expected.type] ?? 'specified type'}, but ${channel} is a ${CHANNEL_TYPE_LABEL[channel.type] ?? 'different channel type'}.`,
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
      const rows = db.prepare('SELECT key, value FROM config ORDER BY key').all() as { key: string; value: string }[];
      const formatted = rows.length > 0
        ? rows.map((r) => `**${r.key}**: \`${r.value}\``).join('\n')
        : 'No configuration set yet.';
      await interaction.reply({ content: `**Bot Configuration:**\n${formatted}`, flags: MessageFlags.Ephemeral });
    }
  },
};
