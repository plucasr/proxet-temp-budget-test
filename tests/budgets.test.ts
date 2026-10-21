// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";

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
