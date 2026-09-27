/**
 * TokTracker SQL: a small, dependency-free SQL interpreter for query
 * widgets. It runs one SELECT over one in-memory table — enough for
 * dashboards — and never evaluates code: statements are tokenised, parsed
 * into a tree and interpreted. See SQL_SYNTAX and SQL_FUNCTIONS in
 * contract.ts for the documented dialect.
 */
import { isNumberCell, isTextCell, QUERY_LIMITS } from "../contract";
import type { Cell, Row, Tables } from "../contract";
import type { NormalizedResult } from "../normalize";
import { SqlError } from "./error";
import { COMPARISONS, isAggregateCall, parseSql } from "./parse";
import type {
  Expression,
  OrderItem,
  SelectItem,
  SelectStatement,
} from "./parse";
import {
  aggregate,
  arithmetic,
  boolean,
  compare,
  compareCells,
  matchesLike,
  scalarFunction,
  toNumber,
  toText,
  truthy,
} from "./values";

interface Scope {
  /** Output values by lower-case column name, for ORDER BY and HAVING. */
  aliases?: Map<string, Cell>;
  /** Rows of the current group, when the query aggregates. */
  group?: readonly Row[];
  row?: Row;
}

type Call = Extract<Expression, { kind: "call" }>;

const distinctValues = (values: readonly Cell[]): Cell[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    const fresh = !seen.has(key);
    seen.add(key);
    return fresh;
  });
};

const unary = (operator: "-" | "+" | "NOT", value: Cell): Cell => {
  if (operator === "NOT") {
    return value === null ? null : boolean(!truthy(value));
  }
  const number = toNumber(value);
  if (number === null) {
    return null;
  }
  return operator === "-" ? -number : number;
};

const cast = (type: "INTEGER" | "REAL" | "TEXT", value: Cell): Cell => {
  if (value === null) {
    return null;
  }
  if (type === "TEXT") {
    return toText(value);
  }
  const number = toNumber(value) ?? 0;
  return type === "INTEGER" ? Math.trunc(number) : number;
};

const negate = (negated: boolean, result: Cell): Cell =>
  negated && result !== null ? boolean(!truthy(result)) : result;

class Evaluator {
  private readonly columns: Map<string, string>;
  private readonly tableNames: Set<string>;

  constructor(columns: readonly string[], tableNames: readonly string[]) {
    this.columns = new Map(
      columns.map((column) => [column.toLowerCase(), column])
    );
    this.tableNames = new Set(tableNames.map((name) => name.toLowerCase()));
  }

  evaluate(expression: Expression, scope: Scope): Cell {
    switch (expression.kind) {
      case "literal": {
        return expression.value;
      }
      case "column": {
        return this.column(expression, scope);
      }
      case "unary": {
        return unary(
          expression.operator,
          this.evaluate(expression.operand, scope)
        );
      }
      case "binary": {
        return this.binary(expression, scope);
      }
      case "call": {
        return isAggregateCall(expression)
          ? this.aggregate(expression, scope)
          : this.scalar(expression, scope);
      }
      case "cast": {
        return cast(expression.type, this.evaluate(expression.operand, scope));
      }
      case "case": {
        return this.caseWhen(expression, scope);
      }
      default: {
        return this.predicate(expression, scope);
      }
    }
  }

  private column(
    expression: Extract<Expression, { kind: "column" }>,
    scope: Scope
  ): Cell {
    const key = expression.name.toLowerCase();
    const { qualifier } = expression;
    if (qualifier && !this.tableNames.has(qualifier.toLowerCase())) {
      throw new SqlError(
        `Unknown table or alias "${qualifier}".`,
        expression.line
      );
    }
    if (!qualifier && scope.aliases?.has(key)) {
      return scope.aliases.get(key) ?? null;
    }
    const name = this.columns.get(key);
    if (!name) {
      const known = [...this.columns.values()];
      const hint = known.length
        ? ` Columns: ${known.join(", ")}.`
        : " Add FROM <table> to read columns.";
      throw new SqlError(
        `No such column: ${expression.name}.${hint}`,
        expression.line
      );
    }
    return (scope.row ?? scope.group?.[0])?.[name] ?? null;
  }

  private binary(
    expression: Extract<Expression, { kind: "binary" }>,
    scope: Scope
  ): Cell {
    const { operator } = expression;
    const left = this.evaluate(expression.left, scope);
    if (operator === "AND") {
      if (left !== null && !truthy(left)) {
        return 0;
      }
      const right = this.evaluate(expression.right, scope);
      if (right !== null && !truthy(right)) {
        return 0;
      }
      return left === null || right === null ? null : 1;
    }
    if (operator === "OR") {
      if (truthy(left)) {
        return 1;
      }
      const right = this.evaluate(expression.right, scope);
      if (truthy(right)) {
        return 1;
      }
      return left === null || right === null ? null : 0;
    }
    const right = this.evaluate(expression.right, scope);
    return COMPARISONS.has(operator)
      ? compare(operator, left, right)
      : arithmetic(operator, left, right);
  }

  private aggregate(expression: Call, scope: Scope): Cell {
    const { group } = scope;
    if (!group) {
      throw new SqlError(
        `${expression.name}() is an aggregate; it cannot be used in WHERE or inside another aggregate.`,
        expression.line
      );
    }
    if (expression.star) {
      return group.length;
    }
    const [argument, separator] = expression.args;
    if (!argument) {
      throw new SqlError(
        `${expression.name}() needs an argument.`,
        expression.line
      );
    }
    const values = group.map((row) => this.evaluate(argument, { row }));
    return aggregate(
      expression.name,
      expression.distinct ? distinctValues(values) : values,
      separator ? this.evaluate(separator, { row: group[0] }) : ","
    );
  }

  private scalar(expression: Call, scope: Scope): Cell {
    const implementation = scalarFunction(expression.name);
    if (!implementation) {
      throw new SqlError(
        `${expression.name}() cannot be used here.`,
        expression.line
      );
    }
    return implementation(
      expression.args.map((arg) => this.evaluate(arg, scope))
    );
  }

  private caseWhen(
    expression: Extract<Expression, { kind: "case" }>,
    scope: Scope
  ): Cell {
    const subject = expression.subject
      ? this.evaluate(expression.subject, scope)
      : undefined;
    for (const branch of expression.branches) {
      const candidate = this.evaluate(branch.condition, scope);
      const matches =
        subject === undefined
          ? truthy(candidate)
          : subject !== null &&
            candidate !== null &&
            compareCells(subject, candidate) === 0;
      if (matches) {
        return this.evaluate(branch.result, scope);
      }
    }
    return expression.fallback
      ? this.evaluate(expression.fallback, scope)
      : null;
  }

  private predicate(
    expression: Extract<
      Expression,
      { kind: "in" | "between" | "like" | "null-check" }
    >,
    scope: Scope
  ): Cell {
    const value = this.evaluate(expression.operand, scope);
    switch (expression.kind) {
      case "null-check": {
        return negate(expression.negated, boolean(value === null));
      }
      case "in": {
        if (value === null) {
          return null;
        }
        const options = expression.list.map((item) =>
          this.evaluate(item, scope)
        );
        const found = options.some(
          (option) => option !== null && compareCells(value, option) === 0
        );
        return negate(expression.negated, boolean(found));
      }
      case "between": {
        const low = this.evaluate(expression.low, scope);
        const high = this.evaluate(expression.high, scope);
        if (value === null || low === null || high === null) {
          return null;
        }
        const inside =
          compareCells(value, low) >= 0 && compareCells(value, high) <= 0;
        return negate(expression.negated, boolean(inside));
      }
      default: {
        const pattern = toText(this.evaluate(expression.pattern, scope));
        const text = toText(value);
        if (text === null || pattern === null) {
          return null;
        }
        return negate(expression.negated, boolean(matchesLike(text, pattern)));
      }
    }
  }
}

const children = (expression: Expression): (Expression | undefined)[] => {
  switch (expression.kind) {
    case "call": {
      return expression.args;
    }
    case "unary":
    case "cast":
    case "null-check": {
      return [expression.operand];
    }
    case "binary": {
      return [expression.left, expression.right];
    }
    case "case": {
      return [
        expression.subject,
        expression.fallback,
        ...expression.branches.flatMap((branch) => [
          branch.condition,
          branch.result,
        ]),
      ];
    }
    case "in": {
      return [expression.operand, ...expression.list];
    }
    case "between": {
      return [expression.operand, expression.low, expression.high];
    }
    case "like": {
      return [expression.operand, expression.pattern];
    }
    default: {
      return [];
    }
  }
};

const containsAggregate = (expression: Expression | undefined): boolean => {
  if (!expression) {
    return false;
  }
  if (expression.kind === "call" && isAggregateCall(expression)) {
    return true;
  }
  return children(expression).some(containsAggregate);
};

interface ResolvedTable {
  columns: string[];
  names: string[];
  rows: readonly Row[];
}

const resolveTable = (
  statement: SelectStatement,
  tables: Tables
): ResolvedTable => {
  if (!statement.from) {
    return { columns: [], names: [], rows: [{}] };
  }
  const { from } = statement;
  const requested = from.table.toLowerCase();
  const entry = Object.entries(tables).find(
    ([name]) => name.toLowerCase() === requested
  );
  if (!entry) {
    throw new SqlError(
      `No such table: ${from.table}. Tables here: ${Object.keys(tables).join(", ") || "none"}.`,
      from.line
    );
  }
  const [name, rows] = entry;
  return {
    columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
    names: from.alias ? [name, from.alias] : [name],
    rows,
  };
};

const groupScopes = (
  evaluator: Evaluator,
  statement: SelectStatement,
  rows: readonly Row[]
): Scope[] => {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = JSON.stringify(
      statement.groupBy.map((expression) =>
        evaluator.evaluate(expression, { row })
      )
    );
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  // An aggregate without GROUP BY always yields one row, even over nothing.
  if (!statement.groupBy.length && !groups.size) {
    groups.set("[]", []);
  }
  return [...groups.values()].map((group) => ({ group }));
};

interface OutputRow {
  scope: Scope;
  values: Cell[];
}

const orderKey = (
  evaluator: Evaluator,
  order: OrderItem,
  row: OutputRow
): Cell => {
  const { expression } = order;
  // `ORDER BY 2` sorts by the second output column.
  if (expression.kind === "literal" && isNumberCell(expression.value)) {
    return row.values[expression.value - 1] ?? null;
  }
  return evaluator.evaluate(expression, row.scope);
};

const compareKeys = (
  orderBy: readonly OrderItem[],
  left: Cell[],
  right: Cell[]
): number => {
  for (const [position, order] of orderBy.entries()) {
    const a = left[position] ?? null;
    const b = right[position] ?? null;
    if (a === null && b === null) {
      continue;
    }
    if (a === null || b === null) {
      const nullsFirst = order.nullsFirst ?? !order.descending;
      return (a === null) === nullsFirst ? -1 : 1;
    }
    const difference = compareCells(a, b);
    if (difference !== 0) {
      return order.descending ? -difference : difference;
    }
  }
  return 0;
};

const sortRows = (
  evaluator: Evaluator,
  orderBy: readonly OrderItem[],
  rows: OutputRow[]
): OutputRow[] => {
  const keyed = rows.map((row, index) => ({
    index,
    keys: orderBy.map((order) => orderKey(evaluator, order, row)),
    row,
  }));
  keyed.sort(
    (left, right) =>
      compareKeys(orderBy, left.keys, right.keys) || left.index - right.index
  );
  return keyed.map((entry) => entry.row);
};

const uniqueRows = (rows: OutputRow[]): OutputRow[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row.values);
    const fresh = !seen.has(key);
    seen.add(key);
    return fresh;
  });
};

const limitValue = (
  evaluator: Evaluator,
  expression: Expression | undefined,
  fallback: number
): number => {
  if (!expression) {
    return fallback;
  }
  const value = toNumber(evaluator.evaluate(expression, {}));
  return value === null || value < 0 ? fallback : Math.trunc(value);
};

const clipCell = (value: Cell): Cell =>
  isTextCell(value) && value.length > QUERY_LIMITS.cellLength
    ? `${value.slice(0, QUERY_LIMITS.cellLength - 1)}…`
    : value;

const selectItems = (
  statement: SelectStatement,
  columns: readonly string[]
): SelectItem[] =>
  statement.columns === "*"
    ? columns.map((column) => ({
        expression: { kind: "column", line: 1, name: column },
        source: column,
      }))
    : statement.columns;

const project = (
  evaluator: Evaluator,
  items: readonly SelectItem[],
  names: readonly string[],
  scopes: readonly Scope[]
): OutputRow[] =>
  scopes.map((scope) => {
    const values = items.map((item) =>
      evaluator.evaluate(item.expression, scope)
    );
    const aliases = new Map(
      names.map((name, index) => [name.toLowerCase(), values[index] ?? null])
    );
    return { scope: { ...scope, aliases }, values };
  });

/** `GROUP BY week` may name a select alias, as in SQLite. */
const resolveGroupAliases = (
  statement: SelectStatement,
  items: readonly SelectItem[],
  columns: readonly string[]
): Expression[] => {
  const known = new Set(columns.map((column) => column.toLowerCase()));
  return statement.groupBy.map((expression) => {
    if (
      expression.kind !== "column" ||
      expression.qualifier ||
      known.has(expression.name.toLowerCase())
    ) {
      return expression;
    }
    const alias = items.find(
      (item) => item.alias?.toLowerCase() === expression.name.toLowerCase()
    );
    return alias ? alias.expression : expression;
  });
};

/** Runs one TokTracker SQL statement against the given tables. */
export const executeSql = (
  source: string,
  tables: Tables
): NormalizedResult => {
  const statement = parseSql(source);
  const table = resolveTable(statement, tables);
  const evaluator = new Evaluator(table.columns, table.names);
  const items = selectItems(statement, table.columns);
  statement.groupBy = resolveGroupAliases(statement, items, table.columns);
  const { having, where } = statement;
  const rows = where
    ? table.rows.filter((row) => truthy(evaluator.evaluate(where, { row })))
    : table.rows;
  const grouped =
    statement.groupBy.length > 0 ||
    items.some((item) => containsAggregate(item.expression)) ||
    containsAggregate(having);
  const scopes = grouped
    ? groupScopes(evaluator, statement, rows)
    : rows.map((row) => ({ row }));
  const names = items.map((item) => item.alias ?? item.source);
  let output = project(evaluator, items, names, scopes);
  if (having) {
    output = output.filter((row) =>
      truthy(evaluator.evaluate(having, row.scope))
    );
  }
  if (statement.distinct) {
    output = uniqueRows(output);
  }
  if (statement.orderBy.length) {
    output = sortRows(evaluator, statement.orderBy, output);
  }
  const offset = limitValue(evaluator, statement.offset, 0);
  const limit = limitValue(
    evaluator,
    statement.limit,
    Number.POSITIVE_INFINITY
  );
  const limited = output.slice(offset, offset + limit);
  return {
    columns: names
      .slice(0, QUERY_LIMITS.columns)
      .map((name) => name.slice(0, QUERY_LIMITS.columnNameLength)),
    rows: limited
      .slice(0, QUERY_LIMITS.rows)
      .map((row) => row.values.slice(0, QUERY_LIMITS.columns).map(clipCell)),
    truncated: limited.length > QUERY_LIMITS.rows,
  };
};
