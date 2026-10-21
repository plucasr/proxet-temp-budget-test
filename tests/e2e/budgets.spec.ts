import { test, expect, type Page } from "./fixtures";

//
// Monthly category budgets (docs/budgets-spec.md, Phases 6–7). Every test
// starts from a fresh `signedInUser` seeded with the default categories
// (e.g. Groceries › Vegetables, Transport › Fuel) and a "Main" PLN account,
// on the free plan.
//
// Spending is created through the real Transactions UI and dated "today" in
// the local timezone — the server computes the month from its own local
// date, and E2E runs browser and server on the same machine.

function ymd(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

const today = () => ymd(new Date());
const lastMonth = () => {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth() - 1, 15));
};

async function gotoBudgets(page: Page) {
  await page.goto("/budgets");
  await expect(
    page.getByRole("heading", { name: "Budgets", level: 1 }),
  ).toBeVisible();
}

function budgetCard(page: Page, categoryName: string) {
  return page.getByRole("listitem", { name: categoryName, exact: true });
}

async function openAddBudget(page: Page) {
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Budget" })
    .click();
  return page.getByRole("dialog", { name: "Add Budget" });
}

/** Create a budget from the Budgets page; `category` is the option label,
 * e.g. "Groceries" or "Groceries › Vegetables". */
async function addBudget(page: Page, category: string, limit: string) {
  const dialog = await openAddBudget(page);
  await dialog.getByLabel("Category").selectOption({ label: category });
  await dialog.getByLabel("Monthly limit").fill(limit);
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  return dialog;
}

async function addBudgetOk(page: Page, category: string, limit: string) {
  const dialog = await addBudget(page, category, limit);
  await expect(dialog).toBeHidden();
  const name = category.split(" › ").at(-1)!;
  await expect(budgetCard(page, name)).toBeVisible();
}

/** Add a transaction through the Transactions page. `category` is the
 * transaction form's option label: "Groceries" or "— Vegetables". */
async function addTransaction(
  page: Page,
  opts: {
    amount: string;
    category: string;
    date?: string;
    description?: string;
    isIncome?: boolean;
  },
) {
  await page.goto("/transactions");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  await modal.getByLabel("Date").fill(`${opts.date ?? today()}T00:00`);
  await modal
    .getByLabel("Description")
    .fill(opts.description ?? `Txn ${opts.amount}`);
  await modal
    .getByRole("spinbutton", { name: "Amount", exact: true })
    .fill(opts.amount);
  await modal.getByLabel("Account").selectOption("Main (PLN)");
  await modal.getByLabel("Category").selectOption(opts.category);
  if (opts.isIncome) await modal.getByLabel("Income").check();
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
}

async function budgetEmails(page: Page, email: string) {
  const res = await page.request.get(
    `/test-emails?to=${encodeURIComponent(email)}`,
  );
  const { emails } = (await res.json()) as {
    emails: Array<{ subject: string; text: string }>;
  };
  return emails.filter((e) => e.subject.includes("budget"));
}

// --- Navigation & CRUD (AC1, AC2) --------------------------------------------

test.describe("Budgets page", () => {
  test("is reachable from the sidebar and starts empty", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Budgets" }).click();
    await expect(page).toHaveURL("/budgets");
    await expect(
      page.getByRole("heading", { name: "Budgets", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "0 of 3 budgets used",
    );
  });

  test("creates a budget showing limit, spent and what's left", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "500");

    const card = budgetCard(page, "Groceries");
    await expect(card.getByTestId("budget-limit")).toHaveText("500.00 PLN");
    await expect(card.getByTestId("budget-spent")).toHaveText("0.00 PLN");
    await expect(card.getByTestId("budget-remaining")).toHaveText("500.00 PLN");
    await expect(card.getByText("Left")).toBeVisible();
    await expect(card.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "1 of 3 budgets used",
    );
  });

  test("changes the limit", async ({ page, signedInUser: _signedInUser }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "500");

    await budgetCard(page, "Groceries")
      .getByRole("button", { name: "Edit" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Edit Budget" });
    await expect(dialog.getByLabel("Category")).toBeDisabled();
    await expect(dialog.getByLabel("Monthly limit")).toHaveValue("500.00");
    await dialog.getByLabel("Monthly limit").fill("750,50");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toBeHidden();

    await expect(
      budgetCard(page, "Groceries").getByTestId("budget-limit"),
    ).toHaveText("750.50 PLN");
    // Persisted, not just optimistic.
    await page.reload();
    await expect(
      budgetCard(page, "Groceries").getByTestId("budget-limit"),
    ).toHaveText("750.50 PLN");
  });

  test("removes a budget after confirmation", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "500");
    const card = budgetCard(page, "Groceries");

    // Cancel keeps it.
    await card.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete budget" });
    await expect(confirm).toContainText("Groceries");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "Delete" }).click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(card).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
  });

  test("validates the form", async ({ page, signedInUser: _signedInUser }) => {
    await gotoBudgets(page);
    const dialog = await openAddBudget(page);
    const submit = dialog.getByRole("button", { name: "Create Budget" });

    // No category.
    await dialog.getByLabel("Monthly limit").fill("100");
    await submit.click();
    await expect(dialog.getByRole("alert")).toHaveText("Choose a category.");

    await dialog.getByLabel("Category").selectOption({ label: "Groceries" });
    for (const limit of ["", "0", "-50", "abc", "10000000.01"]) {
      await dialog.getByLabel("Monthly limit").fill(limit);
      await submit.click();
      await expect(dialog.getByRole("alert")).toHaveText(
        "Enter a monthly limit between 0.01 and 10000000.00.",
      );
    }

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
  });

  test("does not offer categories that already have a budget", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "500");

    const dialog = await openAddBudget(page);
    const select = dialog.getByLabel("Category");
    await expect(select.getByRole("option", { name: "Groceries", exact: true })).toHaveCount(0);
    // Its subcategories are still available.
    await expect(
      select.getByRole("option", { name: "Groceries › Vegetables" }),
    ).toHaveCount(1);
  });
});

// --- Spending (AC3–AC6) ------------------------------------------------------

test.describe("Budget spending", () => {
  test("tracks spending and clearly flags going over", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "500");

    await addTransaction(page, { amount: "120", category: "Groceries" });
    await gotoBudgets(page);
    const card = budgetCard(page, "Groceries");
    await expect(card.getByTestId("budget-spent")).toHaveText("120.00 PLN");
    await expect(card.getByTestId("budget-remaining")).toHaveText("380.00 PLN");
    await expect(card.getByText("Over budget")).toBeHidden();

    await addTransaction(page, { amount: "400", category: "Groceries" });
    await gotoBudgets(page);
    await expect(card.getByTestId("budget-spent")).toHaveText("520.00 PLN");
    await expect(card.getByText("Over budget")).toBeVisible();
    await expect(card.getByText("Over by")).toBeVisible();
    await expect(card.getByTestId("budget-remaining")).toHaveText("20.00 PLN");
    await expect(card.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });

  test("a parent budget includes its subcategories, nested child budgets too", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "1000");
    await addBudgetOk(page, "Groceries › Vegetables", "50");

    await addTransaction(page, { amount: "80", category: "— Vegetables" });
    await gotoBudgets(page);

    const parent = budgetCard(page, "Groceries");
    const child = budgetCard(page, "Vegetables");
    await expect(parent.getByTestId("budget-spent")).toHaveText("80.00 PLN");
    await expect(parent.getByText("Includes subcategories")).toBeVisible();
    await expect(child.getByTestId("budget-spent")).toHaveText("80.00 PLN");
    await expect(child.getByText("Over budget")).toBeVisible();
    await expect(parent.getByText("Over budget")).toBeHidden();

    // Child is rendered after and indented under its budgeted parent.
    const cards = page.getByTestId("budget-card");
    await expect(cards.nth(0)).toHaveAccessibleName("Groceries");
    await expect(cards.nth(1)).toHaveAccessibleName("Vegetables");
    await expect(child).toHaveCSS("margin-left", "24px");
    await expect(child).toContainText("Groceries ›");
  });

  test("income and refunds don't reduce spending", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "500");
    await addTransaction(page, { amount: "100", category: "Groceries" });
    await addTransaction(page, {
      amount: "60",
      category: "Groceries",
      description: "Refund",
      isIncome: true,
    });

    await gotoBudgets(page);
    await expect(
      budgetCard(page, "Groceries").getByTestId("budget-spent"),
    ).toHaveText("100.00 PLN");
  });

  test("only this month's spending counts", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "500");
    await addTransaction(page, {
      amount: "999",
      category: "Groceries",
      date: lastMonth(),
    });

    await gotoBudgets(page);
    await expect(
      budgetCard(page, "Groceries").getByTestId("budget-spent"),
    ).toHaveText("0.00 PLN");
  });

  test("warns when a child limit is higher than its parent's", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "100");
    await addBudgetOk(page, "Groceries › Vegetables", "300");

    await expect(
      budgetCard(page, "Vegetables").getByTestId("budget-exceeds-parent"),
    ).toContainText("higher than the Groceries budget");
    await expect(
      budgetCard(page, "Groceries").getByTestId("budget-exceeds-parent"),
    ).toHaveCount(0);
  });

  test("notes that amounts are not converted across currencies", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await expect(page.getByTestId("budgets-multi-currency")).toHaveCount(0);

    await page.goto("/accounts");
    await page.getByRole("button", { name: "Add Account" }).click();
    await page.getByLabel("Account Name").fill("Euro savings");
    await page.getByLabel("Currency").fill("EUR");
    await page.getByRole("button", { name: "Create Account" }).click();
    await expect(page.getByText("Euro savings")).toBeVisible();

    await gotoBudgets(page);
    await expect(page.getByTestId("budgets-multi-currency")).toContainText(
      "more than one currency",
    );
  });
});

// --- Plan limits (AC8) ---------------------------------------------------------

test.describe("Budget plan limits", () => {
  test("free allows 3 budgets, pro unlimited, downgrade keeps existing ones", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "100");
    await addBudgetOk(page, "Housing", "100");
    await addBudgetOk(page, "Transport", "100");

    // 4th on free → upsell, nothing created.
    const dialog = await addBudget(page, "Health", "100");
    await expect(dialog.getByRole("alert")).toContainText(
      "The free plan is limited to 3 budgets.",
    );
    await expect(
      dialog.getByRole("link", { name: "Upgrade to Pro" }),
    ).toHaveAttribute("href", "/billing");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("budget-card")).toHaveCount(3);

    // Pro → unlimited.
    await page.request.post("/test-set-plan?plan=pro");
    await gotoBudgets(page);
    await addBudgetOk(page, "Health", "100");
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "4 budgets (unlimited)",
    );

    // Downgrade → all 4 kept, but no 5th.
    await page.request.post("/test-set-plan?plan=free");
    await gotoBudgets(page);
    await expect(page.getByTestId("budget-card")).toHaveCount(4);
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "4 of 3 budgets used",
    );
    const fifth = await addBudget(page, "Shopping", "100");
    await expect(fifth.getByRole("alert")).toContainText(
      "limited to 3 budgets",
    );
  });

  test("billing page shows budget usage", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "100");
    await page.goto("/billing");
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText(
      "1 of 3 budgets",
    );
  });
});

// --- Category deletion (Phase 5 wiring) ---------------------------------------

test.describe("Budgets and category deletion", () => {
  async function deleteCategory(page: Page, name: string) {
    await page.goto("/categories");
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row.getByTestId("delete-category").click();
    const confirm = page.getByRole("alertdialog", { name: "Delete Category" });
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
  }

  test("deleting a category or its parent removes the budget", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Transport › Fuel", "100");
    await addBudgetOk(page, "Groceries › Vegetables", "100");

    await deleteCategory(page, "Fuel");
    await deleteCategory(page, "Groceries"); // parent of Vegetables

    await gotoBudgets(page);
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "0 of 3 budgets used",
    );
  });
});

// --- Over-budget email (AC7) -----------------------------------------------------

test.describe("Over-budget email", () => {
  test("sends one email when a budget goes over, not again that month", async ({
    page,
    signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "100");
    expect(await budgetEmails(page, signedInUser.email)).toHaveLength(0);

    await addTransaction(page, { amount: "150", category: "— Vegetables" });
    const emails = await budgetEmails(page, signedInUser.email);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe(
      "You're over your Groceries budget — Finance Tracker",
    );
    expect(emails[0]!.text).toContain("150.00 PLN of your 100.00 PLN");
    expect(emails[0]!.text).toContain("/budgets");

    await addTransaction(page, { amount: "30", category: "Groceries" });
    expect(await budgetEmails(page, signedInUser.email)).toHaveLength(1);
  });

  test("an import that pushes a budget over sends the email", async ({
    page,
    signedInUser,
  }) => {
    await gotoBudgets(page);
    await addBudgetOk(page, "Groceries", "100");

    // Matched to Groceries by the seeded "BIEDRONKA" rule.
    const csv = `Date,Amount,Description,Category\n${today()},-300.00,BIEDRONKA Sklep 1234,\n`;
    // Navigate straight to /import (see ST-4 for why not via the sidebar
    // round-trip) and set the file on the input directly.
    await page.goto("/import");
    await expect(page.getByRole("button", { name: "Choose File" })).toBeVisible();
    await page.locator('input[type="file"][accept=".csv"]').setInputFiles({
      name: "budget-import.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await expect(page.getByRole("combobox", { name: "Date" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page
      .getByRole("combobox", { name: "Account" })
      .selectOption({ label: "Main (PLN)" });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Confirm Import" }).click();
    await expect(
      page.getByRole("heading", { name: "Import complete" }),
    ).toBeVisible();

    const emails = await budgetEmails(page, signedInUser.email);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toContain("Groceries");

    await gotoBudgets(page);
    await expect(
      budgetCard(page, "Groceries").getByText("Over budget"),
    ).toBeVisible();
  });
});
