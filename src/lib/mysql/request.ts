import type { NextRequest } from "next/server";
import { MySqlClient } from "@/lib/mysql-client";
import { mysqlServer } from "@/lib/mysql/server";

export async function mysqlForRequest(req: NextRequest): Promise<MySqlClient> {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return token ? new MySqlClient({ token }) : mysqlServer();
}
