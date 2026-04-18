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

const EXPECTED_CHANNEL_TYPE: Record<string, ChannelType> = {
  guild_info_channel_id: ChannelType.GuildText,
  bot_logs_channel_id: ChannelType.GuildText,
  bot_audit_channel_id: ChannelType.GuildText,
  raider_setup_channel_id: ChannelType.GuildText,
  weekly_check_channel_id: ChannelType.GuildText,
  epgp_rankings_channel_id: ChannelType.GuildText,
  loot_channel_id: ChannelType.GuildText,
  raiders_lounge_channel_id: ChannelType.GuildText,
  application_log_forum_id: ChannelType.GuildForum,
  trial_reviews_forum_id: ChannelType.GuildForum,
  applications_category_id: ChannelType.GuildCategory,
};

const CHANNEL_TYPE_LABEL: Record<number, string> = {
  [ChannelType.GuildText]: 'text channel',
  [ChannelType.GuildForum]: 'forum channel',
  [ChannelType.GuildCategory]: 'category',
};

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
            .addChoices(
              { name: 'Guild Info', value: 'guild_info_channel_id' },
              { name: 'Bot Logs', value: 'bot_logs_channel_id' },
              { name: 'Bot Audit', value: 'bot_audit_channel_id' },
              { name: 'Raider Setup', value: 'raider_setup_channel_id' },
              { name: 'Weekly Check', value: 'weekly_check_channel_id' },
              { name: 'EPGP Rankings', value: 'epgp_rankings_channel_id' },
              { name: 'Loot', value: 'loot_channel_id' },
              { name: 'Raiders Lounge', value: 'raiders_lounge_channel_id' },
              { name: 'Application Log Forum', value: 'application_log_forum_id' },
              { name: 'Trial Reviews Forum', value: 'trial_reviews_forum_id' },
              { name: 'Applications Category', value: 'applications_category_id' },
            ),
        )
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The channel')
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildForum,
              ChannelType.GuildCategory,
            ),
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

      const expectedType = EXPECTED_CHANNEL_TYPE[key];
      if (channel.type !== expectedType) {
        await interaction.reply({
          content: `**${key}** must be a ${CHANNEL_TYPE_LABEL[expectedType]}, but ${channel} is a ${CHANNEL_TYPE_LABEL[channel.type] ?? 'different channel type'}.`,
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
