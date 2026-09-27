/**
 * Query sandbox. Runs one user-written SQL, JavaScript or TypeScript query
 * against a copy of a view's tables and posts back a bounded table.
 *
 * Defence in depth — each layer holds even if another fails:
 * 1. The gateway serves this script with `connect-src 'none'`, so nothing
 *    in this worker can make a network request (and therefore cannot use
 *    the dashboard's session cookies). `script-src 'self'` stops remote
 *    code from being imported.
 * 2. Before user code runs, networking, storage, messaging and worker APIs
 *    are removed from the global scope, and core prototypes are frozen so
 *    user code cannot tamper with the code that serialises its result.
 * 3. User output is only read through a schema (normalize.ts) that coerces
 *    it into primitive cells within fixed limits.
 * 4. The main thread terminates the worker after one result or when the
 *    time limit passes, and re-validates every response with a schema
 *    before rendering it as plain text (never HTML).
 * SQL is interpreted by sql.ts (no eval, no database) over the rows the
 * view already shows; it never reaches the gateway database.
 */
import { TABLE_NAMES } from "./contract";
import type {
  QueryRequest,
  QueryResponse,
  TableName,
  Tables,
} from "./contract";
import { helpers } from "./helpers";
import { queryOutputSchema } from "./normalize";
import type { NormalizedResult } from "./normalize";

interface SandboxMessage {
  response: QueryResponse;
}

interface SandboxScope {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<QueryRequest>) => void,
    options: { once: boolean }
  ) => void;
  postMessage: (message: SandboxMessage) => void;
}

const scope: SandboxScope = globalThis;
const post = scope.postMessage.bind(scope);

// Lines the Function constructor and our wrapper add above user code.
const WRAPPER_LINE_OFFSET = 4;
const STACK_LINE = /(?:<anonymous>|Function|eval)[^:]*:(?<line>\d+):\d+/u;
const MAX_ERROR_LENGTH = 2000;
const TABLE_NAME_SET = new Set<string>(TABLE_NAMES);

const BLOCKED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "EventSource",
  "WebTransport",
  "importScripts",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "MessageChannel",
  "indexedDB",
  "caches",
  "cookieStore",
  "Notification",
  "FileSystemHandle",
  "FileSystemFileHandle",
  "FileSystemDirectoryHandle",
  "postMessage",
  "close",
] as const;

const FROZEN_INTRINSICS = [
  Object.prototype,
  Array.prototype,
  Function.prototype,
  String.prototype,
  Number.prototype,
  Boolean.prototype,
  Map.prototype,
  Set.prototype,
  Error.prototype,
  JSON,
  Math,
  Reflect,
] as const;

/** Removes capabilities user code must never have. */
const lockDown = (): void => {
  for (const name of BLOCKED_GLOBALS) {
    let target: object | null = globalThis;
    while (target) {
      if (Object.hasOwn(target, name)) {
        Reflect.deleteProperty(target, name);
      }
      target = Object.getPrototypeOf(target);
    }
    if (name in globalThis) {
      // Not configurable: shadow it on the global object instead.
      Object.defineProperty(globalThis, name, {
        configurable: false,
        value: undefined,
        writable: false,
      });
    }
  }
  for (const intrinsic of FROZEN_INTRINSICS) {
    Object.freeze(intrinsic);
  }
};

// Our own parse errors carry friendlier labels than their class names.
const ERROR_LABELS = new Map([
  ["QuerySyntaxError", "SyntaxError"],
  ["SqlError", "SQL error"],
]);

const errorMessage = (error: Error): string =>
  `${ERROR_LABELS.get(error.name) ?? error.name}: ${error.message}`.slice(
    0,
    MAX_ERROR_LENGTH
  );

/** The user's line for an error thrown while running script code. */
const userLine = (error: Error, code: string): number | undefined => {
  if ("line" in error && Number.isInteger(error.line)) {
    return Number(error.line);
  }
  const stack = STACK_LINE.exec(error.stack ?? "")?.groups?.line;
  const line = stack ? Number(stack) - WRAPPER_LINE_OFFSET : undefined;
  return line && line >= 1 && line <= code.split("\n").length
    ? line
    : undefined;
};

const runScript = async (request: QueryRequest): Promise<NormalizedResult> => {
  const { toJavaScript } = await import("./strip-types");
  // Syntax is checked (and TypeScript types removed) before anything runs;
  // the wrapper makes top-level `return` and `await` work.
  const script = toJavaScript(request.code, request.language === "typescript");
  lockDown();
  // oxlint-disable-next-line typescript/no-implied-eval, no-new-func -- evaluating user code is this sandbox's purpose; see the file header.
  const factory = new Function(
    `"use strict";\nreturn (async (data, tt) => {\n${script}\n});`
  );
  const query = factory();
  const output = await query(Object.freeze({ ...request.tables }), helpers);
  return queryOutputSchema.parse(output);
};

const runSql = async (request: QueryRequest): Promise<NormalizedResult> => {
  const { executeSql } = await import("./sql/execute");
  lockDown();
  return executeSql(request.code, request.tables);
};

const isTableName = (name: string): name is TableName =>
  TABLE_NAME_SET.has(name);

const knownTables = (tables: Tables | undefined): Tables =>
  Object.fromEntries(
    Object.entries(tables ?? {}).filter(([name]) => isTableName(name))
  );

const handle = async (request: QueryRequest): Promise<void> => {
  const started = performance.now();
  const scoped = { ...request, tables: knownTables(request.tables) };
  try {
    const result =
      request.language === "sql"
        ? await runSql(scoped)
        : await runScript(scoped);
    post({
      response: {
        ...result,
        durationMs: performance.now() - started,
        ok: true,
        runId: request.runId,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    post({
      response: {
        error: errorMessage(reason),
        line: userLine(reason, request.code),
        ok: false,
        runId: request.runId,
      },
    });
  }
};

// Each worker serves exactly one request.
scope.addEventListener("message", (event) => handle(event.data), {
  once: true,
});
