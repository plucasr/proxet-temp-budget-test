import { test, expect, type Page } from "./fixtures";

// Regression: transaction dates are wall-clock values with no zone and must
// render exactly as entered in any viewer timezone. Formatting them in local
// time showed them a day early west of UTC. The browser timezone is pinned
// so the test fails on any machine, not only on one that sits west of UTC.

async function addTransaction(page: Page, date: string, description: string) {
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  await modal.getByLabel("Date").fill(`${date}T00:00`);
  await modal.getByLabel("Description").fill(description);
  await modal
    .getByRole("spinbutton", { name: "Amount", exact: true })
    .fill("10.00");
  await modal.getByLabel("Account").selectOption("Main (PLN)");
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
}

for (const timezoneId of ["America/Sao_Paulo", "Pacific/Auckland"]) {
  test.describe(`Transaction date display (${timezoneId})`, () => {
    test.use({ timezoneId });

    test("shows the date exactly as entered", async ({
      page,
      signedInUser: _signedInUser,
    }) => {
      await page.goto("/transactions");

      // The first of the month is the case that would also flip the month.
      await addTransaction(page, "2025-03-01", "First of month");
      await addTransaction(page, "2025-01-15", "Mid month");

      const table = page.getByRole("table");
      await expect(
        table.getByRole("row", { name: /First of month/ }),
      ).toContainText("Mar 1, 2025");
      await expect(table.getByRole("row", { name: /Mid month/ })).toContainText(
        "Jan 15, 2025",
      );

      // Survives a full reload (server render + hydration), not just the
      // client-side update after the mutation.
      await page.reload();
      await expect(
        table.getByRole("row", { name: /First of month/ }),
      ).toContainText("Mar 1, 2025");
    });
  });
}
