import { getE2EContext } from './bootstrap.js';

export async function verifyScaffold(): Promise<void> {
  const { guild, tester, voterA, voterB, officer } = getE2EContext();

  const missing: string[] = [];

  for (const [label, m] of [
    ['TESTER_PRIMARY', tester],
    ['VOTER_A', voterA],
    ['VOTER_B', voterB],
    ['OFFICER', officer],
  ] as const) {
    if (!guild.members.cache.has(m.id)) {
      missing.push(`member:${label}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Sandbox guild scaffold missing: ${missing.join(', ')}. ` +
      `See docs/superpowers/runbook/e2e-scaffold-setup.md`,
    );
  }
}
