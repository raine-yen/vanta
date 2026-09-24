import { NextRequest, NextResponse } from "next/server";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { fetchProbabilityHistory } from "@/lib/prediction-sync";

// Probability history chart for one outcome token of a cataloged market.
// GET /api/prediction-markets/[id]/history?outcome=yes|no&days=1|7|30
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const outcome = (req.nextUrl.searchParams.get("outcome") ?? "yes").toLowerCase();
  if (outcome !== "yes" && outcome !== "no") {
    return NextResponse.json({ error: "outcome must be yes or no" }, { status: 400 });
  }
  const daysRaw = Number(req.nextUrl.searchParams.get("days") ?? 7);
  const days = [1, 7, 30].includes(daysRaw) ? daysRaw : 7;

  const { data: market } = await mysqlAdmin()
    .from("prediction_markets")
    .select("id, yes_token_id, no_token_id")
    .eq("id", id)
    .maybeSingle();

  if (!market) return NextResponse.json({ error: "market not found" }, { status: 404 });

  const tokenId = outcome === "yes" ? market.yes_token_id : market.no_token_id;
  const items = await fetchProbabilityHistory(fetch, tokenId, days);
  return NextResponse.json({ market: id, outcome, days, items });
}

export const dynamic = "force-dynamic";
export const maxDuration = 30;
