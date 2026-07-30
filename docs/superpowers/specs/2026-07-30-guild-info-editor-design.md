# Guild Info Editor — Design

**Date:** 2026-07-30  
**Status:** Approved

## Summary

Add an administrator/officer-only `/editguildinfo` command for editing every
currently seeded Guild Info value through prefilled Discord modals. Saving an
edit updates only the corresponding existing Guild Info message in place.

Change `/guildinfo` from a destructive rebuild to an in-place refresh by
default. Its optional `force:true` option deletes and recreates only the four
bot-managed Guild Info messages.

## Goals

- Edit the existing About Us, schedule, recruitment, link-button, and
  achievements-heading data without direct database access.
- Preserve Discord Markdown in editable text and keep `{{OVERLORDS}}` as the
  recruitment contact placeholder.
- Preserve each managed message's ID and position during normal refreshes.
- Recover automatically when a tracked message has been deleted or its ID is
  stale.
- Ensure a forced rebuild never deletes unrelated messages from the
  Guild Info channel.

## Non-goals

- Adding, removing, or reordering schedule days, recruitment sections, or
  link buttons. The command edits only the entries seeded today.
- Changing the visual layout or wording of the embeds beyond the values an
  administrator supplies.
- Adding a database migration: `guild_info_messages` already stores the
  necessary message IDs.

## Command interface

Keep the existing `/guildinfo` command and add:

| Command | Modal fields | Refresh target |
| --- | --- | --- |
| `/editguildinfo about` | title, body | About Us |
| `/editguildinfo schedule-config` | title, timezone | Schedule |
| `/editguildinfo schedule-day day:<Wednesday|Sunday>` | day label, time | Schedule |
| `/editguildinfo recruitment section:<Who|Want|Give|Contact>` | section heading, body | Recruitment |
| `/editguildinfo link link:<RaiderIO|WoWProgress|Warcraft Logs>` | label, URL | About Us |
| `/editguildinfo achievements` | heading | Achievements |

Each command opens a modal prefilled from the relevant current database row.
Its submission updates only that row, then refreshes only the target listed
above. The selection values map to stable seeded keys/records instead of
display text supplied by the user.

`/guildinfo` accepts an optional boolean `force`:

- omitted or `false`: refresh all four managed messages in place;
- `true`: delete and recreate the four managed messages.

Both commands use the current protection: Discord's Administrator default
member permission plus the runtime `requireOfficer()` guard. Modal submissions
repeat that guard before making changes.

## Architecture and data flow

Create a shared managed-message helper for `aboutus`, `schedule`,
`recruitment`, and `achievements`.

1. A renderer creates the Discord payload for a key.
2. The helper reads that key's `message_id` from `guild_info_messages`.
3. If the message can be fetched, the helper edits it in place.
4. If the ID is absent, stale, or its message is unavailable, the helper sends
   a replacement and upserts the new ID.

About Us, Schedule, and Recruitment adopt this helper. Achievements' existing
in-place update behavior is brought under the same contract without changing
its image-rendering pipeline.

Normal `/guildinfo` calls all four renderers in update-in-place mode.
`/guildinfo force:true` resolves and deletes only the messages listed in
`guild_info_messages` for the four managed keys, removes those rows, then runs
the same four renderers. It does not scan or delete other channel messages.

`/editguildinfo` writes through small database functions, then calls one
renderer. The command layer is responsible only for slash options, opening
modals, and parsing modal submissions; database mutation, rendering, and
message lifecycle remain separate, testable units.

## Validation and error handling

- Use parameterized SQLite statements for all edits.
- Validate link URLs before persisting or constructing Discord link buttons.
- Reject missing selected seed records rather than creating unexpected rows.
- Preserve Discord Markdown as entered; only the existing renderer replaces
  the first `{{OVERLORDS}}` token with current officer mentions.
- Report validation, permission, database, and Discord API failures
  ephemerally and log operational failures.
- If persistence succeeds but the Discord refresh fails, retain the saved
  value, clearly report that the display was not refreshed, and allow a later
  `/guildinfo` retry. A remote Discord edit cannot participate in the SQLite
  transaction.

## Testing

- Normal `/guildinfo` edits all four tracked messages and leaves unrelated
  Guild Info channel messages intact.
- `force:true` deletes and recreates only the four tracked messages.
- Missing or stale IDs cause a replacement to be posted and the stored ID to
  be repaired.
- Each editor route opens a correctly prefilled modal, updates its intended
  database row, and invokes only its affected renderer.
- Permission checks apply to both command invocation and modal submission.
- Invalid URLs and missing seed records fail without corrupting stored data.
- Existing guild-info refresh behavior and achievements attachment behavior
  remain covered by E2E tests.

## Decisions log

- Use a separate `/editguildinfo` command to preserve `/guildinfo` backward
  compatibility (user choice).
- Use prefilled modals for long text and options for selecting seeded entries
  (user choice).
- Refresh only the affected message after an edit, in place (user choice).
- Allow editing only existing seeded entries for now (user choice).
- Change the default `/guildinfo` behavior to in-place refresh and expose the
  rebuild as `force:true` (user choice).
- Forced refresh deletes only the four managed messages, never the whole
  channel (user choice).
