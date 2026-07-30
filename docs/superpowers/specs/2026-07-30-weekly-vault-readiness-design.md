# Weekly Vault and Readiness Reports Design

## Goal

Improve the Wednesday weekly-check output so officers can see each raider's
Great Vault progress and a separate, small list of actionable readiness
exceptions. The feature informs EP decisions; it does not calculate, award, or
store EP.

## Existing reports

The scheduled job continues to post the two existing text attachments:

- `highest_mythicplus_<date>.txt`, containing every active raider's previous
  week's highest Mythic+ runs.
- `great_vaults_<date>.txt`, containing the Great Vault summary.

No activity totals, highest-key highlights, current affixes, seasonal score,
or item-level summaries are added to the channel message.

## Great Vault attachment

Each row contains the character name and three concise Vault columns:

```text
Character     Raid    Dungeon keys         World
CharacterA    3       +10 / +9 / -         3
CharacterB    3       +10 / +10 / +10      3
CharacterC    2       +9 / - / -           1
```

`Raid` and `World` are the number of unlocked choices: `1`, `2`, or `3`.

`Dungeon keys` shows the activity level determining each dungeon Vault choice.
The data source returns the prior week's ten highest Mythic+ runs. The report
sorts their levels descending and selects positions 1, 4, and 8 respectively:

- first choice: highest run, when at least one run exists;
- second choice: fourth-highest run, when at least four runs exist;
- third choice: eighth-highest run, when at least eight runs exist.

Missing choices render as `-`. A completed run counts regardless of whether it
was timed.

## Readiness exceptions message

After the attachments, post one plain Discord message only if it has at least
one exception. It contains no EP values and only these sections that have
entries:

```text
Weekly Readiness Exceptions

No completed +10
- CharacterC — highest completed key: +9
- CharacterD — no completed M+ key recorded

Dungeon Vault below +10
- CharacterA — +10 / +9 / -
- CharacterC — +9 / - / -

Gear progression
- CharacterE — missing cloak enchant
- CharacterF — missing main-hand enchant

Needs verification
- CharacterG — gear snapshot is stale
```

The first section includes each raider whose highest completed run is below
`+10`, including no recorded run. Timed status is not inspected.

The second section includes a raider when any unlocked dungeon Vault choice is
below `+10`. An unfilled choice (`-`) alone is not an exception; it is shown as
context beside an unlocked lower choice.

Gear issues distinguish a confirmed missing enhancement from data that cannot
be trusted. A stale or unavailable profile is reported only under `Needs
verification`, never as a missing gem or enchant.

## Data sources and boundaries

Raider.IO's existing character profile endpoint supplies previous-week Mythic+
runs, equipped item details, enchant data, gem data, and crawl timestamps.
It is sufficient to detect required enchantments once the required slots are
defined.

The profile data alone cannot reliably establish an empty gem socket: a piece
without a socket and a piece with an unfilled socket can both contain no gems.
A dependable missing-socket check therefore requires a character-equipment
source with socket capacity, such as Blizzard's Character Equipment Profile
API. Until that source is added, the report must not claim that a character is
missing a gem; it may report confirmed enchant gaps and stale data only.

The freshness threshold for a profile is intentionally not specified in this
design. It will be configured once the guild chooses a policy (for example, 24
or 48 hours).

## Failure handling

Existing fail-soft behavior remains: a per-raider Mythic+ lookup failure does
not prevent the other rows or the Vault attachment. A failed or stale gear
lookup creates a `Needs verification` entry rather than a failure claim.

## Tests

Unit coverage will verify:

- choice levels derived from 1st, 4th, and 8th sorted weekly runs;
- missing choices;
- an untimed `+10` qualifying for the +10 check;
- exceptions omitted when no issues exist;
- lower unlocked Dungeon choices reported;
- confirmed missing enchantments and stale-data classification; and
- gear records without socket capacity never reported as missing gems.
