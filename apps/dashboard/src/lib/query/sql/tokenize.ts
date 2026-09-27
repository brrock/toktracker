import { SqlError } from "./error";

export type TokenKind =
  | "number"
  | "string"
  | "identifier"
  | "keyword"
  | "symbol"
  | "end";

export interface Token {
  kind: TokenKind;
  line: number;
  start: number;
  text: string;
  value: string;
}

export const KEYWORDS = new Set([
  "SELECT",
  "DISTINCT",
  "ALL",
  "FROM",
  "WHERE",
  "GROUP",
  "BY",
  "HAVING",
  "ORDER",
  "ASC",
  "DESC",
  "LIMIT",
  "OFFSET",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IS",
  "NULL",
  "LIKE",
  "IN",
  "BETWEEN",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "TRUE",
  "FALSE",
  "CAST",
  "NULLS",
  "FIRST",
  "LAST",
]);

const SYMBOLS = [
  "<=",
  ">=",
  "<>",
  "!=",
  "==",
  "||",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "(",
  ")",
  ",",
  ".",
  ";",
] as const;
const IDENTIFIER_START = /[A-Za-z_]/u;
const IDENTIFIER_PART = /[\w$]/u;
const DIGIT = /\d/u;
const WHITESPACE = /\s/u;

export const lineAt = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

interface QuotedText {
  end: number;
  value: string;
}

const readQuoted = (
  source: string,
  start: number,
  quote: string
): QuotedText => {
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === quote && source.charAt(index + 1) === quote) {
      value += quote;
      index += 2;
    } else if (char === quote) {
      return { end: index + 1, value };
    } else {
      value += char;
      index += 1;
    }
  }
  throw new SqlError("Unterminated quoted text.", lineAt(source, start));
};

const numberEnd = (source: string, start: number): number => {
  let index = start;
  while (DIGIT.test(source.charAt(index)) || source.charAt(index) === ".") {
    index += 1;
  }
  if (source.charAt(index).toLowerCase() === "e") {
    index += 1;
    if (source.charAt(index) === "+" || source.charAt(index) === "-") {
      index += 1;
    }
    while (DIGIT.test(source.charAt(index))) {
      index += 1;
    }
  }
  return index;
};

const wordEnd = (source: string, start: number): number => {
  let index = start + 1;
  while (IDENTIFIER_PART.test(source.charAt(index))) {
    index += 1;
  }
  return index;
};

const commentEnd = (source: string, index: number): number => {
  if (source.startsWith("--", index)) {
    const end = source.indexOf("\n", index);
    return end === -1 ? source.length : end;
  }
  if (source.startsWith("/*", index)) {
    const end = source.indexOf("*/", index + 2);
    return end === -1 ? source.length : end + 2;
  }
  return index;
};

const symbolAt = (source: string, index: number): string | undefined =>
  SYMBOLS.find((candidate) => source.startsWith(candidate, index));

interface Lexeme {
  end: number;
  kind: TokenKind;
  value: string;
}

/** Reads the token starting at `index` (which is not whitespace or a comment). */
const lexeme = (source: string, index: number): Lexeme => {
  const char = source.charAt(index);
  if (char === "'") {
    const quoted = readQuoted(source, index, "'");
    return { end: quoted.end, kind: "string", value: quoted.value };
  }
  if (char === '"' || char === "`") {
    const quoted = readQuoted(source, index, char);
    return { end: quoted.end, kind: "identifier", value: quoted.value };
  }
  if (char === "[") {
    const end = source.indexOf("]", index);
    if (end === -1) {
      throw new SqlError("Unterminated [identifier].", lineAt(source, index));
    }
    return {
      end: end + 1,
      kind: "identifier",
      value: source.slice(index + 1, end),
    };
  }
  const startsNumber =
    DIGIT.test(char) || (char === "." && DIGIT.test(source.charAt(index + 1)));
  if (startsNumber) {
    const end = numberEnd(source, index);
    return { end, kind: "number", value: source.slice(index, end) };
  }
  if (IDENTIFIER_START.test(char)) {
    const end = wordEnd(source, index);
    const word = source.slice(index, end);
    const upper = word.toUpperCase();
    return KEYWORDS.has(upper)
      ? { end, kind: "keyword", value: upper }
      : { end, kind: "identifier", value: word };
  }
  const symbol = symbolAt(source, index);
  if (!symbol) {
    throw new SqlError(
      `Unexpected character "${char}".`,
      lineAt(source, index)
    );
  }
  return { end: index + symbol.length, kind: "symbol", value: symbol };
};

export const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const afterComment = commentEnd(source, index);
    if (afterComment !== index) {
      index = afterComment;
    } else if (WHITESPACE.test(source.charAt(index))) {
      index += 1;
    } else {
      const token = lexeme(source, index);
      tokens.push({
        kind: token.kind,
        line: lineAt(source, index),
        start: index,
        text: source.slice(index, token.end),
        value: token.value,
      });
      index = token.end;
    }
  }
  tokens.push({
    kind: "end",
    line: lineAt(source, source.length),
    start: source.length,
    text: "",
    value: "",
  });
  return tokens;
};
