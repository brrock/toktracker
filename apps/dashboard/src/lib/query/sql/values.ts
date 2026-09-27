import { isNumberCell } from "../contract";
import type { Cell } from "../contract";
import { month as isoMonth, week as isoWeek } from "../helpers";

/** SQL value semantics and the scalar and aggregate functions. */

export const toNumber = (value: Cell): number | null => {
  if (value === null) {
    return null;
  }
  if (value === true || value === false) {
    return Number(value);
  }
  if (isNumberCell(value)) {
    return value;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

export const toText = (value: Cell): string | null => {
  if (value === null) {
    return null;
  }
  if (value === true || value === false) {
    return value ? "1" : "0";
  }
  return String(value);
};

export const truthy = (value: Cell): boolean => {
  const number = toNumber(value);
  return number !== null && number !== 0;
};

export const boolean = (condition: boolean): Cell => (condition ? 1 : 0);

const isNumeric = (value: Cell): boolean =>
  isNumberCell(value) || value === true || value === false;

/** SQL ordering: NULL first, then numbers, then text. */
export const compareCells = (left: Cell, right: Cell): number => {
  if (left === null || right === null) {
    if (left === right) {
      return 0;
    }
    return left === null ? -1 : 1;
  }
  const leftNumeric = isNumeric(left);
  const rightNumeric = isNumeric(right);
  if (leftNumeric && rightNumeric) {
    return (toNumber(left) ?? 0) - (toNumber(right) ?? 0);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  const a = String(left);
  const b = String(right);
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const LIKE_SPECIAL = /[$()*+.?[\\\]^{|}]/gu;
const likeCache = new Map<string, RegExp>();

/** `LIKE` matching: `%` any run, `_` one character, case-insensitive. */
export const matchesLike = (text: string, pattern: string): boolean => {
  let expression = likeCache.get(pattern);
  if (!expression) {
    const body = pattern
      .replaceAll(LIKE_SPECIAL, String.raw`\$&`)
      .replaceAll("%", String.raw`[\s\S]*`)
      .replaceAll("_", String.raw`[\s\S]`);
    expression = new RegExp(`^${body}$`, "iu");
    likeCache.set(pattern, expression);
  }
  return expression.test(text);
};

export const arithmetic = (operator: string, left: Cell, right: Cell): Cell => {
  if (operator === "||") {
    const a = toText(left);
    const b = toText(right);
    return a === null || b === null ? null : a + b;
  }
  const a = toNumber(left);
  const b = toNumber(right);
  if (a === null || b === null) {
    return null;
  }
  switch (operator) {
    case "+": {
      return a + b;
    }
    case "-": {
      return a - b;
    }
    case "*": {
      return a * b;
    }
    case "/": {
      return b === 0 ? null : a / b;
    }
    default: {
      return b === 0 ? null : a % b;
    }
  }
};

export const compare = (operator: string, left: Cell, right: Cell): Cell => {
  if (left === null || right === null) {
    return null;
  }
  const order = compareCells(left, right);
  switch (operator) {
    case "<": {
      return boolean(order < 0);
    }
    case "<=": {
      return boolean(order <= 0);
    }
    case ">": {
      return boolean(order > 0);
    }
    case ">=": {
      return boolean(order >= 0);
    }
    case "!=":
    case "<>": {
      return boolean(order !== 0);
    }
    default: {
      return boolean(order === 0);
    }
  }
};

// ---------------------------------------------------------------- dates

const DATE_PART = /^(?<date>\d{4}-\d{2}-\d{2})/u;
const DATE_ONLY_LENGTH = 10;
const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;
const MONDAY_SHIFT = 6;
const FORMAT_CODE = /%(?<code>.)/gu;

const pad = (value: number, width = 2): string =>
  value.toString().padStart(width, "0");

const parseTimestamp = (value: Cell): Date | null => {
  const text = toText(value);
  if (!text) {
    return null;
  }
  const dateOnly = DATE_PART.test(text) && text.length === DATE_ONLY_LENGTH;
  const date = new Date(dateOnly ? `${text}T00:00:00Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatPart = (code: string, date: Date): string | undefined => {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / DAY_MS) + 1;
  const weekday = date.getUTCDay();
  switch (code) {
    case "Y": {
      return date.getUTCFullYear().toString();
    }
    case "m": {
      return pad(date.getUTCMonth() + 1);
    }
    case "d": {
      return pad(date.getUTCDate());
    }
    case "H": {
      return pad(date.getUTCHours());
    }
    case "M": {
      return pad(date.getUTCMinutes());
    }
    case "S": {
      return pad(date.getUTCSeconds());
    }
    case "j": {
      return pad(dayOfYear, 3);
    }
    case "w": {
      return weekday.toString();
    }
    case "W": {
      const mondayIndex = (weekday + MONDAY_SHIFT) % DAYS_PER_WEEK;
      return pad(
        Math.floor(
          (dayOfYear + DAYS_PER_WEEK - mondayIndex - 1) / DAYS_PER_WEEK
        )
      );
    }
    case "%": {
      return "%";
    }
    default: {
      return undefined;
    }
  }
};

const strftime = (format: string, value: Cell): Cell => {
  const date = parseTimestamp(value);
  if (!date) {
    return null;
  }
  return format.replaceAll(
    FORMAT_CODE,
    (match, code: string) => formatPart(code, date) ?? match
  );
};

const dateOnly = (value: Cell): string | null => {
  const text = toText(value);
  return text ? (DATE_PART.exec(text)?.groups?.date ?? null) : null;
};

const onDate = (value: Cell, apply: (date: string) => string): Cell => {
  const date = dateOnly(value);
  return date ? apply(date) : null;
};

// ---------------------------------------------------------------- functions

const numeric = (value: Cell, apply: (number: number) => number): Cell => {
  const number = toNumber(value);
  return number === null ? null : apply(number);
};

const textual = (value: Cell, apply: (text: string) => Cell): Cell => {
  const text = toText(value);
  return text === null ? null : apply(text);
};

const MAX_ROUND_DIGITS = 10;

const round = (value: Cell, digits: Cell): Cell => {
  const places = Math.min(
    MAX_ROUND_DIGITS,
    Math.max(0, Math.trunc(toNumber(digits) ?? 0))
  );
  const factor = 10 ** places;
  return numeric(value, (number) => Math.round(number * factor) / factor);
};

const substring = (value: Cell, start: Cell, length: Cell): Cell =>
  textual(value, (text) => {
    const characters = [...text];
    const from = Math.trunc(toNumber(start) ?? 1);
    const begin = from > 0 ? from - 1 : Math.max(0, characters.length + from);
    const count =
      length === null
        ? characters.length
        : Math.max(0, Math.trunc(toNumber(length) ?? 0));
    return characters.slice(begin, begin + count).join("");
  });

const extreme = (args: readonly Cell[], direction: 1 | -1): Cell => {
  if (args.includes(null)) {
    return null;
  }
  let best: Cell = args[0] ?? null;
  for (const value of args) {
    if (compareCells(value, best) * direction > 0) {
      best = value;
    }
  }
  return best;
};

const instr = (text: Cell, find: Cell): Cell => {
  const haystack = toText(text);
  const needle = toText(find);
  return haystack === null || needle === null
    ? null
    : haystack.indexOf(needle) + 1;
};

const replace = (value: Cell, find: Cell, replacement: Cell): Cell => {
  const text = toText(value);
  const search = toText(find);
  return text === null || search === null
    ? null
    : text.replaceAll(search, toText(replacement) ?? "");
};

type ScalarFunction = (args: readonly Cell[]) => Cell;

const SCALAR_FUNCTIONS = new Map<string, ScalarFunction>([
  ["ABS", ([value = null]) => numeric(value, Math.abs)],
  ["CEIL", ([value = null]) => numeric(value, Math.ceil)],
  ["COALESCE", (args) => args.find((value) => value !== null) ?? null],
  ["DATE", ([value = null]) => dateOnly(value)],
  ["FLOOR", ([value = null]) => numeric(value, Math.floor)],
  ["IFNULL", ([value = null, fallback = null]) => value ?? fallback],
  [
    "IIF",
    ([condition = null, yes = null, no = null]) =>
      truthy(condition) ? yes : no,
  ],
  ["INSTR", ([text = null, find = null]) => instr(text, find)],
  ["LENGTH", ([value = null]) => textual(value, (text) => [...text].length)],
  ["LOWER", ([value = null]) => textual(value, (text) => text.toLowerCase())],
  ["MAX", (args) => extreme(args, 1)],
  ["MIN", (args) => extreme(args, -1)],
  ["MONTH", ([value = null]) => onDate(value, isoMonth)],
  [
    "NULLIF",
    ([value = null, other = null]) =>
      value !== null && other !== null && compareCells(value, other) === 0
        ? null
        : value,
  ],
  [
    "REPLACE",
    ([value = null, find = null, replacement = null]) =>
      replace(value, find, replacement),
  ],
  ["ROUND", ([value = null, digits = 0]) => round(value, digits)],
  [
    "STRFTIME",
    ([format = null, value = null]) => {
      const pattern = toText(format);
      return pattern === null ? null : strftime(pattern, value);
    },
  ],
  [
    "SUBSTR",
    ([value = null, start = 1, length = null]) =>
      substring(value, start, length),
  ],
  ["TRIM", ([value = null]) => textual(value, (text) => text.trim())],
  ["UPPER", ([value = null]) => textual(value, (text) => text.toUpperCase())],
  ["WEEK", ([value = null]) => onDate(value, isoWeek)],
]);

export const scalarFunction = (name: string): ScalarFunction | undefined =>
  SCALAR_FUNCTIONS.get(name);

const numericSum = (values: readonly Cell[]): number => {
  let total = 0;
  for (const value of values) {
    total += toNumber(value) ?? 0;
  }
  return total;
};

const extremeOf = (values: readonly Cell[], direction: 1 | -1): Cell => {
  let best: Cell = null;
  for (const value of values) {
    if (best === null || compareCells(value, best) * direction > 0) {
      best = value;
    }
  }
  return best;
};

/** Applies an aggregate to a group's values (NULLs already included). */
export const aggregate = (
  name: string,
  values: readonly Cell[],
  separator: Cell
): Cell => {
  const present = values.filter((value) => value !== null);
  switch (name) {
    case "COUNT": {
      return present.length;
    }
    case "SUM": {
      return present.length ? numericSum(present) : null;
    }
    case "TOTAL": {
      return numericSum(present);
    }
    case "AVG": {
      return present.length ? numericSum(present) / present.length : null;
    }
    case "MIN": {
      return extremeOf(present, -1);
    }
    case "MAX": {
      return extremeOf(present, 1);
    }
    default: {
      return present.length
        ? present.map((value) => toText(value)).join(toText(separator) ?? ",")
        : null;
    }
  }
};
