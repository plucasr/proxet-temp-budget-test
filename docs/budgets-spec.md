# Spec — Monthly category budgets

Source: [TASK.md](../TASK.md). This spec is split into phases; each phase is
reviewed and explicitly started by the developer — no phase begins on its own.

---

## 1. Scope

### Acceptance criteria (from TASK.md) and where each is satisfied

| #    | Acceptance criterion                                                   | Phase | Unit tests      | E2E tests                    |
| ---- | ---------------------------------------------------------------------- | ----- | --------------- | ---------------------------- |
| AC1  | New "Budgets" page in the main navigation                              | 6     | —               | E6.1                         |
| AC2  | Add a budget for a category with a monthly limit, change it, remove it | 4, 6  | U4.1–U4.6       | E6.2–E6.6                    |
| AC3  | Each budget shows limit, spent this month, left, and over-budget state | 2, 6  | U2.1, U2.8      | E6.7, E6.8                   |
| AC4  | A parent-category budget includes its subcategories' spending          | 2     | U2.2, U2.3      | E6.9                         |
| AC5  | Only spending counts — income/refunds don't reduce spent               | 2     | U2.4            | E6.10                        |
| AC6  | Budgets reset every month                                              | 2     | U2.5, U2.6      | E6.11                        |
| AC7  | Email when going over a budget, max one per budget per month           | 7     | U7.1–U7.9       | E7.1–E7.3                    |
| AC8  | Free plan: up to 3 budgets; Pro: unlimited                             | 3, 6  | U3.1–U3.5       | E6.12–E6.14                  |
| N1   | Must not break existing functionality                                  | all   | full suite      | full suite (`pnpm run check`) |
| N2   | Budgets are user data — same compliance requirements                   | 4, 5  | U4.7, U5.1–U5.5 | E5.1                         |

### Decisions taken (agreed before the spec)

| Topic                         | Decision                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-currency                | Single-currency assumption, consistent with the dashboard (amounts summed as-is, labelled with `m.analytics_currency()`). The Budgets page shows a **non-blocking notice** when the user has accounts in more than one currency. Documented limitation. |
| Parent + child budgets        | Allowed, tracked independently. A child's spending counts toward both. Page renders budgets **nested** under a budgeted ancestor; **no grand total**. Non-blocking warning when a child's limit exceeds its budgeted ancestor's limit.            |
| What spending is attributed   | By `transactions.category_id` only. Receipt line-item categories are ignored for budgets.                                                                                                                                                        |
| "This month"                  | Calendar month of the **server's local date**, compared against `transactions.date` (a plain `YYYY-MM-DD`). Range is `[YYYY-MM-01, first day of next month)`.                                                                                     |
| Over budget                   | `spent > limit` (strict). `spent == limit` is "at limit", not over, and does not trigger an alert.                                                                                                                                               |
| Downgrade Pro → Free          | Existing budgets above the free limit are kept, keep displaying and keep alerting; only **creating** new ones is blocked (same policy as accounts).                                                                                              |
| Alert idempotency key         | `(user_id, category_id, month)` — not the budget id — so deleting and re-creating a budget in the same month cannot produce a second email.                                                                                                       |
| Alert recipient               | `users.email` when non-null (legacy accounts without email are skipped). Same policy as other transactional emails.                                                                                                                              |
| Alert retrospection           | Alerts are evaluated only for the **current** month. Importing an over-limit past month sends nothing.                                                                                                                                           |

### Out of scope

Currency conversion / per-currency budgets, budget history per month,
rollover of unused budget, non-monthly periods, threshold warnings (e.g. 80%),
in-app notifications.

---

## 2. Design reference

### Data model (Phase 1)

```ts
// src/db/schema.ts
export const budgets = pgTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id),
    category_id: text("category_id").notNull().references(() => categories.id),
    // Integer minor units (grosze/cents) — never store money as floats.
    limit_minor: integer("limit_minor").notNull(),
    created_at: timestamp(..., { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updated_at: timestamp(..., { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("budgets_user_category_idx").on(t.user_id, t.category_id)],
);

// One row per (user, category, month) an over-budget email was sent for —
// the idempotency ledger for "max one email per budget per month".
export const budget_alerts = pgTable(
  "budget_alerts",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id),
    category_id: text("category_id").notNull().references(() => categories.id),
    month: text("month").notNull(), // "YYYY-MM"
    sent_at: timestamp(..., { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("budget_alerts_user_category_month_idx").on(t.user_id, t.category_id, t.month)],
);
```

Plus a `CHECK (limit_minor > 0)` constraint. Migration generated with
`pnpm run db:generate` → `drizzle/0004_*.sql`.

### Module layout

| File                                  | Kind          | Responsibility                                                   |
| ------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `src/lib/budget-period.ts`            | shared, pure  | `monthKey(date)`, `monthRange(date)` → `{ from, toExclusive }`   |
| `src/server/budgets.server.ts`        | server-only   | status calculation, limit gate, alert evaluation                 |
| `src/server/budgets.functions.ts`     | server fns    | `getBudgets`, `createBudget`, `updateBudget`, `deleteBudget`     |
| `src/server/billing.server.ts`        | modified      | `maxBudgets` entitlement, `checkBudgetLimit`                     |
| `src/server/env.ts`                   | modified      | `BILLING_FREE_MAX_BUDGETS` (default 3, positive integer)         |
| `src/routes/_authed/budgets.tsx`      | route         | Budgets page                                                     |
| `src/components/sidebar.tsx`          | modified      | nav item                                                         |
| `messages/en.json`                    | modified      | all new strings                                                  |

### Core types

```ts
export interface BudgetStatus {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string | null;
  /** Ancestor chain names, root first — for "Groceries › Vegetables" labels. */
  categoryPath: string[];
  /** Nearest ancestor category that also has a budget, for nested rendering. */
  parentBudgetId: string | null;
  /** All amounts are integer minor units. */
  limit: number;
  spent: number;        // >= 0
  remaining: number;    // limit - spent, negative when over
  overBudget: boolean;  // spent > limit
  /** True when this limit exceeds the budgeted ancestor's limit. */
  exceedsParentLimit: boolean;
}

export interface BudgetsOverview {
  month: string;                 // "YYYY-MM"
  budgets: BudgetStatus[];
  usage: { used: number; limit: number | null }; // limit null = unlimited
  multiCurrency: boolean;        // user has accounts in >1 currency
}
```

### Spend calculation (single query + in-memory roll-up)

1. Load the user's categories (`id, name, color, parent_id`) — small table.
2. One aggregate query for the month:
   `SELECT category_id, SUM(-amount_minor) FROM transactions WHERE user_id = ? AND date >= from AND date < toExclusive AND amount_minor < 0 AND category_id IS NOT NULL GROUP BY category_id`
   (`SUM` returns bigint-as-string → `.mapWith(Number)`, as in analytics).
3. For each budget, `spent = Σ spentByCategory[c]` over the budget category's
   **full descendant set** (recursive, arbitrary depth; cycle-safe via a visited set).

### Error contract (matches existing `{ error, code }` convention)

| Code                    | When                                                 |
| ----------------------- | ---------------------------------------------------- |
| `budget_limit_reached`  | Free user creating a 4th budget (returns `limit`)    |
| `budget_exists`         | Category already has a budget                        |
| `category_not_found`    | Category missing or owned by another user            |
| `budget_not_found`      | Budget missing or owned by another user              |

Input amounts are sent as `limitMinor: z.number().int().positive().max(1_000_000_000)`;
the client converts with `parseAmountToMinor`, as `transactions.functions.ts` does.

---

## 3. Phases

Each phase ends with **`pnpm run check`** green (required by CLAUDE.md) and a
short summary for review. No phase starts without an explicit go-ahead.
Note: Playwright starts its own server on :3000 — no dev server may be running.

---

### Phase 0 — Baseline

**Goal:** know the starting state so later failures are attributable.

- `pnpm install`, `pnpm exec playwright install chromium`.
- Run `pnpm run check` on the untouched repo; record any pre-existing failures.

**Done when:** baseline result is reported (pass, or list of pre-existing failures).

---

### Phase 1 — Data model & migration

**Tasks**
- Add `budgets` and `budget_alerts` to `src/db/schema.ts` (see §2).
- `pnpm run db:generate` → review the generated `0004_*.sql` (unique indexes, FKs, CHECK).
- Verify app boots against existing local `./data/pg` (migration applies cleanly).

**Unit tests**
- U1.1 `tests/db-migrate.test.ts` still passes (journal count increments; schema up to date).
- U1.2 Inserting two budgets for the same `(user, category)` fails on the unique index.
- U1.3 Inserting `limit_minor <= 0` fails on the CHECK.

**Done when:** migration reviewed, tests pass, no app behaviour changed.

---

### Phase 2 — Budget period & status calculation

**Tasks**
- `src/lib/budget-period.ts`: `monthKey`, `monthRange` (pure, date injectable).
- `budgets.server.ts`: `getBudgetsOverview(userId, today = new Date())` per §2
  (spend roll-up, `remaining`, `overBudget`, `categoryPath`, `parentBudgetId`,
  `exceedsParentLimit`, `multiCurrency`). `usage` is wired in Phase 3.

**Unit tests** (`tests/budgets.test.ts`, unique ids per test, in-memory PGlite)
- U2.1 Budget with no spending → `spent 0`, `remaining = limit`, not over.
- U2.2 Parent budget includes direct-child spending.
- U2.3 Parent budget includes grandchild spending (depth ≥ 3).
- U2.4 Positive amounts (income/refunds) in the category are ignored — they do not reduce spent.
- U2.5 Transactions dated last month / next month are excluded.
- U2.6 Boundaries: `YYYY-MM-01` and the last day of month included; `next-01` excluded; December → January rollover.
- U2.7 Uncategorized transactions and other users' transactions never count.
- U2.8 `spent > limit` → `overBudget`, negative `remaining`; `spent == limit` → not over.
- U2.9 Parent and child both budgeted: child spending counts in both; `parentBudgetId` set on child.
- U2.10 Child limit > parent limit → `exceedsParentLimit: true`; otherwise false.
- U2.11 `multiCurrency` true only when the user's accounts span >1 currency.
- U2.12 `monthRange`/`monthKey` pure-function cases.

**Done when:** AC3–AC6 logic covered by passing unit tests.

---

### Phase 3 — Plan gating

**Tasks**
- `env.ts`: `BILLING_FREE_MAX_BUDGETS` (default 3, validated positive int); add to `.env.example`.
- `billing.server.ts`: `Entitlements.maxBudgets` (`null` for Pro); `checkBudgetLimit(userId)`
  mirroring `checkAccountLimit` → `{ allowed } | { allowed: false, code: "budget_limit_reached", limit, error }`.
- Fill `usage` in `getBudgetsOverview`.

**Unit tests** (extend `tests/billing.test.ts`)
- U3.1 `entitlementsForPlan("free").maxBudgets === 3`; Pro → `null`.
- U3.2 Free user with 2 budgets → allowed; with 3 → `budget_limit_reached`, `limit: 3`.
- U3.3 Pro (`active`, `trialing`, `past_due`) → always allowed.
- U3.4 Canceled Pro with 5 budgets → creation blocked, existing 5 untouched.
- U3.5 `tests/env.test.ts`: invalid `BILLING_FREE_MAX_BUDGETS` rejected.

**Done when:** AC8 server-side enforced and tested.

---

### Phase 4 — Server functions & ownership

**Tasks**
- `budgets.functions.ts`: `getBudgets` (GET → `BudgetsOverview`), `createBudget`,
  `updateBudget` (limit only), `deleteBudget`; `requireUserId()` + Zod `inputValidator`.
- Ownership in the same query (`WHERE id = ? AND user_id = ?`); category ownership checked on create.
- Duplicate category → `budget_exists` (pre-check + unique-violation fallback for races).
- Add `budget: schema.budgets` to `OWNED_TABLES` in `ownership.server.ts`.
- Business logic lives in `budgets.server.ts` (`createBudgetForUser`, …) so it is unit-testable;
  `.functions.ts` stays a thin wrapper.

**Unit tests**
- U4.1 Create → row persisted with `user_id`; returned in overview.
- U4.2 Create for another user's category → `category_not_found`.
- U4.3 Create duplicate → `budget_exists`.
- U4.4 Update limit → persisted, `updated_at` bumped; other user's budget → `budget_not_found`, row unchanged.
- U4.5 Delete → row gone; other user's budget → `budget_not_found`, row kept.
- U4.6 Invalid limits (0, negative, non-integer, above max) rejected by schema.
- U4.7 `tests/authorization.test.ts`: seed a budget for user A (typecheck forces it via `OWNED_TABLES`) — cross-tenant lookup indistinguishable from not found.

**Done when:** AC2 server-side complete; authorization suite green.

---

### Phase 5 — Data integrity & compliance

**Tasks**
- `deleteCategory`: delete `budget_alerts` and `budgets` for every category in the deleted subtree
  before deleting categories (both with and without reassignment — the budget is not moved).
- `compliance.server.ts`:
  - `collectUserExport` + `export.json` → `budgets`, `budgetAlerts`.
  - `budgets.csv` (`id, category, limit, limit_minor, created_at, updated_at`).
  - `hardDeleteUser` → delete `budget_alerts`, `budgets` before `categories`.
- `messages/en.json` → mention budgets in `privacy_what_body`.
- Log lines carry ids/counts only, never amounts or category names.

**Unit tests**
- U5.1 `tests/compliance.test.ts`: `seedFullUser` adds a budget + alert; export zip contains `budgets.csv` and both keys in `export.json`.
- U5.2 `hardDeleteUser` removes budgets and alerts (no FK error) and leaves other users' rows intact.
- U5.3 `sweepExpiredDeletions` succeeds for a user with budgets.
- U5.4 Deleting a budgeted category removes its budget (no FK error); with reassignment too.
- U5.5 Deleting a parent removes budgets on its descendants.

**E2E**
- E5.1 Extend `tests/e2e/compliance.spec.ts`: after creating a budget, the downloaded export contains `budgets.csv`.

**Done when:** N2 covered; account deletion and category deletion never fail on budget FKs.

---

### Phase 6 — Budgets page UI

**Tasks**
- Sidebar: "Budgets" item (after Categories), icon consistent with existing SVG style.
- `src/routes/_authed/budgets.tsx` following the `categories.tsx` pattern
  (`useServerFn` + `useQuery(["budgets"])`, mutations invalidate `["budgets"]`).
- Page content:
  - Header with month label and "Add Budget" button; usage line "2 of 3 budgets" (Free) / "N budgets" (Pro).
  - Empty state with call to action.
  - Budget card: category badge + path, limit, spent, remaining ("Left: X" / "Over by X"),
    progress bar (`role="progressbar"`, `aria-valuenow`, clamped at 100%), and an
    **"Over budget"** text badge (red; not colour-only). At-limit has its own neutral state.
  - Nested rendering under the budgeted ancestor; no grand total.
  - Non-blocking warning on cards with `exceedsParentLimit`.
  - Multi-currency notice when `multiCurrency`.
  - Add/Edit dialog: category select (hierarchical labels; already-budgeted categories excluded),
    limit input (validated client-side with `parseAmountToMinor`, error messages inline).
    Edit only changes the limit.
  - Delete via `AlertDialog` confirmation.
  - Free limit reached: "Add Budget" still visible; submitting shows the localized upsell
    `budget_limit_reached({ limit })` with a link to `/billing`.
- Billing page: usage row "{used} of {limit} budgets" / unlimited; mention budgets in free/pro blurbs.
- All strings in `messages/en.json` (`nav_budgets`, `budgets_*`, `budget_limit_reached`), `pnpm run i18n:compile`.
- Other mutations (transactions, imports, categories) do not need to invalidate `["budgets"]`:
  the page refetches on mount — confirm `staleTime` default makes that true.

**E2E** (`tests/e2e/budgets.spec.ts`, `signedInUser` with default seed — e.g. Groceries › Vegetables)
- E6.1 Sidebar "Budgets" link navigates to `/budgets`; empty state shown.
- E6.2 Create a budget → card shows limit, 0 spent, full remaining.
- E6.3 Edit the limit → card updates.
- E6.4 Delete with confirmation → card gone, empty state back; cancel keeps it.
- E6.5 Validation: empty / 0 / negative limit shows an error, nothing created.
- E6.6 Budgeted category no longer offered in the category select.
- E6.7 Add an expense today in the category → spent/remaining update after navigating back.
- E6.8 Expense above the limit → "Over budget" badge and "Over by X".
- E6.9 Budget on Groceries + expense in Vegetables → counts in Groceries; with a Vegetables budget too, card is nested and both count it.
- E6.10 Income transaction in the category does not change spent.
- E6.11 Expense dated last month does not count.
- E6.12 Free: 3 budgets OK, 4th → upsell message with link to `/billing`.
- E6.13 `/test-set-plan?plan=pro` → 4th budget succeeds; usage shows unlimited.
- E6.14 Downgrade (`?plan=free`) → all 4 still visible; 5th blocked.
- E6.15 Child limit above parent → warning visible.
- E6.16 Second account with EUR → multi-currency notice visible.
- E6.17 Billing page shows the budgets usage row.
- E6.18 Deleting a budgeted category from the Categories page — and deleting its parent — removes the budget
  from the Budgets page (end-to-end check of the Phase 5 `deleteCategory` wiring, which needs a session
  and so is not reachable from unit tests).

**Done when:** AC1–AC6 and AC8 demonstrable in the browser; E2E green.

---

### Phase 7 — Over-budget email alerts

**Tasks**
- `budgets.server.ts` → `evaluateBudgetAlerts(userId, today = new Date())`:
  1. `getBudgetsOverview`; for each `overBudget` budget:
  2. `INSERT INTO budget_alerts (user_id, category_id, month) ON CONFLICT DO NOTHING RETURNING id`.
  3. Only when a row was inserted, and the user has an email: send the email; on send failure
     delete that alert row (so a later write retries) and log.
  - **Implementation note:** the write paths **await** the evaluation instead of firing and
    forgetting it. The common path is a few cheap queries (an early exit when the user has no
    budgets), and the send latency is paid at most once per budget per month. In exchange the alert
    is committed before the response returns — deterministic for tests and no background work
    outliving the request.
  - **Import-protection note:** each `*.functions.ts` call site must actually use the imported
    `safeEvaluateBudgetAlerts`; an unused import of `#/server/budgets.server` survives into the
    client graph and TanStack Start's import protection fails the build.
- `safeEvaluateBudgetAlerts(userId)` wrapper: never throws — an alert failure must not fail the user's write.
- Email strings: `email_budget_over_subject({ category })`, `email_budget_over_body({ category, spent, limit, month, url })`
  with link to `${APP_BASE_URL}/budgets`.
- Call `safeEvaluateBudgetAlerts` after a successful write in:

  | Write path                                   | File                                 |
  | -------------------------------------------- | ------------------------------------ |
  | create / update transaction                  | `transactions.functions.ts`          |
  | import commit                                | `imports.functions.ts` (~L1078)      |
  | transaction created from a receipt scan      | `receipts.functions.ts` (~L519)      |
  | recategorize / apply rules (3 call sites)    | `categorization.functions.ts`        |
  | delete category with reassignment            | `categories.functions.ts`            |
  | update category (re-parent)                  | `categories.functions.ts`            |
  | create budget / update budget limit          | `budgets.functions.ts`               |

  Not needed (can only lower spend): delete transaction, import undo, budget delete.

**Unit tests**
- U7.1 Crossing the limit sends exactly one email to the user's address (captured via `getCapturedEmails(to)`).
- U7.2 Second evaluation in the same month → no second email.
- U7.3 Concurrent evaluations (`Promise.all`) → one email.
- U7.4 Same budget over again next month → new email.
- U7.5 Delete + re-create the budget in the same month → no second email.
- U7.6 Lowering the limit below current spend → email.
- U7.7 Exactly at limit → no email.
- U7.8 User without email → no email, no error.
- U7.9 Send failure → alert row removed; next evaluation retries and sends.
- U7.10 Two budgets (parent + child) crossed by one transaction → one email each.

**E2E** (`budgets.spec.ts`; extend `signedInUser` fixture to expose `email`)
- E7.1 Budget 100, add a 150 expense via the transactions UI → `/test-emails?to=…` has exactly one budget email naming the category.
- E7.2 Add another expense → still exactly one.
- E7.3 Import a CSV that pushes a budget over → one email (import path covered).

**Done when:** AC7 covered on all write paths; full suite green.

---

### Phase 8 — Final verification & hand-off

- `pnpm run check` green; `pnpm run format` on touched files.
- Manual pass with `playwright-cli` at `localhost:3000`: create budgets, go over, see console email (dev provider), Free limit → upsell, Pro via billing flow if Stripe is configured (else `/test-set-plan` only in TEST_MODE).
- README: short "Budgets" section listing the documented limitations (single currency, transaction-level attribution, server-local month).
- Demo script for the interview (happy path + parent rollup + over-budget + limit upsell + email).
- Review the diff against this spec; tick the AC matrix.

---

## 4. Risks & notes

- **Hook coverage for alerts** — a missed write path means a missed email, silently. Mitigated by the
  table in Phase 7 and E7.3; any new write path in future must call `safeEvaluateBudgetAlerts`.
- **Re-parenting a category** shifts spend between budgets mid-month and may trigger an alert with no new
  spending. Accepted consequence of computing from the current tree.
- **Server-local month** — if the server runs in UTC and the user is UTC+2, the month flips 2h late for them.
  Acceptable for a self-hosted single-region app; note in README.
- **Shared test email buffer** — E2E always filters `/test-emails` by `?to=`.
