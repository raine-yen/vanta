import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";

let pool: mysql.Pool | undefined;

export function mysqlPool(): mysql.Pool {
  if (pool) return pool;
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const database = process.env.DB_NAME;
  const password = process.env.DB_PASSWORD;
  if (!host || !user || !database || password === undefined) {
    throw new Error("MySQL connection is not configured (DB_HOST, DB_USER, DB_NAME, DB_PASSWORD).");
  }
  pool = mysql.createPool({
    host,
    port: Number(process.env.DB_PORT || 3306),
    user,
    database,
    password,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    decimalNumbers: true,
    dateStrings: true,
    timezone: "Z",
    charset: "utf8mb4",
  });
  pool.on("connection", (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  return pool;
}

function normalizeRow(row: unknown): unknown {
  if (Array.isArray(row)) return row.map(normalizeRow);
  if (!row || typeof row !== "object") return row;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
      copy[key] = value.replace(" ", "T") + "Z";
    } else if (typeof value === "string" && (key === "tags" || key === "rank_thresholds" || key === "tier_requirements")) {
      try { copy[key] = JSON.parse(value); } catch { copy[key] = value; }
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

export async function query<T = Record<string, unknown>>(sql: string, values: unknown[] = [], connection?: PoolConnection): Promise<T[]> {
  const target = connection ?? mysqlPool();
  const [rows] = await target.query<RowDataPacket[]>(sql, values);
  return normalizeRow(rows) as T[];
}

export async function execute(sql: string, values: unknown[] = [], connection?: PoolConnection) {
  const target = connection ?? mysqlPool();
  const [result] = await target.query(sql, values as any[]);
  return result;
}

export async function transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await mysqlPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
