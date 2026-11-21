/**
 * SlashWho applicant-intel settings. Kept apart from config.ts, with no imports,
 * so startup validation is a pure function of the environment that a test can
 * call without satisfying every other required variable.
 */

function positiveFiniteNumber(name: string, value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a finite number greater than zero`);
  }
  return number;
}

export interface SlashWhoConfig {
  /** Selects the SlashWho applicant-intel runner. Off: the legacy sweep, unchanged. */
  intelEnabled: boolean;
  /** No trailing slash. */
  apiUrl: string;
  /** Empty only while the flag is off. */
  botApiKey: string;
  pollIntervalMs: number;
  /** Publish what exists and stop waiting after this long. */
  jobDeadlineMs: number;
  /**
   * On a SlashWho failure, run the legacy sweep for that job instead of
   * publishing "research unavailable". Off by default: the bot and SlashWho
   * share Warcraft Logs credentials, so a fallback would double-spend one budget.
   */
  fallbackSweep: boolean;
}

const MIN_SLASHWHO_POLL_INTERVAL_MS = 1000;

function booleanFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Validated SlashWho settings. Exported as a pure function of the environment
 * so startup validation can be tested without re-importing this module.
 * Throws at startup when the flag is on and the key is missing, rather than
 * letting every applicant job fail later with a 401.
 */
export function parseSlashWhoConfig(env: NodeJS.ProcessEnv): SlashWhoConfig {
  const intelEnabled = booleanFlag('SLASHWHO_INTEL_ENABLED', env.SLASHWHO_INTEL_ENABLED);
  const botApiKey = env.SLASHWHO_BOT_API_KEY?.trim() ?? '';
  if (intelEnabled && !botApiKey) {
    throw new Error(
      'SLASHWHO_INTEL_ENABLED is true but SLASHWHO_BOT_API_KEY is not set. ' +
        'Set the key, or turn the flag off to use the legacy applicant-intel sweep.',
    );
  }
  const apiUrl = (env.SLASHWHO_API_URL || 'https://slashwho.com').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(apiUrl)) {
    throw new Error('SLASHWHO_API_URL must be an http(s) URL');
  }
  const pollIntervalMs = positiveFiniteNumber(
    'SLASHWHO_POLL_INTERVAL_MS',
    env.SLASHWHO_POLL_INTERVAL_MS || '5000',
  );
  if (pollIntervalMs < MIN_SLASHWHO_POLL_INTERVAL_MS) {
    throw new Error(`SLASHWHO_POLL_INTERVAL_MS must be at least ${MIN_SLASHWHO_POLL_INTERVAL_MS}`);
  }
  return {
    intelEnabled,
    apiUrl,
    botApiKey,
    pollIntervalMs,
    jobDeadlineMs: positiveFiniteNumber(
      'SLASHWHO_JOB_DEADLINE_MS',
      env.SLASHWHO_JOB_DEADLINE_MS || '600000',
    ),
    fallbackSweep: booleanFlag('SLASHWHO_FALLBACK_SWEEP', env.SLASHWHO_FALLBACK_SWEEP),
  };
}
