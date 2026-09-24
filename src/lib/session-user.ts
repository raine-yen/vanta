import type { NextRequest } from "next/server";
import { mysqlServer } from "@/lib/mysql/server";
import { mysqlForRequest } from "@/lib/mysql/request";

export async function getSessionUser(req?: NextRequest) {
  const token = req?.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) {
    const sb = await mysqlForRequest(req);
    const { data } = await sb.auth.getUser(token);
    return data.user ?? null;
  }

  const sb = await mysqlServer();
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
}
