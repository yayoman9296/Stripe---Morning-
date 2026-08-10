# Stripe → morning (Green Invoice) automation

Auto-creates Israeli tax documents in morning for BPS Enterprises from Stripe activity.

## Functions
- `stripe-to-morning` — webhook. `charge.succeeded` → type 320 invoice-receipt. `charge.refunded` → type 330 credit note, linked to the original.
- `backfill` — one-off retroactive invoice creation. Dry-run by default; `execute=true` writes.

## Secrets (Supabase)
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, GI_API_KEY, GI_API_SECRET, GI_BASE_URL, BACKFILL_SECRET

## VAT rule (per accountant)
- USD (foreign clients) → vatType 1, zero-rated service export
- ILS (Israeli clients) → vatType 0, 18% VAT inclusive (price ÷ 1.18)
Currency of the payment link determines treatment — never send a USD link to an Israeli client.

## Deploy
npx supabase functions deploy stripe-to-morning --no-verify-jwt

## Known issues
- morning won't date a document earlier than the most recent existing document.
- Documents are never emailed to clients (client.emails omitted; email kept in remarks).
- backfill duplicate search reads only the first 50 results — caused one duplicate (60615, cancelled). Needs pagination before any future run.const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const GI_API_KEY = Deno.env.get("GI_API_KEY");
const GI_API_SECRET = Deno.env.get("GI_API_SECRET");
const GI_BASE_URL = Deno.env.get("GI_BASE_URL");

function missingEnv(name: string): Response {
  console.error(`Missing required env var: ${name}`);
  return new Response(`Missing required env var: ${name}`, { status: 500 });
}

function formatDateYYYYMMDD(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function todayYYYYMMDD(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Client payload without emails — Green Invoice emails any address in client.emails. */
function buildClient(name: string): Record<string, unknown> {
  return {
    name,
    add: true,
  };
}

/** Append client email to remarks for record-keeping (not used for delivery). */
function remarksWithClientEmail(
  base: string,
  email: string | undefined,
): string {
  return email ? `${base} | Client email: ${email}` : base;
}

/** Local-part of an email (before @), or undefined if unusable. */
function emailLocalPart(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf("@");
  if (at <= 0) return undefined;
  const local = email.slice(0, at).trim();
  return local || undefined;
}

type CustomerCache = Map<string, Stripe.Customer | null>;

/**
 * Retrieve a Stripe customer by id, caching results (including misses).
 */
async function getStripeCustomer(
  stripe: Stripe,
  customerId: string,
  cache: CustomerCache,
): Promise<Stripe.Customer | null> {
  if (cache.has(customerId)) {
    return cache.get(customerId) ?? null;
  }
  try {
    const retrieved = await stripe.customers.retrieve(customerId);
    if ((retrieved as Stripe.DeletedCustomer).deleted) {
      cache.set(customerId, null);
      return null;
    }
    const customer = retrieved as Stripe.Customer;
    cache.set(customerId, customer);
    return customer;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `Failed to retrieve Stripe customer ${customerId}:`,
      message,
    );
    cache.set(customerId, null);
    return null;
  }
}

/**
 * Resolve client name and email with fallbacks for Payment Link charges where
 * billing_details.name is often empty but the linked Customer has the name.
 *
 * Name order: billing_details.name → customer.name → customer_details.name →
 * email local-part → "Customer".
 * Email order: billing_details.email → customer.email → customer_details.email.
 */
async function resolveClientIdentity(
  stripe: Stripe,
  charge: Stripe.Charge,
  cache: CustomerCache,
): Promise<{ name: string; email: string | undefined }> {
  const billingName = charge.billing_details?.name?.trim() || undefined;
  const billingEmail = charge.billing_details?.email?.trim() || undefined;

  // customer_details appears on some charge payloads (e.g. Checkout); not always typed
  const customerDetails = (
    charge as Stripe.Charge & {
      customer_details?: {
        name?: string | null;
        email?: string | null;
      } | null;
    }
  ).customer_details;
  const detailsName = customerDetails?.name?.trim() || undefined;
  const detailsEmail = customerDetails?.email?.trim() || undefined;

  let customerName: string | undefined;
  let customerEmail: string | undefined;
  const customerRef = charge.customer;
  if (customerRef) {
    const customerId = typeof customerRef === "string"
      ? customerRef
      : customerRef.id;
    if (customerId) {
      const customer = await getStripeCustomer(stripe, customerId, cache);
      customerName = customer?.name?.trim() || undefined;
      customerEmail = customer?.email?.trim() || undefined;
    }
  }

  const email = billingEmail || customerEmail || detailsEmail || undefined;
  const name = billingName ||
    customerName ||
    detailsName ||
    emailLocalPart(email) ||
    "Customer";

  return { name, email };
}

/** Authenticate to Green Invoice (Morning) and return a Bearer token. */
async function getGreenInvoiceToken(): Promise<string | Response> {
  const tokenRes = await fetch(`${GI_BASE_URL}/account/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: GI_API_KEY, secret: GI_API_SECRET }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    console.error("Green Invoice auth failed:", tokenRes.status, text);
    return new Response("Green Invoice authentication failed", { status: 500 });
  }

  const tokenData = await tokenRes.json() as { token?: string };
  if (!tokenData.token) {
    console.error("Green Invoice auth response missing token:", tokenData);
    return new Response("Green Invoice authentication failed", { status: 500 });
  }

  return tokenData.token;
}

/** This refund's amount in major units (not cumulative). */
function getRefundAmount(charge: Stripe.Charge): number {
  const refunds = charge.refunds?.data;
  if (refunds && refunds.length > 0) {
    const latest = refunds.reduce((a, b) =>
      (a.created ?? 0) >= (b.created ?? 0) ? a : b
    );
    return latest.amount / 100;
  }
  return charge.amount_refunded / 100;
}

/** Search for the original type-320 invoice by Stripe charge id in remarks. */
async function findOriginalDocumentId(
  token: string,
  chargeId: string,
): Promise<string | undefined> {
  try {
    const searchRes = await fetch(`${GI_BASE_URL}/documents/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        type: [320],
        text: `Stripe charge: ${chargeId}`,
      }),
    });

    if (!searchRes.ok) {
      const text = await searchRes.text();
      console.warn(
        "Green Invoice document search failed; creating credit note without linkage:",
        searchRes.status,
        text,
      );
      return undefined;
    }

    const searchData = await searchRes.json() as {
      items?: Array<{ id?: string }>;
      total?: number;
    };
    const items = searchData.items ?? [];
    if (items.length === 1 && items[0].id) {
      return items[0].id;
    }
    if (items.length === 0) {
      console.warn(
        `No original type-320 document found for Stripe charge ${chargeId}; creating credit note without linkage`,
      );
    } else {
      console.warn(
        `Expected exactly one type-320 document for Stripe charge ${chargeId}, found ${items.length}; creating credit note without linkage`,
      );
    }
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      "Green Invoice document search error; creating credit note without linkage:",
      message,
    );
    return undefined;
  }
}

async function handleChargeSucceeded(
  charge: Stripe.Charge,
  token: string,
  stripe: Stripe,
  customerCache: CustomerCache,
): Promise<Response> {
  const amount = charge.amount / 100;
  const currency = charge.currency.toUpperCase();
  const vatType = currency === "ILS" ? 0 : 1;
  const price = currency === "ILS"
    ? Math.round((amount / 1.18) * 100) / 100
    : amount;
  const { name, email } = await resolveClientIdentity(
    stripe,
    charge,
    customerCache,
  );
  const description = charge.description?.trim() || "Payment";
  const chargeId = charge.id;
  const paymentDate = formatDateYYYYMMDD(charge.created);

  const documentBody = {
    type: 320, // חשבונית מס קבלה
    lang: "he",
    currency,
    vatType,
    rounding: true,
    attachment: false, // do not email the document to the client
    client: buildClient(name),
    income: [
      {
        description,
        quantity: 1,
        price,
        currency,
        vatType,
      },
    ],
    payment: [
      {
        type: 3, // credit card
        price: amount,
        currency,
        date: paymentDate,
      },
    ],
    remarks: remarksWithClientEmail(`Stripe charge: ${chargeId}`, email),
  };

  const docRes = await fetch(`${GI_BASE_URL}/documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(documentBody),
  });

  if (!docRes.ok) {
    const text = await docRes.text();
    console.error(
      "Green Invoice document creation failed:",
      docRes.status,
      text,
    );
    return new Response("Failed to create Green Invoice document", {
      status: 500,
    });
  }

  console.log(
    `Created Green Invoice type 320 for Stripe charge ${chargeId}`,
  );
  return new Response("ok", { status: 200 });
}

async function handleChargeRefunded(
  charge: Stripe.Charge,
  token: string,
  stripe: Stripe,
  customerCache: CustomerCache,
): Promise<Response> {
  const refundAmount = getRefundAmount(charge);
  const currency = charge.currency.toUpperCase();
  const vatType = currency === "ILS" ? 0 : 1;
  const price = currency === "ILS"
    ? Math.round((refundAmount / 1.18) * 100) / 100
    : refundAmount;
  const { name, email } = await resolveClientIdentity(
    stripe,
    charge,
    customerCache,
  );
  const chargeId = charge.id;
  const paymentDate = todayYYYYMMDD();

  const linkedDocumentId = await findOriginalDocumentId(token, chargeId);

  const documentBody: Record<string, unknown> = {
    type: 330, // חשבונית זיכוי
    lang: "he",
    currency,
    vatType,
    rounding: true,
    attachment: false,
    client: buildClient(name),
    income: [
      {
        description: "החזר / Refund",
        quantity: 1,
        price,
        currency,
        vatType,
      },
    ],
    payment: [
      {
        type: 3, // credit card
        price: refundAmount,
        currency,
        date: paymentDate,
      },
    ],
    remarks: remarksWithClientEmail(
      `Refund for Stripe charge: ${chargeId}`,
      email,
    ),
  };

  if (linkedDocumentId) {
    documentBody.linkedDocumentIds = [linkedDocumentId];
  }

  const docRes = await fetch(`${GI_BASE_URL}/documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(documentBody),
  });

  if (!docRes.ok) {
    const text = await docRes.text();
    console.error(
      "Green Invoice credit note creation failed:",
      docRes.status,
      text,
    );
    return new Response("Failed to create Green Invoice credit note", {
      status: 500,
    });
  }

  console.log(
    `Created credit note type 330 for Stripe charge ${chargeId}`,
  );
  return new Response("ok", { status: 200 });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!STRIPE_SECRET_KEY) return missingEnv("STRIPE_SECRET_KEY");
  if (!STRIPE_WEBHOOK_SECRET) return missingEnv("STRIPE_WEBHOOK_SECRET");
  if (!GI_API_KEY) return missingEnv("GI_API_KEY");
  if (!GI_API_SECRET) return missingEnv("GI_API_SECRET");
  if (!GI_BASE_URL) return missingEnv("GI_BASE_URL");

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const body = await req.text();
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Stripe webhook signature verification failed:", message);
    return new Response(`Webhook Error: ${message}`, { status: 400 });
  }

  if (
    event.type !== "charge.succeeded" &&
    event.type !== "charge.refunded"
  ) {
    return new Response("ignored", { status: 200 });
  }

  const tokenOrErr = await getGreenInvoiceToken();
  if (tokenOrErr instanceof Response) return tokenOrErr;
  const token = tokenOrErr;

  const charge = event.data.object as Stripe.Charge;
  const customerCache: CustomerCache = new Map();

  if (event.type === "charge.succeeded") {
    return await handleChargeSucceeded(charge, token, stripe, customerCache);
  }

  return await handleChargeRefunded(charge, token, stripe, customerCache);
});/**
 * Edge Function: retroactively create Green Invoice (Morning) type-320
 * tax invoice-receipts for historical Stripe charges.
 *
 * Trigger: HTTP GET or POST with query params:
 *   from=YYYY-MM-DD           (required, inclusive UTC day start)
 *   to=YYYY-MM-DD             (optional, inclusive UTC day end; default: now)
 *   limit=N                   (optional cap on eligible charges processed)
 *   execute=true              (optional; DEFAULT is dry-run — writes nothing)
 *   documentDate=YYYY-MM-DD   (optional; document date on every invoice;
 *                              default 2026-08-04 — GI rejects dates >60 days past)
 *
 * Env (same as stripe-to-morning): STRIPE_SECRET_KEY, GI_API_KEY,
 * GI_API_SECRET, GI_BASE_URL. STRIPE_WEBHOOK_SECRET is not used.
 *
 * Does not modify or call the stripe-to-morning function.
 */

import Stripe from "npm:stripe@14";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const GI_API_KEY = Deno.env.get("GI_API_KEY");
const GI_API_SECRET = Deno.env.get("GI_API_SECRET");
const GI_BASE_URL = Deno.env.get("GI_BASE_URL");

function missingEnv(name: string): Response {
  console.error(`Missing required env var: ${name}`);
  return jsonResponse({ error: `Missing required env var: ${name}` }, 500);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatDateYYYYMMDD(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD → DD/MM/YYYY for income-line "payment received" text. */
function formatDateDDMMYYYY(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split("-");
  return `${d}/${m}/${y}`;
}

/** Default document date for backfill (within GI's 60-day acceptance window). */
const DEFAULT_DOCUMENT_DATE = "2026-08-04";

/** Inclusive UTC day start for YYYY-MM-DD → unix seconds. */
function dateStartUnix(yyyyMmDd: string): number {
  return Math.floor(Date.parse(`${yyyyMmDd}T00:00:00.000Z`) / 1000);
}

/** Inclusive UTC day end for YYYY-MM-DD → unix seconds. */
function dateEndUnix(yyyyMmDd: string): number {
  return Math.floor(Date.parse(`${yyyyMmDd}T23:59:59.999Z`) / 1000);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Client payload without emails — Green Invoice emails any address in client.emails. */
function buildClient(name: string): Record<string, unknown> {
  return {
    name,
    add: true,
  };
}

/** Append client email to remarks for record-keeping (not used for delivery). */
function remarksWithClientEmail(
  base: string,
  email: string | undefined,
): string {
  return email ? `${base} | Client email: ${email}` : base;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Authenticate to Green Invoice (Morning) and return a Bearer token. */
async function getGreenInvoiceToken(): Promise<string | Response> {
  const tokenRes = await fetch(`${GI_BASE_URL}/account/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: GI_API_KEY, secret: GI_API_SECRET }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    console.error("Green Invoice auth failed:", tokenRes.status, text);
    return jsonResponse({ error: "Green Invoice authentication failed" }, 500);
  }

  const tokenData = await tokenRes.json() as { token?: string };
  if (!tokenData.token) {
    console.error("Green Invoice auth response missing token:", tokenData);
    return jsonResponse({ error: "Green Invoice authentication failed" }, 500);
  }

  return tokenData.token;
}

interface DuplicateSearchResult {
  /** true only when a returned item's remarks/description/text contains the exact charge id */
  isDuplicate: boolean;
  /** raw count of items returned by the search API (before local verification) */
  searchResultCount: number;
  /** document number of the first verified match, when found */
  matchedDocumentNumber?: string | number;
  /** set when search failed or response shape was unexpected — never treat as duplicate */
  searchFailed?: boolean;
  error?: string;
}

/**
 * Extract free-text fields from a Green Invoice search item for charge-id verification.
 */
function itemTextFields(item: Record<string, unknown>): string[] {
  const fields: string[] = [];
  for (const key of ["remarks", "description", "text"] as const) {
    const v = item[key];
    if (typeof v === "string" && v.length > 0) fields.push(v);
  }
  return fields;
}

/**
 * Duplicate protection: search GI by raw charge id, then VERIFY in code that at
 * least one returned item's remarks/description/text actually contains that id.
 * A non-empty search response alone is NOT treated as a duplicate.
 */
async function searchForDuplicateDocument(
  token: string,
  chargeId: string,
): Promise<DuplicateSearchResult> {
  const searchRes = await fetch(`${GI_BASE_URL}/documents/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      page: 1,
      pageSize: 50,
      text: chargeId, // raw charge id only, e.g. "ch_3Tyxxxx"
    }),
  });

  const responseBody = await searchRes.text();

  if (!searchRes.ok) {
    console.error(
      `Green Invoice document search failed for ${chargeId}:`,
      searchRes.status,
      responseBody,
    );
    return {
      isDuplicate: false,
      searchResultCount: 0,
      searchFailed: true,
      error: `search HTTP ${searchRes.status}: ${responseBody}`,
    };
  }

  let searchData: unknown;
  try {
    searchData = JSON.parse(responseBody);
  } catch {
    console.error(
      `Green Invoice document search returned non-JSON for ${chargeId}:`,
      responseBody,
    );
    return {
      isDuplicate: false,
      searchResultCount: 0,
      searchFailed: true,
      error: `search response not JSON: ${responseBody}`,
    };
  }

  if (
    searchData === null ||
    typeof searchData !== "object" ||
    Array.isArray(searchData)
  ) {
    console.error(
      `Green Invoice document search unexpected shape for ${chargeId}:`,
      responseBody,
    );
    return {
      isDuplicate: false,
      searchResultCount: 0,
      searchFailed: true,
      error: `search unexpected response shape: ${responseBody}`,
    };
  }

  const obj = searchData as Record<string, unknown>;
  // Prefer items, fall back to documents if present
  const rawList = obj.items ?? obj.documents;
  if (rawList !== undefined && !Array.isArray(rawList)) {
    console.error(
      `Green Invoice document search unexpected items/documents for ${chargeId}:`,
      responseBody,
    );
    return {
      isDuplicate: false,
      searchResultCount: 0,
      searchFailed: true,
      error: `search unexpected items/documents shape: ${responseBody}`,
    };
  }

  const items = (Array.isArray(rawList) ? rawList : []) as Array<
    Record<string, unknown>
  >;
  const searchResultCount = items.length;

  // VERIFY: only a document that actually references this exact charge id counts
  for (const item of items) {
    const texts = itemTextFields(item);
    const containsChargeId = texts.some((t) => t.includes(chargeId));
    if (containsChargeId) {
      const matchedDocumentNumber =
        (item.number as string | number | undefined) ??
        (item.id as string | number | undefined);
      return {
        isDuplicate: true,
        searchResultCount,
        matchedDocumentNumber,
      };
    }
  }

  return {
    isDuplicate: false,
    searchResultCount,
  };
}

interface InvoiceFields {
  amount: number;
  currency: string;
  vatType: number;
  price: number;
  name: string;
  email: string | undefined;
  description: string;
  paymentDate: string;
}

/** Local-part of an email (before @), or undefined if unusable. */
function emailLocalPart(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf("@");
  if (at <= 0) return undefined;
  const local = email.slice(0, at).trim();
  return local || undefined;
}

type CustomerCache = Map<string, Stripe.Customer | null>;

/**
 * Retrieve a Stripe customer by id, caching results (including misses) so the
 * same customer is not fetched repeatedly during a backfill run.
 */
async function getStripeCustomer(
  stripe: Stripe,
  customerId: string,
  cache: CustomerCache,
): Promise<Stripe.Customer | null> {
  if (cache.has(customerId)) {
    return cache.get(customerId) ?? null;
  }
  try {
    const retrieved = await stripe.customers.retrieve(customerId);
    if ((retrieved as Stripe.DeletedCustomer).deleted) {
      cache.set(customerId, null);
      return null;
    }
    const customer = retrieved as Stripe.Customer;
    cache.set(customerId, customer);
    return customer;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `Failed to retrieve Stripe customer ${customerId}:`,
      message,
    );
    cache.set(customerId, null);
    return null;
  }
}

/**
 * Resolve client name and email with fallbacks for Payment Link charges where
 * billing_details.name is often empty but the linked Customer has the name.
 *
 * Name order: billing_details.name → customer.name → customer_details.name →
 * email local-part → "Customer".
 * Email order: billing_details.email → customer.email → customer_details.email.
 */
async function resolveClientIdentity(
  stripe: Stripe,
  charge: Stripe.Charge,
  cache: CustomerCache,
): Promise<{ name: string; email: string | undefined }> {
  const billingName = charge.billing_details?.name?.trim() || undefined;
  const billingEmail = charge.billing_details?.email?.trim() || undefined;

  // customer_details appears on some charge payloads (e.g. Checkout); not always typed
  const customerDetails = (
    charge as Stripe.Charge & {
      customer_details?: {
        name?: string | null;
        email?: string | null;
      } | null;
    }
  ).customer_details;
  const detailsName = customerDetails?.name?.trim() || undefined;
  const detailsEmail = customerDetails?.email?.trim() || undefined;

  let customerName: string | undefined;
  let customerEmail: string | undefined;
  const customerRef = charge.customer;
  if (customerRef) {
    const customerId = typeof customerRef === "string"
      ? customerRef
      : customerRef.id;
    if (customerId) {
      const customer = await getStripeCustomer(stripe, customerId, cache);
      customerName = customer?.name?.trim() || undefined;
      customerEmail = customer?.email?.trim() || undefined;
    }
  }

  const email = billingEmail || customerEmail || detailsEmail || undefined;
  const name = billingName ||
    customerName ||
    detailsName ||
    emailLocalPart(email) ||
    "Customer";

  return { name, email };
}

/** Compute type-320 fields the same way as stripe-to-morning handleChargeSucceeded. */
async function computeInvoiceFields(
  stripe: Stripe,
  charge: Stripe.Charge,
  customerCache: CustomerCache,
): Promise<InvoiceFields> {
  const amount = charge.amount / 100;
  const currency = charge.currency.toUpperCase();
  const vatType = currency === "ILS" ? 0 : 1;
  const price = currency === "ILS"
    ? Math.round((amount / 1.18) * 100) / 100
    : amount;
  const { name, email } = await resolveClientIdentity(
    stripe,
    charge,
    customerCache,
  );
  const description = charge.description?.trim() || "Payment";
  const paymentDate = formatDateYYYYMMDD(charge.created);

  return {
    amount,
    currency,
    vatType,
    price,
    name,
    email,
    description,
    paymentDate,
  };
}

/**
 * Build type-320 body for backfill. Document `date` is a fixed recent date
 * (GI rejects documents dated >60 days in the past). The true charge date is
 * recorded on the income description and in remarks.
 */
function buildDocumentBody(
  charge: Stripe.Charge,
  fields: InvoiceFields,
  documentDate: string,
): Record<string, unknown> {
  const chargeId = charge.id;
  const {
    amount,
    currency,
    vatType,
    price,
    name,
    email,
    description,
    paymentDate,
  } = fields;

  const incomeDescription =
    `${description} — payment received ${formatDateDDMMYYYY(paymentDate)}`;
  const remarksBase =
    `Stripe charge: ${chargeId} | Original charge date: ${paymentDate}`;

  return {
    type: 320, // חשבונית מס קבלה
    lang: "he",
    currency,
    vatType,
    rounding: true,
    attachment: false, // do not email the document to the client
    date: documentDate, // fixed recent date; original charge date is in remarks/description
    client: buildClient(name),
    income: [
      {
        description: incomeDescription,
        quantity: 1,
        price,
        currency,
        vatType,
      },
    ],
    payment: [
      {
        type: 3, // credit card
        price: amount,
        currency,
        date: documentDate, // same as document date; GI validates payment dates too (error 2405)
      },
    ],
    remarks: remarksWithClientEmail(remarksBase, email),
  };
}

async function createDocument(
  token: string,
  body: Record<string, unknown>,
): Promise<{ id?: string; number?: string | number }> {
  const docRes = await fetch(`${GI_BASE_URL}/documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!docRes.ok) {
    const text = await docRes.text();
    throw new Error(
      `Green Invoice document creation failed (${docRes.status}): ${text}`,
    );
  }

  return await docRes.json() as { id?: string; number?: string | number };
}

// ---------------------------------------------------------------------------
// Query param parsing
// ---------------------------------------------------------------------------

interface BackfillParams {
  from: string;
  to: string | null;
  execute: boolean;
  limit: number | null;
  /** Document date written to every GI document (not the original charge date). */
  documentDate: string;
}

function parseParams(url: URL): BackfillParams | Response {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limitRaw = url.searchParams.get("limit");
  const executeRaw = url.searchParams.get("execute");
  const documentDateRaw = url.searchParams.get("documentDate");

  if (!from) {
    return jsonResponse(
      {
        error: "Missing required query parameter: from=YYYY-MM-DD",
        usage: {
          from: "YYYY-MM-DD (required)",
          to: "YYYY-MM-DD (optional, defaults to now)",
          limit: "N (optional cap on charges processed)",
          execute: "true (optional; default is dry-run)",
          documentDate:
            `YYYY-MM-DD (optional; default ${DEFAULT_DOCUMENT_DATE})`,
        },
      },
      400,
    );
  }
  if (!DATE_RE.test(from)) {
    return jsonResponse(
      { error: `Invalid from date (expected YYYY-MM-DD): ${from}` },
      400,
    );
  }
  if (to !== null && to !== "" && !DATE_RE.test(to)) {
    return jsonResponse(
      { error: `Invalid to date (expected YYYY-MM-DD): ${to}` },
      400,
    );
  }

  let documentDate = DEFAULT_DOCUMENT_DATE;
  if (documentDateRaw !== null && documentDateRaw !== "") {
    if (!DATE_RE.test(documentDateRaw)) {
      return jsonResponse(
        {
          error:
            `Invalid documentDate (expected YYYY-MM-DD): ${documentDateRaw}`,
        },
        400,
      );
    }
    documentDate = documentDateRaw;
  }

  let limit: number | null = null;
  if (limitRaw !== null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      return jsonResponse(
        { error: "limit must be a positive integer" },
        400,
      );
    }
    limit = n;
  }

  // DEFAULT is dry-run. Only execute=true (case-insensitive) writes.
  const execute = (executeRaw ?? "").toLowerCase() === "true";

  return {
    from,
    to: to && to !== "" ? to : null,
    execute,
    limit,
    documentDate,
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

type ChargeAction =
  | "WOULD CREATE"
  | "CREATED"
  | "SKIP-DUPLICATE"
  | "SEARCH-FAILED"
  | "FAILED";

interface ChargeResult {
  date: string;
  /** Document date sent to Green Invoice (fixed/backfill date, not charge date). */
  documentDate: string;
  /** True Stripe charge creation date (YYYY-MM-DD). */
  originalChargeDate: string;
  chargeId: string;
  clientName: string;
  currency: string;
  amount: number;
  vatType: number;
  incomePrice: number;
  action: ChargeAction;
  /** raw count of items returned by GI search (before local verification) */
  searchResultCount?: number;
  /** GI document number of the verified duplicate match, when found */
  matchedDocumentNumber?: string | number;
  documentNumber?: string | number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!STRIPE_SECRET_KEY) return missingEnv("STRIPE_SECRET_KEY");
  if (!GI_API_KEY) return missingEnv("GI_API_KEY");
  if (!GI_API_SECRET) return missingEnv("GI_API_SECRET");
  if (!GI_BASE_URL) return missingEnv("GI_BASE_URL");

  const url = new URL(req.url);
  const parsed = parseParams(url);
  if (parsed instanceof Response) return parsed;
  const { from, to, execute, limit, documentDate } = parsed;

  const createdGte = dateStartUnix(from);
  const createdLte = to !== null
    ? dateEndUnix(to)
    : Math.floor(Date.now() / 1000);

  if (createdGte > createdLte) {
    return jsonResponse({ error: "from must be on or before to" }, 400);
  }

  const mode = execute ? "EXECUTE" : "DRY-RUN";
  console.log(
    `backfill mode=${mode} from=${from} to=${
      to ?? "now"
    } limit=${limit ?? "none"} documentDate=${documentDate}`,
  );

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const tokenOrErr = await getGreenInvoiceToken();
  if (tokenOrErr instanceof Response) return tokenOrErr;
  const token = tokenOrErr;

  let scanned = 0;
  let created = 0;
  let wouldCreate = 0;
  let skippedDuplicate = 0;
  let failed = 0;
  const charges: ChargeResult[] = [];
  const errors: Array<{ chargeId: string; error: string }> = [];

  let lastCreateAt = 0;
  const customerCache: CustomerCache = new Map();

  // Manual cursor pagination — autoPagingIterator is unavailable in this runtime
  const MAX_PAGES = 50;
  let cursor: string | undefined = undefined;
  let pageCount = 0;
  let hitProcessLimit = false;

  while (pageCount < MAX_PAGES && !hitProcessLimit) {
    pageCount++;
    const listParams: Stripe.ChargeListParams = {
      created: { gte: createdGte, lte: createdLte },
      limit: 100,
    };
    if (cursor !== undefined) {
      listParams.starting_after = cursor;
    }

    const page = await stripe.charges.list(listParams);
    const pageData = page.data ?? [];

    if (pageData.length === 0) {
      break;
    }

    for (const charge of pageData) {
      // Process only succeeded, non-refunded, positive-amount charges
      if (charge.status !== "succeeded") continue;
      if (charge.refunded === true) continue;
      if (charge.amount <= 0) continue;

      // Cap total charges PROCESSED across all pages
      if (limit !== null && scanned >= limit) {
        hitProcessLimit = true;
        break;
      }

      scanned++;
      const fields = await computeInvoiceFields(
        stripe,
        charge,
        customerCache,
      );
      const chargeId = charge.id;

      let searchResult: DuplicateSearchResult;
      try {
        searchResult = await searchForDuplicateDocument(token, chargeId);
      } catch (err) {
        // Network / unexpected throw — never treat as duplicate
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `Green Invoice document search exception for ${chargeId}:`,
          message,
        );
        failed++;
        errors.push({ chargeId, error: `search: ${message}` });
        charges.push({
          date: fields.paymentDate,
          documentDate,
          originalChargeDate: fields.paymentDate,
          chargeId,
          clientName: fields.name,
          currency: fields.currency,
          amount: fields.amount,
          vatType: fields.vatType,
          incomePrice: fields.price,
          action: "SEARCH-FAILED",
          searchResultCount: 0,
          error: `search: ${message}`,
        });
        continue;
      }

      if (searchResult.searchFailed) {
        failed++;
        errors.push({
          chargeId,
          error: searchResult.error ?? "search failed",
        });
        charges.push({
          date: fields.paymentDate,
          documentDate,
          originalChargeDate: fields.paymentDate,
          chargeId,
          clientName: fields.name,
          currency: fields.currency,
          amount: fields.amount,
          vatType: fields.vatType,
          incomePrice: fields.price,
          action: "SEARCH-FAILED",
          searchResultCount: searchResult.searchResultCount,
          error: searchResult.error,
        });
        console.error(
          `[SEARCH-FAILED] ${chargeId}: ${searchResult.error ?? "unknown"}`,
        );
        continue;
      }

      if (searchResult.isDuplicate) {
        skippedDuplicate++;
        charges.push({
          date: fields.paymentDate,
          documentDate,
          originalChargeDate: fields.paymentDate,
          chargeId,
          clientName: fields.name,
          currency: fields.currency,
          amount: fields.amount,
          vatType: fields.vatType,
          incomePrice: fields.price,
          action: "SKIP-DUPLICATE",
          searchResultCount: searchResult.searchResultCount,
          matchedDocumentNumber: searchResult.matchedDocumentNumber,
        });
        console.log(
          `[SKIP-DUPLICATE] ${chargeId} (${fields.paymentDate}) matchedDoc=${
            searchResult.matchedDocumentNumber ?? "?"
          } searchCount=${searchResult.searchResultCount}`,
        );
        continue;
      }

      if (!execute) {
        wouldCreate++;
        charges.push({
          date: fields.paymentDate,
          documentDate,
          originalChargeDate: fields.paymentDate,
          chargeId,
          clientName: fields.name,
          currency: fields.currency,
          amount: fields.amount,
          vatType: fields.vatType,
          incomePrice: fields.price,
          action: "WOULD CREATE",
          searchResultCount: searchResult.searchResultCount,
        });
        console.log(
          `[WOULD CREATE] ${chargeId} ${fields.paymentDate} ${fields.name} ${fields.currency} ${fields.amount} searchCount=${searchResult.searchResultCount}`,
        );
        continue;
      }

      // Execute: create document, rate-limit to ≤ 1 request per second
      const elapsed = Date.now() - lastCreateAt;
      if (lastCreateAt > 0 && elapsed < 1000) {
        await sleep(1000 - elapsed);
      }

      const documentBody = buildDocumentBody(charge, fields, documentDate);
      try {
        lastCreateAt = Date.now();
        const result = await createDocument(token, documentBody);
        created++;
        const documentNumber = result.number ?? result.id ?? "(unknown)";
        charges.push({
          date: fields.paymentDate,
          documentDate,
          originalChargeDate: fields.paymentDate,
          chargeId,
          clientName: fields.name,
          currency: fields.currency,
          amount: fields.amount,
          vatType: fields.vatType,
          incomePrice: fields.price,
          action: "CREATED",
          searchResultCount: searchResult.searchResultCount,
          documentNumber,
        });
        console.log(
          `[CREATED] ${chargeId} → document number ${documentNumber}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed++;
        errors.push({ chargeId, error: message });
        charges.push({
          date: fields.paymentDate,
          documentDate,
          originalChargeDate: fields.paymentDate,
          chargeId,
          clientName: fields.name,
          currency: fields.currency,
          amount: fields.amount,
          vatType: fields.vatType,
          incomePrice: fields.price,
          action: "FAILED",
          searchResultCount: searchResult.searchResultCount,
          error: message,
        });
        console.error(`[FAIL] ${chargeId}: ${message}`);
      }
    }

    if (hitProcessLimit) break;

    if (!page.has_more) {
      break;
    }

    const lastItem = pageData[pageData.length - 1];
    if (!lastItem?.id) {
      console.warn("Stripe page has_more but last item missing id; stopping");
      break;
    }
    cursor = lastItem.id;
  }

  if (pageCount >= MAX_PAGES) {
    console.warn(
      `Reached safety cap of ${MAX_PAGES} Stripe charge pages; stopping pagination`,
    );
  }

  const summary = {
    mode,
    from,
    to: to ?? formatDateYYYYMMDD(createdLte),
    limit,
    totalChargesScanned: scanned,
    created: execute ? created : 0,
    wouldCreate: execute ? 0 : wouldCreate,
    skippedDuplicates: skippedDuplicate,
    failed,
  };

  console.log(
    `backfill done: scanned=${scanned} created=${created} wouldCreate=${wouldCreate} skipped=${skippedDuplicate} failed=${failed}`,
  );

  return jsonResponse({
    summary,
    charges,
    errors: errors.length > 0 ? errors : undefined,
  });
});
