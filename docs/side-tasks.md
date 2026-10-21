# Side tasks — pre-existing issues found during the budgets work

Found while taking the Phase 0 baseline (`pnpm run check` on the untouched
repo, macOS, local timezone UTC-3). None of them is caused by the budgets
feature and none blocks it; each is tracked here so it can be addressed (or
not) independently of the feature branch.

| ID   | Issue                                              | Kind           | Status                                          |
| ---- | -------------------------------------------------- | -------------- | ----------------------------------------------- |
| ST-1 | Migration-heavy unit tests time out under load     | Test infra     | Open — decide after the feature                 |
| ST-2 | Transaction dates shown one day early (UTC offset) | **App bug**    | Fixed on branch `fix/transaction-date-timezone` |
| ST-3 | Categories "edit" E2E uses an ambiguous locator     | Test bug       | Open — decide after the feature                 |
| ST-4 | Import E2E helper races its own navigation      | Test flakiness | Open — decide after the feature                 |
| ST-5 | `ReferenceError: module is not defined` on every vitest run | Test infra noise | **To be verified**                      |
| ST-6 | `deleteCategory` does not verify ownership of the target id | **Security bug** (IDOR) | Open — recommend fixing                 |

---

## ST-1 — Migration-heavy unit tests time out under load

- **Symptom:** `tests/db-migrate.test.ts` and `tests/health.test.ts` fail with
  `Test timed out in 5000ms` during `pnpm run test`; both pass when run alone
  (~10s for the two files).
- **Cause:** each test boots a fresh in-memory PGlite and replays every
  migration while vitest runs all files in parallel. Under full-suite CPU
  contention that exceeds the 5s default. Every new migration makes it worse
  (baseline: 2 failures; after budgets migration 0004: 4).
- **Proposed fix:** a per-test timeout on those two files (e.g. `30_000`) —
  test-only change, no production impact.
- **Impact on budgets:** none functionally; it keeps `pnpm run check` red.

## ST-2 — Transaction dates shown one day early

- **Symptom:** a transaction entered for 2025-01-15 is listed as "Jan 14,
  2025" for any user west of UTC. E2E
  `transactions-list.spec.ts › table displays transactions with correct columns`
  fails deterministically on a UTC-3 machine (passes in UTC, e.g. CI).
- **Cause:** `formatTxDate` (`src/routes/_authed/transactions.tsx`) parses the
  stored wall-clock date as UTC midnight (`new Date(iso + "Z")`) and then
  formats it in the browser's local timezone, shifting it back a day.
- **Data impact:** none — the stored `date` is correct; only display is wrong.
  Budget calculations compare `YYYY-MM-DD` strings server-side and are
  unaffected.
- **Fix:** format in UTC (`timeZone: "UTC"`), so the wall-clock value is shown
  exactly as stored. Regression E2E runs the browser in a UTC-3 timezone.
- **Branch:** `fix/transaction-date-timezone` (off `main`, independent of the
  feature branch).

## ST-3 — Categories "edit" E2E uses an ambiguous locator

- **Symptom:** `categories.spec.ts › edits an existing category` fails almost
  every run with a strict-mode violation: `getByText('Edit Me')` resolves to
  the category row **and** the `<option>` in the "Parent Category" select.
- **Cause:** test locator not scoped; app behaviour is correct.
- **Proposed fix:** scope the assertion, e.g. `page.getByRole("main")` list
  region or `getByText("Edit Me", { exact: true }).first()` replaced by a
  role-based locator on the list item.
- **Impact on budgets:** none.

## ST-4 — Import E2E specs intermittently miss the file chooser

- **Symptom:** `import-dedup.spec.ts` / `import-rules.spec.ts` occasionally
  time out at `page.waitForEvent("filechooser")` / clicking "Choose File";
  pass on re-run (9/9 on repeat). `import-rules.spec.ts › deleting a rule
  does not retroactively recategorize` also intermittently times out waiting
  for the rule row's delete button after the import (11/11 when run alone).
- **Cause (confirmed from the failure snapshot):** the shared `importCsv`
  helper "resets" the import wizard by clicking **Dashboard** then **Import**
  back-to-back without waiting for the Dashboard navigation to land. When the
  second click wins the race, the router never leaves `/import`, the wizard
  keeps its previous state, and the page still shows **"Import complete"** —
  so "Choose File" never appears and the file-chooser wait times out. Pure
  test timing; worse under load (seen at 3/4 failures even in isolation).
  Also affects `import-summary.spec.ts`, which uses the same pattern.
  `recategorize.spec.ts` has a sibling variant: its `importWithInlineAccount`
  helper clicks the sidebar "Import" link and calls `setInputFiles`
  immediately, so the upload can land before the page is ready and the
  mapping step ("Date" combobox) never renders (failed once in the
  Phase 6–7 full run, 3/3 on re-run).
- **Proposed fix:** in the helpers, `await expect(page).toHaveURL("/dashboard")`
  between the two clicks (or click "Import another file"), and set the file
  with `setInputFiles` on the file input instead of the native chooser.
- **Impact on budgets:** none; relevant only because Phase 7 adds an import
  E2E (E7.3) — that test will use `setInputFiles` to avoid the same flake.

## ST-5 — `ReferenceError: module is not defined` on every vitest run

- **Status:** to be verified — logged, not investigated.
- **Symptom:** every `vitest run` prints one
  `ReferenceError: module is not defined` with a stack in
  `node_modules/.pnpm/react@19.2.5/node_modules/react/index.js:6` evaluated
  by Vite's `ESModulesEvaluator.runInlinedModule`. No test fails because of
  it; the run continues and results are unaffected.
- **Observations so far:**
  - Present in the untouched baseline (Phase 0 log).
  - Printed once per vitest invocation, **before** the `RUN` banner — i.e.
    while vitest/vite boots (config or plugin loading), not inside a test
    file. Reproduces with any single file (`authorization`, `money`,
    `budgets`, `db-migrate`).
  - `react/index.js` is CommonJS (`module.exports = ...`); the stack shows it
    being run through Vite's ESM module runner, which has no `module`
    global — React's CJS entry is being inlined instead of externalized.
- **To verify:** which import pulls React into the module runner at startup
  (likely a vite plugin in `vite.config.ts` — devtools / router / start —
  or `tests/setup.ts`), and whether `test.server.deps` / `ssr.noExternal`
  settings for React should change. Confirm nothing actually depends on the
  failed evaluation.
- **Impact on budgets:** none observed.

## ST-6 — `deleteCategory` does not verify ownership of the target id

- **Status:** open — found while wiring budget cleanup into category
  deletion (Phase 5). **Recommend fixing**; it is a cross-tenant write.
- **Where:** `src/server/categories.functions.ts` → `deleteCategory`.
- **Cause:** descendants are collected with a `user_id` filter, but the
  requested `data.id` itself is appended to `allIdsToDelete` without an
  ownership check (the `allIdsToDelete.length === 0` "not found" guard can
  never trigger). Three of the follow-up statements then filter by id only:
  - `UPDATE receipt_items SET category_id = NULL WHERE category_id IN (…)`
  - `DELETE FROM categorization_rules WHERE category_id IN (…)`
  - `DELETE FROM categories WHERE id IN (…)`
- **Impact:** a signed-in user who knows another user's category UUID can
  delete that user's categorization rules and un-categorize their receipt
  items, and delete the category itself when no foreign transactions
  reference it. UUIDs are not guessable, which limits exploitability, but it
  breaks the codebase's own rule (`ownership.server.ts`: "any handler taking
  an entity id must verify user_id ownership"). The handler also isn't
  wrapped in a transaction, so a failure part-way leaves partial deletes.
- **Proposed fix:** `ownedEntityExists("category", userId, data.id)` up front
  returning "Category not found"; add `user_id` to the categories / rules
  deletes (receipt_items via the user's receipts); wrap the handler in
  `db.transaction`. Add a cross-tenant unit/E2E test.
- **Budgets:** the new `deleteBudgetsForCategories` is user-scoped, so it
  does not widen the hole — a foreign id leaves the victim's budget in place,
  and its FK then makes the category delete fail.

