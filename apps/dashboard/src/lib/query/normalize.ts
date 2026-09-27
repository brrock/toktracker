import { z } from "zod";

import { QUERY_LIMITS } from "./contract";
import type { Cell, Row } from "./contract";

export interface NormalizedResult {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
}

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

// Takes a thunk so JSON.stringify's own failures (cycles, BigInt) are caught.
const serialise = (stringify: () => string | undefined): string => {
  try {
    return clip(stringify() ?? "", QUERY_LIMITS.cellLength);
  } catch {
    return "[unserialisable]";
  }
};

/** Any value user code can put in a cell, coerced to a primitive cell. */
export const cellSchema: z.ZodType<Cell> = z.union([
  z.null().transform((): Cell => null),
  z.undefined().transform((): Cell => null),
  z.boolean(),
  // Zod numbers exclude NaN and ±Infinity; they carry no value to chart.
  z.nan().transform((): Cell => null),
  z.literal([Infinity, -Infinity]).transform((): Cell => null),
  z
    .number()
    .transform((value): Cell => (Number.isFinite(value) ? value : null)),
  z.string().transform((value): Cell => clip(value, QUERY_LIMITS.cellLength)),
  z.bigint().transform(Number),
  z
    .date()
    .transform(
      (value): Cell =>
        Number.isNaN(value.getTime()) ? null : value.toISOString()
    ),
  z
    .instanceof(Uint8Array)
    .transform((value): Cell => `[${value.length} bytes]`),
  z
    .looseObject({})
    .transform((value): Cell => serialise(() => JSON.stringify(value))),
  z
    .array(z.any())
    .transform((value): Cell => serialise(() => JSON.stringify(value))),
  z
    .any()
    .transform((value): Cell => clip(String(value), QUERY_LIMITS.cellLength)),
]);

const rowObjectSchema = z.record(z.string(), cellSchema);

const tableSchema = z.object({
  columns: z.array(z.any()),
  rows: z.array(z.array(cellSchema).or(z.any().transform((): Cell[] => []))),
});

/** Builds a table from row objects; columns follow first appearance. */
export const rowsToTable = (
  rows: readonly Row[],
  totalRows: number = rows.length
): NormalizedResult => {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key) && columns.length < QUERY_LIMITS.columns) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return {
    columns: columns.map((column) =>
      clip(column, QUERY_LIMITS.columnNameLength)
    ),
    rows: rows.map((row) => columns.map((column) => row[column] ?? null)),
    truncated: totalRows > rows.length,
  };
};

/**
 * Every shape a query may return: an array of row objects, an array of
 * primitives, `{ columns, rows }` with array rows, or a single value.
 * Parsing user output through this schema is the sandbox's only way of
 * reading it.
 */
export const queryOutputSchema = z.union([
  z.undefined().transform(() => {
    throw new TypeError(
      "The query returned nothing. Return an array of row objects, e.g. `return data.daily;`."
    );
  }),
  tableSchema.transform((table): NormalizedResult => {
    const columns = table.columns
      .slice(0, QUERY_LIMITS.columns)
      .map((column) => clip(String(column), QUERY_LIMITS.columnNameLength));
    return {
      columns,
      rows: table.rows
        .slice(0, QUERY_LIMITS.rows)
        .map((row) => columns.map((_, index) => row[index] ?? null)),
      truncated: table.rows.length > QUERY_LIMITS.rows,
    };
  }),
  z
    .array(rowObjectSchema)
    .transform(
      (rows): NormalizedResult =>
        rowsToTable(rows.slice(0, QUERY_LIMITS.rows), rows.length)
    ),
  z.array(cellSchema).transform(
    (values): NormalizedResult => ({
      columns: ["value"],
      rows: values.slice(0, QUERY_LIMITS.rows).map((value) => [value]),
      truncated: values.length > QUERY_LIMITS.rows,
    })
  ),
  cellSchema.transform(
    (value): NormalizedResult => ({
      columns: ["value"],
      rows: [[value]],
      truncated: false,
    })
  ),
]);
