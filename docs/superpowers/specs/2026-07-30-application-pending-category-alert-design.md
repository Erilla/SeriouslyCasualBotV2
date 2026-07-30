# Pending Application Category Alert — Design

## Goal

Make the application-log category visually prominent whenever there is at
least one submitted application awaiting a decision.

## Display Rules

The existing active-only count remains unchanged.

- When the active count is greater than zero, display
  `🟥 APPLICATION LOGS · <N> PENDING`.
- When the active count is zero, display
  `APPLICATION LOGS · 0 PENDING`.

The red-square emoji is only an attention indicator; it does not alter which
application statuses are counted or how the category is resolved.

## Implementation

Extend the existing category-name builder to choose the prefix based on the
count. All current refresh points—startup, submission, acceptance, and
rejection—already call the same builder through the refresh helper, so no
new Discord lifecycle hooks are required.

The category resolver will recognise both the prior unprefixed dynamic title
and the new red-square-prefixed title, so a restart or missing saved category
ID can still rediscover the category after the display changes.

## Testing

Update the category-helper unit tests to assert the exact nonzero prefixed
name, the zero-count unprefixed name, idempotence for both formats, and
resolver discovery of the new alert title.
