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
 * SQL runs in an in-memory SQLite (WebAssembly) holding only the rows the
 * view already shows; it never reaches the gateway database.
 */
import { isNumberCell, QUERY_LIMITS, TABLE_NAMES } from "./contract";
import type {
  Cell,
  QueryRequest,
  QueryResponse,
  Row,
  TableName,
  Tables,
} from "./contract";
import { helpers } from "./helpers";
import { cellSchema, queryOutputSchema } from "./normalize";
import type { NormalizedResult } from "./normalize";

interface SandboxMessage {
  module?: WebAssembly.Module;
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
const SUCRASE_LINE = /\((?<line>\d+):\d+\)/u;
// SQLite names the offending token in these messages; find it in the code.
const SQL_TOKEN =
  /near "(?<near>[^"]+)"|no such (?:column|table|function): (?<name>[\w.]+)/u;
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

const errorMessage = (error: Error): string =>
  `${error.name}: ${error.message}`.slice(0, MAX_ERROR_LENGTH);

const userLine = (error: Error, code: string): number | undefined => {
  const sucrase = SUCRASE_LINE.exec(error.message)?.groups?.line;
  const stack = STACK_LINE.exec(error.stack ?? "")?.groups?.line;
  let line: number | undefined;
  if (sucrase) {
    line = Number(sucrase) - 1;
  } else if (stack) {
    line = Number(stack) - WRAPPER_LINE_OFFSET;
  }
  const lines = code.split("\n").length;
  return line && line >= 1 && line <= lines ? line : undefined;
};

const sqlErrorLine = (error: Error, code: string): number | undefined => {
  const groups = SQL_TOKEN.exec(error.message)?.groups;
  const token = groups?.near ?? groups?.name;
  if (!token) {
    return undefined;
  }
  const index = code.indexOf(token);
  return index === -1 ? undefined : code.slice(0, index).split("\n").length;
};

const runScript = async (request: QueryRequest): Promise<NormalizedResult> => {
  const { transform } = await import("sucrase");
  // Parsing with Sucrase first gives syntax errors a line number and strips
  // TypeScript types. The wrapper makes top-level `return` and `await` work.
  const wrapped = `(async (data, tt) => {\n${request.code}\n})`;
  const compiled = transform(wrapped, {
    disableESTransforms: true,
    transforms: request.language === "typescript" ? ["typescript"] : [],
  }).code;
  lockDown();
  // oxlint-disable-next-line typescript/no-implied-eval, no-new-func -- evaluating user code is this sandbox's purpose; see the file header.
  const factory = new Function(`"use strict";\nreturn ${compiled};`);
  const query = factory();
  const output = await query(Object.freeze({ ...request.tables }), helpers);
  return queryOutputSchema.parse(output);
};

const sqlType = (rows: readonly Row[], column: string): string => {
  const sample = rows.find((row) => row[column] !== null)?.[column];
  if (isNumberCell(sample)) {
    return Number.isInteger(sample) ? "INTEGER" : "REAL";
  }
  return "TEXT";
};

const sqlValue = (cell: Cell | undefined): string | number | null => {
  if (cell === true || cell === false) {
    return Number(cell);
  }
  return cell ?? null;
};

const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

const loadSqlite = async (source: ArrayBuffer | WebAssembly.Module) => {
  const { default: initSqlJs } = await import("sql.js");
  const module =
    source instanceof WebAssembly.Module
      ? source
      : await WebAssembly.compile(source);
  const SQL = await initSqlJs({
    instantiateWasm: (imports, done) => {
      const instantiate = async (): Promise<void> => {
        done(await WebAssembly.instantiate(module, imports));
      };
      instantiate();
      return {};
    },
  });
  return { SQL, module };
};

const runSql = async (
  request: QueryRequest
): Promise<{ module: WebAssembly.Module; result: NormalizedResult }> => {
  if (!request.wasm) {
    throw new Error("SQLite is unavailable in this browser.");
  }
  const { module, SQL } = await loadSqlite(request.wasm);
  const database = new SQL.Database();
  try {
    database.run("BEGIN");
    for (const [name, rows] of Object.entries(request.tables)) {
      const table = quoteIdentifier(name);
      const columns = Object.keys(rows[0] ?? {});
      if (!columns.length) {
        database.run(`CREATE TABLE ${table} (placeholder TEXT)`);
        continue;
      }
      const definitions = columns
        .map((column) => `${quoteIdentifier(column)} ${sqlType(rows, column)}`)
        .join(", ");
      database.run(`CREATE TABLE ${table} (${definitions})`);
      const insert = database.prepare(
        `INSERT INTO ${table} VALUES (${columns.map(() => "?").join(", ")})`
      );
      for (const row of rows) {
        insert.run(columns.map((column) => sqlValue(row[column])));
      }
      insert.free();
    }
    database.run("COMMIT");
    lockDown();
    let result: NormalizedResult = { columns: [], rows: [], truncated: false };
    for (const statement of database.iterateStatements(request.code)) {
      const columns = statement.getColumnNames();
      const rows: Cell[][] = [];
      let truncated = false;
      while (statement.step()) {
        if (rows.length === QUERY_LIMITS.rows) {
          truncated = true;
          break;
        }
        rows.push(statement.get().map((value) => cellSchema.parse(value)));
      }
      if (columns.length) {
        result = { ...queryOutputSchema.parse({ columns, rows }), truncated };
      }
      statement.free();
    }
    return { module, result };
  } finally {
    database.close();
  }
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
    const { module, result } =
      request.language === "sql"
        ? await runSql(scoped)
        : { module: undefined, result: await runScript(scoped) };
    post({
      module,
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
        // Sucrase reports positions in the wrapped source; `line` below
        // carries the user's line instead.
        error: errorMessage(reason).replace(SUCRASE_LINE, "").trim(),
        line:
          request.language === "sql"
            ? sqlErrorLine(reason, request.code)
            : userLine(reason, request.code),
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
