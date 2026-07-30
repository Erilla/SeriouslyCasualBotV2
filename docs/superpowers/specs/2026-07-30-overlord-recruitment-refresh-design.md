# Overlord Recruitment Refresh — Design

**Date:** 2026-07-30  
**Status:** Approved

## Summary

Refresh the existing Recruitment Guild Info message whenever an officer adds
or removes an Overlord with `/raiders`. The refresh updates the message in
place, so its `{{OVERLORDS}}` placeholder immediately reflects the current
database list.

## Design

Keep `src/functions/raids/overlords.ts` database-only. The `/raiders`
command remains the orchestrator:

1. Perform the existing Overlord insert or delete.
2. On success, call `updateRecruitment(interaction.client)`.
3. Audit and reply with the normal success message after the refresh succeeds.

The existing `updateRecruitment` lifecycle already edits the tracked
Recruitment message in place and creates a replacement only when its stored
message ID is absent or stale.

## Failure behavior

If the database mutation fails, do not refresh Recruitment. If it succeeds
but the Discord refresh fails, retain the persisted Overlord change, log the
error, audit the completed change, and return an ephemeral message explaining
that Recruitment was not refreshed and `/guildinfo` can retry it. Do not roll
back the database mutation: Discord updates cannot be made transactional with
SQLite.

## Testing

Add focused `/raiders` command tests covering:

- successful add and remove each call `updateRecruitment` with the
  interaction client;
- a successful mutation followed by refresh rejection keeps the mutation and
  reports the refresh failure;
- a mutation failure does not call `updateRecruitment`.

## Non-goals

- Refreshing other Guild Info messages.
- Moving Discord behavior into the database-only Overlord functions.
- Adding an event bus or schema migration.
