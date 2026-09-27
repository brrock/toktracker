/**
 * The `tt` helpers available to JavaScript/TypeScript queries. They run
 * inside the sandbox worker; see HELPERS in contract.ts for the documented
 * signatures. Each helper validates its input and throws a readable error,
 * because the code calling them is written by people (or LLMs) iterating.
 */
import { isNumberCell } from "./contract";
import type { Row } from "./contract";

type Measure = "sum" | "avg" | "min" | "max" | "count";
type Direction = "asc" | "desc";
type Rows = readonly Readonly<Row>[];

const MEASURES = new Set<string>(["sum", "avg", "min", "max", "count"]);
const DATE_PREFIX = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u;
const DEFAULT_TOP = 5;
const DEFAULT_DIGITS = 2;
const MAX_DIGITS = 10;
const DAYS_TO_MONDAY = 6;
const DAYS_PER_WEEK = 7;

const assertRows = (rows: Rows, helper: string): void => {
  if (!Array.isArray(rows)) {
    throw new TypeError(`tt.${helper}: expected an array of rows.`);
  }
};

const numbers = (rows: Rows, column: string): number[] =>
  rows.map((row) => row[column]).filter(isNumberCell);

export const sum = (rows: Rows, column: string): number => {
  assertRows(rows, "sum");
  return numbers(rows, column).reduce((total, value) => total + value, 0);
};

export const avg = (rows: Rows, column: string): number => {
  assertRows(rows, "avg");
  const values = numbers(rows, column);
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
};

export const min = (rows: Rows, column: string): number => {
  assertRows(rows, "min");
  const values = numbers(rows, column);
  return values.length ? Math.min(...values) : 0;
};

export const max = (rows: Rows, column: string): number => {
  assertRows(rows, "max");
  const values = numbers(rows, column);
  return values.length ? Math.max(...values) : 0;
};

export const groupBy = <T extends Readonly<Row>>(
  rows: readonly T[],
  column: string
): { key: string; rows: T[] }[] => {
  assertRows(rows, "groupBy");
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = String(row[column] ?? "");
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return [...groups].map(([key, groupRows]) => ({ key, rows: groupRows }));
};

const measure = (rows: Rows, column: string, kind: Measure): number => {
  switch (kind) {
    case "count": {
      return rows.length;
    }
    case "avg": {
      return avg(rows, column);
    }
    case "min": {
      return min(rows, column);
    }
    case "max": {
      return max(rows, column);
    }
    default: {
      return sum(rows, column);
    }
  }
};

const isMeasure = (kind: string): kind is Measure => MEASURES.has(kind);

export const rollup = (
  rows: Rows,
  column: string,
  measures: Readonly<Record<string, string>>
): Row[] => {
  assertRows(rows, "rollup");
  const entries = Object.entries(measures ?? {});
  const checked = entries.map(([name, kind]): [string, Measure] => {
    if (!isMeasure(kind)) {
      throw new TypeError(
        `tt.rollup: measure "${name}" must be "sum", "avg", "min", "max" or "count", not "${kind}".`
      );
    }
    return [name, kind];
  });
  const result = groupBy(rows, column).map(
    ({ key, rows: groupRows }): Row =>
      Object.fromEntries([
        [column, key],
        ...checked.map(([name, kind]) => [
          name,
          measure(groupRows, name, kind),
        ]),
      ])
  );
  const [first] = checked;
  if (!first) {
    return result;
  }
  const [firstName] = first;
  return result.toSorted(
    (left, right) => Number(right[firstName]) - Number(left[firstName])
  );
};

export const sortBy = <T extends Readonly<Row>>(
  rows: readonly T[],
  column: string,
  direction: Direction = "desc"
): T[] => {
  assertRows(rows, "sortBy");
  const factor = direction === "asc" ? 1 : -1;
  return rows.toSorted((left, right) => {
    const a = left[column];
    const b = right[column];
    if (isNumberCell(a) && isNumberCell(b)) {
      return (a - b) * factor;
    }
    return String(a ?? "").localeCompare(String(b ?? "")) * factor;
  });
};

export const top = <T extends Readonly<Row>>(
  rows: readonly T[],
  column: string,
  count: number = DEFAULT_TOP
): T[] => sortBy(rows, column, "desc").slice(0, Math.max(0, count));

const parseDate = (date: string, helper: string): Date => {
  const parts = DATE_PREFIX.exec(String(date))?.groups;
  if (!parts) {
    throw new TypeError(
      `tt.${helper}: expected a YYYY-MM-DD date, got "${date}".`
    );
  }
  return new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  );
};

const pad = (value: number): string => value.toString().padStart(2, "0");

export const week = (date: string): string => {
  const parsed = parseDate(date, "week");
  const offset = (parsed.getUTCDay() + DAYS_TO_MONDAY) % DAYS_PER_WEEK;
  parsed.setUTCDate(parsed.getUTCDate() - offset);
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`;
};

export const month = (date: string): string => {
  const parsed = parseDate(date, "month");
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}`;
};

export const round = (
  value: number,
  digits: number = DEFAULT_DIGITS
): number => {
  const places = Math.min(MAX_DIGITS, Math.max(0, Math.trunc(digits)));
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
};

export const helpers = Object.freeze({
  avg,
  groupBy,
  max,
  min,
  month,
  rollup,
  round,
  sortBy,
  sum,
  top,
  week,
});
