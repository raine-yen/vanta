"use client";

import { useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";

const PY_QUICKSTART = `# Install the official Alpaca SDK (works with Paper Trader because the API is compatible)
# pip install alpaca-py

from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce

# 1. Replace BASE with your deployed Paper Trader URL
BASE = "https://your-vanta-hostinger-domain.example"

# 2. Paste your API keys from /api-keys
client = TradingClient(
    api_key="PK...your-key-id...",
    secret_key="your-secret-key",
    paper=True,
    url_override=BASE,
)

# 3. Check your account
acct = client.get_account()
print(f"Cash: \${acct.cash}, Equity: \${acct.equity}")

# 4. Place a market order
order = client.submit_order(
    MarketOrderRequest(
        symbol="AAPL",
        qty=10,
        side=OrderSide.BUY,
        time_in_force=TimeInForce.GTC,
    )
)
print(f"Order {order.id}: {order.status}")

# 5. Get positions
for p in client.get_all_positions():
    print(f"{p.symbol}: {p.qty} @ \${p.avg_entry_price}  P/L \${p.unrealized_pl}")
`;

const PY_RAW = `import requests

BASE = "https://your-vanta-hostinger-domain.example"
H = {
    "APCA-API-KEY-ID":     "PK...",
    "APCA-API-SECRET-KEY": "...",
    "Content-Type":        "application/json",
}

# Buy
r = requests.post(f"{BASE}/v2/orders", headers=H, json={
    "symbol": "TSLA", "qty": 5,
    "side": "buy", "type": "market",
})
print(r.json())

# Account
print(requests.get(f"{BASE}/v2/account", headers=H).json())

# Positions
print(requests.get(f"{BASE}/v2/positions", headers=H).json())

# Historical bars (for backtesting)
print(requests.get(f"{BASE}/v2/stocks/AAPL/bars?range=1mo", headers=H).json())
`;

const CLAUDE_PROMPT = `Write a Python trading bot that:
- Connects to the Paper Trader API at BASE_URL (replace this)
- Authenticates with APCA-API-KEY-ID and APCA-API-SECRET-KEY headers
- Every 60 seconds: checks the price of AAPL, MSFT, and GOOGL
- If a stock dropped 2% from yesterday's close, buy $1000 worth
- If a position is up 5%, sell it all
- Logs every action to the terminal

The API is identical to Alpaca's. Use 'requests'.`;

const endpoints = [
  { method: "GET", path: "/v2/account", desc: "Current cash, equity, status." },
  { method: "GET", path: "/v2/positions", desc: "All open positions." },
  { method: "GET", path: "/v2/positions/:symbol", desc: "Single position." },
  { method: "DELETE", path: "/v2/positions/:symbol", desc: "Liquidate position (market sell)." },
  { method: "POST", path: "/v2/orders", desc: "Place an order. Body: { symbol, qty, side, type, limit_price? }." },
  { method: "GET", path: "/v2/orders", desc: "List orders. Query: ?status=open|closed|all" },
  { method: "GET", path: "/v2/orders/:id", desc: "Get a single order." },
  { method: "DELETE", path: "/v2/orders/:id", desc: "Cancel an open order." },
  { method: "GET", path: "/v2/clock", desc: "Market clock (simulator is always open)." },
  { method: "GET", path: "/v2/assets/:symbol", desc: "Asset details." },
  { method: "GET", path: "/v2/stocks/:symbol/quotes/latest", desc: "Latest quote." },
  { method: "GET", path: "/v2/stocks/:symbol/bars", desc: "Historical bars. Query: ?timeframe=1Day&range=1mo" },
];

export default function DocsPage() {
  return (
    <div className="space-y-8 animate-fade-in max-w-4xl">
      <div>
        <h1 className="text-3xl font-semibold mb-2">Getting Started</h1>
        <p className="text-gray-400">
          Vanta uses Alpaca-compatible REST paths and credentials for its paper accounts. Use a Vanta-generated key and change your client&apos;s base URL.
        </p>
      </div>

      <Section title="1. Create your API keys">
        <p className="text-sm text-gray-400">
          Head to <a href="/api-keys" className="text-accent hover:underline">API Keys</a> and click <b>Generate</b>. Copy the secret immediately — you won't see it again.
        </p>
      </Section>

      <Section title="2. Quick start — Python with the official Alpaca SDK (recommended)">
        <CodeBlock code={PY_QUICKSTART} />
      </Section>

      <Section title="3. Quick start — raw HTTP (no SDK)">
        <p className="text-sm text-gray-400">Useful if you want to understand exactly what's happening.</p>
        <CodeBlock code={PY_RAW} />
      </Section>

      <Section title="4. Build a bot with Claude or ChatGPT">
        <p className="text-sm text-gray-400 mb-3">
          Copy this prompt into Claude, fill in your keys & base URL, and you have a working bot in seconds.
        </p>
        <CodeBlock code={CLAUDE_PROMPT} />
      </Section>

      <Section title="5. API reference">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 uppercase tracking-wider bg-bg-elevated">
              <tr>
                <th className="text-left py-2 px-4 font-medium w-20">Method</th>
                <th className="text-left py-2 px-4 font-medium">Path</th>
                <th className="text-left py-2 px-4 font-medium">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              {endpoints.map((e) => (
                <tr key={e.method + e.path}>
                  <td className="py-2 px-4">
                    <span className={`badge ${e.method === "GET" ? "bg-accent/20 text-accent" : e.method === "POST" ? "bg-accent-green/20 text-accent-green" : "bg-accent-red/20 text-accent-red"}`}>
                      {e.method}
                    </span>
                  </td>
                  <td className="py-2 px-4 font-mono text-xs">{e.path}</td>
                  <td className="py-2 px-4 text-gray-400">{e.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="6. Tips for the competition">
        <ul className="space-y-2 text-sm text-gray-400 list-disc list-inside">
          <li>Market trades fetch a live Yahoo Finance price at the moment the order fills.</li>
          <li>Market orders fill immediately. Limit orders fill when the price crosses your limit.</li>
          <li>You can hold fractional shares (e.g. qty: 0.5).</li>
          <li>The leaderboard sorts by growth on the capital currently invested in open positions.</li>
          <li>Cron-driven engine: don't expect microsecond fills — this is for learning strategy, not HFT.</li>
        </ul>
      </Section>

      <Section title="Authentication headers">
        <p className="text-sm text-gray-400 mb-3">Every API request accepts these standard Alpaca headers. Legacy HTTP Basic authentication with the key ID as the username and secret as the password also works.</p>
        <div className="card p-4 font-mono text-xs space-y-1">
          <div>APCA-API-KEY-ID: <span className="text-accent">PK...</span></div>
          <div>APCA-API-SECRET-KEY: <span className="text-accent">...</span></div>
        </div>
      </Section>

      <div className="card p-5 flex items-center gap-3">
        <ExternalLink className="w-5 h-5 text-accent" />
        <div className="flex-1">
          <div className="font-medium text-sm">Want full Alpaca SDK docs?</div>
          <div className="text-xs text-gray-400">Everything in alpaca-py works here too.</div>
        </div>
        <a href="https://alpaca.markets/sdks/python/" target="_blank" rel="noreferrer" className="btn-ghost border border-bg-border text-xs">
          alpaca-py docs
        </a>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card p-4 relative group">
      <button
        onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-3 right-3 btn-ghost text-xs px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="text-xs font-mono text-gray-300 overflow-x-auto whitespace-pre">{code}</pre>
    </div>
  );
}
