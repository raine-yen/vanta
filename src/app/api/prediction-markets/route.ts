import { NextRequest, NextResponse } from "next/server";
import { mysqlAdmin } from "@/lib/mysql/admin";
import {
  fetchActiveMarkets,
  catalogNeedsQuoteRepair,
  hydratePredictionMarketPrices,
  persistCatalogRows,
  type PredictionMarketRow,
} from "@/lib/prediction-sync";
import { predictionOutcomeLabels } from "@/lib/prediction-presentation";

export interface PredictionMarket {
  id: string; // condition id (catalog PK; matches /api/predictions/* routes)
  question: string;
  category: string | null;
  tags?: string[];
  yesTokenId: string | null;
  noTokenId: string | null;
  yesLabel: string;
  noLabel: string;
  outcomes: string[];
  yesPrice: number | null; // live CLOB midpoint (0..1), last-known on failure
  noPrice: number | null;
  volume24hr: number | null;
  endDate: string | null;
  image: string | null;
  url: string | null;
  status: string;
}

const LIVE_CACHE_MS = 60_000;
interface CatalogPage {
  items: PredictionMarket[];
  cached: boolean;
  hasMore: boolean;
  nextOffset: number | null;
}
let liveCache: { expiresAt: number; key: string; page: CatalogPage } | null = null;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const LIVE_QUOTE_LIMIT = 12;

function cleanSearchTerm(value: string | null): string {
  return (value ?? "").trim().replace(/[\\%_]/g, "").slice(0, 100);
}

function toMarket(row: {
  id: string;
  question: string;
  category: string | null;
  tags?: string[] | null;
  yes_token_id: string | null;
  no_token_id: string | null;
  yes_label?: string | null;
  no_label?: string | null;
  yes_price: number | null;
  no_price: number | null;
  volume_24h: number | null;
  end_date: string | null;
  status: string;
  image: string | null;
  url: string | null;
}): PredictionMarket {
  const [yesLabel, noLabel] = predictionOutcomeLabels(row.question, row.yes_label, row.no_label);
  return {
    id: row.id,
    question: row.question,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    yesTokenId: row.yes_token_id,
    noTokenId: row.no_token_id,
    yesLabel,
    noLabel,
    outcomes: [yesLabel, noLabel],
    yesPrice: row.yes_price,
    noPrice: row.no_price ?? (row.yes_price == null ? null : Math.round((1 - row.yes_price) * 10000) / 10000),
    volume24hr: row.volume_24h,
    endDate: row.end_date,
    image: row.image,
    url: row.url,
    status: row.status,
  };
}

export async function GET(req: NextRequest) {
  const searchParams = new URL(req.url).searchParams;
  const forceRefresh = searchParams.get("refresh") === "1";
  const requestedLimit = Number(searchParams.get("limit"));
  const listLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(requestedLimit))) : DEFAULT_LIST_LIMIT;
  const requestedOffset = Number(searchParams.get("offset"));
  const listOffset = Number.isFinite(requestedOffset) ? Math.max(0, Math.min(100_000, Math.floor(requestedOffset))) : 0;
  const searchTerm = cleanSearchTerm(searchParams.get("q"));
  const requestedIds = Array.from(new Set((searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean))).slice(0, 50);
  const cacheKey = `${listOffset}:${listLimit}:${searchTerm.toLowerCase()}`;
  if (!forceRefresh && !requestedIds.length && !searchTerm && liveCache?.key === cacheKey && liveCache.expiresAt > Date.now()) {
    return NextResponse.json({ ...liveCache.page, cached: true });
  }
  try {
    const db = mysqlAdmin();
    let catalogQuery = db.from("prediction_markets").select("*").eq("status", "active");
    if (searchTerm) catalogQuery = catalogQuery.ilike("question", `%${searchTerm}%`);
    const catalogRows = (await catalogQuery
      .order("volume_24h", { ascending: false })
      .range(listOffset, listOffset + listLimit)).data as PredictionMarketRow[] | null;
    let hasMore = (catalogRows?.length ?? 0) > listLimit;
    let rows = (catalogRows ?? []).slice(0, listLimit);

    if (requestedIds.length && !searchTerm && listOffset === 0) {
      const heldRows = (await db.from("prediction_markets").select("*").in("id", requestedIds)).data as PredictionMarketRow[] | null;
      const merged = new Map(rows.map((row) => [row.id, row]));
      for (const row of heldRows ?? []) merged.set(row.id, row);
      rows = Array.from(merged.values());
    }

    // First run before the cron has populated the catalog: fetch Gamma directly
    // (and let the next cron persist it). Keeps the endpoint usable immediately.
    if (rows.length === 0 && listOffset === 0) {
      const fallbackRows = await fetchActiveMarkets(fetch, 100);
      const matchingRows = searchTerm
        ? fallbackRows.filter((row) => `${row.question} ${row.category ?? ""}`.toLowerCase().includes(searchTerm.toLowerCase()))
        : fallbackRows;
      rows = matchingRows.slice(0, listLimit);
      hasMore = matchingRows.length > listLimit;
      // A first visitor should repair an empty catalog, not merely receive a
      // transient fallback that still cannot be traded or charted.
      await persistCatalogRows(db, fallbackRows);
    } else if (catalogNeedsQuoteRepair(rows)) {
      // Repair a legacy all-null catalog promptly. Two pages keep this request
      // bounded; the cron continues to fill the full 1,000-market catalog.
      try {
        const refreshed = await fetchActiveMarkets(fetch, 2);
        await persistCatalogRows(db, refreshed);
      rows = refreshed.slice(0, listLimit);
      hasMore = refreshed.length > listLimit;
      } catch {
        console.warn("Legacy catalog repair failed; serving cached rows");
      }
    }

    // Hydrate a bounded batch and persist usable values. A later CLOB timeout
    // can then fall back to a recent, real quote rather than disabling trading.
    const quotedRows = await hydratePredictionMarketPrices(rows.slice(0, LIVE_QUOTE_LIMIT), fetch, 4);
    await persistCatalogRows(db, quotedRows);
    const liveRows = new Map(quotedRows.map((row) => [row.id, row]));
    const markets = rows.map((row) => toMarket(liveRows.get(row.id) ?? row));

    const page: CatalogPage = { items: markets, cached: false, hasMore, nextOffset: hasMore ? listOffset + listLimit : null };
    if (!requestedIds.length && !searchTerm) liveCache = { expiresAt: Date.now() + LIVE_CACHE_MS, key: cacheKey, page };
    return NextResponse.json(page);
  } catch (e) {
    console.error("prediction-markets list failed", e);
    return NextResponse.json(
      { ...(liveCache?.page ?? { items: [], hasMore: false, nextOffset: null }), unavailable: true },
      { status: liveCache ? 200 : 503 }
    );
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 30;
