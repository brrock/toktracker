import { z } from "zod";

/**
 * The contract between the dashboard and the query sandbox worker: which
 * tables a query can read, which helpers JavaScript/TypeScript code gets,
 * the limits the sandbox enforces and the messages the two sides exchange.
 * Editor completion, the reference panel and the LLM prompt are all
 * generated from this file, so they cannot drift apart.
 */

export const QUERY_LANGUAGES = [
  { id: "sql", label: "SQL" },
  { id: "typescript", label: "TypeScript" },
  { id: "javascript", label: "JavaScript" },
] as const;
export type QueryLanguage = (typeof QUERY_LANGUAGES)[number]["id"];

export const QUERY_LIMITS = {
  /** Characters kept per text cell. */
  cellLength: 500,
  /** Characters of source code a widget may store. */
  codeLength: 20_000,
  /** Characters kept per column name. */
  columnNameLength: 100,
  /** Columns kept from a result. */
  columns: 50,
  /** Rows kept from a result. */
  rows: 5000,
  /** Milliseconds a query may run before its worker is terminated. */
  timeoutMs: 4000,
} as const;

export type ColumnType = "text" | "integer" | "real";

interface ColumnDoc {
  description: string;
  name: string;
  type: ColumnType;
}

interface TableDoc {
  columns: readonly ColumnDoc[];
  description: string;
  name: TableName;
}

export const TABLE_NAMES = [
  "daily",
  "hourly",
  "agents",
  "models",
  "projects",
  "sessions",
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

const usageColumns = (
  what: string
): readonly [ColumnDoc, ColumnDoc, ColumnDoc] => [
  { description: `${what} name.`, name: "name", type: "text" },
  {
    description: "Tokens used (input, output, cache and reasoning).",
    name: "tokens",
    type: "integer",
  },
  {
    description: "Spend in US dollars (reported or estimated).",
    name: "cost",
    type: "real",
  },
];

export const TABLES: readonly TableDoc[] = [
  {
    columns: [
      {
        description: "Calendar day, YYYY-MM-DD in local time.",
        name: "date",
        type: "text",
      },
      { description: "Tokens used that day.", name: "tokens", type: "integer" },
      {
        description: "Spend that day in US dollars.",
        name: "cost",
        type: "real",
      },
    ],
    description: "Usage per day for the current view.",
    name: "daily",
  },
  {
    columns: [
      {
        description: "Start of the hour as an ISO 8601 timestamp.",
        name: "hour",
        type: "text",
      },
      {
        description: "Tokens used that hour.",
        name: "tokens",
        type: "integer",
      },
      {
        description: "Spend that hour in US dollars.",
        name: "cost",
        type: "real",
      },
    ],
    description: "Usage per hour (only on views showing “Today”).",
    name: "hourly",
  },
  {
    columns: usageColumns("Coding agent (claude, codex, cursor, …)"),
    description: "Usage per coding agent.",
    name: "agents",
  },
  {
    columns: usageColumns("Model (for example claude-sonnet-4-5)"),
    description: "Usage per model.",
    name: "models",
  },
  {
    columns: usageColumns("Project or workspace"),
    description: "Usage per project.",
    name: "projects",
  },
  {
    columns: [
      { description: "Stable session identifier.", name: "id", type: "text" },
      {
        description: "Session title, or its id when untitled.",
        name: "title",
        type: "text",
      },
      {
        description: "Project the session ran in.",
        name: "project",
        type: "text",
      },
      { description: "Coding agent that ran it.", name: "agent", type: "text" },
      { description: "Primary model used.", name: "model", type: "text" },
      { description: "Tokens used.", name: "tokens", type: "integer" },
      { description: "Spend in US dollars.", name: "cost", type: "real" },
      {
        description: "First activity, ISO 8601 timestamp.",
        name: "created_at",
        type: "text",
      },
      {
        description: "Latest activity, ISO 8601 timestamp.",
        name: "last_seen",
        type: "text",
      },
    ],
    description: "Individual coding sessions visible in this view.",
    name: "sessions",
  },
];

export interface HelperDoc {
  description: string;
  example: string;
  name: string;
  signature: string;
}

/** Helpers passed to JavaScript/TypeScript queries as `tt`. */
export const HELPERS: readonly HelperDoc[] = [
  {
    description:
      "Group rows by a column and aggregate other columns. Each measure is " +
      '"sum", "avg", "min", "max" or "count" and reads the column of the ' +
      'same name ("count" counts rows). Results are sorted by the first ' +
      "measure, largest first.",
    example:
      'tt.rollup(data.sessions, "agent", { cost: "sum", sessions: "count" })',
    name: "rollup",
    signature:
      'rollup(rows, key, measures: Record<string, "sum" | "avg" | "min" | "max" | "count">): Row[]',
  },
  {
    description: "Sum a numeric column.",
    example: 'tt.sum(data.daily, "cost")',
    name: "sum",
    signature: "sum(rows, column): number",
  },
  {
    description: "Average of a numeric column (0 for no rows).",
    example: 'tt.avg(data.sessions, "tokens")',
    name: "avg",
    signature: "avg(rows, column): number",
  },
  {
    description: "Smallest value of a numeric column.",
    example: 'tt.min(data.daily, "cost")',
    name: "min",
    signature: "min(rows, column): number",
  },
  {
    description: "Largest value of a numeric column.",
    example: 'tt.max(data.daily, "cost")',
    name: "max",
    signature: "max(rows, column): number",
  },
  {
    description: "Split rows into groups that share a column value.",
    example: 'tt.groupBy(data.sessions, "project")',
    name: "groupBy",
    signature: "groupBy(rows, column): { key: string; rows: Row[] }[]",
  },
  {
    description:
      "Sort rows by a column (descending by default). Returns a copy.",
    example: 'tt.sortBy(data.models, "cost", "desc")',
    name: "sortBy",
    signature: 'sortBy(rows, column, direction?: "asc" | "desc"): Row[]',
  },
  {
    description: "The n rows with the largest value in a column.",
    example: 'tt.top(data.projects, "tokens", 3)',
    name: "top",
    signature: "top(rows, column, n = 5): Row[]",
  },
  {
    description: "Monday of the ISO week containing a date, as YYYY-MM-DD.",
    example: "tt.week(row.date)",
    name: "week",
    signature: "week(date: string): string",
  },
  {
    description: "Month of a date, as YYYY-MM.",
    example: "tt.month(row.date)",
    name: "month",
    signature: "month(date: string): string",
  },
  {
    description: "Round a number to a number of decimal places (default 2).",
    example: "tt.round(row.cost, 2)",
    name: "round",
    signature: "round(value: number, digits = 2): number",
  },
];

/** Functions TokTracker SQL supports (see sql.ts). */
export const SQL_FUNCTIONS: readonly HelperDoc[] = [
  {
    description: "Number of rows, or of non-null values.",
    example: "COUNT(*), COUNT(DISTINCT project)",
    name: "COUNT",
    signature: "COUNT(* | [DISTINCT] x)",
  },
  {
    description: "Sum of non-null values (NULL when there are none).",
    example: "SUM(cost)",
    name: "SUM",
    signature: "SUM([DISTINCT] x)",
  },
  {
    description: "Sum of non-null values, 0 when there are none.",
    example: "TOTAL(tokens)",
    name: "TOTAL",
    signature: "TOTAL(x)",
  },
  {
    description: "Average of non-null values.",
    example: "AVG(cost)",
    name: "AVG",
    signature: "AVG([DISTINCT] x)",
  },
  {
    description:
      "Smallest value; with two or more arguments, the smallest argument.",
    example: "MIN(date)",
    name: "MIN",
    signature: "MIN(x, …)",
  },
  {
    description:
      "Largest value; with two or more arguments, the largest argument.",
    example: "MAX(cost)",
    name: "MAX",
    signature: "MAX(x, …)",
  },
  {
    description: "Join a group's values into one string.",
    example: "GROUP_CONCAT(agent, ', ')",
    name: "GROUP_CONCAT",
    signature: "GROUP_CONCAT(x, separator = ',')",
  },
  {
    description: "Round to a number of decimal places.",
    example: "ROUND(SUM(cost), 2)",
    name: "ROUND",
    signature: "ROUND(x, digits = 0)",
  },
  {
    description: "Absolute value.",
    example: "ABS(x)",
    name: "ABS",
    signature: "ABS(x)",
  },
  {
    description: "Round up to a whole number.",
    example: "CEIL(tokens / 1000.0)",
    name: "CEIL",
    signature: "CEIL(x)",
  },
  {
    description: "Round down to a whole number.",
    example: "FLOOR(cost)",
    name: "FLOOR",
    signature: "FLOOR(x)",
  },
  {
    description: "Lower-case text.",
    example: "LOWER(agent)",
    name: "LOWER",
    signature: "LOWER(text)",
  },
  {
    description: "Upper-case text.",
    example: "UPPER(agent)",
    name: "UPPER",
    signature: "UPPER(text)",
  },
  {
    description: "Number of characters.",
    example: "LENGTH(title)",
    name: "LENGTH",
    signature: "LENGTH(text)",
  },
  {
    description: "Remove surrounding whitespace.",
    example: "TRIM(title)",
    name: "TRIM",
    signature: "TRIM(text)",
  },
  {
    description: "Part of a text, starting at 1.",
    example: "SUBSTR(hour, 12, 2)",
    name: "SUBSTR",
    signature: "SUBSTR(text, start, length?)",
  },
  {
    description: "Replace every occurrence of a text.",
    example: "REPLACE(model, 'claude-', '')",
    name: "REPLACE",
    signature: "REPLACE(text, find, with)",
  },
  {
    description: "Position of a text inside another (1-based, 0 if absent).",
    example: "INSTR(model, 'sonnet')",
    name: "INSTR",
    signature: "INSTR(text, find)",
  },
  {
    description: "First argument that is not NULL.",
    example: "COALESCE(title, id)",
    name: "COALESCE",
    signature: "COALESCE(x, …)",
  },
  {
    description: "The second argument when the first is NULL.",
    example: "IFNULL(cost, 0)",
    name: "IFNULL",
    signature: "IFNULL(x, fallback)",
  },
  {
    description:
      "NULL when both arguments are equal (avoids dividing by zero).",
    example: "cost / NULLIF(tokens, 0)",
    name: "NULLIF",
    signature: "NULLIF(x, y)",
  },
  {
    description: "Inline if.",
    example: "IIF(cost > 1, 'big', 'small')",
    name: "IIF",
    signature: "IIF(condition, then, else)",
  },
  {
    description: "The YYYY-MM-DD date of a date or timestamp.",
    example: "DATE(last_seen)",
    name: "DATE",
    signature: "DATE(x)",
  },
  {
    description:
      "Format a date: %Y %m %d %H %M %S %W (week of year) %w (weekday) %j (day of year).",
    example: "STRFTIME('%Y-%m', date)",
    name: "STRFTIME",
    signature: "STRFTIME(format, x)",
  },
  {
    description: "Monday of the ISO week, as YYYY-MM-DD (same as tt.week).",
    example: "WEEK(date)",
    name: "WEEK",
    signature: "WEEK(x)",
  },
  {
    description: "Month as YYYY-MM (same as tt.month).",
    example: "MONTH(date)",
    name: "MONTH",
    signature: "MONTH(x)",
  },
  {
    description: "Convert a value.",
    example: "CAST(tokens AS REAL)",
    name: "CAST",
    signature: "CAST(x AS INTEGER | REAL | TEXT)",
  },
];

export const SQL_SYNTAX =
  "SELECT [DISTINCT] … FROM table [WHERE …] [GROUP BY …] [HAVING …] [ORDER BY … ASC|DESC] [LIMIT n [OFFSET m]]. " +
  "Operators: + - * / % || = != < <= > >= AND OR NOT, IS [NOT] NULL, [NOT] LIKE, [NOT] IN (…), [NOT] BETWEEN … AND …, CASE WHEN … THEN … ELSE … END. " +
  "One statement, one table (no joins, subqueries or CTEs). Division is always decimal.";

export const JS_GLOBALS = [
  {
    description: `Every table this view provides, as arrays of plain objects: ${TABLE_NAMES.map(
      (name) => `data.${name}`
    ).join(", ")}.`,
    name: "data",
  },
  {
    description: "Aggregation and date helpers (see the reference panel).",
    name: "tt",
  },
] as const;

export type Cell = string | number | boolean | null;

export const isNumberCell = (cell: Cell | undefined): cell is number =>
  Number.isFinite(cell);
export const isTextCell = (cell: Cell | undefined): cell is string =>
  cell !== undefined &&
  cell !== null &&
  cell !== true &&
  cell !== false &&
  !Number.isFinite(cell);
export type Row = Record<string, Cell>;
export type Tables = Partial<Record<TableName, Row[]>>;

export interface QueryRequest {
  code: string;
  language: QueryLanguage;
  runId: string;
  tables: Tables;
}

const cellSchema = z.union([
  z.string().max(QUERY_LIMITS.cellLength),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** Everything the main thread accepts back from the sandbox. */
export const queryResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    columns: z
      .array(z.string().max(QUERY_LIMITS.columnNameLength))
      .max(QUERY_LIMITS.columns),
    durationMs: z.number().nonnegative(),
    ok: z.literal(true),
    rows: z.array(z.array(cellSchema)).max(QUERY_LIMITS.rows),
    runId: z.string(),
    truncated: z.boolean(),
  }),
  z.object({
    error: z.string().max(2000),
    line: z.number().int().positive().optional(),
    ok: z.literal(false),
    runId: z.string(),
  }),
]);
export type QueryResponse = z.infer<typeof queryResponseSchema>;
export type QueryResult = Extract<QueryResponse, { ok: true }>;

/** Tables shown in the reference, limited to those a view provides. */
export const availableTables = (tables: Tables): TableDoc[] =>
  TABLES.filter((table) => tables[table.name] !== undefined);

const tsType = (type: ColumnType): string =>
  type === "text" ? "string" : "number";

/** Declarations shown for TypeScript queries (and in the LLM prompt). */
export const typeDeclarations = (tables: Tables): string => {
  const rows = availableTables(tables)
    .map(
      (table) =>
        `  /** ${table.description} */\n  ${table.name}: {\n${table.columns
          .map(
            (column) =>
              `    /** ${column.description} */\n    ${column.name}: ${tsType(column.type)};`
          )
          .join("\n")}\n  }[];`
    )
    .join("\n");
  return `declare const data: {\n${rows}\n};\n\ndeclare const tt: {\n${HELPERS.map(
    (helper) => `  /** ${helper.description} */\n  ${helper.signature};`
  ).join("\n")}\n};`;
};

export const STARTER_CODE = {
  javascript: `// \`data\` holds this view's tables; \`tt\` has helpers.
// Return an array of row objects: the first text column labels the chart,
// numeric columns are plotted.
return tt.rollup(data.sessions, "agent", {
  cost: "sum",
  sessions: "count",
});
`,
  sql: `-- Query this view's tables with a small SQL dialect (see Reference).
-- The first text column labels the chart; numeric columns are plotted.
SELECT agent, ROUND(SUM(cost), 2) AS cost, COUNT(*) AS sessions
FROM sessions
GROUP BY agent
ORDER BY cost DESC;
`,
  typescript: `// \`data\` holds this view's tables; \`tt\` has helpers.
// Return an array of row objects: the first text column labels the chart,
// numeric columns are plotted.
const byWeek = tt.groupBy(
  data.daily.map((day) => ({ ...day, week: tt.week(day.date) })),
  "week"
);

return byWeek.map(({ key, rows }) => ({
  week: key,
  cost: tt.round(tt.sum(rows, "cost")),
}));
`,
} satisfies Record<QueryLanguage, string>;
