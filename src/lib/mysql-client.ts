import { randomUUID } from "node:crypto";
import { execute, query } from "@/lib/mysql";
import { authForContext, type AuthContext } from "@/lib/mysql-auth";

type Row = Record<string, any>;
type Result = { data: any; error: { message: string; code?: string } | null; count?: number | null };
type Filter = { sql: string; values: unknown[] };

function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return `\`${value}\``;
}

function sqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "object" && value !== null && !(value instanceof Date)) return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString().slice(0, 23).replace("T", " ");
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    return value.slice(0, 23).replace("T", " ").replace(/Z$/, "");
  }
  return value;
}

function splitTopLevel(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === "(") depth++;
    if (expression[i] === ")") depth--;
    if (expression[i] === "," && depth === 0) {
      parts.push(expression.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expression.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parsePostgrestFilter(expression: string): Filter {
  const wrapped = expression.match(/^(and|or)\((.*)\)$/);
  if (wrapped) {
    const children = splitTopLevel(wrapped[2]).map(parsePostgrestFilter);
    return {
      sql: `(${children.map((child) => child.sql).join(wrapped[1] === "and" ? " AND " : " OR ")})`,
      values: children.flatMap((child) => child.values),
    };
  }
  const match = expression.match(/^([a-z_][a-z0-9_]*)\.(eq|neq|lt|lte|gt|gte|is|ilike)\.(.*)$/i);
  if (!match) throw new Error(`Unsupported filter: ${expression}`);
  const [, column, operator, value] = match;
  if (operator === "is" && value === "null") return { sql: `${identifier(column)} IS NULL`, values: [] };
  const operators: Record<string, string> = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=", ilike: "LIKE" };
  return { sql: `${identifier(column)} ${operators[operator]} ?`, values: [sqlValue(value)] };
}

class MySqlQuery implements PromiseLike<Result> {
  private action: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private selected = "*";
  private filters: Filter[] = [];
  private orderings: string[] = [];
  private maxRows: number | null = null;
  private offset = 0;
  private payload: Row[] = [];
  private ignoreDuplicates = false;
  private conflictColumns: string[] = [];
  private one: "single" | "maybeSingle" | null = null;
  private countRequested = false;
  private head = false;

  constructor(private readonly table: string) { identifier(table); }

  select(columns = "*", options?: { count?: string; head?: boolean }) {
    this.selected = columns;
    this.countRequested = options?.count === "exact";
    this.head = options?.head === true;
    return this;
  }
  insert(value: Row | Row[]) { this.action = "insert"; this.payload = Array.isArray(value) ? value : [value]; return this; }
  upsert(value: Row | Row[], options?: { ignoreDuplicates?: boolean; onConflict?: string }) {
    this.action = "upsert";
    this.payload = Array.isArray(value) ? value : [value];
    this.ignoreDuplicates = options?.ignoreDuplicates === true;
    this.conflictColumns = options?.onConflict?.split(",").map((column) => column.trim()).filter(Boolean) ?? [];
    this.conflictColumns.forEach(identifier);
    return this;
  }
  update(value: Row) { this.action = "update"; this.payload = [value]; return this; }
  delete() { this.action = "delete"; return this; }
  eq(column: string, value: unknown) { this.filters.push({ sql: `${identifier(column)} = ?`, values: [sqlValue(value)] }); return this; }
  neq(column: string, value: unknown) { this.filters.push({ sql: `${identifier(column)} <> ?`, values: [sqlValue(value)] }); return this; }
  gt(column: string, value: unknown) { this.filters.push({ sql: `${identifier(column)} > ?`, values: [sqlValue(value)] }); return this; }
  gte(column: string, value: unknown) { this.filters.push({ sql: `${identifier(column)} >= ?`, values: [sqlValue(value)] }); return this; }
  lt(column: string, value: unknown) { this.filters.push({ sql: `${identifier(column)} < ?`, values: [sqlValue(value)] }); return this; }
  lte(column: string, value: unknown) { this.filters.push({ sql: `${identifier(column)} <= ?`, values: [sqlValue(value)] }); return this; }
  is(column: string, value: null | boolean) {
    this.filters.push(value === null ? { sql: `${identifier(column)} IS NULL`, values: [] } : { sql: `${identifier(column)} = ?`, values: [value] });
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push(values.length ? { sql: `${identifier(column)} IN (${values.map(() => "?").join(",")})`, values: values.map(sqlValue) } : { sql: "FALSE", values: [] });
    return this;
  }
  ilike(column: string, value: string) { this.filters.push({ sql: `LOWER(${identifier(column)}) LIKE LOWER(?)`, values: [value] }); return this; }
  match(values: Row) { for (const [column, value] of Object.entries(values)) this.eq(column, value); return this; }
  or(expression: string) {
    const clauses = splitTopLevel(expression).map(parsePostgrestFilter);
    this.filters.push({ sql: `(${clauses.map((clause) => clause.sql).join(" OR ")})`, values: clauses.flatMap((clause) => clause.values) });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) { this.orderings.push(`${identifier(column)} ${options?.ascending === false ? "DESC" : "ASC"}`); return this; }
  limit(count: number) { this.maxRows = Math.max(0, Math.floor(count)); return this; }
  range(from: number, to: number) { this.offset = Math.max(0, Math.floor(from)); this.maxRows = Math.max(0, Math.floor(to - from + 1)); return this; }
  single() { this.one = "single"; return this; }
  maybeSingle() { this.one = "maybeSingle"; return this; }
  then<TResult1 = Result, TResult2 = never>(onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private where() {
    return { sql: this.filters.length ? ` WHERE ${this.filters.map((filter) => filter.sql).join(" AND ")}` : "", values: this.filters.flatMap((filter) => filter.values) };
  }
  private selectSql(overrideWhere?: Filter): { sql: string; values: unknown[] } {
    const columns = this.selected.replace(/,?\s*direct_messages\(\*\)/, "").trim();
    const selectColumns = columns === "*" || !columns ? "*" : columns.split(",").map((column) => identifier(column.trim())).join(", ");
    const where = overrideWhere ? { sql: ` WHERE ${overrideWhere.sql}`, values: overrideWhere.values } : this.where();
    const order = this.orderings.length ? ` ORDER BY ${this.orderings.join(", ")}` : "";
    const limit = this.maxRows === null ? "" : ` LIMIT ${this.maxRows} OFFSET ${this.offset}`;
    return { sql: `SELECT ${selectColumns} FROM ${identifier(this.table)}${where.sql}${order}${limit}`, values: where.values };
  }
  private async rows(overrideWhere?: Filter) {
    const select = this.selectSql(overrideWhere);
    const rows = await query<Row>(select.sql, select.values);
    if (this.table === "message_reports" && this.selected.includes("direct_messages(*)")) {
      for (const row of rows) {
        row.direct_messages = (await query<Row>("SELECT * FROM direct_messages WHERE id = ? LIMIT 1", [row.message_id]))[0] ?? null;
      }
    }
    return rows;
  }
  private async run(): Promise<Result> {
    try {
      const where = this.where();
      let rows: Row[] = [];
      let count: number | null = null;
      if (this.action === "select") {
        if (this.countRequested) {
          const counts = await query<{ total: number }>(`SELECT COUNT(*) AS total FROM ${identifier(this.table)}${where.sql}`, where.values);
          count = counts[0]?.total ?? 0;
        }
        if (!this.head) rows = await this.rows();
      } else if (this.action === "insert" || this.action === "upsert") {
        const inserted: string[] = [];
        for (const input of this.payload) {
          const row = { ...input };
          if (!row.id && !["prices", "prediction_markets", "leaderboard"].includes(this.table)) row.id = randomUUID();
          const columns = Object.keys(row);
          if (!columns.length) throw new Error("Cannot insert an empty row");
          const values = columns.map((column) => sqlValue(row[column]));
          const sql = `INSERT INTO ${identifier(this.table)} (${columns.map(identifier).join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
          const update = this.action === "upsert"
            ? this.ignoreDuplicates
              ? " ON DUPLICATE KEY UPDATE id = id"
              : ` ON DUPLICATE KEY UPDATE ${columns.filter((column) => column !== "id").map((column) => `${identifier(column)} = VALUES(${identifier(column)})`).join(",") || "id = id"}`
            : "";
          await execute(sql + update, values);
          if (row.id) inserted.push(String(row.id));
          else if (row.symbol) inserted.push(String(row.symbol));
          else if (row.account_id) inserted.push(String(row.account_id));
        }
        if (this.conflictColumns.length && this.payload.length) {
          const values: unknown[] = [];
          const conditions = this.payload.map((row) => {
            const clauses = this.conflictColumns.map((column) => {
              const value = row[column];
              if (value === null || value === undefined) return `${identifier(column)} IS NULL`;
              values.push(sqlValue(value));
              return `${identifier(column)} = ?`;
            });
            return `(${clauses.join(" AND ")})`;
          });
          rows = await this.rows({ sql: conditions.join(" OR "), values });
        } else if (inserted.length) {
          const key = this.table === "prices" ? "symbol" : this.table === "leaderboard" ? "account_id" : "id";
          rows = await this.rows({ sql: `${identifier(key)} IN (${inserted.map(() => "?").join(",")})`, values: inserted });
        }
      } else {
        const returning = this.selected !== "*" || this.one !== null;
        const before = returning && this.action === "update" ? await query<Row>(`SELECT id FROM ${identifier(this.table)}${where.sql}`, where.values) : [];
        if (this.action === "update") {
          const row = this.payload[0];
          const columns = Object.keys(row);
          if (!columns.length) throw new Error("Cannot update with an empty row");
          await execute(`UPDATE ${identifier(this.table)} SET ${columns.map((column) => `${identifier(column)} = ?`).join(",")}${where.sql}`, [...columns.map((column) => sqlValue(row[column])), ...where.values]);
          if (returning && before.length) rows = await this.rows({ sql: `id IN (${before.map(() => "?").join(",")})`, values: before.map((row) => row.id) });
        } else {
          await execute(`DELETE FROM ${identifier(this.table)}${where.sql}`, where.values);
        }
      }
      if (this.one) {
        if (rows.length > 1 || (rows.length === 0 && this.one === "single")) return { data: null, error: { message: rows.length ? "Multiple rows returned" : "No rows returned", code: "PGRST116" }, count };
        return { data: rows[0] ?? null, error: null, count };
      }
      return { data: this.head ? null : rows, error: null, count };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string })?.code }, count: null };
    }
  }
}

export class MySqlClient {
  readonly auth;
  constructor(context: AuthContext = {}) { this.auth = authForContext(context); }
  from(table: string): MySqlQuery { return new MySqlQuery(table); }
}
