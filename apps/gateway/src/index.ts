import {
  autoUpdateGateway,
  currentGatewayVersion,
} from "@toktracker/cli/gateway";

import { createApp } from "./app";
import { Store } from "./store";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const accessKey = process.env.TOKTRACKER_API_KEY;
const dashboardAuthRequired =
  process.env.TOKTRACKER_DISABLE_DASHBOARD_AUTH !== "1";
const isLoopbackHost =
  hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
if (!isLoopbackHost && !accessKey) {
  throw new Error(
    "TOKTRACKER_API_KEY is required when exposing the gateway beyond localhost"
  );
}
const store = new Store();
const installedVersion = await currentGatewayVersion();
store.reconcileGatewayUpdate(installedVersion);
const app = createApp(
  store,
  accessKey,
  dashboardAuthRequired,
  // Source checkouts have no installed release to update.
  installedVersion
    ? { currentVersion: currentGatewayVersion, update: autoUpdateGateway }
    : undefined
);
// Development mode serves verbose error pages with stack traces.
export default {
  development: process.env.TOKTRACKER_DEV === "1",
  fetch: app.fetch,
  hostname,
  port,
};
console.log(`TokTracker gateway listening on http://${hostname}:${port}`);
