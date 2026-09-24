import { MySqlClient } from "@/lib/mysql-client";

/** Server-side MySQL access for handlers that have checked authorization. */
export function mysqlAdmin(): MySqlClient {
  return new MySqlClient();
}
