// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { monthKey, monthRange } from "../src/lib/budget-period.ts";
import { getBudgetsOverview } from "../src/server/budgets.server.ts";

// Every test uses its own ids — the in-memory DB is shared across the file.

const userId = "budgets-schema-user";
const categoryId = "budgets-schema-cat";

beforeAll(async () => {
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    password_hash: "x",
  });
  await db.insert(schema.categories).values({
    id: categoryId,
    user_id: userId,
    name: "Groceries",
  });
});

/** Drizzle wraps driver errors; the Postgres error code lives on `cause`. */
async function pgErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const err = error as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? "unknown";
  }
  throw new Error("expected the query to fail");
}

describe("budgets schema constraints", () => {
  it("allows only one budget per category per user", async () => {
    await db.insert(schema.budgets).values({
      id: "budgets-schema-b1",
      user_id: userId,
      category_id: categoryId,
      limit_minor: 50_000,
    });

    const code = await pgErrorCode(
      db.insert(schema.budgets).values({
        id: "budgets-schema-b2",
        user_id: userId,
        category_id: categoryId,
        limit_minor: 10_000,
      }),
    );
    // 23505 = unique_violation
    expect(code).toBe("23505");
  });

  it.each([0, -100])("rejects a non-positive limit (%i)", async (limit) => {
    await db.insert(schema.categories).values({
      id: `budgets-schema-cat-${limit}`,
      user_id: userId,
      name: `Limit ${limit}`,
    });

    const code = await pgErrorCode(
      db.insert(schema.budgets).values({
        id: `budgets-schema-bad-${limit}`,
        user_id: userId,
        category_id: `budgets-schema-cat-${limit}`,
        limit_minor: limit,
      }),
    );
    // 23514 = check_violation
    expect(code).toBe("23514");
  });

  it("allows only one alert per category per month", async () => {
    await db.insert(schema.budget_alerts).values({
      id: "budgets-schema-alert-1",
      user_id: userId,
      category_id: categoryId,
      month: "2026-10",
    });

    const duplicate = await db
      .insert(schema.budget_alerts)
      .values({
        id: "budgets-schema-alert-2",
        user_id: userId,
        category_id: categoryId,
        month: "2026-10",
      })
      .onConflictDoNothing()
      .returning({ id: schema.budget_alerts.id });
    expect(duplicate).toHaveLength(0);

    const nextMonth = await db
      .insert(schema.budget_alerts)
      .values({
        id: "budgets-schema-alert-3",
        user_id: userId,
        category_id: categoryId,
        month: "2026-11",
      })
      .onConflictDoNothing()
      .returning({ id: schema.budget_alerts.id });
    expect(nextMonth).toHaveLength(1);
  });
});

// --- Budget period -----------------------------------------------------------

describe("budget period", () => {
  it("keys and ranges a mid-year month", () => {
    const date = new Date(2026, 9, 21); // Oct 21, 2026 local
    expect(monthKey(date)).toBe("2026-10");
    expect(monthRange(date)).toEqual({
      from: "2026-10-01",
      toExclusive: "2026-11-01",
    });
  });

  it("rolls December over into the next year", () => {
    const date = new Date(2026, 11, 31);
    expect(monthKey(date)).toBe("2026-12");
    expect(monthRange(date)).toEqual({
      from: "2026-12-01",
      toExclusive: "2027-01-01",
    });
  });

  it("treats the first and last day as the same month", () => {
    expect(monthRange(new Date(2026, 1, 1))).toEqual(
      monthRange(new Date(2026, 1, 28)),
    );
  });
});

// --- Budget status calculation ----------------------------------------------

// "Today" for every status test: Oct 21, 2026 → month 2026-10.
const TODAY = new Date(2026, 9, 21);

/**
 * Seed a user with a three-level category tree and one PLN account:
 *   Food › Groceries › Vegetables, plus an unrelated Transport category.
 */
async function seedBudgetUser(prefix: string) {
  const userId = `${prefix}-user`;
  const cat = {
    food: `${prefix}-food`,
    groceries: `${prefix}-groceries`,
    vegetables: `${prefix}-vegetables`,
    transport: `${prefix}-transport`,
  };
  const accountId = `${prefix}-acc`;
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    password_hash: "x",
  });
  await db.insert(schema.categories).values([
    { id: cat.food, user_id: userId, name: "Food" },
    { id: cat.groceries, user_id: userId, name: "Groceries", parent_id: cat.food },
    {
      id: cat.vegetables,
      user_id: userId,
      name: "Vegetables",
      parent_id: cat.groceries,
    },
    { id: cat.transport, user_id: userId, name: "Transport" },
  ]);
  await db.insert(schema.accounts).values({
    id: accountId,
    user_id: userId,
    name: "Main",
    currency: "PLN",
  });

  let seq = 0;
  const addTxn = (
    date: string,
    amountMinor: number,
    categoryId: string | null,
    owner = userId,
    account = accountId,
  ) =>
    db.insert(schema.transactions).values({
      id: `${prefix}-txn-${seq++}`,
      user_id: owner,
      account_id: account,
      date,
      amount_minor: amountMinor,
      category_id: categoryId,
    });
  const addBudget = (categoryId: string, limitMinor: number) =>
    db.insert(schema.budgets).values({
      id: `${prefix}-budget-${seq++}`,
      user_id: userId,
      category_id: categoryId,
      limit_minor: limitMinor,
    });

  return { userId, cat, accountId, addTxn, addBudget };
}

async function overviewFor(userId: string) {
  return getBudgetsOverview(userId, TODAY);
}

describe("getBudgetsOverview", () => {
  it("returns an empty list for a user without budgets", async () => {
    const { userId } = await seedBudgetUser("bo-empty");
    const overview = await overviewFor(userId);
    expect(overview).toEqual({
      month: "2026-10",
      budgets: [],
      usage: { used: 0, limit: 3 },
      multiCurrency: false,
    });
  });

  it("reports full remaining when nothing was spent", async () => {
    const { userId, cat, addBudget } = await seedBudgetUser("bo-zero");
    await addBudget(cat.transport, 30_000);

    const [budget] = (await overviewFor(userId)).budgets;
    expect(budget).toMatchObject({
      categoryId: cat.transport,
      categoryName: "Transport",
      categoryPath: ["Transport"],
      parentBudgetId: null,
      limit: 30_000,
      spent: 0,
      remaining: 30_000,
      overBudget: false,
      exceedsParentLimit: false,
    });
  });

  it("includes spending in direct subcategories", async () => {
    const { userId, cat, addTxn, addBudget } = await seedBudgetUser("bo-child");
    await addBudget(cat.groceries, 50_000);
    await addTxn("2026-10-05", -10_000, cat.groceries);
    await addTxn("2026-10-06", -2_500, cat.vegetables);

    const [budget] = (await overviewFor(userId)).budgets;
    expect(budget!.spent).toBe(12_500);
    expect(budget!.remaining).toBe(37_500);
  });

  it("includes spending at any depth below the budgeted category", async () => {
    const { userId, cat, addTxn, addBudget } = await seedBudgetUser("bo-deep");
    await addBudget(cat.food, 100_000);
    await addTxn("2026-10-05", -1_000, cat.food);
    await addTxn("2026-10-05", -2_000, cat.groceries);
    await addTxn("2026-10-05", -3_000, cat.vegetables);
    await addTxn("2026-10-05", -9_999, cat.transport); // other branch

    const [budget] = (await overviewFor(userId)).budgets;
    expect(budget!.spent).toBe(6_000);
  });

  it("ignores income and refunds — they never reduce spent", async () => {
    const { userId, cat, addTxn, addBudget } = await seedBudgetUser("bo-income");
    await addBudget(cat.groceries, 50_000);
    await addTxn("2026-10-05", -20_000, cat.groceries);
    await addTxn("2026-10-06", 15_000, cat.groceries); // refund
    await addTxn("2026-10-07", 5_000, cat.vegetables); // income in subtree

    const [budget] = (await overviewFor(userId)).budgets;
    expect(budget!.spent).toBe(20_000);
  });

  it("only counts the current month, boundaries included", async () => {
    const { userId, cat, addTxn, addBudget } = await seedBudgetUser("bo-month");
    await addBudget(cat.groceries, 50_000);
    await addTxn("2026-09-30", -1, cat.groceries); // previous month
    await addTxn("2026-10-01", -10, cat.groceries); // first day
    await addTxn("2026-10-31", -100, cat.groceries); // last day
    await addTxn("2026-11-01", -1_000, cat.groceries); // next month
    await addTxn("2025-10-15", -10_000, cat.groceries); // same month, last year

    const [budget] = (await overviewFor(userId)).budgets;
    expect(budget!.spent).toBe(110);
  });

  it("resets when the month changes", async () => {
    const { userId, cat, addTxn, addBudget } = await seedBudgetUser("bo-reset");
    await addBudget(cat.groceries, 50_000);
    await addTxn("2026-10-10", -40_000, cat.groceries);

    const october = await getBudgetsOverview(userId, TODAY);
    const november = await getBudgetsOverview(userId, new Date(2026, 10, 2));
    expect(october.budgets[0]!.spent).toBe(40_000);
    expect(november.month).toBe("2026-11");
    expect(november.budgets[0]!.spent).toBe(0);
    expect(november.budgets[0]!.remaining).toBe(50_000);
  });

  it("never counts uncategorized or other users' transactions", async () => {
    const { userId, cat, addTxn, addBudget } = await seedBudgetUser("bo-scope");
    const other = await seedBudgetUser("bo-scope-other");
    await addBudget(cat.groceries, 50_000);
    await addTxn("2026-10-05", -5_000, null);
    // Another user's expense pointing at this user's category id.
    await other.addTxn(
      "2026-10-05",
      -7_000,
      cat.groceries,
      other.userId,
      other.accountId,
    );

    const [budget] = (await overviewFor(userId)).budgets;
    expect(budget!.spent).toBe(0);
  });

  it("is over budget only when spent strictly exceeds the limit", async () => {
    const { userId, cat, addTxn, addBudget } = await seedBudgetUser("bo-over");
    await addBudget(cat.groceries, 10_000);
    await addBudget(cat.transport, 10_000);
    await addTxn("2026-10-05", -10_000, cat.groceries); // exactly at limit
    await addTxn("2026-10-05", -12_345, cat.transport); // over

    const budgets = (await overviewFor(userId)).budgets;
    const groceries = budgets.find((b) => b.categoryId === cat.groceries)!;
    const transport = budgets.find((b) => b.categoryId === cat.transport)!;
    expect(groceries).toMatchObject({ remaining: 0, overBudget: false });
    expect(transport).toMatchObject({ remaining: -2_345, overBudget: true });
  });

  it("counts child spending in both parent and child budgets and links them", async () => {
    const { userId, cat, addTxn, addBudget } = await seedBudgetUser("bo-nested");
    await addBudget(cat.food, 100_000);
    await addBudget(cat.vegetables, 5_000);
    await addTxn("2026-10-05", -3_000, cat.vegetables);

    const budgets = (await overviewFor(userId)).budgets;
    const food = budgets.find((b) => b.categoryId === cat.food)!;
    const vegetables = budgets.find((b) => b.categoryId === cat.vegetables)!;
    expect(food.spent).toBe(3_000);
    expect(vegetables.spent).toBe(3_000);
    // Nearest budgeted ancestor, skipping the unbudgeted Groceries level.
    expect(vegetables.parentBudgetId).toBe(food.id);
    expect(vegetables.categoryPath).toEqual(["Food", "Groceries", "Vegetables"]);
    expect(food.parentBudgetId).toBeNull();
    // Tree order: parent before child.
    expect(budgets.map((b) => b.categoryName)).toEqual(["Food", "Vegetables"]);
  });

  it("flags a child limit higher than its budgeted ancestor's", async () => {
    const { userId, cat, addBudget } = await seedBudgetUser("bo-exceeds");
    await addBudget(cat.food, 10_000);
    await addBudget(cat.groceries, 20_000); // higher than parent
    await addBudget(cat.vegetables, 5_000); // lower than nearest (Groceries)

    const budgets = (await overviewFor(userId)).budgets;
    const byCategory = (id: string) => budgets.find((b) => b.categoryId === id)!;
    expect(byCategory(cat.food).exceedsParentLimit).toBe(false);
    expect(byCategory(cat.groceries).exceedsParentLimit).toBe(true);
    expect(byCategory(cat.vegetables).exceedsParentLimit).toBe(false);
  });

  it("detects accounts in more than one currency", async () => {
    const { userId } = await seedBudgetUser("bo-currency");
    await db.insert(schema.accounts).values({
      id: "bo-currency-acc-2",
      user_id: userId,
      name: "Savings",
      currency: "PLN",
    });
    expect((await overviewFor(userId)).multiCurrency).toBe(false);

    await db.insert(schema.accounts).values({
      id: "bo-currency-acc-eur",
      user_id: userId,
      name: "Euro",
      currency: "EUR",
    });
    expect((await overviewFor(userId)).multiCurrency).toBe(true);
  });
});

describe("getBudgetsOverview usage", () => {
  it("counts budgets against the free cap and is unlimited on pro", async () => {
    const { userId, cat, addBudget } = await seedBudgetUser("bo-usage");
    await addBudget(cat.food, 10_000);
    await addBudget(cat.transport, 10_000);
    expect((await overviewFor(userId)).usage).toEqual({ used: 2, limit: 3 });

    await db.insert(schema.subscriptions).values({
      user_id: userId,
      plan: "pro",
      status: "active",
    });
    expect((await overviewFor(userId)).usage).toEqual({
      used: 2,
      limit: null,
    });
  });
});
