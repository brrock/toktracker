// Computes dashboard summaries off the gateway's request thread. The worker
// opens its own read-only connection; SQLite WAL mode lets it read while the
// main thread keeps ingesting.
import { Store } from "./store";
import type { SummaryWorkerRequest, SummaryWorkerResponse } from "./store";

declare const self: Worker;

const stores = new Map<string, Store>();

const storeFor = (databasePath: string): Store => {
  const existing = stores.get(databasePath);
  if (existing) {
    return existing;
  }
  const store = new Store(databasePath, false);
  stores.set(databasePath, store);
  return store;
};

self.addEventListener(
  "message",
  (event: MessageEvent<SummaryWorkerRequest>) => {
    const { databasePath, id, task } = event.data;
    let response: SummaryWorkerResponse;
    try {
      const store = storeFor(databasePath);
      response = {
        id,
        result:
          task.kind === "summary"
            ? store.computeSummary(...task.args)
            : store.sessionSummaries(),
      };
    } catch (error) {
      response = {
        error: error instanceof Error ? error.message : String(error),
        id,
      };
    }
    // Worker postMessage has no target origin.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    self.postMessage(response);
  }
);
