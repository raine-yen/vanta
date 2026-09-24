// Unified instrument search catalog — stocks, ETFs, and crypto.
//
// Two layers:
//  1. A curated local catalog (seed instruments with aliases + popularity weights).
//  2. Live augmentation via Yahoo Finance's search endpoint for everything else
//     (results are cached in-memory), normalized into the same shape.
//
// Ranking tiers (highest first):
//   1000 exact symbol match
//    900 exact alias match
//    700 query is a prefix of the symbol
//    650 query is a prefix of the name
//    600 word-prefix name match (any name word starts with the query)
//    500 query is a substring of the name
//    400 subsequence fuzzy match (chars of query appear in order in name/symbol)
//    <400 live-provider hits, ranked by provider score (never above local hits)
// Within a tier, popularity weight is the tiebreaker. For a general company
// query, stocks and ETFs are shown before crypto; an explicit known crypto
// ticker or name keeps the user in crypto-first intent.

export type AssetClass = "stock" | "etf" | "crypto" | "prediction";

export interface Instrument {
  symbol: string;        // canonical trade symbol (crypto uses Yahoo-style BASE-USD)
  displayName: string;
  name: string;          // normalized lowercase name for matching
  aliases: string[];     // normalized lowercase aliases
  assetClass: AssetClass;
  exchange: string | null; // exchange for equities/ETFs, venue label for crypto
  market: string;        // "us-equities" | "crypto"
  tradable: boolean;
  displaySymbol: string; // user-facing symbol (crypto shows BASE, e.g. "BTC")
  displayMarket: string; // e.g. "NASDAQ", "Cryptocurrency · Crypto"
  /** External research page; supplied for prediction-market search results. */
  url?: string | null;
}

interface SeedEntry {
  symbol: string;
  name: string;
  aliases?: string[];
  assetClass: AssetClass;
  exchange?: string;
  weight?: number; // popularity 0..100, default 10
}

const SEED: SeedEntry[] = [
  // ---- Popular / mega-cap stocks ----
  { symbol: "AAPL", name: "Apple Inc.", aliases: ["apple", "apple computer"], assetClass: "stock", exchange: "NASDAQ", weight: 100 },
  { symbol: "TSLA", name: "Tesla Inc.", aliases: ["tesla", "tesla motors"], assetClass: "stock", exchange: "NASDAQ", weight: 98 },
  { symbol: "NVDA", name: "NVIDIA Corp.", aliases: ["nvidia", "nvidia corp"], assetClass: "stock", exchange: "NASDAQ", weight: 97 },
  { symbol: "MSFT", name: "Microsoft Corp.", aliases: ["microsoft"], assetClass: "stock", exchange: "NASDAQ", weight: 96 },
  { symbol: "AMZN", name: "Amazon.com Inc.", aliases: ["amazon"], assetClass: "stock", exchange: "NASDAQ", weight: 95 },
  { symbol: "GOOGL", name: "Alphabet Inc. Class A", aliases: ["alphabet", "google"], assetClass: "stock", exchange: "NASDAQ", weight: 94 },
  { symbol: "GOOG", name: "Alphabet Inc. Class C", aliases: ["alphabet class c"], assetClass: "stock", exchange: "NASDAQ", weight: 80 },
  { symbol: "META", name: "Meta Platforms Inc.", aliases: ["meta", "facebook", "meta platforms"], assetClass: "stock", exchange: "NASDAQ", weight: 93 },
  { symbol: "NFLX", name: "Netflix Inc.", aliases: ["netflix"], assetClass: "stock", exchange: "NASDAQ", weight: 88 },
  { symbol: "AMD", name: "Advanced Micro Devices", aliases: ["advanced micro devices", "amd"], assetClass: "stock", exchange: "NASDAQ", weight: 87 },
  { symbol: "INTC", name: "Intel Corp.", aliases: ["intel"], assetClass: "stock", exchange: "NASDAQ", weight: 75 },
  { symbol: "ORCL", name: "Oracle Corp.", aliases: ["oracle"], assetClass: "stock", exchange: "NYSE", weight: 70 },
  { symbol: "CRM", name: "Salesforce Inc.", aliases: ["salesforce"], assetClass: "stock", exchange: "NYSE", weight: 70 },
  { symbol: "SNOW", name: "Snowflake Inc.", aliases: ["snowflake"], assetClass: "stock", exchange: "NYSE", weight: 60 },
  { symbol: "PLTR", name: "Palantir Technologies", aliases: ["palantir"], assetClass: "stock", exchange: "NASDAQ", weight: 78 },
  { symbol: "UBER", name: "Uber Technologies", aliases: ["uber"], assetClass: "stock", exchange: "NYSE", weight: 72 },
  { symbol: "JPM", name: "JPMorgan Chase", aliases: ["jp morgan", "jpmorgan", "j.p. morgan"], assetClass: "stock", exchange: "NYSE", weight: 74 },
  { symbol: "BAC", name: "Bank of America", aliases: ["bank of america"], assetClass: "stock", exchange: "NYSE", weight: 66 },
  { symbol: "GS", name: "Goldman Sachs", aliases: ["goldman", "goldman sachs"], assetClass: "stock", exchange: "NYSE", weight: 68 },
  { symbol: "MS", name: "Morgan Stanley", aliases: ["morgan stanley"], assetClass: "stock", exchange: "NYSE", weight: 62 },
  { symbol: "V", name: "Visa Inc.", aliases: ["visa"], assetClass: "stock", exchange: "NYSE", weight: 70 },
  { symbol: "MA", name: "Mastercard Inc.", aliases: ["mastercard"], assetClass: "stock", exchange: "NYSE", weight: 68 },
  { symbol: "BRK-B", name: "Berkshire Hathaway Class B", aliases: ["berkshire", "berkshire hathaway", "berkshire b"], assetClass: "stock", exchange: "NYSE", weight: 72 },
  { symbol: "BRK-A", name: "Berkshire Hathaway Class A", aliases: ["berkshire a"], assetClass: "stock", exchange: "NYSE", weight: 50 },
  { symbol: "WFC", name: "Wells Fargo", aliases: ["wells fargo"], assetClass: "stock", exchange: "NYSE", weight: 60 },
  { symbol: "AXP", name: "American Express", aliases: ["american express", "amex"], assetClass: "stock", exchange: "NYSE", weight: 62 },
  { symbol: "C", name: "Citigroup Inc.", aliases: ["citi", "citigroup"], assetClass: "stock", exchange: "NYSE", weight: 58 },
  { symbol: "DIS", name: "Walt Disney Co.", aliases: ["disney", "walt disney"], assetClass: "stock", exchange: "NYSE", weight: 76 },
  { symbol: "COIN", name: "Coinbase Global Inc.", aliases: ["coinbase"], assetClass: "stock", exchange: "NASDAQ", weight: 64 },
  { symbol: "MSTR", name: "MicroStrategy Inc.", aliases: ["microstrategy", "strategy"], assetClass: "stock", exchange: "NASDAQ", weight: 66 },
  { symbol: "SMCI", name: "Super Micro Computer", aliases: ["super micro"], assetClass: "stock", exchange: "NASDAQ", weight: 60 },
  { symbol: "MU", name: "Micron Technology", aliases: ["micron", "micron technology"], assetClass: "stock", exchange: "NASDAQ", weight: 76 },
  { symbol: "ARM", name: "Arm Holdings", aliases: ["arm holdings"], assetClass: "stock", exchange: "NASDAQ", weight: 64 },
  { symbol: "AVGO", name: "Broadcom Inc.", aliases: ["broadcom"], assetClass: "stock", exchange: "NASDAQ", weight: 66 },
  { symbol: "T", name: "AT&T Inc.", aliases: ["at&t", "at and t"], assetClass: "stock", exchange: "NYSE", weight: 55 },
  { symbol: "PFE", name: "Pfizer Inc.", aliases: ["pfizer"], assetClass: "stock", exchange: "NYSE", weight: 56 },
  { symbol: "XOM", name: "ExxonMobil Corp.", aliases: ["exxon", "exxon mobil"], assetClass: "stock", exchange: "NYSE", weight: 58 },
  { symbol: "CVX", name: "Chevron Corp.", aliases: ["chevron"], assetClass: "stock", exchange: "NYSE", weight: 56 },
  { symbol: "BA", name: "Boeing Co.", aliases: ["boeing"], assetClass: "stock", exchange: "NYSE", weight: 60 },
  { symbol: "NKE", name: "Nike Inc.", aliases: ["nike"], assetClass: "stock", exchange: "NYSE", weight: 58 },
  { symbol: "WMT", name: "Walmart Inc.", aliases: ["walmart"], assetClass: "stock", exchange: "NYSE", weight: 62 },
  { symbol: "SBUX", name: "Starbucks Corp.", aliases: ["starbucks"], assetClass: "stock", exchange: "NASDAQ", weight: 58 },
  { symbol: "MCD", name: "McDonald's Corp.", aliases: ["mcdonalds", "mcdonald's", "mcdonald"], assetClass: "stock", exchange: "NYSE", weight: 58 },
  { symbol: "COST", name: "Costco Wholesale", aliases: ["costco"], assetClass: "stock", exchange: "NASDAQ", weight: 60 },
  { symbol: "RIOT", name: "Riot Platforms Inc.", aliases: ["riot", "riot blockchain"], assetClass: "stock", exchange: "NASDAQ", weight: 52 },
  // ---- ETFs ----
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", aliases: ["s&p 500", "sp500", "sp 500", "spy", "s and p 500"], assetClass: "etf", exchange: "NYSE", weight: 92 },
  { symbol: "QQQ", name: "Invesco QQQ Trust (Nasdaq 100)", aliases: ["nasdaq 100", "qqq", "invesco qqq"], assetClass: "etf", exchange: "NASDAQ", weight: 90 },
  { symbol: "VTI", name: "Vanguard Total Stock Market ETF", aliases: ["vanguard total market", "vti"], assetClass: "etf", exchange: "NASDAQ", weight: 66 },
  { symbol: "IWM", name: "iShares Russell 2000 ETF", aliases: ["russell 2000", "iwm"], assetClass: "etf", exchange: "NYSE", weight: 60 },
  { symbol: "GLD", name: "SPDR Gold Shares", aliases: ["gold", "gold etf", "gld"], assetClass: "etf", exchange: "NYSE", weight: 68 },
  { symbol: "SLV", name: "iShares Silver Trust", aliases: ["silver", "silver etf"], assetClass: "etf", exchange: "NYSE", weight: 56 },
  { symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", aliases: ["treasury", "bonds", "tlt"], assetClass: "etf", exchange: "NASDAQ", weight: 54 },
  { symbol: "ARKK", name: "ARK Innovation ETF", aliases: ["ark", "ark invest", "cathie wood"], assetClass: "etf", exchange: "NYSE", weight: 58 },
  { symbol: "DIA", name: "SPDR Dow Jones Industrial Average ETF", aliases: ["dow", "dow jones", "dia"], assetClass: "etf", exchange: "NYSE", weight: 56 },
  { symbol: "XLK", name: "Technology Select Sector SPDR Fund", aliases: ["technology sector", "xlk"], assetClass: "etf", exchange: "NYSE", weight: 50 },
  { symbol: "XLF", name: "Financial Select Sector SPDR Fund", aliases: ["financial sector", "xlf"], assetClass: "etf", exchange: "NYSE", weight: 48 },
  // ---- Crypto (trade symbol = Yahoo BASE-USD; display = BASE) ----
  { symbol: "BTC-USD", name: "Bitcoin", aliases: ["bitcoin", "btc", "xbt"], assetClass: "crypto", exchange: "Crypto", weight: 100 },
  { symbol: "ETH-USD", name: "Ethereum", aliases: ["ethereum", "eth", "ether"], assetClass: "crypto", exchange: "Crypto", weight: 95 },
  { symbol: "DOGE-USD", name: "Dogecoin", aliases: ["dogecoin", "doge", "doge coin"], assetClass: "crypto", exchange: "Crypto", weight: 88 },
  { symbol: "SOL-USD", name: "Solana", aliases: ["solana", "sol"], assetClass: "crypto", exchange: "Crypto", weight: 84 },
  { symbol: "XRP-USD", name: "XRP", aliases: ["xrp", "ripple"], assetClass: "crypto", exchange: "Crypto", weight: 80 },
  { symbol: "SHIB-USD", name: "Shiba Inu", aliases: ["shiba inu", "shiba", "shib"], assetClass: "crypto", exchange: "Crypto", weight: 74 },
  { symbol: "PEPE-USD", name: "Pepe", aliases: ["pepe", "pepe coin"], assetClass: "crypto", exchange: "Crypto", weight: 72 },
  { symbol: "ADA-USD", name: "Cardano", aliases: ["cardano", "ada"], assetClass: "crypto", exchange: "Crypto", weight: 68 },
  { symbol: "AVAX-USD", name: "Avalanche", aliases: ["avalanche", "avax"], assetClass: "crypto", exchange: "Crypto", weight: 62 },
  { symbol: "WIF-USD", name: "dogwifhat", aliases: ["dogwifhat", "wif", "dog wif hat"], assetClass: "crypto", exchange: "Crypto", weight: 46 },
  { symbol: "LINK-USD", name: "Chainlink", aliases: ["chainlink", "link"], assetClass: "crypto", exchange: "Crypto", weight: 60 },
  { symbol: "LTC-USD", name: "Litecoin", aliases: ["litecoin", "ltc"], assetClass: "crypto", exchange: "Crypto", weight: 58 },
  { symbol: "BCH-USD", name: "Bitcoin Cash", aliases: ["bitcoin cash", "bch"], assetClass: "crypto", exchange: "Crypto", weight: 54 },
  { symbol: "TRX-USD", name: "TRON", aliases: ["tron", "trx"], assetClass: "crypto", exchange: "Crypto", weight: 54 },
  { symbol: "DOT-USD", name: "Polkadot", aliases: ["polkadot", "dot"], assetClass: "crypto", exchange: "Crypto", weight: 52 },
  { symbol: "MATIC-USD", name: "Polygon", aliases: ["polygon", "matic"], assetClass: "crypto", exchange: "Crypto", weight: 52 },
  { symbol: "UNI-USD", name: "Uniswap", aliases: ["uniswap", "uni"], assetClass: "crypto", exchange: "Crypto", weight: 50 },
  { symbol: "BNB-USD", name: "BNB", aliases: ["bnb", "binance coin"], assetClass: "crypto", exchange: "Crypto", weight: 60 },
  { symbol: "FLOKI-USD", name: "Floki", aliases: ["floki", "floki inu"], assetClass: "crypto", exchange: "Crypto", weight: 48 },
  { symbol: "BONK-USD", name: "Bonk", aliases: ["bonk", "bonk coin"], assetClass: "crypto", exchange: "Crypto", weight: 46 },
];

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 .&'-]/g, " ").replace(/\s+/g, " ").trim();

function toInstrument(seed: SeedEntry): Instrument {
  const isCrypto = seed.assetClass === "crypto";
  const displaySymbol = isCrypto ? seed.symbol.replace(/-USD$/, "") : seed.symbol;
  return {
    symbol: seed.symbol,
    displayName: seed.name,
    name: norm(seed.name),
    aliases: (seed.aliases ?? []).map(norm),
    assetClass: seed.assetClass,
    exchange: seed.exchange ?? null,
    market: isCrypto ? "crypto" : "us-equities",
    tradable: true,
    displaySymbol,
    displayMarket: isCrypto ? "Cryptocurrency" : (seed.exchange ?? "US"),
  };
}

// Drop placeholder rows (guarded so an accidental empty-name seed never ships).
export const CATALOG: Instrument[] = SEED.filter((s) => s.name.length > 0).map(toInstrument);

export const CATALOG_BY_SYMBOL = new Map(CATALOG.map((i) => [i.symbol, i]));

export interface ScoredInstrument {
  instrument: Instrument;
  score: number;
}

function subsequence(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

/** Score a catalog instrument against a normalized query. 0 = no match. */
export function scoreCatalog(instrument: Instrument, query: string): number {
  const sym = norm(instrument.symbol).replace(/\s/g, "");
  const q = query.replace(/\s/g, "");
  if (!q) return 0;

  let score = 0;
  if (sym === q || norm(instrument.displaySymbol).replace(/\s/g, "") === q) score = 1000;
  else if (instrument.aliases.some((a) => a.replace(/\s/g, "") === q)) score = 900;
  else if (sym.startsWith(q)) score = 700;
  else if (instrument.name.startsWith(query)) score = 650;
  else if (instrument.name.split(" ").some((w) => w.startsWith(query)) || instrument.aliases.some((a) => a.startsWith(query))) score = 600;
  else if (instrument.name.includes(query) || instrument.aliases.some((a) => a.includes(query))) score = 500;
  else if (subsequence(query, sym) || instrument.aliases.some((a) => subsequence(query, a.replace(/\s/g, "")))) score = 400;

  if (score === 0) return 0;
  // Tiebreak inside a tier by popularity weight (kept < tier width).
  const weight = SEED.find((s) => s.symbol === instrument.symbol)?.weight ?? 10;
  return score + weight / 1000;
}

// ---- Live provider augmentation (Yahoo Finance search) ----------------------

const YAHOO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

const providerCache = new Map<string, { at: number; instruments: Instrument[] }>();
const PROVIDER_TTL_MS = 15 * 60 * 1000;

function normalizeQuoteType(qt: string): AssetClass | null {
  switch (qt) {
    case "EQUITY": return "stock";
    case "ETF": return "etf";
    case "CRYPTOCURRENCY": return "crypto";
    default: return null; // futures, FX, indices, mutual funds, etc.
  }
}

async function yahooSearch(query: string): Promise<Instrument[]> {
  const key = query.replace(/\s/g, "+");
  const cached = providerCache.get(key);
  if (cached && Date.now() - cached.at < PROVIDER_TTL_MS) return cached.instruments;

  const out: Instrument[] = [];
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0&enableFuzzyQuery=true`,
      { headers: YAHOO_HEADERS, next: { revalidate: 0 } },
    );
    if (res.ok) {
      const json = await res.json();
      for (const row of json?.quotes ?? []) {
        const assetClass = normalizeQuoteType(String(row?.quoteType ?? ""));
        if (!assetClass || typeof row?.symbol !== "string") continue;
        const name = String(row.longname || row.shortname || row.symbol);
        const isCrypto = assetClass === "crypto";
        out.push({
          symbol: row.symbol.toUpperCase(),
          displayName: name,
          name: norm(name),
          aliases: [],
          assetClass,
          exchange: typeof row.exchDisp === "string" ? row.exchDisp : row.exchange ?? null,
          market: isCrypto ? "crypto" : "us-equities",
          tradable: true,
          displaySymbol: isCrypto ? row.symbol.toUpperCase().replace(/-USD$/, "") : row.symbol.toUpperCase(),
          displayMarket: isCrypto ? "Cryptocurrency" : String(row.exchDisp || row.exchange || "US"),
        });
      }
    }
  } catch {
    // provider unavailable — local catalog only
  }
  providerCache.set(key, { at: Date.now(), instruments: out });
  return out;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  /** Test hook for deterministic provider-result ranking. */
  providerResults?: Instrument[];
  /** Injectable for tests; defaults to the MySQL client. */
  predictionDb?: PredictionCatalogDb;
}

export type InstrumentMatchTier = "exact" | "alias" | "prefix" | "name" | "fuzzy" | "provider";

/** Flattened result: instrument fields + match metadata (what the API route returns). */
export interface InstrumentSearchResult extends Instrument {
  score: number;
  matchTier: InstrumentMatchTier;
  /** Present only for assetClass:'prediction' results — the Polymarket conditionId to trade against. */
  marketId?: string;
}

function tierFor(score: number): InstrumentMatchTier {
  if (score >= 1000) return "exact";
  if (score >= 900) return "alias";
  if (score >= 700) return "prefix";
  if (score >= 500) return "name";
  if (score >= 400) return "fuzzy";
  return "provider";
}

// ---- Prediction markets as a searchable source --------------------------
// Reuses the same tiered scorer against question/category text so "fed"
// surfaces a Fed-rate-cut market the same way "apple" surfaces AAPL.

export interface PredictionSearchRow {
  id: string; // conditionId
  question: string;
  category: string | null;
  yes_price: number | null;
  no_price: number | null;
  image: string | null;
  url: string | null;
  status: string;
}

export interface PredictionCatalogDb {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): PromiseLike<{ data: PredictionSearchRow[] | null; error: { message?: string } | null }>;
    };
  };
}

/** Score a prediction market's question/category against a normalized query, same tiers as scoreCatalog. */
export function scorePredictionMarket(row: PredictionSearchRow, query: string): number {
  const q = query.replace(/\s/g, "");
  if (!q) return 0;
  const question = norm(row.question);
  const category = row.category ? norm(row.category) : "";

  let score = 0;
  if (question.startsWith(query)) score = 650;
  else if (question.split(" ").some((w) => w.startsWith(query)) || (category && category.startsWith(query))) score = 600;
  else if (question.includes(query) || (category && category.includes(query))) score = 500;
  else if (subsequence(query, question.replace(/\s/g, ""))) score = 400;

  return score;
}

function predictionToInstrument(row: PredictionSearchRow): Instrument {
  return {
    symbol: row.id,
    displayName: row.question,
    name: norm(row.question),
    aliases: row.category ? [norm(row.category)] : [],
    assetClass: "prediction",
    exchange: null,
    market: "predictions",
    tradable: row.status === "active",
    displaySymbol: row.id,
    displayMarket: row.category ?? "Prediction market",
    url: row.url,
  };
}

function assetSearchPriority(assetClass: AssetClass): number {
  if (assetClass === "stock" || assetClass === "etf") return 3;
  if (assetClass === "crypto") return 2;
  return 1;
}

function isExplicitCryptoQuery(query: string): boolean {
  const compactQuery = query.replace(/\s/g, "");
  return CATALOG.some((instrument) => instrument.assetClass === "crypto" && (
    norm(instrument.displaySymbol).replace(/\s/g, "") === compactQuery ||
    instrument.name === query ||
    instrument.aliases.some((alias) => alias === query)
  ));
}

async function searchPredictionMarkets(db: PredictionCatalogDb, query: string): Promise<ScoredInstrument[]> {
  const { data, error } = await db.from("prediction_markets").select("*").eq("status", "active");
  if (error || !data) return [];
  const scored: ScoredInstrument[] = [];
  for (const row of data) {
    const score = scorePredictionMarket(row, query);
    if (score > 0) scored.push({ instrument: predictionToInstrument(row), score });
  }
  return scored;
}

/**
 * Unified smart search: local catalog first (deterministic ranking),
 * augmented by live Yahoo search results and persisted prediction markets
 * that the catalog doesn't cover.
 */
export async function searchInstruments(rawQuery: string, options: SearchOptions = {}): Promise<InstrumentSearchResult[]> {
  const query = norm(rawQuery);
  if (!query) return [];

  const local: ScoredInstrument[] = [];
  for (const instrument of CATALOG) {
    const score = scoreCatalog(instrument, query);
    if (score > 0) local.push({ instrument, score });
  }

  // Prediction markets score in the same tier space as tradable instruments,
  // so every result can be ordered by relevance and asset type together.
  let predictionDb = options.predictionDb;
  if (!predictionDb) {
    try {
      const { mysqlAdmin } = await import("@/lib/mysql/admin");
      predictionDb = mysqlAdmin() as unknown as PredictionCatalogDb;
    } catch {
      predictionDb = undefined; // no DB available (e.g. pure unit test) — skip predictions
    }
  }
  const predictionMatches = predictionDb ? await searchPredictionMarkets(predictionDb, query) : [];

  const localMatches = [...local, ...predictionMatches];

  const provider = options.providerResults ?? await yahooSearch(query);
  const seen = new Set(localMatches.map((l) => l.instrument.symbol));
  const providerScored: ScoredInstrument[] = provider
    .filter((p) => !seen.has(p.symbol))
    .map((instrument) => ({ instrument, score: scoreCatalog(instrument, query) }))
    // Yahoo fuzzy matches can include unrelated, long-tail coins. Keep only
    // results that independently match the typed ticker or company query.
    .filter(({ score }) => score > 0);
  const providerSymbols = new Set(providerScored.map(({ instrument }) => instrument.symbol));
  const preferStocks = !isExplicitCryptoQuery(query);
  const ranked = [...localMatches, ...providerScored].sort((a, b) => {
    const stockVsCrypto = preferStocks && (
      ((a.instrument.assetClass === "stock" || a.instrument.assetClass === "etf") && b.instrument.assetClass === "crypto") ||
      ((b.instrument.assetClass === "stock" || b.instrument.assetClass === "etf") && a.instrument.assetClass === "crypto")
    );
    if (stockVsCrypto) return assetSearchPriority(b.instrument.assetClass) - assetSearchPriority(a.instrument.assetClass);
    return Math.floor(b.score) - Math.floor(a.score) ||
      (preferStocks ? assetSearchPriority(b.instrument.assetClass) - assetSearchPriority(a.instrument.assetClass) : 0) ||
      (!preferStocks ? assetSearchPriority(b.instrument.assetClass) - assetSearchPriority(a.instrument.assetClass) : 0) ||
      b.score - a.score;
  });

  const merged: InstrumentSearchResult[] = ranked.map(({ instrument, score }) => ({
    ...instrument,
    score,
    matchTier: providerSymbols.has(instrument.symbol) ? "provider" : tierFor(score),
    ...(instrument.assetClass === "prediction" ? { marketId: instrument.symbol } : {}),
  }));

  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const offset = Math.max(options.offset ?? 0, 0);
  return merged.slice(offset, offset + limit);
}
