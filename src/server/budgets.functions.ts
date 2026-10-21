import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  createBudgetForUser,
  deleteBudgetForUser,
  getBudgetsOverview,
  safeEvaluateBudgetAlerts,
  updateBudgetForUser,
} from "#/server/budgets.server";
import { requireUserId } from "#/server/session";

// Client-callable budgets surface. Handlers stay thin — business rules,
// ownership checks and the plan gate live in budgets.server.ts.

/** Upper bound for a monthly limit: 10,000,000.00 in minor units. */
export const MAX_BUDGET_LIMIT_MINOR = 1_000_000_000;

// Amounts arrive as integer minor units — the client converts its decimal
// input with parseAmountToMinor, as transactions do.
const limitMinorSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_BUDGET_LIMIT_MINOR);

export const createBudgetSchema = z.object({
  categoryId: z.string().min(1),
  limitMinor: limitMinorSchema,
});

export const updateBudgetSchema = z.object({
  id: z.string().min(1),
  limitMinor: limitMinorSchema,
});

export const deleteBudgetSchema = z.object({
  id: z.string().min(1),
});

export const getBudgets = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    return getBudgetsOverview(userId);
  },
);

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(createBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const result = await createBudgetForUser(userId, data);
    // A new budget may already be over its limit this month.
    if ("success" in result) await safeEvaluateBudgetAlerts(userId);
    return result;
  });

export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(updateBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const result = await updateBudgetForUser(userId, data);
    // Lowering a limit below this month's spending counts as going over.
    if ("success" in result) await safeEvaluateBudgetAlerts(userId);
    return result;
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(deleteBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return deleteBudgetForUser(userId, data);
  });
