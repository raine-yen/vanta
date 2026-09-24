import { mysqlAdmin } from "@/lib/mysql/admin";

// Direct Yahoo Finance HTTP fetch — no package, no crumb issues on serverless.
// Uses the v8 chart endpoint which is the most reliable for single-symbol quotes.

export type MarketState = "open" | "pre" | "post" | "closed" | "unknown";
export type QuoteQuality = "delayed" | "last-close" | "after-hours" | "pre-market" | "unknown";

/**
 * A provider timestamp is intentionally kept separate from fetch time.  Fetch
 * time only tells us when our server asked; it must never make a closed-market
 * quote look like a new trade.
 */
export interface PriceQuote {
  symbol: string;
  price: number;
  prevClose: number | null;
  updatedAt: string;
  providerTimestamp?: string | null;
  marketState?: MarketState;
  quality?: QuoteQuality;
  source?: "yahoo" | "cache";
  stale?: boolean;
}

export interface DetailedQuote extends PriceQuote {
  name: string | null;
  currency: string | null;
  exchange: string | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  epsTrailingTwelveMonths: number | null;
  volume: number | null;
  averageVolume: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  yearHigh: number | null;
  yearLow: number | null;
  change: number | null;
  changePercent: number | null;
}

const CACHE_TTL_MS = 5_000;
const QUOTE_TIMEOUT_MS = 3_500;
const memCache = new Map<string, { price: number; prevClose: number | null; ts: number }>();

export type ChartRange = "1h" | "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y";
export type ChartInterval = "1d" | "1h" | "15m" | "5m" | "1m";

/**
 * Yahoo restricts intraday history by range. Keep the range/interval contract
 * explicit so the chart stays detailed without asking the provider for an
 * unsupported combination. `trailingBars` makes 1H mean the last tradable
 * hour even when the exchange is closed.
 */
export function resolveChartRequest(range: ChartRange): { interval: ChartInterval; yahooRange: ChartRange; trailingBars: number | null } {
  switch (range) {
    case "1h": return { interval: "1m", yahooRange: "1d", trailingBars: 60 };
    case "1d": return { interval: "5m", yahooRange: "1d", trailingBars: null };
    case "5d": return { interval: "15m", yahooRange: "5d", trailingBars: null };
    case "1mo": return { interval: "1h", yahooRange: "1mo", trailingBars: null };
    case "3mo": return { interval: "1d", yahooRange: "3mo", trailingBars: null };
    case "6mo": return { interval: "1d", yahooRange: "6mo", trailingBars: null };
    case "1y": return { interval: "1d", yahooRange: "1y", trailingBars: null };
  }
}

const YAHOO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

function providerTime(epochSeconds: unknown): string | null {
  return typeof epochSeconds === "number" && Number.isFinite(epochSeconds)
    ? new Date(epochSeconds * 1000).toISOString()
    : null;
}

/** Yahoo's currentTradingPeriod is provider-supplied exchange time. */
function stateFromTradingPeriod(meta: Record<string, unknown>): MarketState {
  const now = Date.now() / 1000;
  const period = meta.currentTradingPeriod as Record<string, { start?: number; end?: number }> | undefined;
  if (!period) return "unknown";
  if (period.regular?.start != null && period.regular?.end != null && now >= period.regular.start && now < period.regular.end) return "open";
  if (period.pre?.start != null && period.pre?.end != null && now >= period.pre.start && now < period.pre.end) return "pre";
  if (period.post?.start != null && period.post?.end != null && now >= period.post.start && now < period.post.end) return "post";
  return "closed";
}

async function yahooQuote(symbol: string): Promise<PriceQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d&includePrePost=true`;
  try {
    const res = await fetch(url, { headers: YAHOO_HEADERS, next: { revalidate: 0 }, signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta as Record<string, unknown> | undefined;
    if (!meta || typeof meta.regularMarketPrice !== "number") return null;
    const marketState = stateFromTradingPeriod(meta);
    // We deliberately publish an extended quote only when the provider actually
    // supplies one. Otherwise after-hours and pre-market remain last close.
    const extendedPrice = marketState === "post" ? meta.postMarketPrice : marketState === "pre" ? meta.preMarketPrice : null;
    const hasExtended = typeof extendedPrice === "number" && Number.isFinite(extendedPrice);
    const price = hasExtended ? extendedPrice : meta.regularMarketPrice;
    const providerTimestamp = providerTime(hasExtended ? (marketState === "post" ? meta.postMarketTime : meta.preMarketTime) : meta.regularMarketTime);
    return {
      symbol,
      price,
      prevClose: typeof meta.previousClose === "number" ? meta.previousClose : typeof meta.chartPreviousClose === "number" ? meta.chartPreviousClose : null,
      updatedAt: new Date().toISOString(),
      providerTimestamp,
      marketState,
      quality: hasExtended ? (marketState === "post" ? "after-hours" : "pre-market") : marketState === "open" ? "delayed" : "last-close",
      source: "yahoo",
      stale: marketState !== "open" || !providerTimestamp || Date.now() - new Date(providerTimestamp).getTime() > 90_000,
    };
  } catch {
    return null;
  }
}

async function yahooSnapshot(symbols: string[]): Promise<Map<string, DetailedQuote>> {
  const out = new Map<string, DetailedQuote>();
  if (symbols.length === 0) return out;
  const deduped = Array.from(new Set(symbols.map((symbol) => symbol.toUpperCase())));
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(deduped.join(","))}`;

  try {
    const res = await fetch(url, { headers: YAHOO_HEADERS, next: { revalidate: 0 }, signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) });
    if (!res.ok) return out;
    const json = await res.json();
    const results = json?.quoteResponse?.result;
    if (!Array.isArray(results)) return out;

    for (const row of results) {
      const symbol = typeof row?.symbol === "string" ? row.symbol.toUpperCase() : null;
      const price = typeof row?.regularMarketPrice === "number" ? row.regularMarketPrice : null;
      if (!symbol || price == null) continue;

      const prevClose =
        typeof row?.regularMarketPreviousClose === "number"
          ? row.regularMarketPreviousClose
          : typeof row?.regularMarketDayPreviousClose === "number"
            ? row.regularMarketDayPreviousClose
            : null;

      out.set(symbol, {
        symbol,
        price,
        prevClose,
        updatedAt: new Date().toISOString(),
        name: typeof row?.longName === "string" ? row.longName : typeof row?.shortName === "string" ? row.shortName : null,
        currency: typeof row?.currency === "string" ? row.currency : null,
        exchange: typeof row?.fullExchangeName === "string" ? row.fullExchangeName : typeof row?.exchange === "string" ? row.exchange : null,
        marketCap: typeof row?.marketCap === "number" ? row.marketCap : null,
        trailingPE: typeof row?.trailingPE === "number" ? row.trailingPE : null,
        forwardPE: typeof row?.forwardPE === "number" ? row.forwardPE : null,
        epsTrailingTwelveMonths: typeof row?.epsTrailingTwelveMonths === "number" ? row.epsTrailingTwelveMonths : null,
        volume: typeof row?.regularMarketVolume === "number" ? row.regularMarketVolume : null,
        averageVolume: typeof row?.averageDailyVolume3Month === "number" ? row.averageDailyVolume3Month : null,
        open: typeof row?.regularMarketOpen === "number" ? row.regularMarketOpen : null,
        dayHigh: typeof row?.regularMarketDayHigh === "number" ? row.regularMarketDayHigh : null,
        dayLow: typeof row?.regularMarketDayLow === "number" ? row.regularMarketDayLow : null,
        yearHigh: typeof row?.fiftyTwoWeekHigh === "number" ? row.fiftyTwoWeekHigh : null,
        yearLow: typeof row?.fiftyTwoWeekLow === "number" ? row.fiftyTwoWeekLow : null,
        change: typeof row?.regularMarketChange === "number" ? row.regularMarketChange : null,
        changePercent: typeof row?.regularMarketChangePercent === "number" ? row.regularMarketChangePercent : null,
      });
    }
  } catch {
    return out;
  }

  return out;
}

export async function fetchYahooPrice(symbol: string, options: { forceLive?: boolean } = {}): Promise<PriceQuote | null> {
  const upper = symbol.toUpperCase();
  const cached = memCache.get(upper);
  if (!options.forceLive && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { symbol: upper, price: cached.price, prevClose: cached.prevClose, updatedAt: new Date(cached.ts).toISOString(), providerTimestamp: new Date(cached.ts).toISOString(), marketState: "unknown", quality: "unknown", source: "cache", stale: true };
  }
  const q = await yahooQuote(upper);
  if (!q) return null;
  memCache.set(upper, { price: q.price, prevClose: q.prevClose, ts: Date.now() });
  return q;
}

export async function fetchYahooDetailedQuote(symbol: string): Promise<DetailedQuote | null> {
  const upper = symbol.toUpperCase();
  const snapshot = await yahooSnapshot([upper]);
  const detailed = snapshot.get(upper);
  if (detailed) {
    memCache.set(upper, { price: detailed.price, prevClose: detailed.prevClose, ts: Date.now() });
    return detailed;
  }

  const fallback = await fetchYahooPrice(upper);
  if (!fallback) return null;
  return {
    ...fallback,
    name: null,
    currency: null,
    exchange: null,
    marketCap: null,
    trailingPE: null,
    forwardPE: null,
    epsTrailingTwelveMonths: null,
    volume: null,
    averageVolume: null,
    open: null,
    dayHigh: null,
    dayLow: null,
    yearHigh: null,
    yearLow: null,
    change: fallback.prevClose == null ? null : fallback.price - fallback.prevClose,
    changePercent: fallback.prevClose == null || fallback.prevClose === 0 ? null : ((fallback.price - fallback.prevClose) / fallback.prevClose) * 100,
  };
}

export async function fetchYahooPrices(symbols: string[]): Promise<Map<string, PriceQuote>> {
  const out = new Map<string, PriceQuote>();
  if (symbols.length === 0) return out;
  const upper = Array.from(new Set(symbols.map((s) => s.toUpperCase())));

  await Promise.all(
    upper.map(async (s) => {
      const cached = memCache.get(s);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        out.set(s, { symbol: s, price: cached.price, prevClose: cached.prevClose, updatedAt: new Date(cached.ts).toISOString(), providerTimestamp: new Date(cached.ts).toISOString(), marketState: "unknown", quality: "unknown", source: "cache", stale: true });
        return;
      }
      const q = await yahooQuote(s);
      if (!q) return;
      memCache.set(s, { price: q.price, prevClose: q.prevClose, ts: Date.now() });
      out.set(s, q);
    })
  );
  return out;
}

export async function fetchYahooDetailedQuotes(symbols: string[]): Promise<Map<string, DetailedQuote>> {
  const out = new Map<string, DetailedQuote>();
  if (symbols.length === 0) return out;
  const upper = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const cachedNow = Date.now();
  const missing: string[] = [];

  for (const symbol of upper) {
    const cached = memCache.get(symbol);
    if (cached && cachedNow - cached.ts < CACHE_TTL_MS) {
      out.set(symbol, {
        symbol,
        price: cached.price,
        prevClose: cached.prevClose,
        updatedAt: new Date(cached.ts).toISOString(),
        name: null,
        currency: null,
        exchange: null,
        marketCap: null,
        trailingPE: null,
        forwardPE: null,
        epsTrailingTwelveMonths: null,
        volume: null,
        averageVolume: null,
        open: null,
        dayHigh: null,
        dayLow: null,
        yearHigh: null,
        yearLow: null,
        change: cached.prevClose == null ? null : cached.price - cached.prevClose,
        changePercent: cached.prevClose == null || cached.prevClose === 0 ? null : ((cached.price - cached.prevClose) / cached.prevClose) * 100,
      });
    } else {
      missing.push(symbol);
    }
  }

  const fresh = await yahooSnapshot(missing);
  for (const [symbol, quote] of fresh.entries()) {
    memCache.set(symbol, { price: quote.price, prevClose: quote.prevClose, ts: Date.now() });
    out.set(symbol, quote);
  }

  const unresolved = missing.filter((symbol) => !out.has(symbol));
  await Promise.all(
    unresolved.map(async (symbol) => {
      const fallback = await fetchYahooDetailedQuote(symbol);
      if (fallback) out.set(symbol, fallback);
    })
  );

  return out;
}

export async function getPrice(symbol: string, options: { forceLive?: boolean; maxCacheAgeMs?: number } = {}): Promise<number | null> {
  const upper = symbol.toUpperCase();
  const db = mysqlAdmin();
  const maxCacheAgeMs = options.maxCacheAgeMs ?? 5_000;

  const { data: cached } = options.forceLive ? { data: null } : await db
    .from("prices")
    .select("price, updated_at")
    .eq("symbol", upper)
    .maybeSingle();

  if (cached) {
    const age = Date.now() - new Date((cached as { updated_at: string }).updated_at).getTime();
    if (age < maxCacheAgeMs) return Number((cached as { price: number }).price);
  }

  const live = await fetchYahooPrice(upper, { forceLive: options.forceLive });
  if (!live) return cached ? Number((cached as { price: number }).price) : null;

  await db.from("prices").upsert({
    symbol: upper,
    price: live.price,
    prev_close: live.prevClose,
    updated_at: new Date().toISOString(),
  });
  return live.price;
}

export async function getHistoricalBars(
  symbol: string,
  interval: ChartInterval = "1d",
  range: ChartRange = "1mo"
): Promise<Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> {
  const upper = symbol.toUpperCase();
  const resolved = resolveChartRequest(range);
  const requestedInterval = interval === "1d" ? resolved.interval : interval;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upper)}?interval=${requestedInterval}&range=${resolved.yahooRange}`;
  try {
    const res = await fetch(url, { headers: YAHOO_HEADERS, next: { revalidate: 0 } });
    if (!res.ok) return [];
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return [];
    const timestamps: number[] = result.timestamp ?? [];
    const ohlcv = result.indicators?.quote?.[0] ?? {};
    const bars = timestamps
      .map((t: number, i: number) => ({
        t: new Date(t * 1000).toISOString(),
        o: Number(ohlcv.open?.[i] ?? ohlcv.close?.[i] ?? 0),
        h: Number(ohlcv.high?.[i] ?? ohlcv.close?.[i] ?? 0),
        l: Number(ohlcv.low?.[i] ?? ohlcv.close?.[i] ?? 0),
        c: Number(ohlcv.close?.[i] ?? 0),
        v: Number(ohlcv.volume?.[i] ?? 0),
      }))
      .filter((b) => b.c > 0);
    return resolved.trailingBars == null ? bars : bars.slice(-resolved.trailingBars);
  } catch {
    return [];
  }
}
