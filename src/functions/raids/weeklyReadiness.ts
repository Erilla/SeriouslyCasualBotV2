import { config } from '../../config.js';
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

const REQUIRED_ENCHANT_SLOTS = new Set([
  'BACK',
  'CHEST',
  'WRIST',
  'WAIST',
  'LEGS',
  'FEET',
  'FINGER_1',
  'FINGER_2',
  'MAIN_HAND',
  'OFF_HAND',
]);

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

function isGearDataStale(lastCrawledAt: string | null, now: Date): boolean {
  if (!lastCrawledAt) return true;

  const crawledAt = new Date(lastCrawledAt).getTime();
  if (!Number.isFinite(crawledAt)) return true;

  return now.getTime() - crawledAt > config.weeklyGearStaleHours * 60 * 60 * 1000;
}

function formatDungeonChoices(choices: DungeonVaultChoices): string {
  return choices.map((level) => (level == null ? '-' : `+${level}`)).join(' / ');
}

function getGearGaps(equipment: BlizzardEquipmentProfile): {
  emptySocketSlots: string[];
  missingEnchantSlots: string[];
} {
  const emptySocketSlots: string[] = [];
  const missingEnchantSlots: string[] = [];

  for (const equippedItem of equipment.equipped_items) {
    const slot = equippedItem.slot.type;

    if (equippedItem.sockets?.some((socket) => !socket.item)) {
      emptySocketSlots.push(slot);
    }

    if (REQUIRED_ENCHANT_SLOTS.has(slot) && !equippedItem.enchantments?.length) {
      missingEnchantSlots.push(slot);
    }
  }

  return { emptySocketSlots, missingEnchantSlots };
}

export function buildReadinessExceptions(rows: WeeklyReadinessRow[], now: Date): string | null {
  const noCompletedTen: string[] = [];
  const dungeonVaultBelowTen: string[] = [];
  const gearProgression: string[] = [];
  const needsVerification: string[] = [];

  for (const row of rows) {
    if (row.runs && !hasCompletedTen(row.runs)) {
      noCompletedTen.push(row.characterName);
    }

    if (row.runs) {
      const choices = getDungeonVaultChoices(row.runs);
      if (choices.some((choice) => choice != null && choice < 10)) {
        dungeonVaultBelowTen.push(`${row.characterName}: ${formatDungeonChoices(choices)}`);
      }
    }

    if (!row.equipment || isGearDataStale(row.lastCrawledAt, now)) {
      needsVerification.push(row.characterName);
      continue;
    }

    const { emptySocketSlots, missingEnchantSlots } = getGearGaps(row.equipment);
    if (emptySocketSlots.length || missingEnchantSlots.length) {
      const gaps: string[] = [];
      if (emptySocketSlots.length) gaps.push(`empty socket (${emptySocketSlots.join(', ')})`);
      if (missingEnchantSlots.length)
        gaps.push(`missing enchant (${missingEnchantSlots.join(', ')})`);
      gearProgression.push(`${row.characterName}: ${gaps.join('; ')}`);
    }
  }

  const sections: Array<[string, string[]]> = [
    ['No completed +10', noCompletedTen],
    ['Dungeon Vault below +10', dungeonVaultBelowTen],
    ['Gear progression', gearProgression],
    ['Needs verification', needsVerification],
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
