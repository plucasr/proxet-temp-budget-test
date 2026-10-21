import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { z } from "zod";

//
// Centralized, Zod-validated view of process.env. Every required secret is
// checked once at module load (server startup), not at first use — a
// misconfigured production deployment fails to boot instead of silently
// falling back to insecure defaults.

export const DEV_SESSION_SECRET =
  "dev-session-secret-change-in-production-min-32-chars";

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  AI_PROVIDER: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_FAKE: z.string().optional(),
  AI_FREE_SCANS_PER_MONTH: z.string().optional(),
  AI_DAILY_SPEND_CAP_USD: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  BILLING_PRO_SCANS_PER_MONTH: z.string().optional(),
  BILLING_FREE_MAX_ACCOUNTS: z.string().optional(),
  BILLING_FREE_MAX_BUDGETS: z.string().optional(),
  TEST_MODE: z.string().optional(),
  CAPTCHA_ENABLED: z.string().optional(),
  EMAIL_PROVIDER: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  APP_BASE_URL: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
});

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type RawEnv = z.infer<typeof envSchema>;

export interface ValidatedEnv {
  isProduction: boolean;
  isTestMode: boolean;
  /** CAPTCHA hook flag for registration — ships disabled. */
  captchaEnabled: boolean;
  sessionSecret: string;
  email: {
    /** "console" logs emails to stdout (dev); "test" captures them in memory
     * for E2E assertions; "resend" sends via the Resend API. */
    provider: "console" | "test" | "resend";
    resendApiKey: string | undefined;
    from: string;
    /** Absolute origin used to build links inside emails. */
    baseUrl: string;
  };
  ai: {
    /** "openrouter" = hosted (needs AI_API_KEY); "llamacpp" = self-hosted
     * llama-server (OpenAI-compatible, no key required). Explicit via
     * AI_PROVIDER, otherwise inferred: key set → openrouter, else if only a
     * base URL is set → llamacpp. */
    provider: "openrouter" | "llamacpp";
    apiKey: string | undefined;
    baseURL: string | undefined;
    model: string | undefined;
    fake: boolean;
    /** Receipt scans allowed per user per calendar month (free tier). */
    freeScansPerMonth: number;
    /** Global daily spend circuit breaker for the hosted backend, in USD.
     * Undefined disables the cap (e.g. pure self-hosted deployments). */
    dailySpendCapUsd: number | undefined;
  };
  observability: {
    /** Error-tracking DSN (Sentry/GlitchTip). Unset disables reporting. */
    sentryDsn: string | undefined;
    logLevel: LogLevel;
  };
  billing: {
    /** True when all three Stripe variables are set. When false the app runs
     * free-plan-only: no checkout, no portal, webhook returns 404. */
    enabled: boolean;
    stripeSecretKey: string | undefined;
    stripeWebhookSecret: string | undefined;
    /** Stripe Price id (price_...) of the Pro monthly subscription. */
    stripePricePro: string | undefined;
    /** Receipt scans per calendar month on the Pro plan. */
    proScansPerMonth: number;
    /** Accounts a free-plan user may have; Pro is unlimited. */
    freeMaxAccounts: number;
    /** Category budgets a free-plan user may have; Pro is unlimited. */
    freeMaxBudgets: number;
  };
}

/**
 * Validate a raw environment. Pure so it is unit-testable; the module-level
 * `env` export runs it against process.env at startup.
 *
 * Fails closed in production: refuses to boot when SESSION_SECRET is unset,
 * shorter than 32 characters, or still the well-known dev fallback.
 */
export function validateEnv(raw: Record<string, string | undefined>): ValidatedEnv {
  const parsed = envSchema.parse(raw);
  const isProduction = parsed.NODE_ENV === "production";

  let sessionSecret = parsed.SESSION_SECRET;
  if (isProduction) {
    if (!sessionSecret) {
      throw new Error(
        "SESSION_SECRET must be set in production (>= 32 characters). Refusing to boot.",
      );
    }
    if (sessionSecret === DEV_SESSION_SECRET) {
      throw new Error(
        "SESSION_SECRET must not be the dev fallback in production. Refusing to boot.",
      );
    }
    if (sessionSecret.length < 32) {
      throw new Error(
        "SESSION_SECRET must be at least 32 characters in production. Refusing to boot.",
      );
    }
  } else {
    sessionSecret = sessionSecret || DEV_SESSION_SECRET;
    if (sessionSecret.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters.");
    }
  }

  const isTestMode = parsed.TEST_MODE === "1";

  // Transactional email: fail closed in production — the account lifecycle
  // (verification, password reset) is broken without a working sender.
  // TEST_MODE captures emails in memory; dev logs them to the console.
  let emailProvider: "console" | "test" | "resend";
  if (isTestMode) {
    emailProvider = "test";
  } else if (parsed.EMAIL_PROVIDER === "resend") {
    emailProvider = "resend";
  } else if (isProduction) {
    throw new Error(
      "EMAIL_PROVIDER must be configured in production (supported: resend). Refusing to boot.",
    );
  } else {
    emailProvider = "console";
  }
  if (emailProvider === "resend" && !parsed.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY must be set when EMAIL_PROVIDER=resend.");
  }
  if (isProduction && !isTestMode) {
    if (!parsed.EMAIL_FROM) {
      throw new Error("EMAIL_FROM must be set in production. Refusing to boot.");
    }
    if (!parsed.APP_BASE_URL) {
      throw new Error("APP_BASE_URL must be set in production. Refusing to boot.");
    }
  }

  // AI provider: explicit AI_PROVIDER wins; otherwise an API key implies the
  // hosted backend and a bare base URL implies self-hosted llama.cpp.
  let aiProvider: "openrouter" | "llamacpp";
  if (parsed.AI_PROVIDER) {
    if (parsed.AI_PROVIDER !== "openrouter" && parsed.AI_PROVIDER !== "llamacpp") {
      throw new Error(
        `AI_PROVIDER must be "openrouter" or "llamacpp", got: ${parsed.AI_PROVIDER}`,
      );
    }
    aiProvider = parsed.AI_PROVIDER;
  } else {
    aiProvider = !parsed.AI_API_KEY && parsed.AI_BASE_URL ? "llamacpp" : "openrouter";
  }
  if (aiProvider === "llamacpp" && !parsed.AI_BASE_URL) {
    throw new Error("AI_BASE_URL must be set when AI_PROVIDER=llamacpp.");
  }

  const freeScansPerMonth = parsed.AI_FREE_SCANS_PER_MONTH
    ? Number(parsed.AI_FREE_SCANS_PER_MONTH)
    : 10;
  if (!Number.isInteger(freeScansPerMonth) || freeScansPerMonth < 0) {
    throw new Error("AI_FREE_SCANS_PER_MONTH must be a non-negative integer.");
  }
  const dailySpendCapUsd = parsed.AI_DAILY_SPEND_CAP_USD
    ? Number(parsed.AI_DAILY_SPEND_CAP_USD)
    : undefined;
  if (dailySpendCapUsd !== undefined && !(dailySpendCapUsd > 0)) {
    throw new Error("AI_DAILY_SPEND_CAP_USD must be a positive number.");
  }

  // Billing is optional (free-only deployments are valid), but a partial
  // Stripe configuration is always a mistake — fail loudly instead of
  // silently accepting unverified webhooks or unpayable checkouts.
  const stripeVars = [
    parsed.STRIPE_SECRET_KEY,
    parsed.STRIPE_WEBHOOK_SECRET,
    parsed.STRIPE_PRICE_PRO,
  ];
  const stripeSetCount = stripeVars.filter(Boolean).length;
  if (stripeSetCount !== 0 && stripeSetCount !== stripeVars.length) {
    throw new Error(
      "STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_PRO must be set together (all or none).",
    );
  }
  const proScansPerMonth = parsed.BILLING_PRO_SCANS_PER_MONTH
    ? Number(parsed.BILLING_PRO_SCANS_PER_MONTH)
    : 200;
  if (!Number.isInteger(proScansPerMonth) || proScansPerMonth < 0) {
    throw new Error("BILLING_PRO_SCANS_PER_MONTH must be a non-negative integer.");
  }
  const freeMaxAccounts = parsed.BILLING_FREE_MAX_ACCOUNTS
    ? Number(parsed.BILLING_FREE_MAX_ACCOUNTS)
    : 2;
  if (!Number.isInteger(freeMaxAccounts) || freeMaxAccounts < 1) {
    throw new Error("BILLING_FREE_MAX_ACCOUNTS must be a positive integer.");
  }
  const freeMaxBudgets = parsed.BILLING_FREE_MAX_BUDGETS
    ? Number(parsed.BILLING_FREE_MAX_BUDGETS)
    : 3;
  if (!Number.isInteger(freeMaxBudgets) || freeMaxBudgets < 1) {
    throw new Error("BILLING_FREE_MAX_BUDGETS must be a positive integer.");
  }

  const logLevel = parsed.LOG_LEVEL || "info";
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got: ${logLevel}`,
    );
  }

  return {
    isProduction,
    isTestMode,
    captchaEnabled: parsed.CAPTCHA_ENABLED === "1",
    sessionSecret,
    email: {
      provider: emailProvider,
      resendApiKey: parsed.RESEND_API_KEY,
      from: parsed.EMAIL_FROM || "Finance Tracker <no-reply@localhost>",
      baseUrl: (parsed.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, ""),
    },
    ai: {
      provider: aiProvider,
      apiKey: parsed.AI_API_KEY,
      baseURL: parsed.AI_BASE_URL,
      model: parsed.AI_MODEL,
      fake: Boolean(parsed.AI_FAKE),
      freeScansPerMonth,
      dailySpendCapUsd,
    },
    observability: {
      sentryDsn: parsed.SENTRY_DSN,
      logLevel: logLevel as LogLevel,
    },
    billing: {
      enabled: stripeSetCount === stripeVars.length,
      stripeSecretKey: parsed.STRIPE_SECRET_KEY,
      stripeWebhookSecret: parsed.STRIPE_WEBHOOK_SECRET,
      stripePricePro: parsed.STRIPE_PRICE_PRO,
      proScansPerMonth,
      freeMaxAccounts,
      freeMaxBudgets,
    },
  };
}

export const env: ValidatedEnv = validateEnv(process.env);
