# Reduce Recurring Jobs Design

## Goal

Reduce recurring Discord and external-API work while keeping scheduled reminders, weekly reports, backups, and exact trial-alert timing intact.

## Chosen approach

Use two daily cron tasks instead of the four high-frequency intervals:

1. At 06:00, sync the Raider.IO roster, send alerts for newly unlinked raiders, repair the raider-linking channel, and refresh active trial logs.
2. At 06:30, regenerate the achievements image.

The existing signup-reminder cron, weekly reports cron, and daily backup cron remain unchanged. Trial-review and promotion alerts remain database-backed one-shot timers so they still fire at their exact scheduled time.

## Data flow

The 06:00 maintenance task keeps the existing error boundary and status tracking for each operation. A failed roster sync is recorded and logged without preventing the link-message repair or trial-log refresh from being attempted. Existing link and ignore interactions already delete or clear the affected message immediately; the daily link-message job is therefore only a repair sweep.

The 06:30 achievements task keeps its own status tracking. It runs after the maintenance batch so it does not compete with roster and log API traffic.

## Error handling and observability

Each operation preserves the existing scheduler logging and `recordTaskRun` success/failure data. The combined maintenance task records each constituent operation by its current task name, so `/status` continues to show useful health information. A failure in one operation must not skip the remaining operations.

## Testing

Add unit coverage for the immediate linking-message refresh behavior after link and ignore interactions. Extend startup scheduler tests to assert the new schedule: two cron-based daily jobs replace the prior four intervals, while the three existing cron tasks remain registered. Run the focused tests, then typecheck, lint, build, and the full default test project with inert configuration values in the isolated worktree.
