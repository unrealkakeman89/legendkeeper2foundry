import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryLegendKeeper } from "../src/memory-lk.js";
import { createApp, listen } from "../src/server.js";
import { openStore } from "../src/store.js";

async function start() {
  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-server000000000000000",
    name: "Server",
    updatedAt: "2026-10-13T00:00:00.000Z",
    documents: [
      { id: "doc1", name: "Main", type: "page", rank: "a1", blocks: [{ id: "p1", kind: "paragraph", content: [{ text: "Hello" }] }, { id: "sec", kind: "secret", children: [{ id: "s1", kind: "paragraph", content: [{ text: "gm eyes only" }] }] }] },
      { id: "doc-hidden", name: "GM only stash", type: "page", rank: "a0", isHidden: true, blocks: [{ id: "hid", kind: "paragraph", content: [{ text: "stash body" }] }] }
    ]
  });
  const store = openStore(":memory:");
  const app = createApp({
    lk,
    store,
    pairingCode: "pair-once",
    allowedOrigins: ["http://foundry.example"]
  });
  const listener = await listen(app);
  return { lk, store, app, ...listener };
}

async function pair(url) {
  const response = await fetch(`${url}/v1/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-legendkeeper-request": "1",
      origin: "http://foundry.example"
    },
    body: JSON.stringify({ pairingCode: "pair-once", clientId: "gm-1" })
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  return body.token;
}

test("service authentication does not trust isGM, CORS, or a missing token", async () => {
  const server = await start();
  try {
    const health = await fetch(`${server.url}/health`);
    assert.equal((await health.json()).ok, true);

    const crossSite = await fetch(`${server.url}/v1/import`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://foundry.example" },
      body: JSON.stringify({ isGM: true })
    });
    assert.equal(crossSite.status, 403);

    const spoofed = await fetch(`${server.url}/v1/import`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-legendkeeper-request": "1" },
      body: JSON.stringify({ isGM: true })
    });
    assert.equal(spoofed.status, 401);

    const foreignOrigin = await fetch(`${server.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-legendkeeper-request": "1", origin: "http://evil.example" },
      body: JSON.stringify({ pairingCode: "pair-once", clientId: "gm-1" })
    });
    assert.equal(foreignOrigin.status, 403);

    const token = await pair(server.url);
    const imported = await fetch(`${server.url}/v1/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-legendkeeper-request": "1" },
      body: JSON.stringify({})
    });
    assert.equal(imported.status, 200);
    const payload = await imported.json();
    assert.equal(JSON.stringify(payload.journals[0].persist).includes("gm eyes only"), false);
    assert.equal(JSON.stringify(payload.journals[0].persist).includes("GM only stash"), false);
    assert.equal(server.lk.calls.createMany, 0);
    const gmView = await fetch(`${server.url}/v1/journals/r-server000000000000000/gm`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const view = await gmView.json();
    assert.equal(view.hiddenDocuments[0].name, "GM only stash");

    const editor = await fetch(`${server.url}/v1/documents/r-server000000000000000/doc1`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const tree = await editor.json();
    assert.equal(tree.blocks[1].kind, "secret");

    const revoke = await fetch(`${server.url}/v1/tokens/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-legendkeeper-request": "1" },
      body: JSON.stringify({})
    });
    assert.equal(revoke.status, 200);
    const after = await fetch(`${server.url}/v1/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-legendkeeper-request": "1" },
      body: JSON.stringify({})
    });
    assert.equal(after.status, 401);
  } finally {
    server.store.close();
    await server.close();
  }
});
