// Settlement pass tests (node --experimental-strip-types via tsx, alias-aware).
import assert from "node:assert/strict";
import test from "node:test";
import { settlePredictionMarkets, gammaWinner } from "@/lib/prediction-settle";

function json(body, ok = true) {
  return { ok, json: async () => body, text: async () => JSON.stringify(body) };
}

class FakeQ {
  constructor(table, state) {
    this.t = table;
    this.state = state;
    this.filters = [];
  }
  select() { return this; }
  gt(f, v) { this.filters.push((r) => Number(r[f]) > v); return this; }
  eq(f, v) { this.filters.push((r) => r[f] === v); return this; }
  in(f, values) { this.filters.push((r) => values.includes(r[f])); return this; }
  maybeSingle() {
    const rows = this.state[this.t].filter((r) => this.filters.every((f) => f(r)));
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }
  update(values) {
    this._update = values;
    return this;
  }
  insert(row) {
    this.state[this.t].push({ id: `${this.t}-${this.state[this.t].length + 1}`, ...row });
    return Promise.resolve({ error: null });
  }
  then(resolve) {
    // await'ing the builder directly (no terminal method) — used for select+gt chains and update+eq
    if (this._update) {
      for (const r of this.state[this.t]) {
        if (this.filters.every((f) => f(r))) Object.assign(r, this._update);
      }
      resolve({ data: null, error: null });
    } else {
      resolve({ data: this.state[this.t].filter((r) => this.filters.every((f) => f(r))), error: null });
    }
  }
}

function makeDb(state) {
  return { from: (t) => new FakeQ(t, state) };
}

test("gammaWinner: yes wins when outcomePrices = [1,0]", () => {
  assert.equal(gammaWinner({ closed: true, umaResolutionStatus: "resolved", outcomePrices: '["1", "0"]' }), "yes");
});

test("gammaWinner: no wins when outcomePrices = [0,1]", () => {
  assert.equal(gammaWinner({ closed: true, umaResolutionStatus: "resolved", outcomePrices: '["0", "1"]' }), "no");
});

test("gammaWinner: null when not closed or not resolved", () => {
  assert.equal(gammaWinner({ closed: false, umaResolutionStatus: "resolved", outcomePrices: '["1","0"]' }), null);
  assert.equal(gammaWinner({ closed: true, umaResolutionStatus: "pending", outcomePrices: '["1","0"]' }), null);
});

test("settlePredictionMarkets: pays winners $1/share, zeroes losers, marks market resolved", async () => {
  const state = {
    prediction_positions: [
      { id: "p1", account_id: "acct-1", market_id: "0xabc", outcome: "yes", shares: 10, avg_cost: 0.4 },
      { id: "p2", account_id: "acct-2", market_id: "0xabc", outcome: "no", shares: 5, avg_cost: 0.6 },
    ],
    accounts: [
      { id: "acct-1", cash: 100 },
      { id: "acct-2", cash: 50 },
    ],
    prediction_markets: [{ id: "0xabc", status: "active" }],
    prediction_fills: [],
  };
  const db = makeDb(state);
  const fetchImpl = async () =>
    json([{ conditionId: "0xabc", closed: true, umaResolutionStatus: "resolved", outcomePrices: '["1", "0"]' }]);

  const result = await settlePredictionMarkets({ db, fetchImpl });

  assert.equal(result.marketsChecked, 1);
  assert.equal(result.marketsResolved, 1);
  assert.equal(result.payouts, 10); // acct-1 wins 10 shares * $1

  const acct1 = state.accounts.find((a) => a.id === "acct-1");
  const acct2 = state.accounts.find((a) => a.id === "acct-2");
  assert.equal(acct1.cash, 110); // 100 + 10*1
  assert.equal(acct2.cash, 50); // no payout for losing side

  const pos1 = state.prediction_positions.find((p) => p.id === "p1");
  const pos2 = state.prediction_positions.find((p) => p.id === "p2");
  assert.equal(pos1.shares, 0);
  assert.equal(pos2.shares, 0);

  const market = state.prediction_markets.find((m) => m.id === "0xabc");
  assert.equal(market.status, "resolved");
  assert.equal(market.resolved_outcome, "yes");

  assert.equal(state.prediction_fills.length, 2);
  assert.ok(state.prediction_fills.every((f) => f.side === "settle"));
});

test("settlePredictionMarkets: no-op when no open positions", async () => {
  const state = { prediction_positions: [], accounts: [], prediction_markets: [], prediction_fills: [] };
  const db = makeDb(state);
  const result = await settlePredictionMarkets({ db, fetchImpl: async () => json([]) });
  assert.equal(result.marketsChecked, 0);
  assert.equal(result.marketsResolved, 0);
});

test("settlePredictionMarkets: leaves unresolved markets untouched", async () => {
  const state = {
    prediction_positions: [{ id: "p1", account_id: "acct-1", market_id: "0xabc", outcome: "yes", shares: 10, avg_cost: 0.4 }],
    accounts: [{ id: "acct-1", cash: 100 }],
    prediction_markets: [{ id: "0xabc", status: "active" }],
    prediction_fills: [],
  };
  const db = makeDb(state);
  const fetchImpl = async () => json([{ conditionId: "0xabc", closed: false }]);
  const result = await settlePredictionMarkets({ db, fetchImpl });
  assert.equal(result.marketsResolved, 0);
  assert.equal(state.accounts[0].cash, 100);
  assert.equal(state.prediction_positions[0].shares, 10);
});

test("settlePredictionMarkets: only settles the requesting account when scoped", async () => {
  const state = {
    prediction_positions: [
      { id: "p1", account_id: "acct-1", market_id: "0xabc", outcome: "yes", shares: 10, avg_cost: 0.4 },
      { id: "p2", account_id: "acct-2", market_id: "0xabc", outcome: "yes", shares: 5, avg_cost: 0.4 },
    ],
    accounts: [{ id: "acct-1", cash: 100 }, { id: "acct-2", cash: 50 }],
    prediction_markets: [{ id: "0xabc", status: "active" }],
    prediction_fills: [],
  };
  const result = await settlePredictionMarkets({
    db: makeDb(state),
    accountId: "acct-1",
    fetchImpl: async () => json([{ conditionId: "0xabc", closed: true, umaResolutionStatus: "resolved", outcomePrices: '["1", "0"]' }]),
  });
  assert.equal(result.payouts, 10);
  assert.equal(state.accounts[0].cash, 110);
  assert.equal(state.accounts[1].cash, 50);
  assert.equal(state.prediction_positions[0].shares, 0);
  assert.equal(state.prediction_positions[1].shares, 5);
});
