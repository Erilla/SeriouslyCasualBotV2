import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { ButtonHandler } from './registry.js';
import { getDatabase } from '../database/db.js';
import { updateLootResponse } from '../functions/loot/updateLootResponse.js';
import { generateLootPost } from '../functions/loot/generateLootPost.js';
import type { LootPostRow, LootResponseRow, RaiderRow } from '../types/index.js';

async function handleLoot(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId format: loot:{responseType}:{bossId}
  // params = [responseType, bossIdStr]
  const responseType = params[0];
  const bossId = parseInt(params[1], 10);

  const db = getDatabase();
  const raider = db
    .prepare('SELECT * FROM raiders WHERE discord_user_id = ?')
    .get(interaction.user.id) as RaiderRow | undefined;

  if (!raider) {
    await interaction.reply({
      content: 'Could not find a character linked to your Discord account. Please contact an officer!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await updateLootResponse(interaction.client, responseType, bossId, interaction.user.id);

  const lootPost = db
    .prepare('SELECT * FROM loot_posts WHERE boss_id = ?')
    .get(bossId) as LootPostRow | undefined;

  if (lootPost) {
    const responses = db
      .prepare('SELECT * FROM loot_responses WHERE loot_post_id = ?')
      .all(lootPost.id) as LootResponseRow[];

    const raiders = db
      .prepare('SELECT * FROM raiders WHERE discord_user_id IS NOT NULL')
      .all() as RaiderRow[];

    const userToCharacter = new Map<string, string>();
    for (const r of raiders) {
      if (r.discord_user_id && !userToCharacter.has(r.discord_user_id)) {
        userToCharacter.set(r.discord_user_id, r.character_name);
      }
    }

    const grouped: Record<string, string[]> = {
      major: [],
      minor: [],
      wantIn: [],
      wantOut: [],
    };

    for (const response of responses) {
      const charName = userToCharacter.get(response.user_id) ?? 'Unknown';
      if (grouped[response.response_type]) {
        grouped[response.response_type].push(charName);
      }
    }

    const playerResponses = {
      major: grouped.major.length > 0 ? grouped.major.join('\n') : '*None*',
      minor: grouped.minor.length > 0 ? grouped.minor.join('\n') : '*None*',
      wantIn: grouped.wantIn.length > 0 ? grouped.wantIn.join('\n') : '*None*',
      wantOut: grouped.wantOut.length > 0 ? grouped.wantOut.join('\n') : '*None*',
    };

    const postData = generateLootPost(lootPost.boss_name, bossId, playerResponses);
    await interaction.update(postData);
  }
}

export const buttons: ButtonHandler[] = [
  { prefix: 'loot', handle: handleLoot },
];
