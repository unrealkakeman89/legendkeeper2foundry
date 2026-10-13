import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { localPageUpdate, saveParagraph, shareJournal } from "../module/client.mjs";
import { preparePageContext } from "../module/context.mjs";
import { PAGE_TYPE, buildFoundryJournal } from "../module/domain/journal.mjs";
import { linkMentions } from "../module/domain/mentions.mjs";
import { renderPage } from "../module/domain/render.mjs";
import { openOfflineQueue } from "../module/queue.mjs";

const root = new URL("../../../", import.meta.url);

test("module manifest is Foundry V14, system-independent, and has no socket channel", () => {
  const manifest = JSON.parse(readFileSync(new URL("packages/foundry/module.json", root), "utf8"));
  assert.equal(manifest.id, "legendkeeper");
  assert.equal(manifest.compatibility.minimum, "14");
  assert.equal(manifest.compatibility.verified, "14");
  assert.equal(manifest.socket, false);
  assert.equal(manifest.relationships, undefined);
  assert.deepEqual(Object.keys(manifest.documentTypes.JournalEntryPage), ["page"]);
  const engines = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).engines.node;
  assert.equal(engines, "22.14.0");
  assert.equal(readFileSync(new URL(".nvmrc", root), "utf8").trim(), "22.14.0");
  assert.equal(process.versions.node.startsWith("22.14."), true);
  const main = readFileSync(new URL("packages/foundry/module/main.mjs", root), "utf8");
  const client = readFileSync(new URL("packages/foundry/module/client.mjs", root), "utf8");
  assert.equal(main.includes("socket.emit"), false);
  assert.equal(main.includes("game.socket"), false);
  assert.match(client, /http:\/\/127\.0\.0\.1:8787/);
  assert.match(readFileSync(new URL("docs/connectivity.md", root), "utf8"), /authenticated HTTPS/);
  const model = readFileSync(new URL("packages/foundry/module/model.mjs", root), "utf8");
  assert.equal(model.includes("apiKey"), false);
  assert.equal(model.includes("HTMLField"), false);
});

test("supported blocks render with layout, and players do not receive secrets", () => {
  const blocks = [
    { id: "h", kind: "heading", level: 2, content: [{ text: "History" }] },
    { id: "p", kind: "paragraph", content: [{ text: "See " }, { mention: { resourceId: "r1", text: "Tython", foundryUuid: "JournalEntry.tython" } }, { text: " <script>" }] },
    { id: "img", kind: "image", url: "https://assets.legendkeeper.test/temple.png", alt: "Temple", layout: "wrapRight", width: 40, fill: true },
    { id: "cols", kind: "layout", children: [{ id: "c1", kind: "layoutColumn", width: 50, children: [{ id: "cp", kind: "paragraph", content: [{ text: "Left" }] }] }, { id: "c2", kind: "layoutColumn", width: 50, children: [{ id: "cq", kind: "paragraph", content: [{ text: "Right" }] }] }] },
    { id: "box", kind: "infobox", layout: "wrapRight", width: 40, rows: [{ id: "kv", kind: "keyValue", title: "Facts", rows: [{ key: "Climate", text: "Temperate" }] }] },
    { id: "note", kind: "callout", tone: "warning", children: [{ id: "np", kind: "paragraph", content: [{ text: "Careful" }] }] },
    { id: "ex", kind: "expand", title: "More", children: [{ id: "ep", kind: "paragraph", content: [{ text: "Detail" }] }] },
    { id: "tasks", kind: "taskList", children: [{ id: "t1", kind: "taskItem", checked: true, content: [{ text: "Done" }] }] },
    { id: "meter", kind: "meter", mode: "bar", items: [{ name: "Hope", current: 1, max: 2 }] },
    { id: "sec", kind: "secret", children: [{ id: "sp", kind: "paragraph", content: [{ text: "hidden ritual" }] }] },
    { id: "uns", kind: "unsupported" },
    { id: "map", kind: "map" }
  ];
  const html = renderPage({
    banner: { url: "https://assets.legendkeeper.test/banner.png", yPosition: 25 },
    properties: [{ id: "side", kind: "keyValue", title: "Region", isTitleHidden: false, rows: [{ key: "Sector", text: "Deep Core" }] }]
  }, blocks, "player");
  assert.match(html, /class="lk-banner"/);
  assert.match(html, /lk-heading/);
  assert.match(html, /data-uuid="JournalEntry.tython"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-layout="wrapRight"/);
  assert.match(html, /width:40%/);
  assert.match(html, /lk-layout/);
  assert.match(html, /lk-infobox/);
  assert.match(html, /data-tone="warning"/);
  assert.match(html, /lk-expand/);
  assert.match(html, /lk-tasks/);
  assert.match(html, /lk-meter/);
  assert.match(html, /lk-sidebar/);
  assert.match(html, /Open in LegendKeeper/);
  assert.equal(html.includes("hidden ritual"), false);
  const gm = renderPage({}, blocks, "gm");
  assert.match(gm, /hidden ritual/);
  assert.match(gm, /lk-secret/);

  const context = preparePageContext({ blocks, syncState: "failed", syncError: "Version mismatch" }, { mode: "player" });
  assert.equal(context.syncLabel, "Failed");
  assert.equal(context.rendered.includes("hidden ritual"), false);
  assert.equal(context.syncError, "Version mismatch");
});

test("mention links use the journal mapping and sharing stays fail closed", () => {
  const resource = {
    id: "r-tython000000000000000",
    name: "Tython",
    isHidden: false,
    documents: [{
      id: "doc1",
      name: "Overview",
      type: "page",
      rank: "a0",
      blocks: [{ id: "p", kind: "paragraph", content: [{ mention: { resourceId: "r-other", text: "Ossus" } }] }]
    }]
  };
  const envelope = buildFoundryJournal(resource, resource.documents, new Map([
    ["doc1", { version: "v1", blocks: resource.documents[0].blocks }]
  ]));
  const linked = linkMentions(envelope.persist.pages[0].system.blocks, new Map([["r-other", "JournalEntry.ossus"]]));
  assert.equal(linked[0].content[0].mention.foundryUuid, "JournalEntry.ossus");
  assert.equal(linked[0].content[0].mention.resourceId, "r-other");
  assert.equal(envelope.persist.pages[0].type, PAGE_TYPE);
  const shared = shareJournal(envelope.persist, envelope.gmOnly);
  assert.equal(shared.ownership.default, 2);
  assert.equal(JSON.stringify(shared).includes("\"kind\":\"secret\""), false);
  const hiddenResource = buildFoundryJournal({ ...resource, isHidden: true }, resource.documents, new Map([["doc1", { version: "v1", blocks: [] }]]));
  assert.throws(() => shareJournal(hiddenResource.persist, hiddenResource.gmOnly), /hidden LegendKeeper resource/);
});

test("offline public edits survive reload in IndexedDB and keep a failed change", async () => {
  const queue = await openOfflineQueue();
  const change = { blockId: "p1", text: "The temple was destroyed." };
  await queue.enqueue({ id: "op-1", change });
  await queue.mark("op-1", "failed", "LegendKeeper rejected the write");
  queue.close();
  const reloaded = await openOfflineQueue();
  const [record] = await reloaded.list();
  assert.equal(record.state, "failed");
  assert.equal(record.change.text, "The temple was destroyed.");
  assert.match(record.error, /rejected/);
  await reloaded.mark("op-1", "synced");
  const states = ["pending", "synced", "failed"];
  assert.ok(states.includes((await reloaded.list())[0].state));
  reloaded.close();
});

test("a rejected paragraph edit stays in the editor result", async () => {
  const baseline = [{ id: "p1", kind: "paragraph", content: [{ text: "Old" }] }];
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ state: "failed", error: "Version mismatch", retained: [{ id: "p1", kind: "paragraph", content: [{ text: "New" }] }] })
  });
  const result = await saveParagraph("http://127.0.0.1:8787", "token", {
    resourceId: "r1",
    documentId: "d1",
    baseVersion: "v1",
    baseline,
    blockId: "p1",
    text: "New"
  });
  assert.equal(result.syncState, "failed");
  assert.equal(result.syncError, "Version mismatch");
  assert.equal(result.retained[0].content[0].text, "New");
  assert.equal(result.operations[0].blockId, "p1");
  assert.equal(result.operations[0].op, "update");
  const stored = localPageUpdate({ lkDocumentId: "d1", blocks: [] }, [
    { id: "p1", kind: "paragraph", content: [{ text: "New" }] },
    { id: "sec", kind: "secret", children: [{ id: "s", kind: "paragraph", content: [{ text: "gm eyes only" }] }] }
  ]);
  assert.equal(JSON.stringify(stored).includes("gm eyes only"), false);
});
