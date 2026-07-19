# Detailed bot-audit log messages — Design

**Date:** 2026-07-19
**Status:** Approved

## Problem

`audit(officer, action, detail)` (`src/services/auditLog.ts`) renders
`**{officer}** {action}: {detail}` and sends it to the audit channel with no
`allowedMentions`. Several entity-related call sites pass a thin `detail`, so the
log fails to say *who* the action was about or link to the relevant user/post:

- Closing a trial via the review-thread button logs only `#3` — no character name.
  (The command path already logs the character name, so button vs. command is
  inconsistent.)
- Rejecting an application logs only the bare character name — no link to the
  applicant or the forum post.

## Goals

- Entity actions (trials, applications, raider links, overlords) log a
  human-readable identifier plus clickable links to the Discord user and the
  related post/thread where the data exists.
- Links must **not** ping anyone — `<@id>` should render as a clickable name chip
  without sending a notification.

## Non-goals

- Config-type actions (log level, settings toggles, channel/role setup, guild
  info refresh, V1 migration) stay as-is — already self-explanatory.
- Ignored-character logs stay name-only — there is no Discord user or post to
  link to.

## Design

### 1. Suppress pings in `audit()`

Add `allowedMentions: { parse: [] }` to the `auditChannel.send(...)` call in
`audit()`. `<@id>` still renders as a clickable name chip but never notifies, so
overlords and applicants are linked, not pinged. `alertOfficers()` is untouched —
it keeps its intentional officer-role ping via its own `allowedMentions`.

### 2. New pure formatter module `src/services/auditRefs.ts`

Pure functions, no Discord/DB dependencies, unit-testable in isolation:

- `trialRef(trial)` → `**{character_name}** (#{id})`, appending
  ` — <#{thread_id}>` when `thread_id` is set.
- `applicationRef(app)` → `**{character_name}** (<@{applicant_user_id}>)`,
  appending ` — <#{forum_post_id ?? thread_id}>` when present. Falls back to
  `Unknown` when `character_name` is null.
- `dateRef(date)` → renders a `YYYY-MM-DD` string as a Discord long-date
  timestamp `<t:{unix}:D>` (static full date, localised to each viewer — e.g.
  "20 April 2026"; **not** the dynamic relative `:R` style). Falls back to the
  raw string if `Date.parse` yields `NaN`.

Types are accepted as `Pick<...>` of the relevant row so callers can pass either a
DB row or an ad-hoc object (accept flow constructs the character name locally).

### 3. Enriched call sites (entity actions only)

| Site | Before | After |
|---|---|---|
| `interactions/trial.ts` extend / markPromote / close | `#{id}` | fetch row → `trialRef(trial)` |
| `interactions/trial.ts` modalUpdate | `Name (#id)` | `trialRef(trial)` |
| `interactions/trial.ts` modalCreate | `Name as Role (#id)` | `` **Name** (#id) as `Role` — <#thread> `` |
| `commands/trials.ts` remove_trial | `Name (#id)` | `trialRef(trial)` |
| `commands/trials.ts` change_trial_info | `Name (#id): name=…, role=…, start_date=…` | `` trialRef(trial): name=…, role=`…`, start_date=<t:…:D> `` |
| `functions/applications/rejectApplication.ts` | `characterName` | `applicationRef(application)` |
| `functions/applications/acceptApplication.ts` | `Name as Role starting Date` | `` applicationRef(app) as `Role` starting <t:…:D> `` |
| `commands/raiders.ts` linked raider | `Name -> user.tag` | `Name → <@userId>` |
| `commands/raiders.ts` add_overlord | `Name (user.tag)` | `Name (<@userId>)` |
| `commands/raiders.ts` remove_overlord | `Name` | `Name (<@userId>)` — look up `user_id` before removal |

The three `trial.ts` button handlers (extend / markPromote / close) currently hold
only `trialId`, so each gains a small `SELECT * FROM trials WHERE id = ?` fetch of
the row (mirroring the existing `updateInfo` handler) to obtain `character_name`
and `thread_id`.

### Left unchanged

- Ignored-character logs (`raiders.ts` ignore/remove_ignore, `raider.ts` ignore)
  — name only; nothing to link.
- `raider.ts` confirmLink / selectUser — already use `<@userId>`; they now benefit
  from the ping suppression in (1) for free.
- All config-type actions.

### Example results

```
Splo closed trial: **Sploboss** (#3) — <#123456789>
Splo rejected application: **Sploboss** (<@456…>) — <#789…>
Splo accepted application: **Sploboss** (<@456…>) as `Healer` starting <t:1776…:D>
```

## Testing

TDD:

- New `tests/unit/auditRefs.test.ts`:
  - `trialRef` with and without `thread_id`.
  - `applicationRef` with `forum_post_id`, with only `thread_id`, with neither,
    and with null `character_name`.
  - `dateRef` for a valid `YYYY-MM-DD` (asserts `<t:UNIX:D>` with correct unix
    seconds) and an unparseable string (returns input unchanged).
- Extend an audit-send test to assert `audit()` calls `send` with
  `allowedMentions: { parse: [] }`.
