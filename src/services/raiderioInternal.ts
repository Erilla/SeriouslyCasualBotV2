import { httpRequest } from './httpClient.js';
import { logger } from './logger.js';
import type { RaiderIoCharacter } from '../functions/applications/raiderIoName.js';

/**
 * Raider.IO's *internal* API — the endpoints its own site calls. These are
 * undocumented and may change without notice, so everything here fails soft and
 * uses its own apiHealth service key: a break must never open the circuit for
 * the documented API that getGuildRoster and the achievements image depend on.
 */
const SITE = 'https://raider.io';
const SERVICE = 'raiderio-internal' as const;

/** Calling these back-to-back drops payloads silently — an unpaced sweep once
 *  lost a character's kill data and reassigned five first kills to the wrong
 *  character. Callers pace their loops by this. */
export const RAIDERIO_INTERNAL_PACE_MS = 700;

export interface CharacterOwner {
  user: string | null;
  discordProfile: string | null;
  declaredMain: RaiderIoCharacter | null;
}

interface CharacterDetailsResponse {
  characterDetails?: {
    user?: { name?: string } | null;
    characterCustomizations?: {
      isClaimed?: boolean;
      discord_profile?: string | null;
      main_character?: { name?: string; path?: string; realm?: { slug?: string } } | null;
    };
  };
}

function mainFromPath(main: {
  name?: string;
  path?: string;
  realm?: { slug?: string };
}): RaiderIoCharacter | null {
  if (!main.name) return null;
  const fromPath = main.path?.match(/\/characters\/([^/]+)\/([^/]+)\/([^/?#]+)/i);
  const region = fromPath?.[1]?.toLowerCase() ?? 'eu';
  const realm = (main.realm?.slug ?? fromPath?.[2] ?? '').toLowerCase();
  if (!realm) return null;
  return { region, realm, name: main.name };
}

export async function getCharacterOwner(c: RaiderIoCharacter): Promise<CharacterOwner | null> {
  const url = `${SITE}/api/characters/${encodeURIComponent(c.region)}/${encodeURIComponent(
    c.realm,
  )}/${encodeURIComponent(c.name)}`;
  try {
    const data = await httpRequest<CharacterDetailsResponse>(SERVICE, url);
    const details = data.characterDetails;
    if (!details) return null;
    const custom = details.characterCustomizations ?? {};
    return {
      user: details.user?.name ?? null,
      discordProfile: custom.discord_profile ?? null,
      declaredMain: custom.main_character ? mainFromPath(custom.main_character) : null,
    };
  } catch (error) {
    logger.warn('RaiderIOInternal', `Owner lookup failed for ${c.name}-${c.realm}: ${error}`);
    return null;
  }
}

export interface ClaimedCharacter {
  name: string;
  realm: string;
  className: string | null;
  level: number | null;
}

interface ViewCharactersResponse {
  viewUserCharactersApi?: {
    characters?: {
      character?: {
        name?: string;
        level?: number;
        class?: { name?: string };
        realm?: { name?: string };
      };
    }[];
  };
}

export async function getClaimedCharacters(user: string): Promise<ClaimedCharacter[]> {
  const url = `${SITE}/api/user/view-characters?name=${encodeURIComponent(user)}`;
  try {
    const data = await httpRequest<ViewCharactersResponse>(SERVICE, url);
    const list = data.viewUserCharactersApi?.characters ?? [];
    return list
      .map((entry) => entry.character)
      .filter((ch): ch is NonNullable<typeof ch> => Boolean(ch?.name && ch.realm?.name))
      .map((ch) => ({
        name: ch.name!,
        realm: ch.realm!.name!,
        className: ch.class?.name ?? null,
        level: ch.level ?? null,
      }));
  } catch (error) {
    logger.warn('RaiderIOInternal', `Claimed characters failed for "${user}": ${error}`);
    return [];
  }
}

export interface MythicKillDate {
  /** Raider.IO's boss slug, matched to a WCL encounter name by the caller. */
  bossName: string;
  firstDefeated: string;
  /** The guild this kill happened with — dated guild history, free of charge. */
  guild: { name: string; realm: string } | null;
  /**
   * Raider.IO's raid slug (`sepulcher-of-the-first-ones`). The caller needs it to
   * name a raid whose bosses predate the WCL zone catalogue's three-expansion
   * window and so can never be matched to a zone — without it each such boss
   * renders as its own one-kill "raid". Note the CURRENT tier uses an opaque code
   * (`tier-mn-1`) rather than a name, which is why the caller only falls back to
   * this after a zone match fails.
   */
  raid: string | null;
}

interface RaidProgressResponse {
  characterRaidProgress?: {
    raidProgress?: {
      raid?: string;
      encountersDefeated?: {
        mythic?: {
          slug?: string;
          firstDefeated?: string;
          guild?: { name?: string; realm?: { slug?: string; name?: string } };
        }[];
      };
    }[];
  };
}

/**
 * First-kill dates per boss across the given tier ordinals. Returns `null` when
 * ANY tier fetch fails: an empty list would read as "this character killed
 * nothing", which silently moves first-kill credit to another character.
 */
export async function getMythicKillDates(
  c: RaiderIoCharacter,
  tierOrdinals: number[],
): Promise<MythicKillDate[] | null> {
  // Keyed by boss slug, because the endpoint returns the same raid under EVERY
  // tier ordinal at or after it — verified live: `tier-mn-1`'s 9 kills came back
  // under all of tiers 35..28, and `sporefall`'s single kill under seven of them.
  // Flattening the 8 tier queries counted each kill up to 8 times, which
  // published "72 Mythic kills" for 9 real ones in the guild history. A boss has
  // exactly one first kill, so the earliest date across tiers is the right one.
  const byBoss = new Map<string, MythicKillDate>();
  for (const tier of tierOrdinals) {
    const url =
      `${SITE}/api/characters/${encodeURIComponent(c.region)}/${encodeURIComponent(c.realm)}/` +
      `${encodeURIComponent(c.name)}/raid-progress?tier=${tier}`;
    try {
      const data = await httpRequest<RaidProgressResponse>(SERVICE, url);
      for (const raid of data.characterRaidProgress?.raidProgress ?? []) {
        for (const e of raid.encountersDefeated?.mythic ?? []) {
          if (!e.slug || !e.firstDefeated) continue;
          const guildRealm = e.guild?.realm?.slug ?? e.guild?.realm?.name ?? null;
          const existing = byBoss.get(e.slug);
          if (existing && existing.firstDefeated <= e.firstDefeated) continue;
          byBoss.set(e.slug, {
            bossName: e.slug,
            firstDefeated: e.firstDefeated,
            guild: e.guild?.name && guildRealm ? { name: e.guild.name, realm: guildRealm } : null,
            raid: raid.raid ?? null,
          });
        }
      }
    } catch (error) {
      logger.warn(
        'RaiderIOInternal',
        `Kill dates unknown for ${c.name}-${c.realm} tier ${tier}: ${error}`,
      );
      return null;
    }
  }
  return [...byBoss.values()];
}
