# Trial Review Extension Labels Design

## Goal

Keep a trial review thread's final-review text accurate after one or more one-week extensions, and make the extension status visible to officers.

## Behaviour

The review schedule retains its existing two-week and four-week entries. The final review label is calculated from the persisted `6_week` alert date relative to the trial's start date:

- At six weeks: `6-week review`
- After one extension: `7-week review (1-week extension)`
- After two extensions: `8-week review (2-week extension)`

The timestamps continue to use the already persisted final-review date. The label does not require a new database column or extension counter.

## Architecture

The review-message renderer will derive total elapsed weeks and additional extension weeks from the trial start date and final-review alert date. `extendTrial` already supplies the updated persisted alert dates to that renderer, so the change is isolated to schedule-label generation.

## Testing

Regression coverage will verify the initial six-week label, one extension, and multiple extensions. Existing extension date-shifting behaviour remains unchanged.

## Error Handling

If a final-review date is missing or unparseable, existing date fallback behaviour remains in place; the renderer must not prevent an extension from completing.

