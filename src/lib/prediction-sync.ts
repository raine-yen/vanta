// Syncs the Polymarket catalog into `prediction_markets` and provides live
// binary-outcome quotes. The db handle is duck-typed (a query-builder-like
// object) and fetch is injectable, so every code path is unit-testable with
// fakes — production callers pass mysqlAdmin() and global fetch.
import { createHash } from "node:crypto";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Stable internal UUID for an external Polymarket condition ID. */
export function marketUuid(conditionId: string): string {
  const hex = createHash("sha256").update(`vanta:prediction:${conditionId}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface PredictionMarketRow {
  id: string;
  condition_id: string;
  question: string;
  category: string | null;
  event_slug?: string | null;
  tags?: string[] | null;
  yes_label?: string | null;
  no_label?: string | null;
  yes_token_id: string | null;
  no_token_id: string | null;
  yes_price: number | null;
  no_price: number | null;
  volume_24h: number | null;
  end_date: string | null;
  status: string;
  resolved_outcome: string | null;
  image: string | null;
  url: string | null;
  updated_at: string;
}

interface GammaMarket {
  id?: string | number;
  question?: string;
  conditionId?: string;
  slug?: string;
  category?: string;
  endDate?: string;
  volume24hr?: number | string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  image?: string;
  clobTokenIds?: string;
  outcomePrices?: string | Array<string | number>;
  outcomes?: string | Array<string | number>;
  tags?: string[] | string;
  acceptingOrders?: boolean;
  umaResolutionStatus?: string;
}

export interface UpstreamPredictionMarketState {
  tradable: boolean;
  closed: boolean;
  resolved: boolean;
  resolvedOutcome: "yes" | "no" | null;
}

export function price01(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object"
          ? String((item as Record<string, unknown>).label ?? (item as Record<string, unknown>).slug ?? "")
          : String(item))
      .filter(Boolean);
  }
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parseJsonArray(parsed) : [];
  } catch {
    return [];
  }
}

function marketSlug(row: Pick<PredictionMarketRow, "event_slug" | "url">): string | null {
  if (row.event_slug) return row.event_slug;
  if (!row.url) return null;
  const match = row.url.match(/\/event\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Read one market directly from Gamma before accepting an order. Catalog rows
 * can lag after a sports result, so a stored `active` flag is not sufficient. */
export async function fetchUpstreamPredictionMarketState(
  row: Pick<PredictionMarketRow, "event_slug" | "url">,
  fetchImpl: FetchLike = fetch,
): Promise<UpstreamPredictionMarketState | null> {
  const slug = marketSlug(row);
  if (!slug) return null;
  try {
    const response = await fetchImpl(`https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`, { headers: POLYMARKET_HEADERS });
    if (!response.ok) return null;
    const raw = (await response.json()) as GammaMarket;
    const prices = parseJsonArray(raw.outcomePrices);
    const resolvedOutcome = raw.umaResolutionStatus === "resolved"
      ? Number(prices[0]) === 1 ? "yes" : Number(prices[1]) === 1 ? "no" : null
      : null;
    const closed = raw.closed === true || raw.acceptingOrders === false || raw.umaResolutionStatus === "resolved";
    return {
      tradable: raw.active !== false && !closed,
      closed,
      resolved: raw.umaResolutionStatus === "resolved",
      resolvedOutcome,
    };
  } catch {
    return null;
  }
}

/** Parse one Gamma market into a catalog row. Returns null for malformed rows. */
export function parseGammaMarket(raw: GammaMarket): PredictionMarketRow | null {
  const conditionId = String(raw.conditionId ?? raw.id ?? "").trim();
  const question = String(raw.question ?? "").trim();
  if (!conditionId || !question) return null;
  // Binary markets may be phrased Yes/No or name two competing outcomes.
  const tokens = parseJsonArray(raw.clobTokenIds);
  const prices = parseJsonArray(raw.outcomePrices);
  const outcomeLabels = parseJsonArray(raw.outcomes);
  if (tokens.length !== 2) return null;
  const yesPrice = price01(prices[0]);
  const noPrice = price01(prices[1]);
  return {
    id: marketUuid(conditionId),
    condition_id: conditionId,
    question,
    category: raw.category ? String(raw.category) : null,
    event_slug: raw.slug ? String(raw.slug) : null,
    tags: parseJsonArray(raw.tags),
    yes_token_id: tokens[0] ?? null,
    no_token_id: tokens[1] ?? null,
    yes_label: outcomeLabels[0] ?? "Yes",
    no_label: outcomeLabels[1] ?? "No",
    yes_price: yesPrice,
    no_price: noPrice,
    volume_24h: Number.isFinite(Number(raw.volume24hr)) ? Number(raw.volume24hr) : null,
    end_date: typeof raw.endDate === "string" ? raw.endDate : null,
    status: raw.closed ? "closed" : "active",
    resolved_outcome: null,
    image: typeof raw.image === "string" ? raw.image : null,
    url: raw.slug ? `https://polymarket.com/event/${encodeURIComponent(String(raw.slug))}` : null,
    updated_at: new Date().toISOString(),
  };
}

// Gamma and CLOB sit behind Cloudflare, which returns 403 (error 1010) for
// requests without a browser-like User-Agent.
const POLYMARKET_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/**
 * Fetch all active binary markets from Gamma via the /events endpoint
 * (paginated, up to `maxPages` events pages). Events carry the tag taxonomy
 * that the /markets endpoint omits, so sports/esports discovery works; each
 * event embeds its markets, which are parsed exactly like /markets rows and
 * annotated with the parent event's tags + slug. Gamma rejects offsets beyond
 * ~2000 on this endpoint (422 "offset too large") — treated as end of data.
 */
export async function fetchActiveMarkets(
  fetchImpl: FetchLike = fetch,
  maxPages = 100,
): Promise<PredictionMarketRow[]> {
  const out: PredictionMarketRow[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const url =
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100" +
      `&offset=${page * 100}&order=volume24hr&ascending=false`;
    const res = await fetchImpl(url, { headers: POLYMARKET_HEADERS });
    // Gamma rejects deep offsets ("offset too large", 422) — that is the end
    // of the offset-paginated window, not a failure.
    if (res.status === 422) break;
    if (!res.ok) throw new Error(`Gamma returned ${res.status}`);
    const data = (await res.json()) as GammaMarket[];
    if (!Array.isArray(data) || data.length === 0) break;
    for (const raw of data) {
      if (raw.closed || raw.active === false) continue;
      const row = parseGammaMarket(raw);
      if (row && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
    }
    if (data.length < 100) break;
  }
  return out;
}

export function catalogNeedsQuoteRepair(rows: Array<Pick<PredictionMarketRow, "yes_price" | "no_price">>): boolean {
  return rows.length > 0 && rows.every((row) => row.yes_price == null && row.no_price == null);
}

export async function hydratePredictionMarketPrices(
  rows: PredictionMarketRow[],
  fetchImpl: FetchLike = fetch,
  concurrency = 4,
): Promise<PredictionMarketRow[]> {
  const hydrated: PredictionMarketRow[] = [];
  const width = Math.max(1, Math.floor(concurrency));
  for (let index = 0; index < rows.length; index += width) {
    const batch = rows.slice(index, index + width);
    const priced = await Promise.all(batch.map(async (row) => {
      const [yesPrice, noPrice] = await Promise.all([
        liveMidpoint(row.yes_token_id, fetchImpl, row.yes_price),
        liveMidpoint(row.no_token_id, fetchImpl, row.no_price),
      ]);
      return { ...row, yes_price: yesPrice, no_price: noPrice };
    }));
    hydrated.push(...priced);
  }
  return hydrated;
}

export interface CatalogDb {
  from(table: string): {
    upsert(rows: unknown[], opts?: { onConflict?: string }): PromiseLike<{ error?: { message?: string } | null }>;
    update(values: Record<string, unknown>): {
      eq(col: string, val: unknown): PromiseLike<{ error?: { message?: string } | null }>;
    };
  };
}

export async function persistCatalogRows(
  db: CatalogDb,
  rows: PredictionMarketRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await db.from("prediction_markets").upsert(rows, { onConflict: "id" });
  if (error) {
    // If the taxonomy columns haven't been migrated yet (20260912_prediction_taxonomy.sql),
    // retry with the pre-migration shape so discovery keeps working on old schemas.
    const legacy = rows.map(({ event_slug: _e, tags: _t, yes_label: _yes, no_label: _no, ...rest }) => rest);
    const retry = await db.from("prediction_markets").upsert(legacy, { onConflict: "id" });
    if (retry.error) throw new Error(`catalog upsert failed: ${retry.error ?? error.message ?? "unknown"}`);
  }
  return rows.length;
}

/**
 * Upsert the fetched catalog into prediction_markets (conflict on id).
 * Prices are intentionally NOT overwritten here (live quote path owns them);
 * we only refresh metadata + volume. Returns the number of upserted rows.
 */
export async function syncPredictionCatalog(
  db: CatalogDb,
  fetchImpl: FetchLike = fetch,
  maxPages = 100,
): Promise<number> {
  const rows = await fetchActiveMarkets(fetchImpl, maxPages);
  return persistCatalogRows(db, rows);
}

/**
 * Live midpoint price (0..1) for one outcome token via the CLOB,
 * with fallback to the top of the book, then to a last-known price.
 */
export async function liveMidpoint(
  tokenId: string | null,
  fetchImpl: FetchLike = fetch,
  lastKnown: number | null = null,
): Promise<number | null> {
  if (!tokenId) return lastKnown;
  try {
    const res = await fetchImpl(`https://clob.polymarket.com/midpoint?token_id=${encodeURIComponent(tokenId)}`, {
          headers: POLYMARKET_HEADERS,
        });
    if (res.ok) {
      const body = (await res.json()) as { mid?: string | number; midpoint?: string | number };
      const mid = price01(body.mid ?? body.midpoint);
      if (mid != null) return mid;
    }
  } catch {
    /* fall through to book */
  }
  try {
    const res = await fetchImpl(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, {
          headers: POLYMARKET_HEADERS,
        });
    if (res.ok) {
      const book = (await res.json()) as { bids?: Array<{ price: string | number }>; asks?: Array<{ price: string | number }> };
      // Gamma/CLOB return bids ascending, asks descending; top of book is the extreme.
      const bid = Math.max(0, ...(book.bids ?? []).map((b) => Number(b.price)).filter((n) => Number.isFinite(n)));
      const ask = Math.min(1, ...(book.asks ?? []).map((a) => Number(a.price)).filter((n) => Number.isFinite(n)));
      if (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid) return price01((bid + ask) / 2);
      if (Number.isFinite(bid) && bid > 0) return price01(bid);
    }
  } catch {
    /* fall through */
  }
  return lastKnown;
}

/**
 * Probability history for one outcome token (CLOB prices-history).
 * Returns chronological {t (unix seconds), p (0..1)} points; [] on failure.
 */
export async function fetchProbabilityHistory(
  fetchImpl: FetchLike,
  tokenId: string | null,
  days = 7,
  fidelityMinutes = 60,
): Promise<Array<{ t: number; p: number }>> {
  if (!tokenId) return [];
  const now = Math.floor(Date.now() / 1000);
  const url =
    "https://clob.polymarket.com/prices-history?market=" + encodeURIComponent(tokenId) +
    `&startTs=${now - days * 86400}&endTs=${now}&fidelity=${fidelityMinutes}`;
  try {
    const res = await fetchImpl(url, { headers: POLYMARKET_HEADERS });
        if (!res.ok) return [];
    const body = (await res.json()) as { history?: Array<{ t?: number; p?: number }> };
    return (body.history ?? [])
      .map((h) => ({ t: Number(h.t), p: price01(h.p) }))
      .filter((h): h is { t: number; p: number } => Number.isFinite(h.t) && h.p != null);
  } catch {
    return [];
  }
}

/** Live outcome prices for a catalog row: yes from CLOB midpoint, no = 1 - yes. */
export async function liveOutcomePrices(
  row: { yes_token_id: string | null; yes_price: number | null },
  fetchImpl: FetchLike = fetch,
): Promise<{ yesPrice: number | null; noPrice: number | null }> {
  const yes = await liveMidpoint(row.yes_token_id, fetchImpl, row.yes_price);
  return { yesPrice: yes, noPrice: yes == null ? null : Math.round((1 - yes) * 10000) / 10000 };
}

/** Mark a Gamma market resolved in our catalog (called by the settlement pass). */
export async function markResolved(
  db: CatalogDb,
  marketId: string,
  outcome: "yes" | "no",
): Promise<void> {
  const { error } = await db
    .from("prediction_markets")
    .update({ status: "resolved", resolved_outcome: outcome, settled_at: new Date().toISOString() })
    .eq("id", marketId);
  if (error) throw new Error(`mark resolved failed: ${error.message ?? "unknown"}`);
}
