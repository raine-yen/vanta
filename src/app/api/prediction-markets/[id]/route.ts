import { NextRequest, NextResponse } from "next/server";
import { predictionOutcomeLabels } from "@/lib/prediction-presentation";
import { fetchUpstreamPredictionMarketState, type PredictionMarketRow } from "@/lib/prediction-sync";
import { mysqlAdmin } from "@/lib/mysql/admin";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = mysqlAdmin();
  const { data: market } = await db.from("prediction_markets").select("*").eq("id", id).maybeSingle();
  if (!market) return NextResponse.json({ error: "market not found" }, { status: 404 });

  const row = market as PredictionMarketRow;
  const upstream = await fetchUpstreamPredictionMarketState(row);
  if (!upstream) return NextResponse.json({ error: "market status unavailable" }, { status: 503 });

  if (!upstream.tradable && row.status === "active") {
    await db.from("prediction_markets").update({
      status: upstream.resolved ? "resolved" : "closed",
      resolved_outcome: upstream.resolvedOutcome,
      updated_at: new Date().toISOString(),
    }).eq("id", id);
  }

  const [yesLabel, noLabel] = predictionOutcomeLabels(row.question, row.yes_label, row.no_label);
  const winnerLabel = upstream.resolvedOutcome === "yes" ? yesLabel : upstream.resolvedOutcome === "no" ? noLabel : null;
  return NextResponse.json({ ...upstream, winnerLabel });
}

export const dynamic = "force-dynamic";
