import { describe, expect, it } from "vitest";
import { DEV_SESSION_SECRET, validateEnv } from "#/server/env";

const STRONG_SECRET = "a".repeat(48);

describe("env validation", () => {
  it("production fails closed without a real SESSION_SECRET", () => {
    expect(() => validateEnv({ NODE_ENV: "production" })).toThrow(
      /SESSION_SECRET must be set/,
    );
    expect(() =>
      validateEnv({ NODE_ENV: "production", SESSION_SECRET: DEV_SESSION_SECRET }),
    ).toThrow(/dev fallback/);
    expect(() =>
      validateEnv({ NODE_ENV: "production", SESSION_SECRET: "short" }),
    ).toThrow(/at least 32 characters/);
  });

  const PROD_EMAIL_ENV = {
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "Finance Tracker <no-reply@example.com>",
    APP_BASE_URL: "https://tracker.example.com",
  };

  it("production boots with a strong secret", () => {
    const env = validateEnv({
      NODE_ENV: "production",
      SESSION_SECRET: STRONG_SECRET,
      ...PROD_EMAIL_ENV,
    });
    expect(env.isProduction).toBe(true);
    expect(env.sessionSecret).toBe(STRONG_SECRET);
  });

  it("production fails closed without email configuration", () => {
    const base = { NODE_ENV: "production", SESSION_SECRET: STRONG_SECRET };
    expect(() => validateEnv(base)).toThrow(/EMAIL_PROVIDER/);
    expect(() =>
      validateEnv({ ...base, EMAIL_PROVIDER: "resend" }),
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      validateEnv({
        ...base,
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_test",
      }),
    ).toThrow(/EMAIL_FROM/);
    expect(() =>
      validateEnv({
        ...base,
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_test",
        EMAIL_FROM: "x@example.com",
      }),
    ).toThrow(/APP_BASE_URL/);
  });

  it("selects the email provider by mode", () => {
    // dev default: console
    expect(validateEnv({}).email.provider).toBe("console");
    // TEST_MODE: in-memory capture wins over everything
    expect(
      validateEnv({ TEST_MODE: "1", EMAIL_PROVIDER: "resend" }).email.provider,
    ).toBe("test");
    // explicit resend outside production
    const env = validateEnv({
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test",
      APP_BASE_URL: "https://tracker.example.com/",
    });
    expect(env.email.provider).toBe("resend");
    // trailing slash is normalized away so links concatenate cleanly
    expect(env.email.baseUrl).toBe("https://tracker.example.com");
  });

  it("development falls back to the dev secret", () => {
    const env = validateEnv({});
    expect(env.isProduction).toBe(false);
    expect(env.sessionSecret).toBe(DEV_SESSION_SECRET);
    // but still rejects an explicitly-set too-short secret
    expect(() => validateEnv({ SESSION_SECRET: "short" })).toThrow(
      /at least 32 characters/,
    );
  });

  it("exposes AI config and test mode", () => {
    const env = validateEnv({
      TEST_MODE: "1",
      AI_FAKE: "1",
      AI_API_KEY: "k",
      AI_BASE_URL: "https://example.com",
      AI_MODEL: "m",
    });
    expect(env.isTestMode).toBe(true);
    expect(env.ai).toEqual({
      provider: "openrouter",
      apiKey: "k",
      baseURL: "https://example.com",
      model: "m",
      fake: true,
      freeScansPerMonth: 10,
      dailySpendCapUsd: undefined,
    });
    expect(validateEnv({}).ai.fake).toBe(false);
  });

  it("selects the AI provider explicitly or by inference", () => {
    // explicit values pass through (llamacpp needs a base URL)
    expect(
      validateEnv({ AI_PROVIDER: "llamacpp", AI_BASE_URL: "http://llm:8080/v1" })
        .ai.provider,
    ).toBe("llamacpp");
    expect(() => validateEnv({ AI_PROVIDER: "llamacpp" })).toThrow(
      /AI_BASE_URL/,
    );
    expect(() => validateEnv({ AI_PROVIDER: "gpt4all" })).toThrow(
      /AI_PROVIDER/,
    );
    // inference: a key implies hosted, a bare base URL implies llamacpp
    expect(validateEnv({ AI_API_KEY: "k" }).ai.provider).toBe("openrouter");
    expect(
      validateEnv({ AI_BASE_URL: "http://llm:8080/v1" }).ai.provider,
    ).toBe("llamacpp");
    expect(validateEnv({}).ai.provider).toBe("openrouter");
  });

  it("validates AI quota and spend cap config", () => {
    expect(validateEnv({ AI_FREE_SCANS_PER_MONTH: "25" }).ai.freeScansPerMonth).toBe(25);
    expect(() => validateEnv({ AI_FREE_SCANS_PER_MONTH: "-1" })).toThrow(
      /AI_FREE_SCANS_PER_MONTH/,
    );
    expect(() => validateEnv({ AI_FREE_SCANS_PER_MONTH: "many" })).toThrow(
      /AI_FREE_SCANS_PER_MONTH/,
    );
    expect(validateEnv({ AI_DAILY_SPEND_CAP_USD: "5.5" }).ai.dailySpendCapUsd).toBe(5.5);
    expect(() => validateEnv({ AI_DAILY_SPEND_CAP_USD: "0" })).toThrow(
      /AI_DAILY_SPEND_CAP_USD/,
    );
  });

  it("validates observability config", () => {
    // defaults: info level, error tracking disabled
    const defaults = validateEnv({});
    expect(defaults.observability).toEqual({
      sentryDsn: undefined,
      logLevel: "info",
    });
    // explicit values pass through
    const env = validateEnv({
      SENTRY_DSN: "https://x@sentry.example.com/1",
      LOG_LEVEL: "debug",
    });
    expect(env.observability.sentryDsn).toBe("https://x@sentry.example.com/1");
    expect(env.observability.logLevel).toBe("debug");
    // unknown level fails at boot, not at first log call
    expect(() => validateEnv({ LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("validates billing config", () => {
    // defaults: billing disabled, free-only deployment
    const defaults = validateEnv({});
    expect(defaults.billing.enabled).toBe(false);
    expect(defaults.billing.proScansPerMonth).toBe(200);
    expect(defaults.billing.freeMaxAccounts).toBe(2);
    expect(defaults.billing.freeMaxBudgets).toBe(3);

    // all three Stripe vars enable billing
    const enabled = validateEnv({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      STRIPE_PRICE_PRO: "price_x",
    });
    expect(enabled.billing.enabled).toBe(true);

    // a partial Stripe configuration is always a mistake
    expect(() => validateEnv({ STRIPE_SECRET_KEY: "sk_test_x" })).toThrow(
      /must be set together/,
    );
    expect(() =>
      validateEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_PRO: "price_x" }),
    ).toThrow(/must be set together/);

    // numeric knobs validate
    expect(
      validateEnv({ BILLING_PRO_SCANS_PER_MONTH: "500" }).billing.proScansPerMonth,
    ).toBe(500);
    expect(() => validateEnv({ BILLING_PRO_SCANS_PER_MONTH: "-1" })).toThrow(
      /BILLING_PRO_SCANS_PER_MONTH/,
    );
    expect(() => validateEnv({ BILLING_FREE_MAX_ACCOUNTS: "0" })).toThrow(
      /BILLING_FREE_MAX_ACCOUNTS/,
    );
    expect(
      validateEnv({ BILLING_FREE_MAX_BUDGETS: "5" }).billing.freeMaxBudgets,
    ).toBe(5);
    for (const invalid of ["0", "-1", "2.5", "many"]) {
      expect(() =>
        validateEnv({ BILLING_FREE_MAX_BUDGETS: invalid }),
      ).toThrow(/BILLING_FREE_MAX_BUDGETS/);
    }
  });
});
