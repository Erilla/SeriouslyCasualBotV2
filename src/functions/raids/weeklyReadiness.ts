import type { BlizzardEquipmentProfile } from '../../services/blizzard.js';
import type { MythicPlusRun } from '../../services/raiderio.js';

export type DungeonVaultChoices = [number | null, number | null, number | null];

export interface VaultOptions {
  option_1?: unknown;
  option_2?: unknown;
  option_3?: unknown;
}

export interface WeeklyReadinessRow {
  characterName: string;
  runs: MythicPlusRun[] | null;
  lastCrawledAt: string | null;
  equipment: BlizzardEquipmentProfile | null;
}

export function getDungeonVaultChoices(runs: MythicPlusRun[]): DungeonVaultChoices {
  const levels = [...runs].map((run) => run.mythic_level).sort((a, b) => b - a);
  return [levels[0] ?? null, levels[3] ?? null, levels[7] ?? null];
}

export function hasCompletedTen(runs: MythicPlusRun[]): boolean {
  return runs.some((run) => run.mythic_level >= 10);
}

export function getUnlockedChoiceCount(vaultOptions: VaultOptions | null | undefined): number {
  if (!vaultOptions) return 0;

  return ['option_1', 'option_2', 'option_3'].filter(
    (option) => vaultOptions[option as keyof VaultOptions] != null,
  ).length;
}

function formatDungeonChoices(choices: DungeonVaultChoices): string {
  return choices.map((level) => (level == null ? '-' : `+${level}`)).join(' / ');
}

// Gear progression and Needs verification are intentionally not reported. The
// enchant slot list was not expansion-accurate (BACK takes no enchant this
// expansion, so every raider was flagged for a missing one), which made both
// sections untrustworthy. The equipment and lastCrawledAt row fields are still
// populated so the checks can be restored once the slot rules are corrected.
export function buildReadinessExceptions(rows: WeeklyReadinessRow[]): string | null {
  const noCompletedTen: string[] = [];
  const dungeonVaultBelowTen: string[] = [];

  for (const row of rows) {
    if (!row.runs) continue;

    if (!hasCompletedTen(row.runs)) {
      noCompletedTen.push(row.characterName);
    }

    const choices = getDungeonVaultChoices(row.runs);
    if (choices.some((choice) => choice != null && choice < 10)) {
      dungeonVaultBelowTen.push(`${row.characterName}: ${formatDungeonChoices(choices)}`);
    }
  }

  const sections: Array<[string, string[]]> = [
    ['No completed +10', noCompletedTen],
    ['Dungeon Vault below +10', dungeonVaultBelowTen],
  ];
  const nonEmptySections = sections.filter(([, entries]) => entries.length > 0);

  if (nonEmptySections.length === 0) return null;

  return [
    '**Weekly Readiness Exceptions**',
    ...nonEmptySections.flatMap(([title, entries]) => [
      `## ${title}`,
      ...entries.map((entry) => `- ${entry}`),
    ]),
  ].join('\n');
}
