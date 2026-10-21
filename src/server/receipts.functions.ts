import { createServerFn } from "@tanstack/react-start";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "#/db";
import { isEmailVerified, requireUserId } from "#/server/session";
import { extractReceiptItems, type ReceiptExtraction } from "#/server/ai";
import {
  checkScanAllowed,
  getMonthlyUsageSummary,
} from "#/server/ai-usage.server";
import { decimalToMinor, formatMinor } from "#/lib/money";
import {
  MAX_RECEIPT_IMAGES,
  MAX_RECEIPT_IMAGE_BYTES,
  base64LengthLimit,
  stripImageMetadata,
  validateReceiptImage,
} from "#/lib/upload";
import { storage, receiptImageKey } from "#/server/storage";
import { safeEvaluateBudgetAlerts } from "#/server/budgets.server";


// --- Helpers ---

function decodeBase64(b64: string): Uint8Array {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin);
}

// --- Schemas ---

const scanReceiptSchema = z.object({
  images: z.array(
    z.object({
      data: z.string(), // base64
      filename: z.string(),
    }),
  ),
});

// --- Server Functions ---

export const scanReceipt = createServerFn({ method: "POST" })
  .inputValidator(scanReceiptSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // AI spend is gated on a verified email.
    if (!(await isEmailVerified(userId))) {
      return { error: "Verify your email address to use receipt scanning." };
    }

    // Rate limit, monthly scan quota, and the global daily spend cap — all
    // checked before any storage or AI work. `code` lets the UI show a
    // localized message with an upgrade path.
    const gate = await checkScanAllowed(userId);
    if (!gate.allowed) {
      return { error: gate.error, code: gate.code };
    }

    if (data.images.length === 0) {
      return { error: "No images provided" };
    }
    if (data.images.length > MAX_RECEIPT_IMAGES) {
      return { error: `Too many images. Max ${MAX_RECEIPT_IMAGES} per scan` };
    }

    // Validate all images: cheap length pre-check before decoding, then
    // size cap + magic-byte sniffing on the decoded bytes. EXIF/XMP metadata
    // (GPS, device ids) is stripped before the bytes are stored or sent to
    // the AI provider.
    const validated: Array<{ base64: string; bytes: Uint8Array; ext: string }> = [];
    for (const img of data.images) {
      if (img.data.length > base64LengthLimit(MAX_RECEIPT_IMAGE_BYTES)) {
        return { error: "File exceeds 20MB limit" };
      }
      const bytes = decodeBase64(img.data);
      const validation = validateReceiptImage(bytes);
      if (!validation.ok) {
        return { error: validation.error };
      }
      const stripped = stripImageMetadata(bytes, validation.ext);
      validated.push({
        base64: Buffer.from(stripped).toString("base64"),
        bytes: stripped,
        ext: validation.ext,
      });
    }

    // Persist images via the storage driver; the returned keys go in the DB.
    const savedPaths: string[] = [];
    for (const img of validated) {
      const key = receiptImageKey(userId, img.ext);
      await storage.put(key, img.bytes);
      savedPaths.push(key);
    }

    // Get user categories for AI
    const categories = await db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        parent_id: schema.categories.parent_id,
      })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId));

    // Extract from first image (Phase 1: single image processing)
    // For multi-image support, we'd combine them or process sequentially
    const firstImage = validated[0].base64;
    const firstExt = validated[0].ext;
    const result = await extractReceiptItems(
      firstImage,
      categories,
      { userId, kind: "receipt_scan" },
      firstExt,
    );

    if (!result.success) {
      // Clean up saved images on failure
      for (const p of savedPaths) {
        await storage.delete(p);
      }
      return { error: result.error.message };
    }

    return {
      success: true,
      data: {
        ...result.data,
        _categories: categories,
      },
      imagePaths: savedPaths,
    };
  });

export const getReceiptByTransactionId = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      transactionId: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Verify transaction belongs to user
    const txn = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, data.transactionId),
          eq(schema.transactions.user_id, userId),
        ),
      )
      .limit(1);

    if (txn.length === 0) {
      return { error: "Transaction not found" };
    }

    const receipt = await db
      .select({
        id: schema.receipts.id,
        transaction_id: schema.receipts.transaction_id,
        image_path: schema.receipts.image_path,
        ai_raw_response: schema.receipts.ai_raw_response,
        created_at: schema.receipts.created_at,
      })
      .from(schema.receipts)
      .where(
        and(
          eq(schema.receipts.transaction_id, data.transactionId),
          eq(schema.receipts.user_id, userId),
        ),
      )
      .limit(1);

    if (receipt.length === 0) {
      return { error: "Receipt not found" };
    }

    const items = await db
      .select({
        id: schema.receipt_items.id,
        receipt_id: schema.receipt_items.receipt_id,
        name: schema.receipt_items.name,
        quantity: schema.receipt_items.quantity,
        unit_price_minor: schema.receipt_items.unit_price_minor,
        total_price_minor: schema.receipt_items.total_price_minor,
        category_id: schema.receipt_items.category_id,
        created_at: schema.receipt_items.created_at,
      })
      .from(schema.receipt_items)
      .where(eq(schema.receipt_items.receipt_id, receipt[0].id));

    return {
      success: true,
      receipt: receipt[0],
      items,
    };
  });

export const deleteReceipt = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      receiptId: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Find receipt — ownership enforced in the same query
    const receiptInfo = await db
      .select({
        id: schema.receipts.id,
        transaction_id: schema.receipts.transaction_id,
        image_path: schema.receipts.image_path,
      })
      .from(schema.receipts)
      .where(
        and(
          eq(schema.receipts.id, data.receiptId),
          eq(schema.receipts.user_id, userId),
        ),
      )
      .limit(1);

    if (receiptInfo.length === 0) {
      return { error: "Receipt not found" };
    }

    const receipt = receiptInfo[0];

    // Delete receipt items
    await db
      .delete(schema.receipt_items)
      .where(eq(schema.receipt_items.receipt_id, receipt.id));

    // Delete image object
    if (receipt.image_path) {
      await storage.delete(receipt.image_path);
    }

    // Delete receipt row
    await db.delete(schema.receipts).where(eq(schema.receipts.id, receipt.id));

    return { success: true };
  });

// ── Phase 2: Edit, Match & Save ──────────────────────────────────────────────


export const updateReceiptItems = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      receiptId: z.string(),
      items: z.array(
        z.object({
          id: z.string().optional(),
          name: z.string(),
          quantity: z.number().optional().default(1),
          // Integer minor units (grosze/cents)
          unit_price_minor: z.number().int(),
          total_price_minor: z.number().int(),
          category_id: z.string().nullish(),
        }),
      ),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Verify receipt exists and belongs to user — direct user_id ownership
    const receiptInfo = await db
      .select({
        id: schema.receipts.id,
        transaction_id: schema.receipts.transaction_id,
      })
      .from(schema.receipts)
      .where(
        and(
          eq(schema.receipts.id, data.receiptId),
          eq(schema.receipts.user_id, userId),
        ),
      )
      .limit(1);

    if (receiptInfo.length === 0) {
      return { error: "Receipt not found" };
    }

    // Delete existing items for this receipt
    await db
      .delete(schema.receipt_items)
      .where(eq(schema.receipt_items.receipt_id, data.receiptId));

    // Insert updated items
    const insertedItems: Array<{
      id: string;
      receipt_id: string;
      name: string;
      quantity: number | null;
      unit_price_minor: number | null;
      total_price_minor: number;
      category_id: string | null;
    }> = [];

    for (const item of data.items) {
      const id = crypto.randomUUID();
      await db.insert(schema.receipt_items).values({
        id,
        receipt_id: data.receiptId,
        name: item.name,
        quantity: item.quantity ?? 1,
        unit_price_minor: item.unit_price_minor,
        total_price_minor: item.total_price_minor,
        category_id: item.category_id || null,
      });
      insertedItems.push({
        id,
        receipt_id: data.receiptId,
        name: item.name,
        quantity: item.quantity ?? 1,
        unit_price_minor: item.unit_price_minor,
        total_price_minor: item.total_price_minor,
        category_id: item.category_id || null,
      });
    }

    // Compute sum (integer minor units)
    const totalMinor = insertedItems.reduce(
      (sum, item) => sum + item.total_price_minor,
      0,
    );

    return {
      success: true,
      items: insertedItems,
      totalMinor,
    };
  });

export const saveReceiptAndLink = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      imagePaths: z.array(z.string()),
      store_name: z.string(),
      date: z.string(),
      // Integer minor units (grosze/cents)
      totalMinor: z.number().int(),
      suggested_parent_category: z.string().optional(),
      items: z.array(
        z.object({
          name: z.string(),
          quantity: z.number().optional().default(1),
          // Integer minor units (grosze/cents)
          unit_price_minor: z.number().int(),
          total_price_minor: z.number().int(),
          category_id: z.string().optional().or(z.literal("")),
        }),
      ),
      accountId: z.string().min(1, "Account is required"),
      existingTransactionId: z.string().nullish(),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Validate account exists and belongs to user
    const account = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.id, data.accountId),
          eq(schema.accounts.user_id, userId),
        ),
      )
      .limit(1);

    if (account.length === 0) {
      return { error: "Account does not exist" };
    }

    // Validate suggested_parent_category if provided
    let parentId: string | null = null;
    if (data.suggested_parent_category) {
      const category = await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.name, data.suggested_parent_category),
            eq(schema.categories.user_id, userId),
          ),
        )
        .limit(1);
      if (category.length > 0) {
        parentId = category[0].id;
      }
    }

    // Create receipt row
    const receiptId = crypto.randomUUID();

    // Build raw response for storage
    const rawResponse: ReceiptExtraction = {
      store_name: data.store_name,
      date: data.date,
      items: data.items.map((item) => ({
        name: item.name,
        quantity: item.quantity ?? 1,
        unit_price_minor: item.unit_price_minor,
        total_price_minor: item.total_price_minor,
        suggested_category: "",
      })),
      total_minor: data.totalMinor,
      suggested_parent_category: data.suggested_parent_category || "",
    };

    await db.insert(schema.receipts).values({
      id: receiptId,
      user_id: userId,
      image_path: data.imagePaths[0] || null,
      ai_raw_response: JSON.stringify(rawResponse),
      transaction_id: data.existingTransactionId || null,
    });

    // Create receipt items
    const receiptItems: Array<{
      id: string;
      name: string;
      quantity: number | null;
      unit_price_minor: number | null;
      total_price_minor: number;
      category_id: string | null;
    }> = [];

    for (const item of data.items) {
      const itemId = crypto.randomUUID();
      const categoryId = item.category_id || parentId || null;
      await db.insert(schema.receipt_items).values({
        id: itemId,
        receipt_id: receiptId,
        name: item.name,
        quantity: item.quantity ?? 1,
        unit_price_minor: item.unit_price_minor,
        total_price_minor: item.total_price_minor,
        category_id: categoryId,
      });
      receiptItems.push({
        id: itemId,
        name: item.name,
        quantity: item.quantity ?? 1,
        unit_price_minor: item.unit_price_minor,
        total_price_minor: item.total_price_minor,
        category_id: categoryId,
      });
    }

    let transaction = null;

    if (data.existingTransactionId) {
      // Link receipt to existing transaction — do NOT modify transaction's category_id
      await db
        .update(schema.receipts)
        .set({ transaction_id: data.existingTransactionId })
        .where(eq(schema.receipts.id, receiptId));

      transaction = await db
        .select({
          id: schema.transactions.id,
          account_id: schema.transactions.account_id,
          date: schema.transactions.date,
          amount_minor: schema.transactions.amount_minor,
          description: schema.transactions.description,
          category_id: schema.transactions.category_id,
          source: schema.transactions.source,
          source_ref: schema.transactions.source_ref,
          created_at: schema.transactions.created_at,
          account_name: schema.accounts.name,
          account_currency: schema.accounts.currency,
          category_name: schema.categories.name,
          category_color: schema.categories.color,
        })
        .from(schema.transactions)
        .leftJoin(
          schema.accounts,
          eq(schema.transactions.account_id, schema.accounts.id),
        )
        .leftJoin(
          schema.categories,
          eq(schema.transactions.category_id, schema.categories.id),
        )
        .where(
          and(
            eq(schema.transactions.id, data.existingTransactionId),
            eq(schema.transactions.user_id, userId),
          ),
        )
        .limit(1);

      if (transaction.length === 0) {
        return { error: "Transaction not found" };
      }
      transaction = transaction[0];
    } else {
      // Create new transaction
      const txnId = crypto.randomUUID();

      // Generate source_ref from date, store_name, amount
      const normalizedStore = data.store_name
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();
      const sourceRef = `${data.date}-${normalizedStore}-${formatMinor(data.totalMinor)}`;

      await db.insert(schema.transactions).values({
        id: txnId,
        user_id: userId,
        account_id: data.accountId,
        date: data.date,
        amount_minor: data.totalMinor,
        description: data.store_name || null,
        category_id: parentId,
        source: "receipt",
        source_ref: sourceRef,
      });

      // Link receipt to new transaction
      await db
        .update(schema.receipts)
        .set({ transaction_id: txnId })
        .where(eq(schema.receipts.id, receiptId));

      transaction = await db
        .select({
          id: schema.transactions.id,
          account_id: schema.transactions.account_id,
          date: schema.transactions.date,
          amount_minor: schema.transactions.amount_minor,
          description: schema.transactions.description,
          category_id: schema.transactions.category_id,
          source: schema.transactions.source,
          source_ref: schema.transactions.source_ref,
          created_at: schema.transactions.created_at,
          account_name: schema.accounts.name,
          account_currency: schema.accounts.currency,
          category_name: schema.categories.name,
          category_color: schema.categories.color,
        })
        .from(schema.transactions)
        .leftJoin(
          schema.accounts,
          eq(schema.transactions.account_id, schema.accounts.id),
        )
        .leftJoin(
          schema.categories,
          eq(schema.transactions.category_id, schema.categories.id),
        )
        .where(eq(schema.transactions.id, txnId))
        .limit(1);

      if (transaction.length === 0) {
        return { error: "Transaction creation failed" };
      }
      transaction = transaction[0];
    }

    // This write can raise this month's spending.
    await safeEvaluateBudgetAlerts(userId);

    return {
      success: true,
      receipt_id: receiptId,
      items: receiptItems,
      transaction,
    };
  });

export const suggestTransactionForReceipt = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      date: z.string(),
      // Integer minor units (grosze/cents)
      amountMinor: z.number().int(),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Find all transactions on the same day — `date` is a proper DATE column.
    const sameDayTxns = await db
      .select({
        id: schema.transactions.id,
        account_id: schema.transactions.account_id,
        date: schema.transactions.date,
        amount_minor: schema.transactions.amount_minor,
        description: schema.transactions.description,
        category_id: schema.transactions.category_id,
        source: schema.transactions.source,
        source_ref: schema.transactions.source_ref,
        created_at: schema.transactions.created_at,
        account_name: schema.accounts.name,
        account_currency: schema.accounts.currency,
        category_name: schema.categories.name,
        category_color: schema.categories.color,
      })
      .from(schema.transactions)
      .leftJoin(
        schema.accounts,
        eq(schema.transactions.account_id, schema.accounts.id),
      )
      .leftJoin(
        schema.categories,
        eq(schema.transactions.category_id, schema.categories.id),
      )
      .where(
        and(
          eq(schema.transactions.user_id, userId),
          eq(schema.transactions.date, data.date),
        ),
      );
    if (sameDayTxns.length === 0) {
      return { success: true, suggestion: null };
    }

    // Find exact match first
    const exactMatch = sameDayTxns.find(
      (t) => t.amount_minor === data.amountMinor,
    );
    if (exactMatch) {
      return { success: true, suggestion: exactMatch };
    }

    // No exact match — return the one with the closest amount
    let closest = sameDayTxns[0];
    let closestDiff = Math.abs(closest.amount_minor - data.amountMinor);

    for (const txn of sameDayTxns) {
      const diff = Math.abs(txn.amount_minor - data.amountMinor);
      if (diff < closestDiff) {
        closest = txn;
        closestDiff = diff;
      }
    }

    return { success: true, suggestion: closest };
  });

export const rescanReceipt = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      receiptId: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // AI spend is gated on a verified email.
    if (!(await isEmailVerified(userId))) {
      return { error: "Verify your email address to use receipt scanning." };
    }

    // Rescans consume quota like first scans — each is a full AI call.
    const gate = await checkScanAllowed(userId);
    if (!gate.allowed) {
      return { error: gate.error, code: gate.code };
    }

    // Find receipt and read image path — ownership enforced in the query
    const receiptInfo = await db
      .select({
        id: schema.receipts.id,
        image_path: schema.receipts.image_path,
      })
      .from(schema.receipts)
      .where(
        and(
          eq(schema.receipts.id, data.receiptId),
          eq(schema.receipts.user_id, userId),
        ),
      )
      .limit(1);

    if (receiptInfo.length === 0) {
      return { error: "Receipt not found" };
    }

    const receipt = receiptInfo[0];
    if (!receipt.image_path) {
      return { error: "No image found for this receipt" };
    }

    // Read image via the storage driver and encode as base64 — the driver
    // validates the key so a tampered image_path can't escape storage.
    const imageBuffer = await storage.get(receipt.image_path);
    if (!imageBuffer) {
      return { error: "Image file not found" };
    }
    const base64 = imageBuffer.toString("base64");

    // Detect extension from key
    const ext = receipt.image_path.split(".").pop() || "png";

    // Get user categories for AI
    const categories = await db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        parent_id: schema.categories.parent_id,
      })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId));

    // Re-extract
    const result = await extractReceiptItems(
      base64,
      categories,
      { userId, kind: "receipt_scan" },
      ext,
    );

    if (!result.success) {
      return { error: result.error.message };
    }

    return {
      success: true,
      data: result.data,
    };
  });

// ── Phase 4: Receipt Viewer ──────────────────────────────────────────────────


/**
 * Fetch a receipt with its items and metadata for a given transaction.
 * Returns the receipt, items, and parsed AI raw response (store name, date, total).
 * Also returns category info for each item.
 */
export const getReceiptWithItems = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      transactionId: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Verify transaction belongs to user
    const txn = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, data.transactionId),
          eq(schema.transactions.user_id, userId),
        ),
      )
      .limit(1);

    if (txn.length === 0) {
      return { error: "Transaction not found" };
    }

    const receipt = await db
      .select({
        id: schema.receipts.id,
        transaction_id: schema.receipts.transaction_id,
        image_path: schema.receipts.image_path,
        ai_raw_response: schema.receipts.ai_raw_response,
        created_at: schema.receipts.created_at,
      })
      .from(schema.receipts)
      .where(
        and(
          eq(schema.receipts.transaction_id, data.transactionId),
          eq(schema.receipts.user_id, userId),
        ),
      )
      .limit(1);

    if (receipt.length === 0) {
      return { error: "Receipt not found" };
    }

    const items = await db
      .select({
        id: schema.receipt_items.id,
        receipt_id: schema.receipt_items.receipt_id,
        name: schema.receipt_items.name,
        quantity: schema.receipt_items.quantity,
        unit_price_minor: schema.receipt_items.unit_price_minor,
        total_price_minor: schema.receipt_items.total_price_minor,
        category_id: schema.receipt_items.category_id,
        created_at: schema.receipt_items.created_at,
      })
      .from(schema.receipt_items)
      .where(eq(schema.receipt_items.receipt_id, receipt[0].id));

    // Fetch category info for items
    const categoryIds = [...new Set(items.map((i) => i.category_id).filter(Boolean))] as string[];
    const categories = categoryIds.length > 0
      ? await db
          .select({ id: schema.categories.id, name: schema.categories.name, color: schema.categories.color })
          .from(schema.categories)
          .where(inArray(schema.categories.id, categoryIds))
      : [];

    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    // Parse AI raw response for metadata. Rows written before the
    // minor-units migration store a decimal `total`; new rows store
    // `total_minor` — convert legacy values at this read boundary.
    let storeName = "";
    let receiptDate = "";
    let receiptTotalMinor = 0;
    if (receipt[0].ai_raw_response) {
      try {
        const parsed: ReceiptExtraction & { total?: number } = JSON.parse(
          receipt[0].ai_raw_response,
        );
        storeName = parsed.store_name || "";
        receiptDate = parsed.date || "";
        receiptTotalMinor =
          parsed.total_minor ?? decimalToMinor(parsed.total ?? 0);
      } catch {
        // Ignore parse errors
      }
    }

    return {
      success: true,
      receipt: {
        id: receipt[0].id,
        transaction_id: receipt[0].transaction_id,
        image_path: receipt[0].image_path,
      },
      metadata: { storeName, date: receiptDate, totalMinor: receiptTotalMinor },
      items: items.map((item) => ({
        ...item,
        category_name: item.category_id ? categoryMap.get(item.category_id)?.name ?? null : null,
        category_color: item.category_id ? categoryMap.get(item.category_id)?.color ?? null : null,
      })),
    };
  });

/**
 * Serve a receipt image with authenticated access.
 * Verifies the receipt belongs to the current user via the linked transaction.
 * Returns the image as a base64-encoded string with content type.
 */
export const getReceiptImage = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      receiptId: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Find receipt — direct user_id ownership enforced in the query
    const receiptInfo = await db
      .select({
        id: schema.receipts.id,
        transaction_id: schema.receipts.transaction_id,
        image_path: schema.receipts.image_path,
      })
      .from(schema.receipts)
      .where(
        and(
          eq(schema.receipts.id, data.receiptId),
          eq(schema.receipts.user_id, userId),
        ),
      )
      .limit(1);

    if (receiptInfo.length === 0) {
      return { error: "Receipt not found" };
    }

    const receipt = receiptInfo[0];

    // Read image via the storage driver — the driver validates the key so a
    // tampered image_path can't escape storage.
    if (!receipt.image_path) {
      return { error: "No image found for this receipt" };
    }

    const imageBuffer = await storage.get(receipt.image_path);
    if (!imageBuffer) {
      return { error: "Image file not found" };
    }

    const ext = (receipt.image_path.split(".").pop() ?? "").toLowerCase();
    const contentTypes: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
    };
    const contentType = contentTypes[ext] ?? "application/octet-stream";

    return {
      success: true,
      data: imageBuffer.toString("base64"),
      contentType,
    };
  });

// Backs the "scans used this month" display on the scan page.
export const getAiUsage = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    return await getMonthlyUsageSummary(userId);
  },
);

export type ScanResult =
  | { success: true; data: ReceiptExtraction; imagePaths: string[] }
  | { error: string };

export type ReceiptItemDB = {
  id: string;
  receipt_id: string;
  name: string;
  quantity: number | null;
  /** Integer minor units (grosze/cents). */
  unit_price_minor: number | null;
  total_price_minor: number;
  category_id: string | null;
};

export type TransactionSuggestion = {
  id: string;
  account_id: string;
  date: string;
  /** Integer minor units (grosze/cents). */
  amount_minor: number;
  description: string | null;
  category_id: string | null;
  source: string | null;
  source_ref: string | null;
  created_at: Date | null;
  account_name: string | null;
  account_currency: string | null;
  category_name: string | null;
  category_color: string | null;
};
