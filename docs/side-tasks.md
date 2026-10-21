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
| ST-4 | Import E2E specs intermittently miss file chooser  | Test flakiness | Open — decide after the feature                 |

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
- **Cause (suspected):** click lands before hydration attaches the label →
  input association under full-suite load.
- **Proposed fix:** use `page.getByLabel(...).setInputFiles()` directly on the
  file input instead of driving the native chooser.
- **Impact on budgets:** none; relevant only because Phase 7 adds an import
  E2E (E7.3) — that test will use `setInputFiles` to avoid the same flake.
