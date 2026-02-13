# Creating Commands

## File pattern
Commands live in `src/commands/` and export a default `Command` object:
```ts
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { Command } from '../types/index.js';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('mycommand')
        .setDescription('Does something'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.reply({ content: 'Done!', flags: MessageFlags.Ephemeral });
    },
};

export default command;
```

Commands are auto-loaded from `src/commands/` at startup and auto-registered with Discord in `ready.ts`.

## Key patterns

### Ephemeral replies
Use `flags: MessageFlags.Ephemeral` (NOT `ephemeral: true` which is deprecated):
```ts
await interaction.reply({ content: 'Only you can see this', flags: MessageFlags.Ephemeral });
```

When storing reply objects in variables, use `as const` to avoid type widening:
```ts
const reply = { content: 'Error', flags: MessageFlags.Ephemeral } as const;
```

### Admin-only commands
Two layers of protection:
1. Builder level (hides from non-admins in Discord UI):
```ts
.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
```
2. Runtime check (defense in depth):
```ts
import { requireAdmin } from '../utils/permissions.js';
if (!(await requireAdmin(interaction))) return;
```

### Subcommands
```ts
data: new SlashCommandBuilder()
    .setName('mycommand')
    .setDescription('...')
    .addSubcommand(sub => sub.setName('action').setDescription('...'))
```
Then in execute: `interaction.options.getSubcommand()`

### Getting channel config
```ts
import { getChannel } from '../functions/setup/getChannel.js';
const channelId = getChannel('guild_info'); // returns string | null
```
Always handle null (channel not configured) gracefully.

## Setup config keys
- Channels: guild_info, applications_category, applications_forum, trial_review_forum, raiders_lounge, loot, priority_loot, weekly_check, bot_setup, audit
- Roles: admin_role, raider_role

## Settings (boolean toggles)
```ts
import { getBooleanSetting } from '../functions/settings/getSetting.js';
if (!getBooleanSetting('alert_signups')) return; // feature disabled
```
