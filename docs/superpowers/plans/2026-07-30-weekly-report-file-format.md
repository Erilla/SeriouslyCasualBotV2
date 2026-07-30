# Weekly Report File Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post readiness exceptions as a separate `.txt` attachment and render zero Raid/World Vault choices as `-` in compact columns.

**Architecture:** Keep all scheduled-report wiring in `alertHighestMythicPlusDone.ts`. It will build an `AttachmentBuilder` from the existing exception text and send it only after the required report attachment post succeeds. The Great Vault renderer will format zero counts locally, while its existing data source and Dungeon column remain unchanged.

**Tech Stack:** TypeScript, discord.js `AttachmentBuilder`, Vitest.

## Global Constraints

- The first scheduled post retains exactly the existing two attachments.
- When exceptions exist, a second, file-only post attaches `weekly_readiness_exceptions_<YYYY-MM-DD>.txt`; no duplicate exception message content is sent.
- No exceptions means no second post; manual report commands still never post exceptions.
- Zero Raid/World choices render `-`; positive counts remain `1`, `2`, or `3`.
- Raid and World columns are compact; the Dungeon keys column stays wide enough for `+10 / +10 / +10`.
- A failed optional exception attachment send is logged and cannot undo the required first post.
- Use TDD: test each changed behavior red before production code.

---

### Task 1: Attach readiness exceptions and compact Vault counts

**Files:**
- Modify: `src/functions/raids/alertHighestMythicPlusDone.ts:122-154,228-236`
- Modify: `tests/unit/greatVaultReport.test.ts:70-209`

**Interfaces:**
- Consumes: `buildReadinessExceptions(rows, now): string | null`.
- Produces: a second scheduled `channel.send` payload containing only `files: [AttachmentBuilder]` when exceptions exist.
- Produces: Great Vault row values `- | +keys | -` for zero Raid/World choices.

- [ ] **Step 1: Write failing scheduler and table tests**

In `greatVaultReport.test.ts`, change the exception-present scheduler test to expect a second payload with no `content`, one file named `weekly_readiness_exceptions_<date>.txt`, and that file’s buffer containing `Weekly Readiness Exceptions`. Keep the no-exception test asserting one send. Add a Vault fixture with absent Raid and World options and assert its row renders `-` in both compact columns.

- [ ] **Step 2: Run the focused tests to verify red**

Run:

```powershell
npm test -- tests/unit/greatVaultReport.test.ts
```

Expected: FAIL because exceptions are sent as `content` and zero counts render `0`.

- [ ] **Step 3: Implement the minimal renderer and attachment changes**

Add a local count formatter:

```ts
function formatUnlockedChoiceCount(count: number): string {
  return count === 0 ? '-' : String(count);
}
```

Use it for Raid and World, with compact `padEnd` widths sufficient for the headings and one-character values. Build the exception attachment only when text exists:

```ts
const readinessFile = new AttachmentBuilder(Buffer.from(readinessExceptions), {
  name: `weekly_readiness_exceptions_${dateStr}.txt`,
});
await channel.send({ files: [readinessFile] });
```

Leave the optional send inside its existing guarded `try`/`catch` after the required post.

- [ ] **Step 4: Run focused tests to verify green**

Run:

```powershell
npm test -- tests/unit/greatVaultReport.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run static and full verification**

With disposable required configuration values, run:

```powershell
npm run typecheck
npm run lint
npm test
npx prettier --check src/functions/raids/alertHighestMythicPlusDone.ts tests/unit/greatVaultReport.test.ts
git diff --check
```

Expected: all pass except the already-known non-fatal `node-cron` sourcemap warning.

- [ ] **Step 6: Commit implementation**

```powershell
git add src/functions/raids/alertHighestMythicPlusDone.ts tests/unit/greatVaultReport.test.ts
git commit -m "feat: attach weekly readiness exceptions"
```

## Self-review

- Spec coverage: the one task covers the separate file-only post, omission when empty, required-post ordering, compact zero-count output, and test coverage.
- Placeholder scan: exact filename, payload shape, and count behavior are specified.
- Type consistency: existing `AttachmentBuilder`, `Buffer`, `channel.send`, and `buildReadinessExceptions` are used without public-interface changes.
