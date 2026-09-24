import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy | Paper Trader",
  description: "Privacy policy for the Paper Trader web and mobile apps.",
};

const sections = [
  {
    title: "Information We Collect",
    body: [
      "Paper Trader collects the information needed to create and operate a paper trading account. This includes your email address, display name, authentication session data, simulated account balances, positions, orders, leaderboard performance, watchlists, alerts, direct messages, practice-credit activity, reports, blocks, and API key metadata.",
      "If you contact us for support, we may also receive the information you include in your message.",
    ],
  },
  {
    title: "How We Use Information",
    body: [
      "We use this information to authenticate users, maintain paper trading accounts, simulate trades, display leaderboards, provide API access for bots, support social competition features, review safety reports, and support the reliability and security of the service.",
      "Paper Trader does not support real-money trading, deposits, withdrawals, or live brokerage activity.",
    ],
  },
  {
    title: "Sharing",
    body: [
      "We use Hostinger for application hosting and MySQL database storage, and market data providers to power educational paper trading features.",
      "We do not sell personal information.",
    ],
  },
  {
    title: "Data Retention",
    body: [
      "We retain account information for as long as your account remains active or as needed to operate the service, comply with legal obligations, resolve disputes, and enforce our agreements.",
    ],
  },
  {
    title: "Your Choices",
    body: [
      "You can delete your account from Settings inside the app. You can also request account access or correction by contacting support, and you can revoke API keys directly inside the app.",
    ],
  },
  {
    title: "Contact",
    body: [
      "For privacy questions, contact support at the support page listed below.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-bg text-gray-50">
      <div className="mx-auto max-w-4xl px-5 py-16">
        <div className="mb-10 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-gray-500">Paper Trader</p>
            <h1 className="mt-3 text-4xl font-black tracking-tight md:text-5xl">Privacy Policy</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-gray-400">
              This policy applies to the Paper Trader website and mobile app.
            </p>
          </div>
          <Link href="/" className="btn-ghost border border-bg-border">
            Back to site
          </Link>
        </div>

        <div className="space-y-6">
          {sections.map((section) => (
            <section key={section.title} className="card p-6">
              <h2 className="text-lg font-semibold">{section.title}</h2>
              <div className="mt-3 space-y-4 text-sm leading-7 text-gray-300">
                {section.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
