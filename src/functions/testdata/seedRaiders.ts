import type Database from 'better-sqlite3';

interface MockRaider {
  character_name: string;
  realm: string;
  region: string;
  rank: number;
  class: string;
}

const MOCK_RAIDERS: MockRaider[] = [
  { character_name: 'Azerothian',    realm: 'silvermoon',    region: 'eu', rank: 1, class: 'Warrior'      },
  { character_name: 'Brightmane',    realm: 'silvermoon',    region: 'eu', rank: 2, class: 'Paladin'      },
  { character_name: 'Coldwhisper',   realm: 'silvermoon',    region: 'eu', rank: 3, class: 'Hunter'       },
  { character_name: 'Duskweaver',    realm: 'argent-dawn',   region: 'eu', rank: 3, class: 'Rogue'        },
  { character_name: 'Emberstrike',   realm: 'argent-dawn',   region: 'eu', rank: 3, class: 'Priest'       },
  { character_name: 'Frostmantle',   realm: 'stormscale',    region: 'eu', rank: 3, class: 'Death Knight' },
  { character_name: 'Galehowl',      realm: 'stormscale',    region: 'eu', rank: 3, class: 'Shaman'       },
  { character_name: 'Hollowsong',    realm: 'ravencrest',    region: 'eu', rank: 3, class: 'Mage'         },
  { character_name: 'Ironveil',      realm: 'ravencrest',    region: 'eu', rank: 3, class: 'Warlock'      },
  { character_name: 'Jadestrike',    realm: 'silvermoon',    region: 'eu', rank: 3, class: 'Monk'         },
  { character_name: 'Kael\'threx',   realm: 'silvermoon',    region: 'eu', rank: 3, class: 'Druid'        },
  { character_name: 'Lunéshadow',    realm: 'argent-dawn',   region: 'eu', rank: 3, class: 'Demon Hunter' },
  { character_name: 'Moonsváler',    realm: 'stormscale',    region: 'eu', rank: 3, class: 'Evoker'       },
  { character_name: 'Nightshiver',   realm: 'silvermoon',    region: 'eu', rank: 4, class: 'Warrior'      },
  { character_name: 'Oathbinder',    realm: 'silvermoon',    region: 'eu', rank: 4, class: 'Paladin'      },
];

/**
 * Seed the raiders table with 15 mock raiders.
 * Idempotent: uses INSERT OR IGNORE so re-running is safe.
 */
export function seedRaiders(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO raiders (character_name, realm, region, rank, class)
    VALUES (@character_name, @realm, @region, @rank, @class)
  `);

  const insertMany = db.transaction((raiders: MockRaider[]) => {
    for (const raider of raiders) {
      insert.run(raider);
    }
  });

  insertMany(MOCK_RAIDERS);
}
