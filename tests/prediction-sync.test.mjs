// Unit tests for src/lib/prediction-sync.ts (run: node --experimental-strip-types tests/prediction-sync.test.mjs)
import assert from "node:assert/strict";
import test from "node:test";
import {
  price01,
  parseGammaMarket,
  fetchActiveMarkets,
  syncPredictionCatalog,
  persistCatalogRows,
  hydratePredictionMarketPrices,
  catalogNeedsQuoteRepair,
  fetchUpstreamPredictionMarketState,
  liveMidpoint,
} from "../src/lib/prediction-sync.ts";

const gammaRow = (over = {}) => ({
  id: 123,
  conditionId: "0xabc",
  question: "Will the Fed cut rates in September?",
  slug: "fed-cut-september",
  category: "Fed",
  endDate: "2026-09-30T00:00:00Z",
  volume24hr: "1500000",
  active: true,
  closed: false,
  image: "https://img/1.png",
  clobTokenIds: '["3233822019007135", "2565931067499367"]',
  ...over,
});

test("price01 clamps to [0,1] and rejects garbage", () => {
  assert.equal(price01("0.62"), 0.62);
  assert.equal(price01(0), 0);
  assert.equal(price01(1), 1);
  assert.equal(price01("1.2"), null);
  assert.equal(price01(-0.1), null);
  assert.equal(price01("abc"), null);
  assert.equal(price01(null), null);
});

test("parseGammaMarket maps a binary market and rejects non-binary", () => {
  const row = parseGammaMarket(gammaRow());
  assert.ok(row);
  assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(row.condition_id, "0xabc");
  assert.equal(row.yes_token_id, "3233822019007135");
  assert.equal(row.no_token_id, "2565931067499367");
  assert.equal(row.volume_24h, 1500000);
  assert.equal(row.status, "active");
  assert.equal(row.url, "https://polymarket.com/event/fed-cut-september");
  const nonBinary = parseGammaMarket(gammaRow({ clobTokenIds: JSON.stringify(["1"]) }));
  assert.equal(nonBinary, null);
  const noQuestion = parseGammaMarket(gammaRow({ question: "  " }));
  assert.equal(noQuestion, null);
});

test("parseGammaMarket keeps named binary outcomes for head-to-head markets", () => {
  const row = parseGammaMarket({
    conditionId: "sabalenka-rybakina",
    question: "US Open WTA: Aryna Sabalenka vs Elena Rybakina",
    clobTokenIds: '["token-a", "token-b"]',
    outcomes: '["Aryna Sabalenka", "Elena Rybakina"]',
    outcomePrices: '["0.62", "0.38"]',
  });
  assert.equal(row?.yes_label, "Aryna Sabalenka");
  assert.equal(row?.no_label, "Elena Rybakina");
});

test("upstream status closes a stale catalog market as soon as Polymarket resolves it", async () => {
  const state = await fetchUpstreamPredictionMarketState(
    { event_slug: "wta-sabalen-rybakin-2026-09-12", url: null },
    async () => new Response(JSON.stringify({ active: true, closed: true, acceptingOrders: false, umaResolutionStatus: "resolved", outcomePrices: '["0", "1"]' })),
  );
  assert.deepEqual(state, { tradable: false, closed: true, resolved: true, resolvedOutcome: "no" });
});

test("parseGammaMarket retains valid upstream outcome-price fallbacks", () => {
  const row = parseGammaMarket(gammaRow({ outcomePrices: '["0.62", "0.38"]' }));
  assert.equal(row?.yes_price, 0.62);
  assert.equal(row?.no_price, 0.38);
});
test("fetchActiveMarkets paginates by 100 and stops on short page", async () => {
  const calls = [];
  const mkPage = (n, offset = 0) =>
    Array.from({ length: n }, (_, i) => gammaRow({ conditionId: `0x${offset + i}`, id: offset + i }));
  const fakeFetch = async (url) => {
    calls.push(url);
    // first page full (100), second short (3) -> stop after 2 calls
    const rows = calls.length === 1 ? mkPage(100) : mkPage(3, 100);
    return { ok: true, status: 200, json: async () => rows };
  };
  const rows = await fetchActiveMarkets(fakeFetch);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /offset=100/);
  assert.equal(rows.length, 103);
});

test("fetchActiveMarkets removes duplicate condition IDs across paginated results", async () => {
  let call = 0;
  const fakeFetch = async () => {
    call += 1;
    const rows = call === 1
      ? Array.from({ length: 100 }, (_, index) => gammaRow({ conditionId: index === 0 ? "0xfirst" : index === 1 ? "0xshared" : `0xpage-one-${index}` }))
      : [gammaRow({ conditionId: "0xshared" }), gammaRow({ conditionId: "0xsecond" })];
    return { ok: true, status: 200, json: async () => rows };
  };
  const rows = await fetchActiveMarkets(fakeFetch, 2);
  assert.equal(rows.filter((row) => row.condition_id === "0xshared").length, 1);
  assert.equal(rows.at(-1)?.condition_id, "0xsecond");
});
test("fetchActiveMarkets throws on non-OK upstream", async () => {
  await assert.rejects(
    () => fetchActiveMarkets(async () => ({ ok: false, status: 503 })),
    /Gamma returned 503/,
  );
});

test("syncPredictionCatalog upserts rows with onConflict=id", async () => {
  const upserted = [];
  const db = {
    from(table) {
      assert.equal(table, "prediction_markets");
      return {
        async upsert(rows, opts) {
          upserted.push([rows.length, opts?.onConflict]);
          return { error: null };
        },
        update() {
          throw new Error("not used here");
        },
      };
    },
  };
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [gammaRow(), gammaRow({ conditionId: "0x2" })],
  });
  const n = await syncPredictionCatalog(db, fakeFetch);
  assert.equal(n, 2);
  assert.deepEqual(upserted, [[2, "id"]]);
});

test("fallback catalog rows persist with the catalog primary key", async () => {
  const calls = [];
  const db = { from: (table) => ({ upsert: async (rows, opts) => { calls.push({ table, rows, opts }); return { error: null }; } }) };
  const count = await persistCatalogRows(db, [parseGammaMarket(gammaRow())]);
  assert.equal(count, 1);
  assert.equal(calls[0].table, "prediction_markets");
  assert.equal(calls[0].opts.onConflict, "id");
});

test("catalog quote repair runs only when every visible market lacks both prices", () => {
  assert.equal(catalogNeedsQuoteRepair([parseGammaMarket(gammaRow())]), true);
  assert.equal(catalogNeedsQuoteRepair([parseGammaMarket(gammaRow({ outcomePrices: '["0.62", "0.38"]' }))]), false);
});
test("catalog quote hydration retains both outcome prices for later trade fallback", async () => {
  const hydrated = await hydratePredictionMarketPrices(
    [parseGammaMarket(gammaRow())],
    async (url) => ({ ok: true, json: async () => ({ mid: url.includes("323382") ? "0.62" : "0.38" }) }),
    1,
  );
  assert.equal(hydrated[0].yes_price, 0.62);
  assert.equal(hydrated[0].no_price, 0.38);
});
test("liveMidpoint prefers midpoint, then book, then last-known", async () => {
  // midpoint happy path
  let calls = [];
  let mid = await liveMidpoint("tok", async (u) => {
    calls.push(u);
    return { ok: true, json: async () => ({ mid: "0.415" }) };
  });
  assert.equal(mid, 0.415);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /midpoint\?token_id=tok/);

  // midpoint fails -> book: bids ascending, asks descending -> (0.038 + 0.039)/2
  mid = await liveMidpoint(
    "tok",
    async (u) => {
      if (u.includes("midpoint")) return { ok: false, status: 429 };
      return {
        ok: true,
        json: async () => ({
          bids: [{ price: "0.03" }, { price: "0.038" }],
          asks: [{ price: "0.039" }, { price: "0.05" }],
        }),
      };
    },
    0.2,
  );
  assert.ok(Math.abs(mid - 0.0385) < 1e-9);

  // both fail -> last-known
  mid = await liveMidpoint("tok", async () => { throw new Error("down"); }, 0.5);
  assert.equal(mid, 0.5);

  // no token -> last-known
  mid = await liveMidpoint(null, async () => { throw new Error("no"); }, 0.33);
  assert.equal(mid, 0.33);
});
