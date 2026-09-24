import { NextRequest, NextResponse } from "next/server";
import { getAdaptiveQuests, getDailyQuestCycle, type DailyQuestStats } from "@/lib/adaptive-quests";
import { getCurrentAccount } from "@/lib/app-data";
import type { MySqlClient } from "@/lib/mysql-client";

const REWARD_POINTS = 200; // recognition points only — never account cash

async function questState(db: MySqlClient, accountId: string) {
  const cycle = getDailyQuestCycle();
  const start = cycle.startsAt;
  const end = cycle.endsAt;
  const [todayOrdersResult, totalOrdersResult, predictionResult, claimsResult] = await Promise.all([
    db.from("orders").select("symbol, side, type, status").eq("account_id", accountId).gte("created_at", start).lt("created_at", end),
    db.from("orders").select("id", { count: "exact", head: true }).eq("account_id", accountId),
    db.from("prediction_fills").select("id").eq("account_id", accountId).in("side", ["buy", "sell"]).gte("created_at", start).lt("created_at", end),
    db.from("quest_points").select("quest_id, cycle_id").eq("account_id", accountId).eq("cycle_id", cycle.id),
  ]);
  const submittedOrders = (todayOrdersResult.data ?? []) as Array<{ symbol: string; side: string; type: string; status: string }>;
  const todayOrders = submittedOrders.filter((order) => order.status === "filled");
  const stats: DailyQuestStats = {
    lifetimeOrders: totalOrdersResult.count ?? 0,
    filledOrders: todayOrders.length,
    uniqueSymbols: new Set(todayOrders.map((order) => order.symbol)).size,
    buyOrders: todayOrders.filter((order) => order.side === "buy").length,
    sellOrders: todayOrders.filter((order) => order.side === "sell").length,
    limitOrders: submittedOrders.filter((order) => order.type === "limit").length,
    predictionTrades: predictionResult.data?.length ?? 0,
  };
  const { tier, quests } = getAdaptiveQuests(stats);
  return { cycle, tier, quests, claims: (claimsResult.data ?? []).map((claim: { quest_id: string; cycle_id: string }) => `${claim.cycle_id}:${claim.quest_id}`) };
}

export async function GET(req: NextRequest) {
  const context = await getCurrentAccount(req);
  if ("response" in context) return context.response;
  return NextResponse.json(await questState(context.db, context.account.id));
}

export async function POST(req: NextRequest) {
  const context = await getCurrentAccount(req);
  if ("response" in context) return context.response;
  const body = await req.json().catch(() => null);
  const questId = typeof body?.quest_id === "string" ? body.quest_id : "";
  const cycleId = typeof body?.cycle_id === "string" ? body.cycle_id : "";
  if (!questId || !cycleId) return NextResponse.json({ error: "quest_id and cycle_id required" }, { status: 400 });

  const state = await questState(context.db, context.account.id);
  const quest = state.quests.find((item) => item.id === questId);
  if (cycleId !== state.cycle.id || !quest) return NextResponse.json({ error: "That quest is no longer active." }, { status: 400 });
  if (quest.progress < quest.goal) return NextResponse.json({ error: "Complete this daily quest before claiming it." }, { status: 409 });

  const { error: claimError } = await context.db.from("quest_points").insert({ account_id: context.account.id, quest_id: questId, cycle_id: cycleId, points: REWARD_POINTS });
  const message = claimError?.message?.toLowerCase() ?? "";
  if (claimError?.code === "23505" || message.includes("duplicate")) return NextResponse.json({ error: "reward already claimed" }, { status: 409 });
  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 });
  return NextResponse.json({ ok: true, points: REWARD_POINTS, claim: `${cycleId}:${questId}` });
}

export const dynamic = "force-dynamic";
