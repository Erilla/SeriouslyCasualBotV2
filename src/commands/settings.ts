import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { getDatabase } from '../database/db.js';
import { requireOfficer } from '../utils.js';
import { audit } from '../services/auditLog.js';

export default {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Manage bot settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('get_setting')
        .setDescription('View a setting value')
        .addStringOption((opt) =>
          opt
            .setName('setting_name')
            .setDescription('Setting to view')
            .setRequired(true)
            .addChoices(
              { name: 'Alert Signup Wednesday', value: 'alertSignup_Wednesday' },
              { name: 'Alert Signup Wednesday 48h', value: 'alertSignup_Wednesday_48' },
              { name: 'Alert Signup Sunday', value: 'alertSignup_Sunday' },
              { name: 'Alert Signup Sunday 48h', value: 'alertSignup_Sunday_48' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('toggle_setting')
        .setDescription('Toggle a setting on/off')
        .addStringOption((opt) =>
          opt
            .setName('setting_name')
            .setDescription('Setting to toggle')
            .setRequired(true)
            .addChoices(
              { name: 'Alert Signup Wednesday', value: 'alertSignup_Wednesday' },
              { name: 'Alert Signup Wednesday 48h', value: 'alertSignup_Wednesday_48' },
              { name: 'Alert Signup Sunday', value: 'alertSignup_Sunday' },
              { name: 'Alert Signup Sunday 48h', value: 'alertSignup_Sunday_48' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('get_all_settings').setDescription('View all settings')),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const db = getDatabase();
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'get_setting') {
      const key = interaction.options.getString('setting_name', true);
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: number } | undefined;
      const value = row?.value === 1 ? 'enabled' : 'disabled';
      await interaction.reply({ content: `**${key}** is currently **${value}**`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'toggle_setting') {
      const key = interaction.options.getString('setting_name', true);
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: number } | undefined;
      const current = row?.value ?? 0;
      const newValue = current === 1 ? 0 : 1;
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, newValue);

      const label = newValue === 1 ? 'enabled' : 'disabled';
      await audit(interaction.user, 'toggled setting', `${key}: ${label}`);
      await interaction.reply({ content: `Set **${key}** to **${label}**`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'get_all_settings') {
      const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as { key: string; value: number }[];
      const formatted = rows
        .map((r) => `**${r.key}**: ${r.value === 1 ? 'enabled' : 'disabled'}`)
        .join('\n');
      await interaction.reply({ content: `**All Settings:**\n${formatted || 'No settings found.'}`, flags: MessageFlags.Ephemeral });
    }
  },
};
