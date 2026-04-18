import { getE2EContext } from './bootstrap.js';

export async function verifyScaffold(): Promise<void> {
  const { guild } = getE2EContext();

  const missing: string[] = [];

  if (guild.channels.cache.filter((c) => c.isTextBased()).size === 0) {
    missing.push('text-channel');
  }

  if (missing.length > 0) {
    throw new Error(
      `Sandbox guild scaffold missing: ${missing.join(', ')}. ` +
      `See docs/superpowers/runbook/e2e-scaffold-setup.md`,
    );
  }
}
