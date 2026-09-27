import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
/**
 * Turns TypeScript query code into JavaScript by blanking out its type
 * syntax, using the Lezer parser that the editor already ships (no
 * compiler dependency). Removed text is replaced with spaces so line and
 * column numbers stay exact. Constructs that need real compilation (enums,
 * namespaces, decorators, parameter properties) are rejected with a clear
 * message, and syntax errors are reported with their line.
 */
import { parser } from "@lezer/javascript";

const typescriptParser = parser.configure({ dialect: "ts" });

/** Node types that are pure type syntax and can be removed entirely. */
const TYPE_ONLY = new Set([
  "TypeAnnotation",
  "TypeParamList",
  "TypeArgList",
  "InterfaceDeclaration",
  "TypeAliasDeclaration",
]);

const UNSUPPORTED = new Map([
  ["AbstractClass", "Abstract classes are not supported in queries."],
  ["Decorator", "Decorators are not supported in queries."],
  [
    "EnumDeclaration",
    "Enums are not supported in queries; use an object instead.",
  ],
  ["ModuleDeclaration", "Namespaces are not supported in queries."],
  ["NamespaceDeclaration", "Namespaces are not supported in queries."],
]);

const PARAMETER_MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "readonly",
]);

export class QuerySyntaxError extends SyntaxError {
  // A class field defines `name` on the instance; assigning it would fail
  // once the sandbox has frozen Error.prototype.
  override readonly name = "QuerySyntaxError";
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

const lineOf = (code: string, index: number): number =>
  code.slice(0, index).split("\n").length;

const blank = (text: string): string => text.replaceAll(/[^\n]/gu, " ");

const describe = (code: string, node: SyntaxNodeRef): string => {
  const near = code
    .slice(node.from, Math.min(node.to + 12, code.length))
    .trim();
  return near ? ` near "${near.split("\n")[0]}"` : "";
};

const rangeFor = (node: SyntaxNodeRef): [number, number] | undefined => {
  if (TYPE_ONLY.has(node.name)) {
    return [node.from, node.to];
  }
  const parent: SyntaxNode | null = node.node.parent;
  // `x as T` and `x satisfies T`: drop the keyword and the type after it.
  if (
    (node.name === "as" || node.name === "satisfies") &&
    parent?.name === "BinaryExpression"
  ) {
    return [node.from, parent.to];
  }
  // `value!` non-null assertions.
  if (node.name === "LogicOp" && parent?.name === "PostfixExpression") {
    return [node.from, node.to];
  }
  // `(limit?: number)` optional parameters.
  if (node.name === "Optional" && parent?.name === "ParamList") {
    return [node.from, node.to];
  }
  return undefined;
};

/**
 * Checks script syntax and, for TypeScript, removes type syntax. Returns
 * plain JavaScript with the same line layout as the input.
 */
export const toJavaScript = (code: string, typescript: boolean): string => {
  const tree = (typescript ? typescriptParser : parser).parse(code);
  const ranges: [number, number][] = [];
  let problem: QuerySyntaxError | undefined;
  tree.iterate({
    enter: (node) => {
      if (problem) {
        return false;
      }
      if (node.type.isError) {
        problem = new QuerySyntaxError(
          `Unexpected syntax${describe(code, node)}.`,
          lineOf(code, node.from)
        );
        return false;
      }
      const unsupported = UNSUPPORTED.get(node.name);
      if (unsupported) {
        problem = new QuerySyntaxError(unsupported, lineOf(code, node.from));
        return false;
      }
      if (
        typescript &&
        node.node.parent?.name === "ParamList" &&
        PARAMETER_MODIFIERS.has(code.slice(node.from, node.to))
      ) {
        problem = new QuerySyntaxError(
          "Parameter properties are not supported in queries.",
          lineOf(code, node.from)
        );
        return false;
      }
      const range = typescript ? rangeFor(node) : undefined;
      if (range) {
        ranges.push(range);
      }
      // Returning false skips a node's children.
      return !range;
    },
  });
  if (problem) {
    throw problem;
  }
  let output = "";
  let cursor = 0;
  for (const [from, to] of ranges.toSorted(
    (left, right) => left[0] - right[0]
  )) {
    if (to <= cursor) {
      continue;
    }
    const start = Math.max(from, cursor);
    output += code.slice(cursor, start) + blank(code.slice(start, to));
    cursor = to;
  }
  return output + code.slice(cursor);
};
