import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sortByRank } from "../../foundry/module/domain/rank.mjs";
import { createEngine } from "../src/engine.js";
import { IDEMPOTENCY_STORE_LIMIT, createMemoryLegendKeeper } from "../src/memory-lk.js";
import { withRateLimit } from "../src/rate-limit.js";
import { openStore } from "../src/store.js";

function world(lk) {
  const directory = mkdtempSync(join(tmpdir(), "lk-sync-"));
  const store = openStore(join(directory, "sync.sqlite"));
  const engine = createEngine({ lk, store });
  return { store, engine, directory };
}

test("legacy pages require an authorized id migration before editing", async () => {
  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-legacy0000000000000000",
    name: "Legacy",
    updatedAt: "2026-10-13T00:00:00.000Z",
    documents: [{ id: "doc1", name: "Main", type: "page", rank: "a0", blocks: [{ kind: "paragraph", content: [{ text: "No id yet" }] }, { id: "keep", kind: "unsupported" }] }]
  });
  const { engine, store } = world(lk);
  await engine.importBranch();
  assert.equal(lk.calls.assignBlockIds, 0);
  const stored = store.getDocument("r-legacy0000000000000000", "doc1");
  const refused = await engine.editParagraph("r-legacy0000000000000000", "doc1", {
    baseVersion: stored.version,
    blockId: "missing",
    content: [{ text: "No id yet" }]
  });
  assert.equal(refused.state, "failed");
  assert.equal(refused.code, "NEEDS_ID_MIGRATION");
  assert.equal(refused.retained[0].text, "No id yet");
  await assert.rejects(() => engine.migrateIds("r-legacy0000000000000000", "doc1", { confirm: false }), /authorization/);
  const migrated = await engine.migrateIds("r-legacy0000000000000000", "doc1", { confirm: true });
  assert.equal(migrated.assigned, 1);
  assert.notEqual(migrated.version, stored.version);
  assert.ok(migrated.blocks[0].id);
  assert.equal(migrated.blocks[1].id, "keep");
  const saved = await engine.editParagraph("r-legacy0000000000000000", "doc1", {
    baseVersion: migrated.version,
    blockId: migrated.blocks[0].id,
    content: [{ text: "Now addressable" }]
  });
  assert.equal(saved.state, "synced");
  assert.equal(saved.operations[0].blockId, migrated.blocks[0].id);
  store.close();
});

test("overlapping edits become a conflict and the Foundry change is retained", async () => {
  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-conflict00000000000000",
    name: "Temple",
    updatedAt: "2026-10-13T00:00:00.000Z",
    documents: [{
      id: "doc1",
      name: "Overview",
      type: "page",
      rank: "a0",
      blocks: [
        { id: "p1", kind: "paragraph", content: [{ text: "The temple was abandoned." }] },
        { id: "p2", kind: "paragraph", content: [{ text: "The road remains." }] }
      ]
    }]
  });
  const { engine, store } = world(lk);
  await engine.importBranch();
  const baseline = store.getDocument("r-conflict00000000000000", "doc1");
  lk.debugSetBlocks("r-conflict00000000000000", "doc1", [
    { id: "p1", kind: "paragraph", content: [{ text: "The temple was abandoned approximately 4,000 years ago." }] },
    { id: "p2", kind: "paragraph", content: [{ text: "The road remains." }] }
  ]);
  const result = await engine.editParagraph("r-conflict00000000000000", "doc1", {
    baseVersion: baseline.version,
    blockId: "p1",
    content: [{ text: "The temple was destroyed during an ancient conflict." }]
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "VERSION_MISMATCH");
  assert.equal(result.retained[0].text, "The temple was destroyed during an ancient conflict.");
  const remote = await lk.getBlocks("r-conflict00000000000000", "doc1");
  assert.equal(remote.blocks[0].content[0].text, "The temple was abandoned approximately 4,000 years ago.");
  const held = store.getDocument("r-conflict00000000000000", "doc1");
  assert.equal(held.baseline.blocks[0].content[0].text, "The temple was abandoned.");
  assert.equal(held.draft.content[0].text.includes("destroyed"), true);
  assert.equal(held.remote.blocks[0].content[0].text.includes("4,000"), true);
  const [conflict] = store.listConflicts();
  assert.equal(conflict.legendkeeper.content[0].text.includes("4,000"), true);
  assert.equal(conflict.foundry.content[0].text.includes("destroyed"), true);
  engine.acquireLeader("gm-1", 60_000);
  const kept = await engine.resolveConflict(conflict.id, { choice: "legendkeeper", leaderClientId: "gm-1" });
  assert.equal(kept.state, "synced");
  const settled = await lk.getBlocks("r-conflict00000000000000", "doc1");
  assert.equal(settled.blocks[0].content[0].text, "The temple was abandoned approximately 4,000 years ago.");
  store.close();
});

test("a version change on a different block merges and does not open a conflict", async () => {
  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-merge00000000000000000",
    name: "Merge",
    updatedAt: "2026-10-13T00:00:00.000Z",
    documents: [{
      id: "doc1",
      name: "Overview",
      type: "page",
      rank: "a0",
      blocks: [
        { id: "p1", kind: "paragraph", content: [{ text: "The temple was abandoned." }] },
        { id: "p2", kind: "paragraph", content: [{ text: "The road remains." }] }
      ]
    }]
  });
  const { engine, store } = world(lk);
  await engine.importBranch();
  const baseline = store.getDocument("r-merge00000000000000000", "doc1");
  lk.debugSetBlocks("r-merge00000000000000000", "doc1", [
    { id: "p1", kind: "paragraph", content: [{ text: "The temple was abandoned." }] },
    { id: "p2", kind: "paragraph", content: [{ text: "The road was repaired." }] }
  ]);
  const result = await engine.editParagraph("r-merge00000000000000000", "doc1", {
    baseVersion: baseline.version,
    blockId: "p1",
    content: [{ text: "The temple was destroyed." }]
  });
  assert.equal(result.state, "synced");
  assert.equal(result.merged, true);
  assert.equal(store.listConflicts().length, 0);
  const after = await lk.getBlocks("r-merge00000000000000000", "doc1");
  assert.equal(after.blocks[0].content[0].text, "The temple was destroyed.");
  assert.equal(after.blocks[1].content[0].text, "The road was repaired.");
  const accepted = store.getDocument("r-merge00000000000000000", "doc1");
  assert.equal(accepted.draft, null);
  assert.equal(accepted.baseline.blocks[0].content[0].text, "The temple was destroyed.");
  store.close();
});

test("a remote version cannot overwrite a paragraph that changed", async () => {
  const route = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.equal(route.includes("overwrite"), false);
  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-remote0000000000000000",
    name: "Remote",
    updatedAt: "2026-10-13T00:00:00.000Z",
    documents: [{
      id: "doc1",
      name: "Overview",
      type: "page",
      rank: "a0",
      blocks: [{ id: "p1", kind: "paragraph", content: [{ text: "Old" }] }]
    }]
  });
  const { engine, store } = world(lk);
  await engine.importBranch();
  const remoteVersion = lk.debugSetBlocks("r-remote0000000000000000", "doc1", [
    { id: "p1", kind: "paragraph", content: [{ text: "Remote" }] }
  ]);
  store.setRemote("r-remote0000000000000000", "doc1", await lk.getBlocks("r-remote0000000000000000", "doc1"));
  const writes = lk.calls.updateBlock;
  const result = await engine.editParagraph("r-remote0000000000000000", "doc1", {
    baseVersion: remoteVersion,
    blockId: "p1",
    content: [{ text: "Old edit" }],
    overwrite: true
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "VERSION_MISMATCH");
  assert.equal(lk.calls.updateBlock, writes);
  const remote = await lk.getBlocks("r-remote0000000000000000", "doc1");
  assert.equal(remote.blocks[0].content[0].text, "Remote");
  const held = store.getDocument("r-remote0000000000000000", "doc1");
  assert.equal(held.baseline.blocks[0].content[0].text, "Old");
  engine.acquireLeader("gm-1", 60_000);
  const kept = await engine.resolveConflict(result.conflictId, { choice: "foundry", leaderClientId: "gm-1" });
  assert.equal(kept.state, "synced");
  const written = await lk.getBlocks("r-remote0000000000000000", "doc1");
  assert.equal(written.blocks[0].content[0].text, "Old edit");
  store.close();
});

test("timestamps do not prove the block tree is unchanged", async () => {
  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-stale00000000000000000",
    name: "Stale",
    updatedAt: "2026-10-13T00:00:00.000Z",
    documents: [{ id: "doc1", name: "Main", type: "page", rank: "a0", blocks: [{ id: "p1", kind: "paragraph", content: [{ text: "Original" }] }] }]
  });
  const { engine, store } = world(lk);
  await engine.importBranch();
  const readsAfterImport = lk.calls.getBlocks;
  lk.debugSetBlocks("r-stale00000000000000000", "doc1", [
    { id: "p1", kind: "paragraph", content: [{ text: "Changed without a new timestamp" }] }
  ], { stampResource: false });
  engine.acquireLeader("gm-1", 60_000);
  const fast = await engine.poll({ full: false, leaderClientId: "gm-1" });
  assert.equal(fast.updates.length, 0);
  assert.equal(lk.calls.getBlocks, readsAfterImport);
  const full = await engine.poll({ full: true, leaderClientId: "gm-1" });
  assert.equal(full.updates[0].system.blocks[0].content[0].text, "Changed without a new timestamp");
  assert.equal(JSON.stringify(full.updates).includes("\"kind\":\"secret\""), false);
  store.close();
});

test("only one GM client holds the synchronization lease", async () => {
  const lk = createMemoryLegendKeeper();
  const { engine, store } = world(lk);
  assert.equal(engine.acquireLeader("gm-1", 60_000).acquired, true);
  assert.equal(engine.acquireLeader("gm-2", 60_000).acquired, false);
  await assert.rejects(() => engine.poll({ leaderClientId: "gm-2" }), /leader/);
  assert.equal(engine.acquireLeader("gm-2", -1).acquired, false);
  engine.acquireLeader("gm-1", -1);
  assert.equal(engine.acquireLeader("gm-2", 60_000).acquired, true);
  store.close();
});

test("deletions wait for review and can be restored", async () => {
  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-delete0000000000000000",
    name: "Gone",
    updatedAt: "2026-10-13T00:00:00.000Z",
    documents: [{ id: "doc1", name: "Main", type: "page", rank: "a0", blocks: [{ id: "p1", kind: "paragraph", content: [{ text: "Keep" }] }] }]
  });
  const { engine, store } = world(lk);
  const queued = engine.requestDeletion({ targetType: "resource", resourceId: "r-delete0000000000000000", source: "foundry" });
  assert.equal(queued.state, "pending");
  assert.equal(lk.calls.deleteResource, 0);
  engine.acquireLeader("gm-1", 60_000);
  await engine.reviewDeletion(queued.id, "approve", { leaderClientId: "gm-1" });
  assert.equal(lk.calls.deleteResource, 1);
  await engine.restore({ resourceId: "r-delete0000000000000000" }, { leaderClientId: "gm-1" });
  assert.equal((await lk.getResource("r-delete0000000000000000")).name, "Gone");
  store.close();
});

test("a crashed create is verified by id and is not repeated when replay is unavailable", async () => {
  const lk = createMemoryLegendKeeper();
  const { engine, store } = world(lk);
  const id = "r-large00000000000000000";
  lk.crashAfterWrite = true;
  await assert.rejects(() => engine.createJournal({ name: "Large", id, padBytes: IDEMPOTENCY_STORE_LIMIT + 128 }));
  assert.equal(lk.calls.createResource, 1);
  lk.crashAfterWrite = false;
  const report = await engine.recover();
  assert.equal(report[0].state, "completed");
  assert.equal(report[0].verifiedId, id);
  assert.equal(lk.calls.createResource, 1);
  assert.equal(store.getResource(id).name, "Large");
  store.close();
});

test("bulk export uses createMany and import does not", async () => {
  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-existing00000000000000",
    name: "Existing",
    updatedAt: "2026-10-13T00:00:00.000Z",
    documents: [{ id: "doc1", name: "Main", type: "page", rank: "a0", blocks: [{ id: "p1", kind: "paragraph", content: [{ text: "Here" }] }] }]
  });
  const { engine, store } = world(lk);
  await engine.importBranch();
  assert.equal(lk.calls.createMany, 0);
  await engine.exportJournals([
    { id: "r-export1000000000000000", name: "One" },
    { id: "r-export2000000000000000", name: "Two" }
  ]);
  assert.equal(lk.calls.createMany, 1);
  const created = await engine.createJournal({ name: "Single", id: "r-single000000000000000" });
  assert.equal(lk.calls.createResource, 1);
  const again = await engine.createJournal({ name: "Single", id: "r-single000000000000000" });
  assert.equal(again.reconciled, true);
  assert.equal(lk.calls.createResource, 1);
  const documentId = again.journal.persist.pages[0].system.lkDocumentId;
  engine.registerFoundryMapping("r-single000000000000000", {
    foundryUuid: "JournalEntry.once",
    pages: [{ documentId, foundryUuid: "JournalEntryPage.once" }]
  });
  engine.registerFoundryMapping("r-single000000000000000", {
    foundryUuid: "JournalEntry.other",
    pages: [{ documentId, foundryUuid: "JournalEntryPage.other" }]
  });
  assert.equal(store.getResource("r-single000000000000000").foundryUuid, "JournalEntry.once");
  assert.equal(store.getDocument("r-single000000000000000", documentId).foundryUuid, "JournalEntryPage.once");
  assert.equal(created.journal.persist.flags.legendkeeper.resourceId, "r-single000000000000000");
  assert.equal(created.journal.persist.ownership.default, 0);
  const tab = await engine.createDocument("r-single000000000000000", { name: "History", type: "page" });
  assert.equal(tab.document.name, "History");
  assert.equal(lk.calls.createDocument, 1);
  store.close();
});

test("dropping an unsupported block fails and keeps the user's draft", async () => {
  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-uns0000000000000000000",
    name: "Keep",
    updatedAt: "2026-10-13T00:00:00.000Z",
    documents: [{ id: "doc1", name: "Main", type: "page", rank: "a0", blocks: [{ id: "p1", kind: "paragraph", content: [{ text: "Visible" }] }, { id: "uns", kind: "unsupported" }] }]
  });
  const { engine, store } = world(lk);
  await engine.importBranch();
  const stored = store.getDocument("r-uns0000000000000000000", "doc1");
  const { diffBlocks } = await import("../../foundry/module/domain/diff.mjs");
  assert.throws(() => diffBlocks(stored.baseline.blocks, [stored.baseline.blocks[0]]), /unsupported block/);
  const result = await engine.editDocument("r-uns0000000000000000000", "doc1", {
    baseVersion: stored.version,
    blocks: [stored.baseline.blocks[0]]
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "FULL_TREE_REFUSED");
  const remote = await lk.getBlocks("r-uns0000000000000000000", "doc1");
  assert.equal(remote.blocks[1].kind, "unsupported");
  store.close();
});

test("backup and schema migrations survive a reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lk-backup-"));
  const store = openStore(join(directory, "sync.sqlite"));
  assert.deepEqual(store.migrationVersions(), [1, 2, 3]);
  store.putResource({ id: "r-backup000000000000000", name: "Backup", updatedAt: "2026-10-13T00:00:00.000Z" });
  const backup = join(directory, "backup.sqlite");
  store.backup(backup);
  store.putResource({ id: "r-backup000000000000000", name: "Changed", updatedAt: "2026-10-13T00:00:00.000Z" });
  const restored = openStore(backup);
  assert.equal(restored.getResource("r-backup000000000000000").name, "Backup");
  assert.deepEqual(restored.migrationVersions(), [1, 2, 3]);
  restored.close();
  store.close();
});

test("rank order is plain string order and a 429 is remembered", async () => {
  assert.deepEqual(sortByRank([{ rank: "a10", name: "ten" }, { rank: "a2", name: "two" }, { rank: "a1", name: "one" }]).map((item) => item.name), ["one", "ten", "two"]);
  let clock = 0;
  const port = {
    async listResources() {
      const error = new Error("slow down");
      error.status = 429;
      error.code = "RATE_LIMITED";
      error.retryAfterMs = 5_000;
      throw error;
    }
  };
  const limited = withRateLimit(port, () => clock);
  await assert.rejects(() => limited.listResources(), /slow down/);
  clock = 1_000;
  await assert.rejects(() => limited.listResources(), /has not elapsed/);
});

test("startup recovery leaves a non-create operation pending instead of dropping it", async () => {
  const { engine, store } = world(createMemoryLegendKeeper());
  const id = store.beginOperation({ opKey: "edit-1", kind: "edit", payload: { kept: true } });
  const report = await engine.recover();
  assert.equal(report[0].state, "pending");
  assert.equal(store.getOperation(id).state, "pending");
  assert.equal(store.getOperation(id).payload.kept, true);
  store.close();
});
