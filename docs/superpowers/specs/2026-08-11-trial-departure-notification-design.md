# Trial departure notifications

**Date:** 2026-08-11
**Status:** approved, ready for implementation

Overlords are told, in a trial's review post, when the Discord user behind an **active
trial** leaves the server — the same treatment applicants received in map
[#89](https://github.com/Erilla/SeriouslyCasualBotV2/issues/89), which explicitly ruled
trials out of scope at the time.

## Why it is not simply "the same code again"

An application row knows whose account it is: `applications.applicant_user_id` is written
at submission. **A trial row does not.** `trials` holds `character_name`, `role`,
`start_date`, `thread_id`, `logs_message_id`, a nullable `application_id`, and `status` —
no Discord user anywhere. Trials also arrive by two routes: accepting an application, and
`/trials create_thread`, which asks only for a character name, a role and a start date.

So the identity has to be established before the notification can exist at all. That is
the substance of this change; the notification itself is a variation on one that works.

## Decisions

| # | Decision |
| - | -------- |
| Identity | A new `trials.discord_user_id` column. Not derived at notification time from `application_id` or `raiders` — a stored id is unambiguous, survives a character rename, and does not depend on the wowaudit sync having run. |
| Scope | `status = 'active'` only. `promoted` means they are a full raider, and a raider leaving is a different feature with a different audience; `closed` is over. |
| Trigger | The user is no longer in the guild by any means — leave, kick and ban alike. No audit-log correlation. |
| Missed events | The live `guildMemberRemove` handler **plus** the boot sweep, because every merge to `main` restarts the bot. |
| Side effects | **Notify only.** Pending `trial_alerts` and `promote_alerts` are left alone and `status` is untouched — clicking **Close trial** already cancels the alerts, so the nudge to close is what stops the noise. Nothing is decided for the officers. |
| Surface | The trial review post (`trials.thread_id`) — where the review alerts already land. |
| Ping | The overlord user ids, as the applicant notification does. |
| Audit channel | Mirrored, **without** a ping. The post is the only place that alerts. |
| Dedup | `trials.departed_notified_at`. Once per trial, ever. |
| Structure | One `guildMemberRemove` handler and one boot sweep cover both subjects. A leaver cannot be both an undecided applicant and an active trial, because accepting an application moves it off `'active'`. |

## Schema v13

Two columns on `trials`, added to `createTables` and to the migration path:

- `discord_user_id TEXT` — whose account this trial is. NULL means unknown, which simply
  never notifies.
- `departed_notified_at TEXT` — NULL means overlords have not been told.

**Back-fill of `discord_user_id`, best-effort, in the migration:**

1. From `applications.applicant_user_id` where `trials.application_id` resolves.
2. Otherwise from `raiders.discord_user_id` matched on `character_name`.

Whatever neither route resolves stays NULL. `departed_notified_at` needs no back-fill:
NULL already means "not yet notified", and no trial has been notified about.

Guarded the same way as v12 — check `sqlite_master` for the table, then `table_info` for
each column, so a fresh database that already has them from `createTables` does not throw.

## Filling the id going forward

- **Accepting an application.** `createTrialReviewThread` already receives `applicationId`,
  so it reads that application's `applicant_user_id` and stores it on the trial.
- **`/trials create_thread`.** The creation path is a *modal*, and Discord modals accept
  only text — prompting there would mean pasting a raw snowflake with no picker and no way
  to prefill, since the character name is typed in the same modal. Instead the id is
  resolved from `raiders` by the character name given. On a miss the officer's confirmation
  reply says plainly that departure notifications are off for this trial until it is linked.
- **`/trials change_trial_info`.** A new optional `discord_user` USER option sets or
  corrects it. A slash command can offer a real user picker, which the modal cannot.

## The notification

One plain line in the trial post, matching `buildDepartureNotification`:

```
@overlord1 @overlord2
**Charname** <@123> (trial) has left the server. Close the trial to tidy it up.
```

- `allowedMentions` locked to the explicit overlord ids, so a crafted character name cannot
  ping the server.
- The subject mention is inert and earns its place by rendering the leaver's display name
  rather than a possibly stale tag.
- No overlords configured means no mention line at all, not a leading blank.
- `trials.character_name` is `NOT NULL`, so unlike an application there is no tag fallback
  to worry about.

The audit mirror carries the same facts plus the raw user id and `trial #N`, under the
title `Trial left the server`, and never pings.

`departureNotification.ts` is **parameterised**, not copied: the subject label
(`applicant` / `trial`), the closing sentence, and the reference (`application #N` /
`trial #N`) become inputs. The shape of the message, the mention locking and the audit
detail stay in one place.

## Both paths

Selection, for either path: `status = 'active'` **and** `discord_user_id` is the departed
user **and** `departed_notified_at IS NULL`.

- **Live.** The existing `guildMemberRemove` handler asks both questions — undecided
  application, then active trial.
- **Boot sweep.** `sweepDepartedApplicants` becomes `sweepDepartures`, with an applications
  pass and a trials pass sharing the existing membership check, whose `departed` /
  `unknown` distinction is the point: only Discord explicitly answering
  `UnknownMember` / `UnknownUser` counts as a departure, so a rate limit or a blip is left
  for the next boot rather than announced.
- **Ordering, unchanged.** Post, then stamp, then mirror. A failed post leaves the row
  unstamped so the next boot retries, and the stamp is what stops a second notification.

The startup line reports both: `departures: apps 0/1, trials 1/2`.

## Testing

Unit tests mirroring `tests/unit/applicantDeparture.test.ts`:

- **Copy:** pings the overlords, names the character, says how to close it; mentions
  restricted to overlord ids so an applicant-supplied name cannot ping; no mention line
  without overlords; audit detail carries the raw id and `trial #N`.
- **Selection:** finds an active trial; ignores `promoted` and `closed`; ignores a trial
  with a NULL `discord_user_id`; ignores one already notified about.
- **Delivery:** posts to the trial thread and stamps exactly once; mirrors without a ping;
  does not stamp when the post fails; does not stamp when the trial has no `thread_id`;
  stamps even when the audit mirror throws.
- **Handler:** notifies on a real departure, ignores bots, ignores another guild, never
  throws back into the gateway.
- **Migration:** back-fills via the application route; back-fills via the raiders route;
  leaves a genuinely unknown trial NULL; is idempotent on a database that already has the
  columns.

## Known limitations, accepted

- **A trial whose Discord user was never linked is never covered.** Deliberate: guessing
  from a character name at notification time is what the stored column exists to avoid.
  The officer is told at creation when this applies.
- **A deleted trial thread retries forever**, one warning per boot, exactly as an
  application with a deleted thread does. The alternative is stamping a notification that
  was never delivered.
- **A promoted trial who leaves is silent.** Out of scope; a raider departure is its own
  feature with its own audience.
