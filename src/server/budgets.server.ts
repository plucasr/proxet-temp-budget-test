import { and, countDistinct, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "#/db";
import { monthKey, monthRange } from "#/lib/budget-period";
import { getEntitlements } from "#/server/billing.server";

//
// Monthly category budgets. Server-only — imported by budgets.functions.ts
// handlers and by the write paths that re-evaluate over-budget alerts.
//
// "Spent" is always computed on read for the current calendar month (see
// budget-period.ts), so budgets reset on their own when the month changes.
// Only expenses count (amount_minor < 0) — income and refunds never reduce
// spending — and a budget covers its category's whole subtree, so a parent
// budget includes spending in every descendant category.

// --- Types ---

export interface BudgetStatus {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string | null;
  /** Category names from the root down to the budgeted category. */
  categoryPath: string[];
  /** Nearest ancestor category's budget, for nested rendering. */
  parentBudgetId: string | null;
  /** All amounts are integer minor units (grosze/cents). */
  limit: number;
  spent: number;
  /** limit - spent; negative when over budget. */
  remaining: number;
  /** Strictly over: spending exactly the limit is not over budget. */
  overBudget: boolean;
  /** This limit is higher than the budgeted ancestor's limit. */
  exceedsParentLimit: boolean;
}

export interface BudgetsOverview {
  /** "YYYY-MM" of the month the figures are for. */
  month: string;
  budgets: BudgetStatus[];
  /** Budgets in use vs the plan's cap; limit null = unlimited (Pro). */
  usage: { used: number; limit: number | null };
  /** Accounts span more than one currency — amounts are summed as-is. */
  multiCurrency: boolean;
}

interface CategoryNode {
  id: string;
  name: string;
  color: string | null;
  parent_id: string | null;
}

// --- Category tree helpers ---

/** The category and all its descendants, at any depth. Cycle-safe. */
function subtreeIds(
  rootId: string,
  childrenByParent: Map<string, string[]>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(childrenByParent.get(id) ?? []));
  }
  return seen;
}

/** Ancestor ids from the direct parent up to the root. Cycle-safe. */
function ancestorIds(
  categoryId: string,
  byId: Map<string, CategoryNode>,
): string[] {
  const ancestors: string[] = [];
  const seen = new Set([categoryId]);
  let parentId = byId.get(categoryId)?.parent_id ?? null;
  while (parentId && !seen.has(parentId) && byId.has(parentId)) {
    ancestors.push(parentId);
    seen.add(parentId);
    parentId = byId.get(parentId)?.parent_id ?? null;
  }
  return ancestors;
}

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const cmp = a[i]!.localeCompare(b[i]!);
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}

// --- Server Logic ---

/**
 * Every budget of the user with this month's spending. One aggregate query
 * sums expenses per category; the per-budget subtree roll-up happens in
 * memory over the user's (small) category tree.
 */
export async function getBudgetsOverview(
  userId: string,
  today: Date = new Date(),
): Promise<BudgetsOverview> {
  const { from, toExclusive } = monthRange(today);

  const categories: CategoryNode[] = await db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      color: schema.categories.color,
      parent_id: schema.categories.parent_id,
    })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));

  const budgetRows = await db
    .select({
      id: schema.budgets.id,
      categoryId: schema.budgets.category_id,
      limit: schema.budgets.limit_minor,
    })
    .from(schema.budgets)
    .where(eq(schema.budgets.user_id, userId));

  const spendRows = await db
    .select({
      categoryId: schema.transactions.category_id,
      // SUM over integers is bigint in Postgres (returned as a string) — map back to number.
      spent: sql<number>`COALESCE(SUM(-${schema.transactions.amount_minor}), 0)`.mapWith(Number),
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.user_id, userId),
        gte(schema.transactions.date, from),
        lt(schema.transactions.date, toExclusive),
        lt(schema.transactions.amount_minor, 0),
        isNotNull(schema.transactions.category_id),
      ),
    )
    .groupBy(schema.transactions.category_id);

  const [currencies] = await db
    .select({ count: countDistinct(schema.accounts.currency) })
    .from(schema.accounts)
    .where(eq(schema.accounts.user_id, userId));

  const byId = new Map(categories.map((c) => [c.id, c]));
  const childrenByParent = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parent_id) continue;
    const siblings = childrenByParent.get(c.parent_id) ?? [];
    siblings.push(c.id);
    childrenByParent.set(c.parent_id, siblings);
  }
  const spentByCategory = new Map(
    spendRows.map((r) => [r.categoryId!, r.spent]),
  );
  const budgetByCategory = new Map(budgetRows.map((b) => [b.categoryId, b]));

  const budgets = budgetRows.map((budget): BudgetStatus => {
    const category = byId.get(budget.categoryId);
    const ancestors = ancestorIds(budget.categoryId, byId);

    let spent = 0;
    for (const id of subtreeIds(budget.categoryId, childrenByParent)) {
      spent += spentByCategory.get(id) ?? 0;
    }

    const parentBudget =
      ancestors
        .map((id) => budgetByCategory.get(id))
        .find((b) => b !== undefined) ?? null;

    return {
      id: budget.id,
      categoryId: budget.categoryId,
      categoryName: category?.name ?? "",
      categoryColor: category?.color ?? null,
      categoryPath: [...ancestors]
        .reverse()
        .map((id) => byId.get(id)!.name)
        .concat(category?.name ?? ""),
      parentBudgetId: parentBudget?.id ?? null,
      limit: budget.limit,
      spent,
      remaining: budget.limit - spent,
      overBudget: spent > budget.limit,
      exceedsParentLimit: parentBudget !== null && budget.limit > parentBudget.limit,
    };
  });

  budgets.sort((a, b) => comparePaths(a.categoryPath, b.categoryPath));

  const entitlements = await getEntitlements(userId);

  return {
    month: monthKey(today),
    budgets,
    usage: { used: budgets.length, limit: entitlements.maxBudgets },
    multiCurrency: (currencies?.count ?? 0) > 1,
  };
}
