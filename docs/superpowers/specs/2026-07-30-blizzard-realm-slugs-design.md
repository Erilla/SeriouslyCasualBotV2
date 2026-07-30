# Blizzard realm slug normalization

## Goal

Make Blizzard Character Equipment Profile requests use the realm slug format
required by Blizzard, so valid raiders do not produce false `Needs
verification` results.

## Scope

`getCharacterEquipment` receives the Raider.IO realm name stored for each
raider. It will normalize that realm to a Blizzard URL slug before URL
encoding it:

- trim surrounding whitespace;
- lowercase it;
- replace one or more internal whitespace characters with `-`.

Examples: `Tarren Mill` becomes `tarren-mill`, `Twisting Nether` becomes
`twisting-nether`, and `Argent Dawn` becomes `argent-dawn`. Existing hyphens
remain unchanged. Character-name normalization remains lowercase plus URL
encoding.

## Error behavior

This change only corrects valid character paths. A genuinely missing,
transferred, or private character can still return 404 and is reported as
`Needs verification`; the circuit breaker behavior is unchanged.

## Tests

Extend the Blizzard-service request test with a realm containing spaces and a
character containing accents. The test must fail against the current
space-encoded realm path and pass only when the URL contains
`tarren-mill` and the lowercased encoded character name.

## Out of scope

The requested Great Vault column formatting and readiness-exception `.txt`
attachment are separate presentation changes and are not included in this
bug-fix branch.
