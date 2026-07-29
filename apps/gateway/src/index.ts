import { createApp } from "./app";
import { Store } from "./store";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const accessKey = process.env.TOKTRACKER_API_KEY;
if (hostname !== "127.0.0.1" && hostname !== "localhost" && !accessKey) {
  throw new Error(
    "TOKTRACKER_API_KEY is required when exposing the gateway beyond localhost"
  );
}
const app = createApp(new Store(), accessKey);
export default { fetch: app.fetch, hostname, port };
console.log(`TokTracker gateway listening on http://${hostname}:${port}`);
