import { QUERY_LIMITS, queryResponseSchema } from "./contract";
import type {
  QueryLanguage,
  QueryRequest,
  QueryResponse,
  Tables,
} from "./contract";

const MAX_CONCURRENT_RUNS = 2;
const CACHE_ENTRIES = 48;

const cache = new Map<string, QueryResponse>();
// Tables are memoised per view data, so their identity names a dataset.
const datasetIds = new WeakMap<Tables, number>();
let nextDatasetId = 0;
let runCounter = 0;
let running = 0;
const waiting: (() => void)[] = [];

const datasetId = (tables: Tables): number => {
  const known = datasetIds.get(tables);
  if (known !== undefined) {
    return known;
  }
  nextDatasetId += 1;
  datasetIds.set(tables, nextDatasetId);
  return nextDatasetId;
};

const remember = (key: string, response: QueryResponse): void => {
  cache.delete(key);
  cache.set(key, response);
  if (cache.size > CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
};

const acquireSlot = async (): Promise<void> => {
  if (running >= MAX_CONCURRENT_RUNS) {
    // oxlint-disable-next-line promise/avoid-new -- a queue of waiters has no promise-returning API
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  }
  running += 1;
};

const releaseSlot = (): void => {
  running -= 1;
  waiting.shift()?.();
};

const failure = (runId: string, error: string): QueryResponse => ({
  error,
  ok: false,
  runId,
});

// Every response is re-validated here: the worker runs untrusted code, so
// nothing it sends is trusted until it matches the schema exactly.
const parseResponse = (runId: string, message: MessageEvent): QueryResponse => {
  const envelope: { response?: QueryResponse } = message.data ?? {};
  const parsed = queryResponseSchema.safeParse(envelope.response);
  if (!parsed.success || parsed.data.runId !== runId) {
    return failure(runId, "The query returned a malformed result.");
  }
  const { data } = parsed;
  if (data.ok && data.rows.some((row) => row.length !== data.columns.length)) {
    return failure(runId, "The query returned rows of uneven width.");
  }
  return data;
};

const execute = (
  request: Omit<QueryRequest, "runId">,
  signal?: AbortSignal
): Promise<QueryResponse> => {
  runCounter += 1;
  const runId = `run-${runCounter}`;
  // oxlint-disable-next-line promise/avoid-new -- Worker results arrive as events
  return new Promise<QueryResponse>((resolve) => {
    const worker = new Worker(new URL("query.worker.ts", import.meta.url), {
      name: "toktracker-query-sandbox",
      type: "module",
    });
    let timer = 0;
    let settled = false;
    const finish = (response: QueryResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      worker.terminate();
      window.clearTimeout(timer);
      resolve(response);
    };
    timer = window.setTimeout(
      () =>
        finish(
          failure(
            runId,
            `The query took longer than ${QUERY_LIMITS.timeoutMs / 1000}s and was stopped.`
          )
        ),
      QUERY_LIMITS.timeoutMs
    );
    signal?.addEventListener(
      "abort",
      () => finish(failure(runId, "Cancelled.")),
      {
        once: true,
      }
    );
    worker.addEventListener("message", (message) =>
      finish(parseResponse(runId, message))
    );
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      finish(
        failure(runId, "The query sandbox could not start in this browser.")
      );
    });
    worker.addEventListener("messageerror", () =>
      finish(failure(runId, "The query returned a result that cannot be read."))
    );
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no target origin
    worker.postMessage({ ...request, runId });
  });
};

/**
 * Runs a query in a fresh sandbox worker. Results are cached per code and
 * dataset, at most two sandboxes run at once, and every run is stopped after
 * QUERY_LIMITS.timeoutMs.
 */
export const runQuery = async (
  query: { code: string; language: QueryLanguage; tables: Tables },
  signal?: AbortSignal
): Promise<QueryResponse> => {
  if (query.code.length > QUERY_LIMITS.codeLength) {
    return failure("", "The query is too long.");
  }
  const key = `${query.language}\u0000${datasetId(query.tables)}\u0000${query.code}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  await acquireSlot();
  try {
    if (signal?.aborted) {
      return failure("", "Cancelled.");
    }
    const response = await execute(query, signal);
    if (!signal?.aborted) {
      remember(key, response);
    }
    return response;
  } catch (error) {
    return failure(
      "",
      error instanceof Error ? error.message : "Query failed."
    );
  } finally {
    releaseSlot();
  }
};
