# Trial Extension Audit Detail Design

## Goal

Make a trial-extension audit entry useful to officers by identifying the trial
and recording its resulting expiry date, without exposing the internal trial
database ID.

## Behaviour

After a successful extension, the audit entry will contain:

- the trial character name;
- a clickable review-thread reference when the trial has one; and
- the new trial end date rendered as a Discord-localized full date.

For example:

```text
Ryan extended trial: Binded — #binded-review; ends 6 August 2026
```

The handler will read the trial again after `extendTrial` completes so the
audited date is the persisted post-extension value. If the row cannot be
retrieved, it will retain the existing `#<id>` fallback rather than failing a
completed extension.

## Implementation and Testing

The trial audit reference helper will render a character name and optional
review-thread link without a trial ID. The extension interaction will append
the refreshed `end_date` using the existing Discord date formatter.

A focused regression test will assert that a successful extension sends the
enriched audit detail, including the updated expiry date, and omits the trial
ID from normal output.

## Error Handling

Existing extension failure handling remains unchanged. Audit enrichment is
performed only after `extendTrial` succeeds.
