import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "#/db";
import { isEmailVerified, requireUserId } from "#/server/session";
import { matchRule, type RuleRow } from "#/server/imports.functions";
import { categorizeDescription, isAIVisible } from "#/server/ai";
import { checkSpendCap } from "#/server/ai-usage.server";
import { safeEvaluateBudgetAlerts } from "#/server/budgets.server";


const transactionCountsSchema = z.object({
  mode: z.enum(["only_uncategorized", "overwrite_all"]),
});

export const getTransactionCounts = createServerFn({ method: "POST" })
  .inputValidator(transactionCountsSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    const conditions = [eq(schema.transactions.user_id, userId)];
    if (data.mode === "only_uncategorized") {
      conditions.push(isNull(schema.transactions.category_id));
    }

    const countResult = await db
      .select({ count: sql`COUNT(*)` })
      .from(schema.transactions)
      .where(and(...conditions));

    return { count: Number(countResult[0].count) };
  });

export const getAiStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    return { visible: isAIVisible() };
  },
);

const matchTypeSchema = z.enum(["substring", "exact"]);

const createRuleSchema = z.object({
  pattern: z.string().min(1, "Pattern is required").max(256),
  matchType: matchTypeSchema.default("substring"),
  categoryId: z.string().min(1, "Category is required"),
  priority: z.number().int().optional(),
});

const updateRuleSchema = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1).max(256).optional(),
  matchType: matchTypeSchema.optional(),
  categoryId: z.string().min(1).optional(),
  priority: z.number().int().optional(),
});

const ruleIdSchema = z.object({ id: z.string().min(1) });

const previewRuleImpactSchema = z.object({
  pattern: z.string().min(1),
  matchType: matchTypeSchema.default("substring"),
  categoryId: z.string().min(1),
  // When updating an existing rule, exclude its prior matches from the
  // overwrite count for the same target category (idempotent edit).
  excludeRuleId: z.string().optional(),
});

const applyRuleSchema = z.object({
  ruleId: z.string().min(1),
  mode: z.enum(["only_uncategorized", "overwrite_all"]),
});

const reorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const getCategorizationRules = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    const rows = await db
      .select({
        id: schema.categorization_rules.id,
        pattern: schema.categorization_rules.pattern,
        match_type: schema.categorization_rules.match_type,
        category_id: schema.categorization_rules.category_id,
        priority: schema.categorization_rules.priority,
        created_at: schema.categorization_rules.created_at,
        source: schema.categorization_rules.source,
        category_name: schema.categories.name,
        category_color: schema.categories.color,
      })
      .from(schema.categorization_rules)
      .leftJoin(
        schema.categories,
        eq(schema.categorization_rules.category_id, schema.categories.id),
      )
      .where(eq(schema.categorization_rules.user_id, userId))
      .orderBy(
        asc(schema.categorization_rules.priority),
        asc(schema.categorization_rules.created_at),
      );
    return rows;
  },
);

async function ensureCategoryOwned(userId: string, categoryId: string) {
  const found = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.id, categoryId),
        eq(schema.categories.user_id, userId),
      ),
    )
    .limit(1);
  return found.length > 0;
}

export const createCategorizationRule = createServerFn({ method: "POST" })
  .inputValidator(createRuleSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    if (!(await ensureCategoryOwned(userId, data.categoryId))) {
      return { error: "Category does not exist" };
    }
    const id = crypto.randomUUID();
    await db.insert(schema.categorization_rules).values({
      id,
      user_id: userId,
      pattern: data.pattern,
      match_type: data.matchType,
      category_id: data.categoryId,
      priority: data.priority ?? 100,
    });
    return { id };
  });

export const updateCategorizationRule = createServerFn({ method: "POST" })
  .inputValidator(updateRuleSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const existing = await db
      .select({ id: schema.categorization_rules.id })
      .from(schema.categorization_rules)
      .where(
        and(
          eq(schema.categorization_rules.id, data.id),
          eq(schema.categorization_rules.user_id, userId),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      return { error: "Rule not found" };
    }
    if (data.categoryId && !(await ensureCategoryOwned(userId, data.categoryId))) {
      return { error: "Category does not exist" };
    }
    const update: Record<string, unknown> = {};
    if (data.pattern !== undefined) update.pattern = data.pattern;
    if (data.matchType !== undefined) update.match_type = data.matchType;
    if (data.categoryId !== undefined) update.category_id = data.categoryId;
    if (data.priority !== undefined) update.priority = data.priority;
    if (Object.keys(update).length === 0) {
      return { success: true };
    }
    await db
      .update(schema.categorization_rules)
      .set(update)
      .where(
        and(
          eq(schema.categorization_rules.id, data.id),
          eq(schema.categorization_rules.user_id, userId),
        ),
      );
    return { success: true };
  });

export const deleteCategorizationRule = createServerFn({ method: "POST" })
  .inputValidator(ruleIdSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    await db
      .delete(schema.categorization_rules)
      .where(
        and(
          eq(schema.categorization_rules.id, data.id),
          eq(schema.categorization_rules.user_id, userId),
        ),
      );
    return { success: true };
  });

// Counts how many existing transactions a candidate rule would (a) categorize
// when uncategorized, and (b) overwrite when already categorized to a
// different target. Returns sample rows for the UI's confirmation dialog.
export const previewRuleImpact = createServerFn({ method: "POST" })
  .inputValidator(previewRuleImpactSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const rows = await db
      .select({
        id: schema.transactions.id,
        description: schema.transactions.description,
        category_id: schema.transactions.category_id,
        date: schema.transactions.date,
        amount_minor: schema.transactions.amount_minor,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.user_id, userId));

    const fakeRule: RuleRow = {
      id: "preview",
      pattern: data.pattern,
      match_type: data.matchType,
      category_id: data.categoryId,
      priority: 0,
    };

    let wouldCategorize = 0;
    let wouldOverwrite = 0;
    const overwriteSamples: { description: string; date: string }[] = [];

    for (const r of rows) {
      const desc = r.description ?? "";
      const matched = matchRule(desc, [fakeRule]);
      if (!matched) continue;
      if (r.category_id === null) {
        wouldCategorize++;
      } else if (r.category_id !== data.categoryId) {
        wouldOverwrite++;
        if (overwriteSamples.length < 5) {
          overwriteSamples.push({ description: desc, date: r.date });
        }
      }
    }

    return { wouldCategorize, wouldOverwrite, overwriteSamples };
  });

export const applyRuleToExisting = createServerFn({ method: "POST" })
  .inputValidator(applyRuleSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const ruleRows = await db
      .select({
        id: schema.categorization_rules.id,
        pattern: schema.categorization_rules.pattern,
        match_type: schema.categorization_rules.match_type,
        category_id: schema.categorization_rules.category_id,
        priority: schema.categorization_rules.priority,
      })
      .from(schema.categorization_rules)
      .where(
        and(
          eq(schema.categorization_rules.id, data.ruleId),
          eq(schema.categorization_rules.user_id, userId),
        ),
      )
      .limit(1);
    if (ruleRows.length === 0) {
      return { error: "Rule not found" };
    }
    const rule = ruleRows[0];

    const conditions = [eq(schema.transactions.user_id, userId)];
    if (data.mode === "only_uncategorized") {
      conditions.push(isNull(schema.transactions.category_id));
    }

    const candidates = await db
      .select({
        id: schema.transactions.id,
        description: schema.transactions.description,
        category_id: schema.transactions.category_id,
      })
      .from(schema.transactions)
      .where(and(...conditions));

    let updated = 0;
    for (const t of candidates) {
      const matched = matchRule(t.description ?? "", [rule]);
      if (!matched) continue;
      if (t.category_id === rule.category_id) continue;
      await db
        .update(schema.transactions)
        .set({ category_id: rule.category_id })
        .where(
          and(
            eq(schema.transactions.id, t.id),
            eq(schema.transactions.user_id, userId),
          ),
        );
      updated++;
    }
    if (updated > 0) {
      // Moving transactions between categories shifts budget spending.
      await safeEvaluateBudgetAlerts(userId);
    }
    return { success: true, updated };
  });

export const reorderCategorizationRules = createServerFn({ method: "POST" })
  .inputValidator(reorderSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    // Verify all ids belong to the user.
    const owned = await db
      .select({ id: schema.categorization_rules.id })
      .from(schema.categorization_rules)
      .where(eq(schema.categorization_rules.user_id, userId));
    const ownedSet = new Set(owned.map((r) => r.id));
    for (const id of data.ids) {
      if (!ownedSet.has(id)) {
        return { error: "Rule not owned by user" };
      }
    }
    // Use a wide gap so future single inserts don't need a full re-numbering.
    const STEP = 10;
    for (let i = 0; i < data.ids.length; i++) {
      await db
        .update(schema.categorization_rules)
        .set({ priority: (i + 1) * STEP })
        .where(
          and(
            eq(schema.categorization_rules.id, data.ids[i]),
            eq(schema.categorization_rules.user_id, userId),
          ),
        );
    }
    return { success: true };
  });


const reCategorizeSchema = z.object({
  mode: z.enum(["only_uncategorized", "overwrite_all"]),
  useAi: z.boolean().default(false),
});

export const reCategorizeTransactions = createServerFn({ method: "POST" })
  .inputValidator(reCategorizeSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    const conditions = [eq(schema.transactions.user_id, userId)];
    if (data.mode === "only_uncategorized") {
      conditions.push(isNull(schema.transactions.category_id));
    }

    const candidates = await db
      .select({
        id: schema.transactions.id,
        description: schema.transactions.description,
        category_id: schema.transactions.category_id,
      })
      .from(schema.transactions)
      .where(and(...conditions));

    if (candidates.length === 0) {
      return { updated: 0, aiCategorized: 0, skipped: 0 };
    }

    const userRules = await db
      .select({
        id: schema.categorization_rules.id,
        pattern: schema.categorization_rules.pattern,
        match_type: schema.categorization_rules.match_type,
        category_id: schema.categorization_rules.category_id,
        priority: schema.categorization_rules.priority,
      })
      .from(schema.categorization_rules)
      .where(eq(schema.categorization_rules.user_id, userId))
      .orderBy(
        asc(schema.categorization_rules.priority),
        asc(schema.categorization_rules.created_at),
      );

    const allCategories = await db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
      })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId));

    // AI spend is gated on a verified email and the global daily spend cap;
    // rule-based recategorization below is unaffected.
    const aiAllowed =
      data.useAi &&
      isAIVisible() &&
      (await isEmailVerified(userId)) &&
      (await checkSpendCap()).allowed;

    let updated = 0;
    let aiCategorized = 0;
    let skipped = 0;
    const aiRulesToCreate: Array<{
      pattern: string;
      match_type: "substring" | "exact";
      category_id: string;
    }> = [];

    // In-run memo by normalized description: N transactions with the same
    // merchant string cost one AI call, not N (the rules created from AI
    // suggestions only land after the loop, so they can't short-circuit it).
    const aiMemo = new Map<string, string | null>();

    const applyCategory = async (txnId: string, categoryId: string) => {
      await db
        .update(schema.transactions)
        .set({ category_id: categoryId })
        .where(
          and(
            eq(schema.transactions.id, txnId),
            eq(schema.transactions.user_id, userId),
          ),
        );
    };

    for (const t of candidates) {
      const desc = t.description ?? "";
      const matched = matchRule(desc, userRules);

      if (matched) {
        if (t.category_id === matched.category_id) {
          skipped++;
        } else {
          await db
            .update(schema.transactions)
            .set({ category_id: matched.category_id })
            .where(
              and(
                eq(schema.transactions.id, t.id),
                eq(schema.transactions.user_id, userId),
              ),
            );
          updated++;
        }
        continue;
      }

      if (aiAllowed) {
        const memoKey = desc.trim().toUpperCase();
        if (aiMemo.has(memoKey)) {
          const memoCategoryId = aiMemo.get(memoKey);
          if (memoCategoryId) {
            await applyCategory(t.id, memoCategoryId);
            updated++;
            aiCategorized++;
          } else {
            skipped++;
          }
          continue;
        }

        const result = await categorizeDescription(desc, allCategories, {
          userId,
          kind: "categorize",
        });
        if (result.success) {
          const matchedCategory = allCategories.find(
            (c) => c.name.toLowerCase() === result.category_name.toLowerCase(),
          );
          if (matchedCategory) {
            const pattern = result.pattern || desc;
            aiRulesToCreate.push({
              pattern,
              match_type: result.pattern ? "substring" : "exact",
              category_id: matchedCategory.id,
            });
            aiMemo.set(memoKey, matchedCategory.id);
            await applyCategory(t.id, matchedCategory.id);
            updated++;
            aiCategorized++;
          } else {
            aiMemo.set(memoKey, null);
            skipped++;
          }
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }

    if (aiRulesToCreate.length > 0) {
      const aiRulesInsert = aiRulesToCreate.map((rule) => ({
        id: crypto.randomUUID(),
        user_id: userId,
        pattern: rule.pattern,
        match_type: rule.match_type,
        category_id: rule.category_id,
        priority: 50,
        source: "ai" as const,
      }));
      await db.insert(schema.categorization_rules).values(aiRulesInsert);
    }

    if (updated > 0) {
      // Moving transactions between categories shifts budget spending.
      await safeEvaluateBudgetAlerts(userId);
    }
    return { updated, aiCategorized, skipped };
  });
