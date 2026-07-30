# Weekly report attachment and Vault layout

## Goal

Make weekly readiness exceptions a text-file attachment and make the Great
Vault report distinguish no Raid/World choices with compact columns.

## Scheduled weekly output

The first weekly-check post remains unchanged: it contains the existing M+
and Great Vault `.txt` attachments.

When readiness exceptions exist, send a second post containing one attachment
named `weekly_readiness_exceptions_<YYYY-MM-DD>.txt`. Its file contents are
the existing `Weekly Readiness Exceptions` report. Do not send that second
post when there are no exceptions. The exception file replaces the current
plain-text exception message; its post has no duplicate body content.

Manual report commands remain unchanged and do not send exceptions.

## Great Vault table

For the Raid and World columns, render a zero unlocked-choice count as `-`.
Render positive counts as `1`, `2`, or `3` as before. Use compact fixed widths
for `Raid` and `World`, retaining the wider `Dungeon keys` column needed for
three key levels. Missing Dungeon key choices remain `-`.

## Failure behavior and tests

The required M+ and Great Vault attachment post still happens before the
optional exceptions post. A failure sending the exceptions file is logged and
does not undo the report post.

Tests will prove the second post has one `.txt` attachment and no duplicate
content, is omitted when no exceptions exist, and the Vault row renders
`-` for zero Raid/World choices with the compact layout.
