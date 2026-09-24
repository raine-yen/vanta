"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, display_name: displayName }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "signup failed");
      setLoading(false);
      return;
    }
    // Sign in after creating the MySQL account.
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="flex items-center gap-2 mb-8 justify-center">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-white text-sm font-black text-black">V</div>
          <span className="font-semibold tracking-tight text-lg">Vanta</span>
        </Link>
        <div className="border border-bg-border bg-bg-soft p-6">
          <h1 className="text-xl font-semibold mb-1">Create your account</h1>
          <p className="text-sm text-gray-400 mb-6">Start with $10,000 in paper money.</p>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">Display name</label>
              <input
                type="text"
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                placeholder="How you appear on the leaderboard"
                autoFocus
              />
            </div>
            <div>
              <label className="label">Email</label>
              <input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label className="label">Password</label>
              <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
              <p className="text-xs text-gray-500 mt-1">Minimum 6 characters.</p>
            </div>
            {error && <p className="text-sm text-accent-red">{error}</p>}
            <button type="submit" disabled={loading} className="btn-buy w-full">
              {loading ? "Creating..." : "Create account"}
            </button>
          </form>
          <p className="text-center text-sm text-gray-400 mt-6">
            Already have an account? <Link href="/login" className="text-accent hover:underline">Log in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
