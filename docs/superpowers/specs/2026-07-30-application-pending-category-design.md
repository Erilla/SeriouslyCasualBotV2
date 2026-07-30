# Pending Application Category Count — Design

## Goal

Show the number of submitted applications awaiting a decision in the name of
the category that contains the `application-log` forum channel.

## Display and Count

The category is displayed as `APPLICATION LOGS · <N> PENDING`, where `<N>` is
the number of rows in `applications` whose status is `active`. Applications
that are still being filled in, abandoned, accepted, or rejected are not
included.

## Design

Add a focused `applicationLogCategory` helper that:

1. Resolves the existing `Application-logs` category and persists its Discord
   ID in the `application_log_category_id` config value. That setting is
   distinct from `applications_category_id`, which belongs to the private
   application text-channel category.
2. Queries SQLite for the count of `active` applications.
3. Renames the category only if its current name differs from the desired
   display name, avoiding needless Discord API calls.
4. Logs failures as warnings and does not fail an application submission or
   decision because the display could not be refreshed.

The resolver uses the stored ID after the first refresh, so changing the
category's displayed name never prevents the bot from finding it again. It
does not create a category; if the existing category cannot be found, the
refresh is skipped. The forum creation path will use the resolved category ID
as its parent instead of relying on the old static category name.

The helper will run after the database status changes that affect the count:

- after an application is recorded as `active` on submission;
- after an application is recorded as `accepted`;
- after an application is recorded as `rejected`;
- during bot startup, so the name is correct after downtime or a failed
  earlier refresh.

The category remains the current parent of `application-log`; no locked
statistics channel is created.

## Error Handling

The count display is non-critical. Missing guild/category access, insufficient
channel-management permission, and Discord API failures produce a warning and
leave the core application flow successful. A later lifecycle event or restart
will retry the refresh.

## Testing

Unit tests will cover the active-only count, the generated name, renaming only
when needed, and best-effort failure handling. Existing application-flow tests
will verify that submission and both decision paths invoke the refresh after
their database updates.

