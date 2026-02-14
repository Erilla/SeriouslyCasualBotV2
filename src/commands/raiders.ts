import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { requireAdmin } from '../utils/permissions.js';
import { getRaidersFormatted } from '../functions/raids/getRaiders.js';
import { syncRaiders } from '../functions/raids/syncRaiders.js';
import { sendAlertForRaidersWithNoUser } from '../functions/raids/sendAlertForRaidersWithNoUser.js';
import { autoMatchRaiders } from '../functions/raids/autoMatchRaiders.js';
import { sendAutoMatchAlerts } from '../functions/raids/sendAutoMatchAlerts.js';
import { updateRaiderDiscordUser } from '../functions/raids/updateRaiderDiscordUser.js';
import {
    ignoreCharacter,
    removeIgnoredCharacter,
    getIgnoredCharactersFormatted,
} from '../functions/raids/ignoreCharacter.js';
import {
    addOverlord,
    removeOverlord,
    getOverlordsFormatted,
} from '../functions/raids/overlords.js';
import {
    getPreviousWeekMythicPlusMessage,
    getPreviousWeeklyGreatVaultMessage,
} from '../functions/raids/alertHighestMythicPlusDone.js';
import { getHistoricalData } from '../services/wowaudit.js';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('raiders')
        .setDescription('Commands surrounding raiders')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((sub) =>
            sub.setName('get_raiders')
                .setDescription('Returns list of current raiders'),
        )
        .addSubcommand((sub) =>
            sub.setName('get_ignored_characters')
                .setDescription('Returns list of ignored characters'),
        )
        .addSubcommand((sub) =>
            sub.setName('ignore_character')
                .setDescription('Ignores character for sync raiders')
                .addStringOption((opt) =>
                    opt.setName('character_name')
                        .setDescription('Character name of the raider')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub.setName('remove_ignore_character')
                .setDescription('Remove specified ignored character')
                .addStringOption((opt) =>
                    opt.setName('character_name')
                        .setDescription('Character name of the raider')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub.setName('sync_raiders')
                .setDescription('Syncs raiders with BattleNet roster'),
        )
        .addSubcommand((sub) =>
            sub.setName('check_missing_users')
                .setDescription('Checks for raiders with missing users'),
        )
        .addSubcommand((sub) =>
            sub.setName('update_raider_user')
                .setDescription('Updates specified raiders user id')
                .addStringOption((opt) =>
                    opt.setName('character_name')
                        .setDescription('Character name of the raider')
                        .setRequired(true),
                )
                .addUserOption((opt) =>
                    opt.setName('user')
                        .setDescription('Discord user of the raider')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub.setName('previous_highest_mythicplus')
                .setDescription('Returns the highest mythic plus dungeon each raider has completed'),
        )
        .addSubcommand((sub) =>
            sub.setName('previous_great_vault')
                .setDescription('Returns the previous great vault each raider has completed'),
        )
        .addSubcommand((sub) =>
            sub.setName('add_overlord')
                .setDescription('Adds specified user as overlord')
                .addUserOption((opt) =>
                    opt.setName('user')
                        .setDescription('Discord user of the overlord')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub.setName('get_overlords')
                .setDescription('Returns list of current overlords'),
        )
        .addSubcommand((sub) =>
            sub.setName('remove_overlord')
                .setDescription('Removes specified overlord')
                .addStringOption((opt) =>
                    opt.setName('name')
                        .setDescription('Name of the overlord')
                        .setRequired(true),
                ),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!(await requireAdmin(interaction))) return;

        const sub = interaction.options.getSubcommand();

        switch (sub) {
            case 'get_raiders': {
                const list = getRaidersFormatted();
                await interaction.reply({ content: list, flags: MessageFlags.Ephemeral });
                break;
            }

            case 'get_ignored_characters': {
                const list = getIgnoredCharactersFormatted();
                await interaction.reply({ content: list, flags: MessageFlags.Ephemeral });
                break;
            }

            case 'ignore_character': {
                const name = interaction.options.getString('character_name', true);
                if (ignoreCharacter(name)) {
                    await interaction.reply({ content: `Successfully ignored character ${name}`, flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: `Error: Did not ignore character ${name}`, flags: MessageFlags.Ephemeral });
                }
                break;
            }

            case 'remove_ignore_character': {
                const name = interaction.options.getString('character_name', true);
                if (removeIgnoredCharacter(name)) {
                    await interaction.reply({ content: `Successfully removed ignored character ${name}`, flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: `Error: Did not remove ignored character ${name}`, flags: MessageFlags.Ephemeral });
                }
                break;
            }

            case 'sync_raiders': {
                await interaction.reply({ content: 'Syncing raiders...', flags: MessageFlags.Ephemeral });
                await syncRaiders(interaction.client);
                const list = getRaidersFormatted();
                await interaction.editReply({ content: list });
                break;
            }

            case 'check_missing_users': {
                await interaction.reply({ content: 'Checking missing users...', flags: MessageFlags.Ephemeral });
                const result = await autoMatchRaiders(interaction.client);
                if (result.matched.length > 0) {
                    await sendAutoMatchAlerts(interaction.client, result.matched);
                }
                if (result.unmatched.length > 0) {
                    await sendAlertForRaidersWithNoUser(interaction.client, result.unmatched);
                }
                const msg = result.matched.length > 0
                    ? `Auto-linked ${result.matched.length}, ${result.unmatched.length} need manual linking. See bot setup channel.`
                    : 'Check complete! See bot setup channel for results.';
                await interaction.editReply({ content: msg });
                break;
            }

            case 'update_raider_user': {
                const name = interaction.options.getString('character_name', true);
                const user = interaction.options.getUser('user', true);
                if (updateRaiderDiscordUser(name, user.id)) {
                    await interaction.reply({ content: `Successfully updated ${name} to ${user}`, flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: `Error: Raider ${name} not found`, flags: MessageFlags.Ephemeral });
                }
                break;
            }

            case 'previous_highest_mythicplus': {
                await interaction.reply({ content: 'Retrieving runs...' });
                const data = await getHistoricalData();
                const message = await getPreviousWeekMythicPlusMessage(data);
                await interaction.editReply(message);
                break;
            }

            case 'previous_great_vault': {
                await interaction.reply({ content: 'Retrieving runs...' });
                const data = await getHistoricalData();
                const message = await getPreviousWeeklyGreatVaultMessage(data);
                await interaction.editReply(message);
                break;
            }

            case 'add_overlord': {
                const user = interaction.options.getUser('user', true);
                const name = user.displayName;
                if (addOverlord(name, user.id)) {
                    await interaction.reply({ content: `Successfully added overlord ${user}`, flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: `Error: Did not add overlord ${user}`, flags: MessageFlags.Ephemeral });
                }
                break;
            }

            case 'get_overlords': {
                const list = getOverlordsFormatted();
                await interaction.reply({ content: list, flags: MessageFlags.Ephemeral });
                break;
            }

            case 'remove_overlord': {
                const name = interaction.options.getString('name', true);
                if (removeOverlord(name)) {
                    await interaction.reply({ content: `Successfully removed overlord ${name}`, flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: `Error: Overlord ${name} not found`, flags: MessageFlags.Ephemeral });
                }
                break;
            }
        }
    },
};

export default command;
