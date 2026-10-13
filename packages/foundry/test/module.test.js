import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLegendKeeperJournal, importIntoWorld, localPageUpdate, paragraphSaveUpdate, saveParagraph, shareJournal } from "../module/client.mjs";
import { decodeSourcePayload, encodeSourceAttribute, preparePageContext, sheetMode } from "../module/context.mjs";
import { planRunEdit } from "../module/domain/editor.mjs";
import { visualFidelityCheck } from "../module/domain/fidelity.mjs";
import { PAGE_TYPE, buildFoundryJournal } from "../module/domain/journal.mjs";
import { linkMentions } from "../module/domain/mentions.mjs";
import { renderPage } from "../module/domain/render.mjs";
import { updatesSafeToApply } from "../module/domain/reconcile.mjs";
import { applyPolledPageUpdates, clampPollInterval, currentSyncStatus, noteSyncStatus, performReview, renderReviewPanel, renderSyncStatus, startAutomaticSync } from "../module/review.mjs";
import { runSetup, setupForm } from "../module/setup.mjs";
import { captureTypedDraft, commitParagraphSave } from "../module/sheets.mjs";
import { createMemoryLegendKeeper } from "../../service/src/memory-lk.js";
import { createApp, listen } from "../../service/src/server.js";
import { openStore } from "../../service/src/store.js";
import { safeImageUrl, safeLink } from "../module/domain/urls.mjs";
import { openOfflineQueue } from "../module/queue.mjs";

const root = new URL("../../../", import.meta.url);
const realFetch = globalThis.fetch;

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
  assert.equal(envelope.persist.pages[0].sort, 100000);
  assert.equal(envelope.persist.systemPresentation, undefined);
  assert.equal(envelope.persist.pages[0].system.banner, null);
  assert.deepEqual(envelope.persist.pages[0].system.properties, []);
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
  const content = [
    { text: "The temple", bold: true },
    { mention: { resourceId: "r-other", text: "Tython" } },
    { text: "archive", link: "lk:document/archive" }
  ];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.blockId, "p1");
    assert.equal(body.content[0].bold, true);
    assert.equal(body.content[1].mention.resourceId, "r-other");
    assert.equal(body.content[2].link, "lk:document/archive");
    assert.equal(body.blocks, undefined);
    return {
      ok: true,
      json: async () => ({ state: "failed", error: "Version mismatch", code: "VERSION_MISMATCH", retained: body.content })
    };
  };
  const result = await saveParagraph("http://127.0.0.1:8787", "token", {
    resourceId: "r1",
    documentId: "d1",
    baseVersion: "v1",
    blockId: "p1",
    content
  });
  assert.equal(result.syncState, "failed");
  assert.equal(result.syncError, "Version mismatch");
  assert.equal(result.retained[0].text, "The temple");
  assert.equal(result.retained[0].bold, true);
  assert.equal(result.operations[0].blockId, "p1");
  assert.equal(result.operations[0].op, "update");
  const system = paragraphSaveUpdate({
    lkDocumentId: "d1",
    version: "v1",
    blocks: [{ id: "p1", kind: "paragraph", content }]
  }, "p1", result);
  assert.equal(system.version, "v1");
  assert.equal(system.blocks[0].content[0].text, "The temple");
  assert.equal(system.draft.content[2].text, "archive");
  const stored = localPageUpdate({ lkDocumentId: "d1", blocks: [] }, [
    { id: "p1", kind: "paragraph", content },
    { id: "sec", kind: "secret", children: [{ id: "s", kind: "paragraph", content: [{ text: "gm eyes only" }] }] }
  ]);
  assert.equal(JSON.stringify(stored).includes("gm eyes only"), false);
});

test("the run editor changes one run and keeps marks, mentions, links, and breaks", () => {
  const blocks = [{
    id: "p1",
    kind: "paragraph",
    content: [
      { text: "The temple", bold: true },
      { text: " of " },
      { mention: { resourceId: "r1", text: "Tython" } },
      { text: "archive", link: "https://legendkeeper.test/temple", italic: true },
      { break: true },
      { text: "was abandoned." }
    ]
  }];
  const plan = planRunEdit(blocks, "p1", ["The temple", " of ", "Tython", "archive", undefined, "was destroyed."]);
  assert.equal(plan.content[0].bold, true);
  assert.equal(plan.content[0].text, "The temple");
  assert.equal(plan.content[2].mention.resourceId, "r1");
  assert.equal(plan.content[2].mention.text, "Tython");
  assert.equal(plan.content[3].link, "https://legendkeeper.test/temple");
  assert.equal(plan.content[3].italic, true);
  assert.equal(plan.content[4].break, true);
  assert.equal(plan.content[5].text, "was destroyed.");
  assert.equal(plan.operations[0].op, "update");
  const context = preparePageContext({
    blocks,
    draft: { blockId: "p1", content: plan.content },
    syncState: "failed",
    syncError: "Still here"
  }, { mode: "gm", editable: true });
  assert.equal(context.runs[5].text, "was destroyed.");
  assert.equal(context.runs[0].marks, "bold");
  assert.equal(context.runs[2].mentionId, "r1");
  assert.equal(context.runs[3].link, "https://legendkeeper.test/temple");
  assert.equal(context.runs[4].locked, true);
  assert.equal(context.syncState, "failed");
  const template = readFileSync(new URL("packages/foundry/templates/page.hbs", root), "utf8");
  assert.equal(template.includes("contenteditable"), false);
  assert.equal(template.includes("textarea"), false);
  assert.match(template, /data-action="saveParagraph"/);
  assert.match(template, /data-run-index/);
  assert.match(template, /value="\{\{sourceRuns\}\}"/);
  assert.equal(template.includes("{{{sourceRuns}}}"), false);
  assert.equal(sheetMode({ isGM: false, token: "token" }), false);
  assert.equal(sheetMode({ isGM: true, token: "" }), false);
  assert.equal(sheetMode({ isGM: true, token: "token" }), true);
});

test("links allow http, https, mailto, and lk, and images require https", () => {
  assert.equal(safeLink("https://legendkeeper.test/a"), "https://legendkeeper.test/a");
  assert.equal(safeLink("http://legendkeeper.test/a"), "http://legendkeeper.test/a");
  assert.equal(safeLink("mailto:gm@example.com"), "mailto:gm@example.com");
  assert.equal(safeLink("lk:document/archive"), "lk:document/archive");
  assert.equal(safeLink("javascript:alert(1)"), "");
  assert.equal(safeLink("data:text/html,hi"), "");
  assert.equal(safeLink("blob:https://legendkeeper.test/id"), "");
  assert.equal(safeImageUrl("https://assets.legendkeeper.test/a.png"), "https://assets.legendkeeper.test/a.png");
  assert.equal(safeImageUrl("http://assets.legendkeeper.test/a.png"), "");
  assert.equal(safeImageUrl("javascript:alert(1)"), "");
  const html = renderPage(
    { banner: { url: "javascript:alert(1)" } },
    [
      { id: "p", kind: "paragraph", content: [{ text: "go", link: "lk:document/archive" }, { text: "bad", link: "javascript:alert(1)" }] },
      { id: "img", kind: "image", url: "http://assets.legendkeeper.test/a.png", alt: "nope" }
    ]
  );
  assert.match(html, /href="lk:document\/archive"/);
  assert.equal(html.includes("javascript:"), false);
  assert.equal(html.includes("http://assets"), false);
  assert.match(html, /Image omitted/);
  assert.equal(html.includes("lk-banner"), false);
});

function editorRoot({ source, texts, baseVersion = "v-rendered", blockId = "p1" }) {
  const fieldset = {
    dataset: { blockId, baseVersion, resourceId: "r1", documentId: "d1" },
    querySelector(selector) {
      if (selector === 'input[name="sourceRuns"]') return { value: source };
      return null;
    },
    querySelectorAll() {
      return texts.map((value, index) => ({ dataset: { runIndex: String(index) }, value }));
    }
  };
  return {
    querySelector(selector) {
      if (selector === ".lk-runs[data-block-id]") return fieldset;
      if (selector === "[data-block-id]") return { dataset: { blockId: "heading" } };
      return null;
    },
    querySelectorAll() {
      return [{ dataset: { runIndex: "0" }, value: "from-heading" }];
    }
  };
}

test("sheet save uses the rendered paragraph, rejects a bad source, and keeps typed text", async () => {
  const content = [{ text: "Old", bold: true }, { text: "tail" }];
  const encoded = encodeSourceAttribute({ id: "p1", content });
  assert.match(encoded, /&quot;/);
  assert.equal(encoded.includes("<script"), false);
  const decoded = decodeSourcePayload(encoded);
  assert.equal(decoded.id, "p1");
  assert.equal(decoded.content[0].bold, true);
  assert.throws(() => decodeSourcePayload('{"id":"p1"'), (error) => error.code === "INVALID_SOURCE");
  assert.throws(() => decodeSourcePayload(JSON.stringify({ id: "h1", kind: "heading", content: [{ text: "Title" }] })), (error) => error.code === "INVALID_SOURCE");

  const quoted = encodeSourceAttribute({ id: "p1", content: [{ text: 'say "hello" & <b>' }] });
  assert.match(quoted, /&quot;/);
  assert.match(quoted, /&amp;/);
  assert.match(quoted, /&lt;/);
  assert.equal(decodeSourcePayload(quoted).content[0].text, 'say "hello" & <b>');

  const root = editorRoot({ source: encoded, texts: ["New", "tail"] });
  let sent;
  const outcome = await commitParagraphSave({
    system: {
      lkResourceId: "r-document",
      lkDocumentId: "d-document",
      version: "v-document",
      blocks: [
        { id: "heading", kind: "heading", content: [{ text: "Title" }] },
        { id: "p1", kind: "paragraph", content }
      ]
    },
    root,
    serviceUrl: "http://127.0.0.1:8787",
    token: "token",
    isGM: true,
    save: async (_url, _token, body) => {
      sent = body;
      return { syncState: "failed", syncError: "Version mismatch", retained: body.content, operations: [{ op: "update", blockId: body.blockId }], version: "v-document" };
    }
  });
  assert.equal(sent.blockId, "p1");
  assert.equal(sent.baseVersion, "v-rendered");
  assert.equal(sent.resourceId, "r1");
  assert.equal(sent.documentId, "d1");
  assert.equal(sent.content[0].text, "New");
  assert.equal(sent.content[0].bold, true);
  assert.equal(sent.content[1].text, "tail");
  assert.equal(outcome.system.version, "v-document");
  assert.equal(outcome.system.blocks[0].content[0].text, "Title");
  assert.equal(outcome.system.blocks[1].content[0].text, "Old");
  assert.equal(outcome.system.draft.baseVersion, "v-rendered");
  assert.equal(outcome.system.draft.blockId, "p1");
  assert.equal(outcome.system.draft.content[0].text, "New");

  const typedRoot = editorRoot({ source: JSON.stringify({ id: "p1", kind: "paragraph", content }), texts: ["Typed", "tail"] });
  const typed = captureTypedDraft(typedRoot);
  assert.equal(typed.blockId, "p1");
  assert.equal(typed.baseVersion, "v-rendered");
  assert.equal(typed.content[0].text, "Typed");
  assert.equal(typed.content[0].bold, true);
  const again = preparePageContext({
    version: "v-document",
    blocks: [
      { id: "heading", kind: "heading", content: [{ text: "Title" }] },
      { id: "p1", kind: "paragraph", content }
    ],
    draft: typed
  }, { mode: "gm", editable: true });
  assert.equal(again.editBlockId, "p1");
  assert.equal(again.baseVersion, "v-rendered");
  assert.equal(again.runs[0].text, "Typed");
  assert.equal(again.runs[1].text, "tail");

  const broken = editorRoot({ source: '{"id":"p1"', texts: ["New"] });
  await assert.rejects(() => commitParagraphSave({
    system: { version: "v-document", blocks: [] },
    root: broken,
    serviceUrl: "http://127.0.0.1:8787",
    token: "token",
    isGM: true
  }), (error) => error.code === "INVALID_SOURCE");
  const mismatched = editorRoot({
    source: JSON.stringify({ id: "other", kind: "paragraph", content: [{ text: "Old" }] }),
    texts: ["New"]
  });
  await assert.rejects(() => commitParagraphSave({
    system: { version: "v-document", blocks: [] },
    root: mismatched,
    serviceUrl: "http://127.0.0.1:8787",
    token: "token",
    isGM: true
  }), (error) => error.code === "INVALID_SOURCE");
  await assert.rejects(() => commitParagraphSave({
    system: { blocks: [] },
    root,
    serviceUrl: "http://127.0.0.1:8787",
    token: "token",
    isGM: false
  }), /GM/);
});

test("setup pairs a GM, imports, and registers Foundry uuids", async () => {
  assert.match(setupForm({ serviceUrl: "http://127.0.0.1:8787", paired: false }), /Pairing code/);
  await assert.rejects(() => runSetup("test", { isGM: false }, {}), /GM/);
  const tested = await runSetup("test", { isGM: true, serviceUrl: "http://127.0.0.1:8787" }, {
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) })
  });
  assert.equal(tested.ok, true);
  let stored = "";
  const paired = await runSetup("pair", { isGM: true, serviceUrl: "http://127.0.0.1:8787", pairingCode: "code", clientId: "gm-1" }, {
    pair: async () => "token-1",
    saveToken: async (token) => {
      stored = token;
    }
  });
  assert.equal(paired.paired, true);
  assert.equal(stored, "token-1");

  const envelope = buildFoundryJournal({
    id: "r-a",
    name: "A",
    documents: [{ id: "doc1", name: "Overview", type: "page", rank: "a0", blocks: [{ id: "p", kind: "paragraph", content: [{ mention: { resourceId: "r-b", text: "B" } }] }] }]
  }, [{ id: "doc1", name: "Overview", type: "page", rank: "a0" }], new Map([["doc1", { version: "v1", blocks: [{ id: "p", kind: "paragraph", content: [{ mention: { resourceId: "r-b", text: "B" } }] }] }]]));
  const other = buildFoundryJournal({
    id: "r-b",
    name: "B",
    documents: [{ id: "doc2", name: "B", type: "page", rank: "a0", blocks: [] }]
  }, [{ id: "doc2", name: "B", type: "page", rank: "a0" }], new Map([["doc2", { version: "v1", blocks: [] }]]));
  const mapped = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/v1/import")) return { ok: true, json: async () => ({ journals: [envelope, other] }) };
    if (String(url).endsWith("/v1/mappings")) {
      mapped.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "no" }) };
  };
  let created;
  try {
    created = await importIntoWorld({
      async createJournal(data) {
        return {
          uuid: `JournalEntry.${data.flags.legendkeeper.resourceId}`,
          pages: data.pages.map((page) => ({
            id: page.system.lkDocumentId,
            uuid: `JournalEntryPage.${page.system.lkDocumentId}`,
            system: page.system
          }))
        };
      },
      async updatePages(journal, pages) {
        journal.pages = pages;
      }
    }, "http://127.0.0.1:8787", "token");
    assert.equal(created[0].pages[0].system.blocks[0].content[0].mention.foundryUuid, "JournalEntry.r-b");
    assert.equal(mapped[0].foundryUuid, "JournalEntry.r-a");
    assert.equal(mapped[0].pages[0].foundryUuid, "JournalEntryPage.doc1");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("automatic sync stays off and review covers same-block conflicts", async () => {
  const main = readFileSync(new URL("packages/foundry/module/main.mjs", root), "utf8");
  const lang = JSON.parse(readFileSync(new URL("packages/foundry/lang/en.json", root), "utf8"));
  const journal = readFileSync(new URL("packages/foundry/templates/journal.hbs", root), "utf8");
  assert.match(main, /liveProofAccepted/);
  assert.match(main, /acquireLeader/);
  assert.match(main, /pollIntervalSeconds/);
  assert.match(main, /pendingResourceId/);
  assert.match(main, /default: false/);
  assert.equal(main.includes("setInterval"), false);
  assert.match(lang["LEGENDKEEPER.LiveProofHint"], /live-api/);
  assert.match(lang["LEGENDKEEPER.LiveProofHint"], /live-foundry/);
  assert.match(journal, /\{\{\{syncStatus\}\}\}/);
  assert.equal(clampPollInterval(15_000), 60_000);
  assert.equal(clampPollInterval(90_000), 90_000);
  assert.equal(clampPollInterval(180_000), 120_000);
  assert.equal(clampPollInterval("nope"), 90_000);
  const idle = startAutomaticSync({ automaticSync: false, liveProofAccepted: false, poll: () => {}, acquireLeader: async () => ({ acquired: true }) });
  assert.equal(idle.started, false);
  const blocked = startAutomaticSync({ automaticSync: true, liveProofAccepted: false, poll: () => {}, acquireLeader: async () => ({ acquired: true }) });
  assert.equal(blocked.started, false);
  const unled = startAutomaticSync({ automaticSync: true, liveProofAccepted: true, poll: async () => {} });
  assert.equal(unled.started, false);
  const calls = [];
  let releasePoll;
  const pollGate = new Promise((resolve) => {
    releasePoll = resolve;
  });
  const started = startAutomaticSync({
    automaticSync: true,
    liveProofAccepted: true,
    intervalMs: 15_000,
    acquireLeader: async (ttlMs) => {
      calls.push(["acquire", ttlMs]);
      return { acquired: true };
    },
    poll: async () => {
      calls.push(["poll"]);
      await pollGate;
    }
  });
  assert.equal(started.started, true);
  assert.equal(started.interval, 60_000);
  const first = started.tick();
  const skipped = await started.tick();
  assert.equal(skipped.skipped, true);
  assert.deepEqual(calls, [["acquire", 120_000], ["poll"]]);
  releasePoll();
  assert.equal((await first).state, "synced");
  started.stop();

  noteSyncStatus({ state: "", error: "" });
  const held = startAutomaticSync({
    automaticSync: true,
    liveProofAccepted: true,
    acquireLeader: async () => ({ acquired: false }),
    poll: async () => {
      throw new Error("polled while another GM holds the lease");
    }
  });
  assert.equal((await held.tick()).state, "held");
  assert.equal(currentSyncStatus().state, "held");
  assert.match(renderSyncStatus(), /data-state="held"/);
  assert.match(renderSyncStatus(), /Another GM is synchronizing/);
  held.stop();

  const refused = startAutomaticSync({
    automaticSync: true,
    liveProofAccepted: true,
    acquireLeader: async () => {
      const error = new Error("An authorized synchronization leader is required");
      error.code = "NOT_LEADER";
      throw error;
    },
    poll: async () => {
      throw new Error("polled");
    }
  });
  assert.equal((await refused.tick()).state, "held");
  refused.stop();

  const failed = startAutomaticSync({
    automaticSync: true,
    liveProofAccepted: true,
    acquireLeader: async () => ({ acquired: true }),
    poll: async () => {
      throw new Error("service unreachable");
    }
  });
  assert.equal((await failed.tick()).state, "failed");
  assert.match(renderSyncStatus(), /data-state="failed"/);
  assert.match(renderSyncStatus(), /service unreachable/);
  failed.stop();
  const reviewCalls = [];
  await performReview("keepFoundry", { conflictId: "4", isGM: true, token: "token" }, {
    resolveConflict: async (id, body) => {
      reviewCalls.push({ id, body });
    }
  });
  assert.deepEqual(reviewCalls, [{ id: "4", body: { choice: "foundry" } }]);
  await assert.rejects(() => performReview("approveDeletion", { deletionId: "9", isGM: false, token: "token" }, {}), /GM/);
  const applied = await applyPolledPageUpdates(
    [
      { system: { lkDocumentId: "d1", banner: { url: "https://assets.legendkeeper.test/a.png" }, draft: { blockId: "p1" }, blocks: [] } },
      { system: { lkDocumentId: "d2", banner: { url: "https://assets.legendkeeper.test/b.png" }, blocks: [] } }
    ],
    [
      { documentId: "d1", system: { blocks: [{ id: "x", kind: "paragraph" }], version: "v2" } },
      { documentId: "d2", system: { blocks: [{ id: "y", kind: "paragraph" }], version: "v3" } }
    ],
    async (page, system) => {
      page.system = system;
    }
  );
  assert.deepEqual(applied, ["d2"]);
  const html = renderReviewPanel({
    conflicts: [{ id: 4, state: "open", blockId: "p1", legendkeeper: { content: [{ text: "remote" }] }, foundry: { content: [{ text: "draft" }] } }],
    deletions: [{ id: 9, state: "pending", targetType: "resource", resourceId: "r1" }]
  });
  assert.match(html, /Same-block conflicts/);
  assert.match(html, /Keep Foundry/);
  assert.match(html, /Deletions awaiting review/);
  const fidelity = visualFidelityCheck(`<p data-block-id="p1"></p>`, `<p data-block-id="p1"></p>`);
  assert.equal(fidelity.visualSignOff, false);
  assert.equal(fidelity.sameBlockIds, true);
  assert.match(fidelity.note, /not a visual sign-off/);
  const applicable = updatesSafeToApply(
    [{ system: { lkDocumentId: "d1", draft: { blockId: "p1" } } }, { system: { lkDocumentId: "d2" } }],
    [{ documentId: "d1" }, { documentId: "d2" }]
  );
  assert.deepEqual(applicable.map((item) => item.documentId), ["d2"]);
});

async function pairedCreateService() {
  const lk = createMemoryLegendKeeper();
  const store = openStore(":memory:");
  const app = createApp({ lk, store, pairingCode: "pair-once", allowedOrigins: [] });
  const listener = await listen(app);
  const response = await fetch(`${listener.url}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-legendkeeper-request": "1" },
    body: JSON.stringify({ pairingCode: "pair-once", clientId: "gm-1" })
  });
  const body = await response.json();
  return { lk, store, url: listener.url, token: body.token, close: listener.close };
}

function fakeWorld() {
  const journals = new Map();
  let creates = 0;
  return {
    journals,
    get creates() {
      return creates;
    },
    async findJournal(resourceId) {
      return journals.get(resourceId) ?? null;
    },
    async createJournal(data) {
      creates += 1;
      const resourceId = data.flags.legendkeeper.resourceId;
      const doc = {
        uuid: `JournalEntry.${resourceId}`,
        pages: data.pages.map((page) => ({
          id: page.system.lkDocumentId,
          uuid: `JournalEntryPage.${page.system.lkDocumentId}`,
          system: page.system
        }))
      };
      journals.set(resourceId, doc);
      return doc;
    }
  };
}

test("a failed Foundry create or mapping retries the same LegendKeeper journal", async () => {
  const server = await pairedCreateService();
  try {
    const createId = "r-client000000000000000";
    const createWorld = fakeWorld();
    const originalCreate = createWorld.createJournal.bind(createWorld);
    let failCreate = true;
    createWorld.createJournal = async (data) => {
      if (failCreate) {
        failCreate = false;
        const error = new Error("Foundry journal was not created");
        throw error;
      }
      return originalCreate(data);
    };
    await assert.rejects(() => createLegendKeeperJournal(createWorld, server.url, server.token, { name: "Retry", id: createId }), /not created/);
    assert.equal(server.lk.calls.createResource, 1);
    const created = await createLegendKeeperJournal(createWorld, server.url, server.token, { name: "Retry", id: createId });
    assert.equal(server.lk.calls.createResource, 1);
    assert.equal(createWorld.creates, 1);
    assert.equal(created.uuid, `JournalEntry.${createId}`);
    assert.equal(server.store.getResource(createId).foundryUuid, `JournalEntry.${createId}`);
    const createPageId = [...createWorld.journals.values()][0].pages[0].system.lkDocumentId;
    assert.equal(server.store.getDocument(createId, createPageId).foundryUuid, `JournalEntryPage.${createPageId}`);

    const mapId = "r-client200000000000000";
    const mapWorld = fakeWorld();
    let failMapping = true;
    const bodies = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith("/v1/mappings") && failMapping) {
        failMapping = false;
        return { ok: false, status: 500, statusText: "fail", json: async () => ({ error: "mapping failed", code: "ERROR" }) };
      }
      if (String(url).endsWith("/v1/mappings")) bodies.push(JSON.parse(options.body));
      return realFetch(url, options);
    };
    await assert.rejects(() => createLegendKeeperJournal(mapWorld, server.url, server.token, { name: "Mapped", id: mapId }), /mapping failed/);
    assert.equal(server.lk.calls.createResource, 2);
    assert.equal(mapWorld.creates, 1);
    const mapped = await createLegendKeeperJournal(mapWorld, server.url, server.token, { name: "Mapped", id: mapId });
    assert.equal(server.lk.calls.createResource, 2);
    assert.equal(mapWorld.creates, 1);
    assert.equal(mapped.uuid, `JournalEntry.${mapId}`);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].resourceId, mapId);
    assert.equal(bodies[0].foundryUuid, `JournalEntry.${mapId}`);
    assert.equal(bodies[0].pages.length, 1);
    assert.equal(bodies[0].pages[0].foundryUuid, `JournalEntryPage.${bodies[0].pages[0].documentId}`);
    assert.equal(server.store.getResource(mapId).foundryUuid, bodies[0].foundryUuid);
    assert.equal(server.store.getDocument(mapId, bodies[0].pages[0].documentId).foundryUuid, bodies[0].pages[0].foundryUuid);
  } finally {
    globalThis.fetch = realFetch;
    server.store.close();
    await server.close();
  }
});
