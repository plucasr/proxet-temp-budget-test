import { test as base, expect, type Page } from "@playwright/test";

//
// Two fixtures back the parallel e2e suite:
//
// - `signedInUser` — destructure this when the test should start signed in.
//   It creates a unique user via `/test-create-user?seed=defaults` and the
//   server sets a session cookie scoped to the browser context. Default
//   categories, rules, and a "Main" account are seeded for the new user.
//
// - `unauthUser`   — destructure this when the test drives the login UI
//   itself (auth spec). The user is created but no session is set, so the
//   browser context starts logged out. Returns `{ username, password }`.
//
// Both fixtures hit the same multi-user code path real users would hit;
// they don't touch any global state, so tests run fully in parallel.

type SignedInUser = { userId: string; username: string; email: string };
type UnauthUser = {
  userId: string;
  username: string;
  email: string;
  password: string;
};

const ANIMATIONS_OFF_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

const test = base.extend<{
  signedInUser: SignedInUser;
  unauthUser: UnauthUser;
}>({
  page: async ({ page }, use) => {
    // Disable CSS animations/transitions globally so tests don't race against
    // opacity tweens (fade-in dialogs etc.). Applies to every page in the
    // context, including subsequent navigations.
    await page.addInitScript((css) => {
      const apply = () => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
      };
      if (document.head) apply();
      else
        document.addEventListener("DOMContentLoaded", apply, { once: true });
    }, ANIMATIONS_OFF_CSS);

    // Wait for the network to go idle after navigations so hydration has
    // settled before tests interact with the page — replaces the older
    // `__reactFiber` heuristic, which silently timed out on redirect/error
    // pages and surfaced as misleading downstream failures.
    const origGoto = page.goto.bind(page);
    page.goto = async (url, options) => {
      const response = await origGoto(url, options);
      await page.waitForLoadState("networkidle");
      return response;
    };

    await use(page);
  },
  signedInUser: async ({ page }, use) => {
    const res = await page.request.post("/test-create-user?seed=defaults");
    if (!res.ok()) {
      throw new Error(
        `/test-create-user failed (${res.status()}). Is NODE_ENV=test on the server?`,
      );
    }
    const { userId, username, email } = (await res.json()) as UnauthUser;
    await use({ userId, username, email });
  },
  unauthUser: async ({ page }, use) => {
    const res = await page.request.post(
      "/test-create-user?seed=defaults&signIn=false",
    );
    if (!res.ok()) {
      throw new Error(
        `/test-create-user failed (${res.status()}). Is NODE_ENV=test on the server?`,
      );
    }
    const data = (await res.json()) as UnauthUser;
    await use(data);
  },
});

export { test, expect, type Page };
