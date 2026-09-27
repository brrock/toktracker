import { SQL_FUNCTIONS } from "../contract";
import type { Cell } from "../contract";
import { SqlError } from "./error";
import { tokenize } from "./tokenize";
import type { Token } from "./tokenize";

export interface CaseBranch {
  condition: Expression;
  result: Expression;
}

export type Expression =
  | { kind: "literal"; value: Cell }
  | { kind: "column"; line: number; name: string; qualifier?: string }
  | { kind: "unary"; operand: Expression; operator: "-" | "+" | "NOT" }
  | { kind: "binary"; left: Expression; operator: string; right: Expression }
  | {
      args: Expression[];
      distinct: boolean;
      kind: "call";
      line: number;
      name: string;
      star: boolean;
    }
  | { kind: "cast"; operand: Expression; type: CastType }
  | {
      branches: CaseBranch[];
      fallback?: Expression;
      kind: "case";
      subject?: Expression;
    }
  | { kind: "in"; list: Expression[]; negated: boolean; operand: Expression }
  | {
      high: Expression;
      kind: "between";
      low: Expression;
      negated: boolean;
      operand: Expression;
    }
  | { kind: "like"; negated: boolean; operand: Expression; pattern: Expression }
  | { kind: "null-check"; negated: boolean; operand: Expression };

export type CastType = "INTEGER" | "REAL" | "TEXT";

export interface SelectItem {
  alias?: string;
  expression: Expression;
  source: string;
}

export interface OrderItem {
  descending: boolean;
  expression: Expression;
  nullsFirst?: boolean;
}

export interface TableReference {
  alias?: string;
  line: number;
  table: string;
}

export interface SelectStatement {
  columns: SelectItem[] | "*";
  distinct: boolean;
  from?: TableReference;
  groupBy: Expression[];
  having?: Expression;
  limit?: Expression;
  offset?: Expression;
  orderBy: OrderItem[];
  where?: Expression;
}

/** Aggregate functions (MIN/MAX with 2+ arguments are scalar instead). */
export const AGGREGATES = new Set([
  "COUNT",
  "SUM",
  "TOTAL",
  "AVG",
  "MIN",
  "MAX",
  "GROUP_CONCAT",
]);
export const COMPARISONS = new Set([
  "=",
  "==",
  "!=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
]);
const FUNCTION_NAMES = new Set([
  ...SQL_FUNCTIONS.map((doc) => doc.name),
  "SUBSTRING",
]);
const UNSUPPORTED = new Set([
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "NATURAL",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "WITH",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VALUES",
  "WINDOW",
  "OVER",
  "RECURSIVE",
]);
const ADDITIVE = new Set(["+", "-", "||"]);
const MULTIPLICATIVE = new Set(["*", "/", "%"]);
const MAX_DEPTH = 64;
const END_TOKEN: Token = {
  kind: "end",
  line: 1,
  start: 0,
  text: "",
  value: "",
};

export const isAggregateCall = (
  expression: Extract<Expression, { kind: "call" }>
): boolean =>
  AGGREGATES.has(expression.name) &&
  !(
    (expression.name === "MIN" || expression.name === "MAX") &&
    expression.args.length > 1
  );

const isCastType = (type: string): type is CastType =>
  type === "INTEGER" || type === "REAL" || type === "TEXT";

const describe = (token: Token): string =>
  token.kind === "end" ? "the end of the query" : `"${token.text}"`;

const fail = (message: string, token: Token): never => {
  throw new SqlError(message, token.line);
};

const unsupported = (token: Token): never =>
  fail(
    `${token.value.toUpperCase()} is not supported. Write a single SELECT over one table.`,
    token
  );

class Parser {
  private readonly source: string;
  private readonly tokens: Token[];
  private position = 0;
  private depth = 0;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return (
      this.tokens[Math.min(this.position, this.tokens.length - 1)] ?? END_TOKEN
    );
  }

  private previous(): Token {
    return this.tokens[this.position - 1] ?? END_TOKEN;
  }

  private next(): Token {
    const token = this.peek();
    this.position += 1;
    return token;
  }

  private isKeyword(word: string): boolean {
    const token = this.peek();
    return token.kind === "keyword" && token.value === word;
  }

  private isSymbol(symbol: string): boolean {
    const token = this.peek();
    return token.kind === "symbol" && token.value === symbol;
  }

  private acceptKeyword(word: string): boolean {
    const found = this.isKeyword(word);
    if (found) {
      this.position += 1;
    }
    return found;
  }

  private acceptSymbol(symbol: string): boolean {
    const found = this.isSymbol(symbol);
    if (found) {
      this.position += 1;
    }
    return found;
  }

  private expectKeyword(word: string): void {
    if (!this.acceptKeyword(word)) {
      fail(`Expected ${word} but found ${describe(this.peek())}.`, this.peek());
    }
  }

  private expectSymbol(symbol: string): void {
    if (!this.acceptSymbol(symbol)) {
      fail(
        `Expected "${symbol}" but found ${describe(this.peek())}.`,
        this.peek()
      );
    }
  }

  private identifier(what: string): Token {
    const token = this.peek();
    if (token.kind !== "identifier") {
      fail(`Expected ${what} but found ${describe(token)}.`, token);
    }
    return this.next();
  }

  parseStatement(): SelectStatement {
    const first = this.peek();
    if (
      first.kind === "identifier" &&
      UNSUPPORTED.has(first.value.toUpperCase())
    ) {
      unsupported(first);
    }
    if (!this.isKeyword("SELECT")) {
      fail(`Queries start with SELECT, not ${describe(first)}.`, first);
    }
    const statement = this.parseSelect();
    this.acceptSymbol(";");
    const rest = this.peek();
    if (rest.kind !== "end") {
      if (UNSUPPORTED.has(rest.value.toUpperCase())) {
        unsupported(rest);
      }
      fail(
        `Unexpected ${describe(rest)}. Only one statement is supported.`,
        rest
      );
    }
    return statement;
  }

  private parseSelect(): SelectStatement {
    this.expectKeyword("SELECT");
    const distinct = this.acceptKeyword("DISTINCT");
    this.acceptKeyword("ALL");
    const statement: SelectStatement = {
      columns: this.parseColumns(),
      distinct,
      groupBy: [],
      orderBy: [],
    };
    if (this.acceptKeyword("FROM")) {
      const table = this.identifier("a table name");
      statement.from = {
        alias: this.parseAlias(),
        line: table.line,
        table: table.value,
      };
    }
    if (this.acceptKeyword("WHERE")) {
      statement.where = this.parseExpression();
    }
    if (this.acceptKeyword("GROUP")) {
      this.expectKeyword("BY");
      statement.groupBy = this.parseList(() => this.parseExpression());
    }
    if (this.acceptKeyword("HAVING")) {
      statement.having = this.parseExpression();
    }
    if (this.acceptKeyword("ORDER")) {
      this.expectKeyword("BY");
      statement.orderBy = this.parseList(() => this.parseOrderItem());
    }
    if (this.acceptKeyword("LIMIT")) {
      this.parseLimit(statement);
    }
    return statement;
  }

  private parseLimit(statement: SelectStatement): void {
    statement.limit = this.parseExpression();
    if (this.acceptKeyword("OFFSET")) {
      statement.offset = this.parseExpression();
    } else if (this.acceptSymbol(",")) {
      // SQLite's `LIMIT offset, count`.
      statement.offset = statement.limit;
      statement.limit = this.parseExpression();
    }
  }

  private parseColumns(): SelectItem[] | "*" {
    if (this.acceptSymbol("*")) {
      return "*";
    }
    return this.parseList(() => {
      const { start } = this.peek();
      const expression = this.parseExpression();
      const last = this.previous();
      const source = this.source
        .slice(start, last.start + last.text.length)
        .trim();
      return { alias: this.parseAlias(), expression, source };
    });
  }

  private parseAlias(): string | undefined {
    if (this.acceptKeyword("AS")) {
      const token = this.next();
      if (token.kind !== "identifier" && token.kind !== "string") {
        fail(`Expected a name after AS but found ${describe(token)}.`, token);
      }
      return token.value;
    }
    const token = this.peek();
    if (token.kind !== "identifier") {
      return undefined;
    }
    if (UNSUPPORTED.has(token.value.toUpperCase())) {
      unsupported(token);
    }
    return this.next().value;
  }

  private parseOrderItem(): OrderItem {
    const expression = this.parseExpression();
    const descending = this.acceptKeyword("DESC");
    if (!descending) {
      this.acceptKeyword("ASC");
    }
    if (!this.acceptKeyword("NULLS")) {
      return { descending, expression };
    }
    const nullsFirst = this.acceptKeyword("FIRST");
    if (!nullsFirst) {
      this.expectKeyword("LAST");
    }
    return { descending, expression, nullsFirst };
  }

  private parseList<T>(item: () => T): T[] {
    const items = [item()];
    while (this.acceptSymbol(",")) {
      items.push(item());
    }
    return items;
  }

  parseExpression(): Expression {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      fail("The expression is nested too deeply.", this.peek());
    }
    try {
      return this.parseOr();
    } finally {
      this.depth -= 1;
    }
  }

  private parseOr(): Expression {
    let left = this.parseAnd();
    while (this.acceptKeyword("OR")) {
      left = { kind: "binary", left, operator: "OR", right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseNot();
    while (this.acceptKeyword("AND")) {
      left = { kind: "binary", left, operator: "AND", right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Expression {
    if (this.acceptKeyword("NOT")) {
      return { kind: "unary", operand: this.parseNot(), operator: "NOT" };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expression {
    const left = this.parseAdditive();
    const token = this.peek();
    if (token.kind === "symbol" && COMPARISONS.has(token.value)) {
      this.next();
      return {
        kind: "binary",
        left,
        operator: token.value,
        right: this.parseAdditive(),
      };
    }
    if (this.acceptKeyword("IS")) {
      const negated = this.acceptKeyword("NOT");
      this.expectKeyword("NULL");
      return { kind: "null-check", negated, operand: left };
    }
    return this.parsePredicate(left);
  }

  private parsePredicate(left: Expression): Expression {
    const negated = this.acceptKeyword("NOT");
    if (this.acceptKeyword("LIKE")) {
      return {
        kind: "like",
        negated,
        operand: left,
        pattern: this.parseAdditive(),
      };
    }
    if (this.acceptKeyword("IN")) {
      this.expectSymbol("(");
      if (this.isKeyword("SELECT")) {
        fail("Subqueries are not supported.", this.peek());
      }
      const list = this.parseList(() => this.parseExpression());
      this.expectSymbol(")");
      return { kind: "in", list, negated, operand: left };
    }
    if (this.acceptKeyword("BETWEEN")) {
      const low = this.parseAdditive();
      this.expectKeyword("AND");
      return {
        high: this.parseAdditive(),
        kind: "between",
        low,
        negated,
        operand: left,
      };
    }
    if (negated) {
      fail(
        `Expected LIKE, IN or BETWEEN after NOT but found ${describe(this.peek())}.`,
        this.peek()
      );
    }
    return left;
  }

  private parseAdditive(): Expression {
    let left = this.parseMultiplicative();
    while (this.peek().kind === "symbol" && ADDITIVE.has(this.peek().value)) {
      const operator = this.next().value;
      left = {
        kind: "binary",
        left,
        operator,
        right: this.parseMultiplicative(),
      };
    }
    return left;
  }

  private parseMultiplicative(): Expression {
    let left = this.parseUnary();
    while (
      this.peek().kind === "symbol" &&
      MULTIPLICATIVE.has(this.peek().value)
    ) {
      const operator = this.next().value;
      left = { kind: "binary", left, operator, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expression {
    if (this.acceptSymbol("-")) {
      return { kind: "unary", operand: this.parseUnary(), operator: "-" };
    }
    if (this.acceptSymbol("+")) {
      return { kind: "unary", operand: this.parseUnary(), operator: "+" };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    const token = this.next();
    if (token.kind === "number") {
      return { kind: "literal", value: Number(token.value) };
    }
    if (token.kind === "string") {
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "keyword") {
      return this.parseKeywordPrimary(token);
    }
    if (token.kind === "identifier") {
      return this.parseIdentifierPrimary(token);
    }
    if (token.kind === "symbol" && token.value === "(") {
      if (this.isKeyword("SELECT")) {
        fail("Subqueries are not supported.", this.peek());
      }
      const inner = this.parseExpression();
      this.expectSymbol(")");
      return inner;
    }
    return fail(`Expected a value but found ${describe(token)}.`, token);
  }

  private parseKeywordPrimary(token: Token): Expression {
    switch (token.value) {
      case "NULL": {
        return { kind: "literal", value: null };
      }
      case "TRUE": {
        return { kind: "literal", value: 1 };
      }
      case "FALSE": {
        return { kind: "literal", value: 0 };
      }
      case "CASE": {
        return this.parseCase();
      }
      case "CAST": {
        return this.parseCast();
      }
      default: {
        return fail(`Expected a value but found ${describe(token)}.`, token);
      }
    }
  }

  private parseCast(): Expression {
    this.expectSymbol("(");
    const operand = this.parseExpression();
    this.expectKeyword("AS");
    const typeToken = this.identifier("INTEGER, REAL or TEXT");
    const type = typeToken.value.toUpperCase();
    if (!isCastType(type)) {
      return fail(
        `CAST supports INTEGER, REAL and TEXT, not ${type}.`,
        typeToken
      );
    }
    this.expectSymbol(")");
    return { kind: "cast", operand, type };
  }

  private parseCase(): Expression {
    const subject = this.isKeyword("WHEN") ? undefined : this.parseExpression();
    const branches: CaseBranch[] = [];
    while (this.acceptKeyword("WHEN")) {
      const condition = this.parseExpression();
      this.expectKeyword("THEN");
      branches.push({ condition, result: this.parseExpression() });
    }
    if (!branches.length) {
      fail("CASE needs at least one WHEN … THEN ….", this.peek());
    }
    const fallback = this.acceptKeyword("ELSE")
      ? this.parseExpression()
      : undefined;
    this.expectKeyword("END");
    return { branches, fallback, kind: "case", subject };
  }

  private parseIdentifierPrimary(token: Token): Expression {
    if (this.isSymbol("(")) {
      return this.parseCall(token);
    }
    if (this.acceptSymbol(".")) {
      const column = this.identifier("a column name");
      return {
        kind: "column",
        line: column.line,
        name: column.value,
        qualifier: token.value,
      };
    }
    return { kind: "column", line: token.line, name: token.value };
  }

  private parseCall(token: Token): Expression {
    const upper = token.value.toUpperCase();
    if (!FUNCTION_NAMES.has(upper)) {
      fail(
        `Unknown function ${token.value}. Supported: ${[...FUNCTION_NAMES].join(", ")}.`,
        token
      );
    }
    const name = upper === "SUBSTRING" ? "SUBSTR" : upper;
    this.expectSymbol("(");
    if (this.acceptSymbol("*")) {
      this.expectSymbol(")");
      if (name !== "COUNT") {
        fail(`Only COUNT accepts *, not ${name}.`, token);
      }
      return {
        args: [],
        distinct: false,
        kind: "call",
        line: token.line,
        name,
        star: true,
      };
    }
    const distinct = this.acceptKeyword("DISTINCT");
    const args = this.isSymbol(")")
      ? []
      : this.parseList(() => this.parseExpression());
    this.expectSymbol(")");
    return {
      args,
      distinct,
      kind: "call",
      line: token.line,
      name,
      star: false,
    };
  }
}

export const parseSql = (source: string): SelectStatement =>
  new Parser(source).parseStatement();
