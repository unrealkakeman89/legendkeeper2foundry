import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openStore } from "./store.js";
import { createSdkPort } from "./sdk-lk.js";
import { createApp, listen } from "./server.js";

const node = process.versions.node;
if (!node.startsWith("22.14.")) {
  console.error(`LegendKeeper companion service expects Node 22.14.x. This process is ${node}.`);
  process.exit(1);
}

const apiKey = process.env.LEGENDKEEPER_API_KEY;
if (!apiKey) {
  console.error("Set LEGENDKEEPER_API_KEY to an Admin project key. The key stays in this process.");
  process.exit(1);
}

const dataDir = resolve(process.env.LEGENDKEEPER_DATA_DIR ?? "data");
mkdirSync(dataDir, { recursive: true });
const pairingPath = resolve(dataDir, "pairing-code.txt");
let pairingCode = process.env.LEGENDKEEPER_PAIRING_CODE ?? "";
if (!pairingCode) {
  if (existsSync(pairingPath)) {
    console.error(`Set LEGENDKEEPER_PAIRING_CODE or remove ${pairingPath} is not read automatically. Generate a code and pass it in the environment.`);
    process.exit(1);
  }
  pairingCode = randomBytes(24).toString("hex");
  writeFileSync(pairingPath, `${pairingCode}\n`, { mode: 0o600 });
  console.log(`Pairing code written to ${pairingPath}. Enter it once in Foundry. It is not a LegendKeeper API key.`);
}

const host = process.env.LEGENDKEEPER_HOST ?? "127.0.0.1";
const port = Number(process.env.LEGENDKEEPER_PORT ?? 8787);
const allowedOrigins = (process.env.LEGENDKEEPER_ALLOWED_ORIGINS ?? "http://127.0.0.1:30000,http://localhost:30000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const store = openStore(resolve(dataDir, "sync.sqlite"));
const lk = createSdkPort(apiKey);
const { createEngine } = await import("./engine.js");
const recovered = await createEngine({ lk, store }).recover();
const app = createApp({ lk, store, pairingCode, allowedOrigins });
if (recovered.length > 0) console.log(`Recovered ${recovered.length} interrupted operation(s).`);
const listener = await listen(app, { host, port });
console.log(`LegendKeeper sync service listening on ${listener.url}`);
console.log("Loopback is reachable only from a browser on this computer. A remote GM browser needs LEGENDKEEPER_HOST behind authenticated HTTPS and LEGENDKEEPER_ALLOWED_ORIGINS.");
