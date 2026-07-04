# SeriouslyCasualBot V2 — Feature Test Checklist

A domain-by-domain checklist of every bot feature for manual testing. Tick each box once you've verified the behaviour on the test server.

> Source: `docs/superpowers/specs/2026-04-17-seriouslycasualbot-v2-design.md`, cross-checked against `src/commands/`.

---

## 1. Applications

- [x] `/apply` starts the DM questionnaire (creates an `in_progress` record)
- [x] "Apply Now" button (posted via `/applications post_apply_button`) starts the same flow
- [x] Questions are DM'd one at a time in `sort_order`
- [x] Each answer is persisted as it comes in
- [ ] Restarting the bot mid-questionnaire resumes from the last unanswered question
- [x] Running `/apply` with an existing `in_progress` app resumes it (doesn't start fresh)
- [x] Summary screen shows numbered Q&A with Edit / Confirm / Cancel
- [x] **Edit** re-asks a chosen question and updates the answer, returns to summary
- [x] Can edit multiple answers before confirming
- [x] **Cancel** sets status `abandoned` and sends goodbye message
- [ ] **Timeout** (30 min no response) abandons and sends timeout message; `/apply` can restart
- [x] **Confirm** creates `app-{charactername}` text channel with correct permissions (applicant + overlords only)
- [ ] Applications category auto-created if missing
- [x] Full Q&A posted as first message in the channel (split if long)
- [x] `application-log` forum post created with title = character name, Active tag (auto-created)
- [x] Voting embed posted (for / neutral / against / kekw)
- [x] Accept/Reject buttons posted
- [x] Overlords notified
- [x] Voting: any user who can see the post can vote
- [x] One vote per user; clicking a different button changes the vote
- [x] Voting embed shows progress bar + voter names per category
- [ ] **Accept** — non-officer click rejected with ephemeral
- [x] Accept modal pre-fills character name + accept message; takes role + start date
- [x] On accept submit: transcript generated, posted to forum, DM'd to applicant as file
- [x] On accept: Active tag removed, Accepted tag added, thread locked, temp channel deleted
- [x] On accept: **trial review thread auto-created** (cross-domain)
- [ ] **Reject** — non-officer click rejected with ephemeral
- [x] Reject modal pre-fills reject message
- [x] On reject submit: transcript posted + DM'd, Rejected tag set, thread locked, channel deleted
- [x] `/applications view_pending` lists active/in-progress/abandoned applications
- [ ] `/applications add_question` / `remove_question` / `list_questions`
- [ ] `/applications set_accept_message` / `set_reject_message`

## 2. Trial Review

- [ ] `/trials create_thread` opens a modal and manually creates a trial
- [x] Trial thread created in trial-reviews forum (auto-created if missing)
- [x] Review message posted with character, role, start date, review dates
- [ ] WarcraftLogs attendance links posted (OAuth2 + GraphQL)
- [x] 4 buttons present: Update Info, Extend, Mark for Promotion, Close Trial
- [x] Overlords added to thread
- [ ] Review alerts (2/4/6 week) scheduled and stored in `trial_alerts`
- [ ] Alert fires at the right time → notification in thread, marked alerted
- [ ] On restart: pending future alerts re-scheduled; missed alerts fire immediately
- [ ] **Mark for Promotion** schedules a promote reminder (persists across restart)
- [ ] Promote reminder fires → mentions admin role in thread
- [ ] **Extend** extends trial by one week
- [ ] **Update Info** modal edits trial info
- [ ] **Close Trial** closes + archives thread
- [ ] Trial thread auto-unarchives if Discord auto-archives it (`threadUpdate`)
- [ ] WarcraftLogs logs refresh every ~60 min
- [x] `/trials get_current_trials` lists active trials
- [ ] `/trials remove_trial` removes by thread ID
- [ ] `/trials change_trial_info` edits name/role/start date
- [ ] `/trials update_trial_logs` refreshes all WarcraftLogs messages
- [ ] `/trials update_trial_review_messages` refreshes all review messages

## 3. Raids (Roster Management)

- [x] Roster syncs from Raider.io every ~10 min
- [x] Missing raider: first miss sets `missing_since` (grace period starts)
- [x] Missing < 24h: no action; missing ≥ 24h: officer alert posted once
- [x] Raiders never auto-deleted
- [x] Raider returns to API → `missing_since` cleared
- [ ] New raider auto-linked from `raider_identity_map` if a match exists
- [ ] Identity map survives raider removal + re-addition
- [ ] Auto-link suggestion posted when a Discord member matches (name/nickname/username)
- [ ] Suggestion has Confirm / Reject / manual-select
- [ ] Confirm applies link + saves to identity map
- [ ] Reject falls through to manual select menu
- [x] Missing-user alert has select menu + Ignore button
- [x] Linking messages de-duplicated (one per raider via `message_id`)
- [x] Resolved linking messages deleted on next sync
- [x] Stale linking messages refreshed to stay near bottom of channel
- [ ] Sync summary posted to raider-setup channel
- [x] Signup alerts fire 7PM Mon/Tue/Fri/Sat (respect the relevant setting toggle)
- [ ] Signup alert mentions unsigned raiders with a random message
- [ ] 48-hour reminders use Discord relative timestamps
- [ ] Weekly report fires noon Wednesday → highest M+ runs file + Great Vault file
- [x] `/raiders get_raiders` lists current raiders (paginated if long)
- [x] `/raiders get_ignored_characters`
- [x] `/raiders ignore_character` / `remove_ignore_character`
- [x] `/raiders sync_raiders` (manual sync; ephemeral error if Raider.io down)
- [x] `/raiders check_missing_users`
- [ ] `/raiders update_raider_user` links a raider to a Discord user
- [x] `/raiders previous_highest_mythicplus` (manual M+ report)
- [x] `/raiders previous_great_vault` (manual vault report)
- [x] `/raiders add_overlord` / `get_overlords` / `remove_overlord`

## 4. Loot

- [x] `/loot create_posts` auto-discovers the current raid tier (Raider.io expansion walk)
- [x] One embed + 4 buttons per boss in loot channel (channel auto-created)
- [x] Buttons: Major / Minor / Want In / Do Not Need, showing character names
- [ ] Clicking a button as a non-raider → ephemeral error (early return)
- [x] Response switch: old response removed, new inserted (transaction), embed re-rendered
- [ ] `/loot delete_post` deletes a single post
- [ ] `/loot delete_posts` batch-deletes by boss IDs

## 5. Guild Info

- [x] `/guildinfo` full refresh recreates all 4 embeds in order
- [x] About Us embed with link buttons (Raider.io, WoWProgress, WarcraftLogs)
- [x] Schedule embed with days/times + timezone footer
- [ ] Recruitment embed with sections, overlord mentions, Apply Here button
- [x] Achievements rendered as a generated PNG (canvas)
- [x] Achievements combine manual data (exp 4-5) + live Raider.io (exp 6+)
- [x] Cutting Edge rows detected + highlighted
- [x] Achievements refresh every ~30 min
- [x] `/updateachievements` refreshes achievements only
- [x] Message IDs stored for edit-in-place

## 6. Settings

- [x] `/settings get_setting` views a value
- [x] `/settings toggle_setting` toggles a value
- [x] `/settings get_all_settings` views all
- [x] Toggles: `alertSignup_Wednesday`, `_Wednesday_48`, `_Sunday`, `_Sunday_48`
- [ ] All default to disabled

## 7. Setup & Config

- [x] `/setup set_channel` points to an existing channel
- [x] `/setup set_role` points to an existing role (e.g. officer)
- [x] `/setup get_config` shows current config
- [ ] Auto-creation works for all 13 resource types (category, forums, tags, channels)
- [ ] Officer-only commands reject non-officers with ephemeral + audit log entry

## 8. Operational / Infrastructure

- [x] `/status` shows uptime, last sync/update times, counts, DB size
- [x] `/ping` responds
- [x] `/help` lists commands
- [x] `/loglevel get` shows current level (ephemeral)
- [x] `/loglevel set` changes level at runtime (officer-only, audited)
- [x] **bot-logs** channel receives operational events (sync, startup/shutdown, errors)
- [x] **bot-audit** channel logs every state-changing officer action (who/what/when)
- [ ] Scheduler: errors caught (no crash), overlapping runs skipped
- [ ] Graceful shutdown on SIGTERM/SIGINT (timers cancelled, DB closed)
- [ ] Daily SQLite backup runs; keeps last 7
- [ ] DB migrations apply on startup (forward-only, transactional)
- [ ] In-progress DM questionnaires survive restart

## 9. Test Data (dev only — `NODE_ENV=development`)

- [ ] `/testdata seed_raiders`
- [ ] `/testdata seed_application`
- [ ] `/testdata seed_trial`
- [ ] `/testdata seed_loot`
- [ ] `/testdata reset`
- [ ] `/testdata` commands NOT registered in production
