import { test, expect, type Page } from "./fixtures";
import type { APIRequestContext } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

//
// GDPR user-rights flows: full data export, account deletion with grace
// period and cancel, the hard-delete sweep, and the public legal pages.
// The sweep is triggered deterministically via the TEST_MODE-only
// /test-run-sweep and /test-backdate routes — the hourly loop is disarmed
// under TEST_MODE.

type CapturedEmail = { to: string; subject: string; text: string };

async function pollEmails(
  request: APIRequestContext,
  to: string,
  subjectPart: string,
): Promise<CapturedEmail[]> {
  let matching: CapturedEmail[] = [];
  await expect
    .poll(async () => {
      const res = await request.get(`/test-emails?to=${encodeURIComponent(to)}`);
      const { emails } = (await res.json()) as { emails: CapturedEmail[] };
      matching = emails.filter((e) => e.subject.includes(subjectPart));
      return matching.length;
    })
    .toBeGreaterThanOrEqual(1);
  return matching;
}

async function requestDeletion(page: Page, password: string) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Request deletion" }).click();
}

test.describe("Data export", () => {
  test("downloads a zip containing the user's data", async ({
    page,
    signedInUser,
  }) => {
    await page.goto("/settings");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download my data" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^finance-tracker-export-\d{4}-\d{2}-\d{2}\.zip$/,
    );

    // Same endpoint through the request context so the bytes can be parsed.
    const res = await page.request.get("/api/export-data");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await res.body()));
    const json = JSON.parse(strFromU8(files["export.json"]));
    expect(json.user.id).toBe(signedInUser.userId);
    expect(
      json.accounts.map((a: { name: string }) => a.name),
    ).toContain("Main");
    expect(files["transactions.csv"]).toBeDefined();
    expect(files["categories.csv"]).toBeDefined();
    // Budgets are user data too — exported even when the user has none yet.
    expect(json.budgets).toEqual([]);
    expect(json.budgetAlerts).toEqual([]);
    expect(strFromU8(files["budgets.csv"])).toBe(
      '"id","category","limit","limit_minor","created_at","updated_at"',
    );
  });

  test("rejects unauthenticated export requests", async ({
    page,
    unauthUser,
  }) => {
    void unauthUser; // user exists, but this context has no session cookie
    const res = await page.request.get("/api/export-data");
    expect(res.status()).toBe(401);
  });
});

test.describe("Account deletion", () => {
  test("rejects deletion request with a wrong password", async ({
    page,
    signedInUser,
  }) => {
    void signedInUser;
    await requestDeletion(page, "not-the-password");
    await expect(page.getByText("Incorrect password.")).toBeVisible();
    await expect(
      page.getByTestId("deletion-pending-banner"),
    ).toBeHidden();
  });

  test("requests deletion, emails the user, and can be canceled", async ({
    page,
    signedInUser,
  }) => {
    await requestDeletion(page, "test-password");

    const banner = page.getByTestId("deletion-pending-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("scheduled for permanent deletion");
    const email = `${signedInUser.username}@example.com`;
    await pollEmails(page.request, email, "scheduled for deletion");

    // Survives a reload — state is server-side, not client-side.
    await page.reload();
    await expect(page.getByTestId("deletion-pending-banner")).toBeVisible();

    await page.getByRole("button", { name: "Cancel deletion" }).click();
    await expect(
      page.getByText("Account deletion has been canceled."),
    ).toBeVisible();
    await expect(page.getByTestId("deletion-pending-banner")).toBeHidden();
    await pollEmails(page.request, email, "deletion canceled");
  });

  test("hard-deletes the account once the grace period elapses", async ({
    page,
    signedInUser,
  }) => {
    await requestDeletion(page, "test-password");
    await expect(page.getByTestId("deletion-pending-banner")).toBeVisible();

    // Rewind the request 15 days and run the sweep the hourly loop would run.
    const backdate = await page.request.post(
      `/test-backdate?userId=${signedInUser.userId}&deletionDays=15`,
    );
    expect(backdate.ok()).toBeTruthy();
    const sweep = await page.request.post("/test-run-sweep");
    expect(sweep.ok()).toBeTruthy();

    // The session dies with the user row...
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/(login|setup)/);

    // ...and the credentials no longer exist.
    await page.goto("/login");
    await page
      .getByLabel("Email or username")
      .fill(`${signedInUser.username}@example.com`);
    await page.getByLabel("Password").fill("test-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Invalid credentials")).toBeVisible();
  });
});

test.describe("Legal pages", () => {
  test("privacy, terms, and security pages render without a session", async ({
    page,
  }) => {
    await page.goto("/privacy");
    await expect(
      page.getByRole("heading", { name: "Privacy Policy" }),
    ).toBeVisible();
    await expect(page.getByText("Sub-processors")).toBeVisible();

    await page.goto("/terms");
    await expect(
      page.getByRole("heading", { name: "Terms of Service" }),
    ).toBeVisible();

    await page.goto("/security");
    await expect(
      page.getByRole("heading", { name: "Security" }),
    ).toBeVisible();

    const securityTxt = await page.request.get("/.well-known/security.txt");
    expect(securityTxt.status()).toBe(200);
    expect(await securityTxt.text()).toContain("Contact:");
  });

  test("signup page links to terms and privacy", async ({ page }) => {
    await page.goto("/setup");
    await expect(
      page.getByText("By creating an account you agree"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Terms of Service" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Privacy Policy" }),
    ).toBeVisible();
  });
});
