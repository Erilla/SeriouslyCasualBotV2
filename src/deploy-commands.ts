import { REST, Routes } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';
import type { Command } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function deployCommands(): Promise<void> {
    const commands: ReturnType<Command['data']['toJSON']>[] = [];
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js') || f.endsWith('.ts'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const fileUrl = pathToFileURL(filePath).href;
        const mod = await import(fileUrl);
        const command = mod.default as Command;

        if (command?.data?.name) {
            if (command.testOnly && config.nodeEnv === 'production') {
                console.log(`Skipping test-only command: /${command.data.name}`);
                continue;
            }
            commands.push(command.data.toJSON());
            console.log(`Loaded command: /${command.data.name}`);
        } else {
            console.warn(`Skipping ${file}: missing data or name`);
        }
    }

    const rest = new REST({ version: '10' }).setToken(config.token);

    console.log(`\nRegistering ${commands.length} commands to guild ${config.guildId}...`);

    const data = await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: commands }
    );

    console.log(`Successfully registered ${(data as unknown[]).length} commands.`);
}

deployCommands().catch(console.error);
