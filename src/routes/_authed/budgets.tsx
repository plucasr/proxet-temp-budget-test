import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { m } from "#/paraglide/messages";
import { formatMonthLabel } from "#/lib/budget-period";
import { formatMinor, parseAmountToMinor } from "#/lib/money";
import { cn } from "#/lib/utils";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
  MAX_BUDGET_LIMIT_MINOR,
} from "#/server/budgets.functions";
import { getCategories } from "#/server/categories.functions";

type BudgetsOverview = Awaited<ReturnType<typeof getBudgets>>;
type Budget = BudgetsOverview["budgets"][number];
type CategoryRow =
  ReturnType<typeof getCategories> extends Promise<(infer T)[]> ? T : never;
type BudgetMutationResult = Awaited<ReturnType<typeof createBudget>>;

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

const BUDGETS_QUERY_KEY = ["budgets"] as const;
// Shared with the Categories page — same server function, same cache entry.
const CATEGORIES_QUERY_KEY = ["categories"] as const;

// --- Helpers ---

/** Amounts are summed as-is (single-currency assumption, like the dashboard). */
function formatAmount(minor: number): string {
  return `${formatMinor(minor)} ${m.analytics_currency()}`;
}

/** Category label with its ancestors, e.g. "Groceries › Vegetables". */
function categoryLabels(categories: CategoryRow[]): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const labels = new Map<string, string>();
  for (const category of categories) {
    const names = [category.name];
    const seen = new Set([category.id]);
    let parentId = category.parent_id;
    while (parentId && !seen.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) break;
      names.unshift(parent.name);
      seen.add(parentId);
      parentId = parent.parent_id;
    }
    labels.set(category.id, names.join(" › "));
  }
  return labels;
}

/** Flatten budgets into display order, each nested under the nearest
 * budgeted ancestor. The server returns them in category-tree order. */
function flattenBudgetTree(
  budgets: Budget[],
): Array<{ budget: Budget; depth: number }> {
  const ids = new Set(budgets.map((b) => b.id));
  const childrenOf = new Map<string, Budget[]>();
  const roots: Budget[] = [];
  for (const budget of budgets) {
    if (budget.parentBudgetId && ids.has(budget.parentBudgetId)) {
      const siblings = childrenOf.get(budget.parentBudgetId) ?? [];
      siblings.push(budget);
      childrenOf.set(budget.parentBudgetId, siblings);
    } else {
      roots.push(budget);
    }
  }
  const rows: Array<{ budget: Budget; depth: number }> = [];
  const visit = (budget: Budget, depth: number) => {
    rows.push({ budget, depth });
    for (const child of childrenOf.get(budget.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/** Localized message for a failed budget mutation. */
function mutationErrorMessage(
  result: Exclude<BudgetMutationResult, { success: true }>,
): React.ReactNode {
  switch (result.code) {
    case "budget_limit_reached":
      return (
        <>
          {m.budget_limit_reached({ limit: result.limit ?? 0 })}{" "}
          <Link to="/billing" className="font-medium underline">
            {m.budget_upgrade_link()}
          </Link>
        </>
      );
    case "budget_exists":
      return m.budget_exists();
    case "category_not_found":
      return m.budget_category_not_found();
    case "budget_not_found":
      return m.budget_not_found();
    default:
      return result.error;
  }
}

// --- Budget Card ---

function BudgetCard({
  budget,
  depth,
  parentName,
  hasSubcategories,
  onEdit,
  onDelete,
}: {
  budget: Budget;
  depth: number;
  parentName: string | null;
  hasSubcategories: boolean;
  onEdit: (budget: Budget) => void;
  onDelete: (budget: Budget) => void;
}) {
  const atLimit = !budget.overBudget && budget.spent === budget.limit;
  const percentUsed = Math.min(
    100,
    Math.round((budget.spent / budget.limit) * 100),
  );
  const ancestors = budget.categoryPath.slice(0, -1);

  return (
    <li
      aria-label={budget.categoryName}
      data-testid="budget-card"
      className={cn(
        "rounded-xl border bg-card p-4",
        budget.overBudget ? "border-destructive/50" : "border-line/50",
      )}
      style={{ marginLeft: `${depth * 24}px` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="size-3 shrink-0 rounded-full"
              style={{ backgroundColor: budget.categoryColor ?? "#6b7280" }}
              aria-hidden="true"
            />
            {ancestors.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {ancestors.join(" › ")} ›
              </span>
            )}
            <span className="text-sm font-semibold">{budget.categoryName}</span>
            {budget.overBudget && (
              <Badge variant="destructive">{m.budget_over_badge()}</Badge>
            )}
            {atLimit && (
              <Badge variant="secondary">{m.budget_at_limit_badge()}</Badge>
            )}
          </div>
          {hasSubcategories && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {m.budget_includes_subcategories()}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <EditButton onClick={() => onEdit(budget)} data-testid="edit-budget" />
          <DeleteButton
            onClick={() => onDelete(budget)}
            data-testid="delete-budget"
          />
        </div>
      </div>

      <div
        role="progressbar"
        aria-label={m.budget_progress_label({ category: budget.categoryName })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentUsed}
        className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            budget.overBudget ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${percentUsed}%` }}
        />
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">
            {m.budget_limit_label()}
          </dt>
          <dd className="tabular-nums" data-testid="budget-limit">
            {formatAmount(budget.limit)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            {m.budget_spent_label()}
          </dt>
          <dd className="tabular-nums" data-testid="budget-spent">
            {formatAmount(budget.spent)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            {budget.overBudget
              ? m.budget_over_by_label()
              : m.budget_remaining_label()}
          </dt>
          <dd
            className={cn(
              "tabular-nums",
              budget.overBudget && "font-semibold text-destructive",
            )}
            data-testid="budget-remaining"
          >
            {formatAmount(Math.abs(budget.remaining))}
          </dd>
        </div>
      </dl>

      {budget.exceedsParentLimit && parentName && (
        <p
          className="mt-3 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400"
          data-testid="budget-exceeds-parent"
        >
          {m.budget_exceeds_parent({ parent: parentName })}
        </p>
      )}
    </li>
  );
}

// --- Budget Form Modal ---

interface BudgetFormData {
  categoryId: string;
  limitMinor: number;
}

function BudgetForm({
  isOpen,
  editingBudget,
  categoryOptions,
  onClose,
  onSubmit,
  error,
}: {
  isOpen: boolean;
  editingBudget: Budget | null;
  /** Categories without a budget, with their full-path labels. */
  categoryOptions: Array<{ id: string; label: string }>;
  onClose: () => void;
  onSubmit: (data: BudgetFormData) => Promise<void>;
  error: React.ReactNode;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCategoryId(editingBudget?.categoryId ?? "");
      setLimit(editingBudget ? formatMinor(editingBudget.limit) : "");
      setValidationError(null);
      setSubmitting(false);
    }
  }, [isOpen, editingBudget]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!categoryId) {
      setValidationError(m.budget_category_required());
      return;
    }
    const limitMinor = parseAmountToMinor(limit);
    if (
      limitMinor === null ||
      limitMinor <= 0 ||
      limitMinor > MAX_BUDGET_LIMIT_MINOR
    ) {
      setValidationError(
        m.budget_limit_invalid({ max: formatMinor(MAX_BUDGET_LIMIT_MINOR) }),
      );
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    try {
      await onSubmit({ categoryId, limitMinor });
    } finally {
      setSubmitting(false);
    }
  };

  const noCategoriesLeft = !editingBudget && categoryOptions.length === 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingBudget ? m.edit_budget_title() : m.add_budget()}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="budget-category" className="mb-1">
              {m.budget_category_label()}
            </Label>
            <Select
              id="budget-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={editingBudget !== null}
            >
              {editingBudget ? (
                <SelectItem value={editingBudget.categoryId}>
                  {editingBudget.categoryPath.join(" › ")}
                </SelectItem>
              ) : (
                <>
                  <SelectItem value="">{m.budget_select_category()}</SelectItem>
                  {categoryOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </>
              )}
            </Select>
            {noCategoriesLeft && (
              <p className="mt-1 text-xs text-muted-foreground">
                {m.budget_no_categories_left()}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budget_limit_input_label()}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="budget-limit"
                type="text"
                inputMode="decimal"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="500.00"
                autoFocus={editingBudget !== null}
              />
              <span className="text-sm text-muted-foreground">
                {m.analytics_currency()}
              </span>
            </div>
          </div>

          {error && (
            <div className="text-destructive text-sm" role="alert">
              {error}
            </div>
          )}
          {validationError && (
            <div className="text-destructive text-sm" role="alert">
              {validationError}
            </div>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting || noCategoriesLeft}>
              {submitting
                ? editingBudget
                  ? m.saving()
                  : m.creating()
                : editingBudget
                  ? m.save_changes()
                  : m.create_budget_btn()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Main Page ---

function BudgetsPage() {
  const queryClient = useQueryClient();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  // Spending changes on other pages (transactions, imports, categories)
  // without invalidating this key — always refetch on mount.
  const { data: overview, isLoading } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
    refetchOnMount: true,
    staleTime: 0,
  });

  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
    refetchOnMount: true,
    staleTime: 0,
  });

  const invalidateBudgets = () =>
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (data: BudgetFormData) => createBudgetFn({ data }),
    onSuccess: invalidateBudgets,
  });

  const updateMutation = useMutation({
    mutationFn: (data: { id: string; limitMinor: number }) =>
      updateBudgetFn({ data }),
    onSuccess: invalidateBudgets,
  });

  const deleteMutation = useMutation({
    mutationFn: (data: { id: string }) => deleteBudgetFn({ data }),
    onSuccess: invalidateBudgets,
  });

  // Form state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [formError, setFormError] = useState<React.ReactNode>(null);

  // Delete state
  const [deletingBudget, setDeletingBudget] = useState<Budget | null>(null);
  const [deleteError, setDeleteError] = useState<React.ReactNode>(null);

  const budgets = overview?.budgets ?? [];
  const budgetById = new Map(budgets.map((b) => [b.id, b]));
  const budgetedCategoryIds = new Set(budgets.map((b) => b.categoryId));
  const labels = categoryLabels(categories);
  const categoryOptions = categories
    .filter((c) => !budgetedCategoryIds.has(c.id))
    .map((c) => ({ id: c.id, label: labels.get(c.id) ?? c.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const parentCategoryIds = new Set(
    categories.map((c) => c.parent_id).filter((id) => id !== null),
  );

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingBudget(null);
    setFormError(null);
  };

  const handleAdd = () => {
    setEditingBudget(null);
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleEdit = (budget: Budget) => {
    setEditingBudget(budget);
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleFormSubmit = async (data: BudgetFormData) => {
    setFormError(null);
    const result = editingBudget
      ? await updateMutation.mutateAsync({
          id: editingBudget.id,
          limitMinor: data.limitMinor,
        })
      : await createMutation.mutateAsync(data);
    if ("error" in result) {
      setFormError(mutationErrorMessage(result));
      return;
    }
    closeForm();
  };

  const handleDeleteConfirm = async () => {
    if (!deletingBudget) return;
    setDeleteError(null);
    const result = await deleteMutation.mutateAsync({ id: deletingBudget.id });
    if ("error" in result) {
      setDeleteError(mutationErrorMessage(result));
      return;
    }
    setDeletingBudget(null);
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold display-title">
              {m.budgets_title()}
            </h1>
            {overview && (
              <p className="text-sm text-muted-foreground mt-0.5">
                {m.budgets_subtitle({ month: formatMonthLabel(overview.month) })}
              </p>
            )}
            {overview && (
              <p
                className="text-xs text-muted-foreground mt-0.5"
                data-testid="budgets-usage"
              >
                {overview.usage.limit === null
                  ? m.budgets_usage_unlimited({ used: overview.usage.used })
                  : m.budgets_usage({
                      used: overview.usage.used,
                      limit: overview.usage.limit,
                    })}
              </p>
            )}
          </div>
          <Button onClick={handleAdd}>
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            {m.add_budget()}
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="page-wrap py-8 space-y-4">
        {overview?.multiCurrency && (
          <div
            className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
            role="note"
            data-testid="budgets-multi-currency"
          >
            {m.budgets_multi_currency()}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">
                {m.loading()}
              </span>
            </div>
          </div>
        ) : budgets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg
              className="size-12 text-muted-foreground/40 mb-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5z"
              />
            </svg>
            <h3 className="text-base font-medium mb-1">
              {m.no_budgets_yet()}
            </h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              {m.create_first_budget()}
            </p>
          </div>
        ) : (
          <ul aria-label={m.budgets_list_label()} className="space-y-3">
            {flattenBudgetTree(budgets).map(({ budget, depth }) => (
              <BudgetCard
                key={budget.id}
                budget={budget}
                depth={depth}
                parentName={
                  budget.parentBudgetId
                    ? (budgetById.get(budget.parentBudgetId)?.categoryName ??
                      null)
                    : null
                }
                hasSubcategories={parentCategoryIds.has(budget.categoryId)}
                onEdit={handleEdit}
                onDelete={(b) => {
                  setDeletingBudget(b);
                  setDeleteError(null);
                }}
              />
            ))}
          </ul>
        )}
      </main>

      <BudgetForm
        isOpen={isFormOpen}
        editingBudget={editingBudget}
        categoryOptions={categoryOptions}
        onClose={closeForm}
        onSubmit={handleFormSubmit}
        error={formError}
      />

      <AlertDialog
        open={deletingBudget !== null}
        onOpenChange={(open) => !open && setDeletingBudget(null)}
      >
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.delete_budget_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.delete_budget_confirm({
                category: deletingBudget?.categoryName ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div
              className="text-destructive text-sm p-3 rounded-md bg-destructive/10"
              role="alert"
            >
              {deleteError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletingBudget(null)}>
              {m.cancel()}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                // Keep the dialog open until the server confirms.
                e.preventDefault();
                void handleDeleteConfirm();
              }}
            >
              {m.delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
