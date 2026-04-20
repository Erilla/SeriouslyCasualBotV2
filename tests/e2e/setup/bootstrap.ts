import { Client, Collection, GatewayIntentBits, Partials, type Guild, type GuildMember } from 'discord.js';
import { loadE2EEnv } from './env.js';
import { loadCommands } from '../../../src/loadCommands.js';
import type { BotClient, Command } from '../../../src/types/index.js';

export interface E2EContext {
  client: Client;
  guild: Guild;
  tester: GuildMember;
  voterA: GuildMember;
  voterB: GuildMember;
  officer: GuildMember;
}

let context: E2EContext | null = null;

export async function bootstrapE2E(): Promise<E2EContext> {
  if (context) return context;

  const env = loadE2EEnv();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  }) as BotClient;

  // Populate client.commands the same way src/index.ts does, so handlers that
  // read interaction.client.commands (e.g. /help iterating the collection)
  // work without per-test monkey-patching.
  client.commands = new Collection<string, Command>();
  await loadCommands(client);

  const LOGIN_TIMEOUT_MS = 30_000;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Discord client failed to reach 'ready' within ${LOGIN_TIMEOUT_MS}ms`));
    }, LOGIN_TIMEOUT_MS);
    client.once('ready', () => { clearTimeout(timeout); resolve(); });
    client.once('error', (err) => { clearTimeout(timeout); reject(err); });
    client.login(env.discordToken).catch((err) => { clearTimeout(timeout); reject(err); });
  });

  const guild = await client.guilds.fetch(env.sandboxGuildId);

  // Fetch only the specific tester accounts, not the whole guild roster.
  const fetchMember = async (id: string, label: string): Promise<GuildMember> => {
    const m = await guild.members.fetch(id).catch(() => null);
    if (!m) throw new Error(`Sandbox member ${label} (${id}) not found in guild ${guild.id}`);
    return m;
  };

  context = {
    client,
    guild,
    tester: await fetchMember(env.testerPrimaryId, 'TESTER_PRIMARY'),
    voterA: await fetchMember(env.voterAId, 'VOTER_A'),
    voterB: await fetchMember(env.voterBId, 'VOTER_B'),
    officer: await fetchMember(env.officerId, 'OFFICER'),
  };
  return context;
}

export async function shutdownE2E(): Promise<void> {
  if (!context) return;
  await context.client.destroy();
  context = null;
}

export function getE2EContext(): E2EContext {
  if (!context) throw new Error('bootstrapE2E() must be called before getE2EContext()');
  return context;
}

