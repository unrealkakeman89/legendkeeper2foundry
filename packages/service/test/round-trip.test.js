import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unchangedBlocksMatch } from "../../foundry/module/domain/compare.mjs";
import { diffBlocks } from "../../foundry/module/domain/diff.mjs";
import { createEngine } from "../src/engine.js";
import { createMemoryLegendKeeper } from "../src/memory-lk.js";
import { openStore } from "../src/store.js";

const originalBlocks = [
  {
    id: "p1",
    kind: "paragraph",
    content: [
      { text: "The temple", bold: true },
      { text: " of " },
      { mention: { resourceId: "r-tython000000000000000", text: "Tython" } },
      { text: " is documented at " },
      { text: "the archive", link: "https://legendkeeper.test/temple" },
      { break: true },
      { text: "was abandoned." }
    ]
  },
  { id: "h1", kind: "heading", level: 2, content: [{ text: "History" }] },
  { id: "img", kind: "image", url: "https://assets.legendkeeper.test/temple.png", alt: "Temple gates", layout: "wrapRight", width: 40 },
  { id: "call", kind: "callout", tone: "warning", children: [{ id: "cp", kind: "paragraph", content: [{ text: "Do not enter." }] }] },
  { id: "sec", kind: "secret", children: [{ id: "sp", kind: "paragraph", content: [{ text: "The hidden ritual." }] }] },
  { id: "uns", kind: "unsupported" }
];

function seed(lk) {
  return lk.seed({
    id: "r-tython000000000000000",
    name: "Tython",
    updatedAt: "2026-10-13T00:00:00.000Z",
    properties: [
      { id: "prop-public", kind: "keyValue", title: "Region", isHidden: false, rows: [{ id: "row1", key: "Sector", text: "Deep Core" }] },
      { id: "prop-hidden", kind: "keyValue", title: "Classified", isHidden: true, rows: [{ id: "row2", key: "Code", text: "do-not-leak" }] }
    ],
    documents: [
      { id: "doc-hidden", name: "GM only stash", type: "page", rank: "a0", isHidden: true, blocks: [{ id: "hid", kind: "paragraph", content: [{ text: "stash body" }] }] },
      { id: "doc-overview", name: "Overview", type: "page", rank: "a1", isFullWidth: false, blocks: structuredClone(originalBlocks) },
      { id: "doc-map", name: "Map", type: "map", rank: "a2", blocks: [] }
    ]
  });
}

test("round trip changes one paragraph and preserves every other block", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lk-round-"));
  const dbPath = join(directory, "sync.sqlite");
  const lk = createMemoryLegendKeeper();
  seed(lk);
  const store = openStore(dbPath);
  const engine = createEngine({ lk, store });

  // 1. The page already exists in LegendKeeper with formatted blocks, an image, and an unsupported block.
  const before = await lk.getBlocks("r-tython000000000000000", "doc-overview");
  assert.equal(before.blocks.at(-1).kind, "unsupported");

  // 2. Import into a GM-only Foundry journal.
  const imported = await engine.importBranch();
  const envelope = imported.journals[0];
  assert.equal(envelope.persist.ownership.default, 0);
  assert.equal(envelope.persist.flags.legendkeeper.managed, true);
  assert.equal(lk.calls.createMany, 0);
  assert.equal(lk.calls.createResource, 0);
  assert.equal(lk.calls.assignBlockIds, 0);
  assert.equal(lk.calls.replaceBlocks, 0);

  // 3. Public block ids, formatting, and order match. Restricted content is not in the journal.
  const page = envelope.persist.pages.find((item) => item.system.lkDocumentId === "doc-overview");
  assert.deepEqual(page.system.blocks.map((block) => block.id), ["p1", "h1", "img", "call", "uns"]);
  assert.equal(page.sort, 100000);
  assert.equal(envelope.persist.systemPresentation, undefined);
  assert.equal(page.system.properties[0].title, "Region");
  assert.equal(page.system.blocks[2].width, 40);
  assert.equal(page.system.blocks[2].alt, "Temple gates");
  assert.equal(page.type, "legendkeeper.page");
  const persisted = JSON.stringify(envelope.persist);
  assert.equal(persisted.includes("The hidden ritual."), false);
  assert.equal(persisted.includes("GM only stash"), false);
  assert.equal(persisted.includes("do-not-leak"), false);
  assert.equal(persisted.includes("stash body"), false);
  assert.equal(envelope.gmOnly.hiddenDocuments[0].name, "GM only stash");
  const mapPage = envelope.persist.pages.find((item) => item.system.lkDocumentId === "doc-map");
  assert.equal(mapPage.system.placeholder, "map");
  const baseline = store.getDocument("r-tython000000000000000", "doc-overview");
  assert.deepEqual(baseline.baseline.blocks.map((block) => block.id), originalBlocks.map((block) => block.id));

  // A redacted tree omits the secret. That payload cannot delete it.
  const redacted = baseline.baseline.blocks.filter((block) => block.kind !== "secret");
  assert.throws(() => diffBlocks(baseline.baseline.blocks, redacted), /secret block/);
  const refused = await engine.editDocument("r-tython000000000000000", "doc-overview", {
    baseVersion: baseline.version,
    blocks: redacted
  });
  assert.equal(refused.code, "FULL_TREE_REFUSED");
  assert.equal(lk.calls.deleteBlock, 0);
  const collapsed = await engine.editParagraph("r-tython000000000000000", "doc-overview", {
    baseVersion: baseline.version,
    blockId: "p1",
    content: [{ text: "The temple was destroyed." }]
  });
  assert.equal(collapsed.code, "FORMAT_LOSS");
  const unchanged = await lk.getBlocks("r-tython000000000000000", "doc-overview");
  assert.equal(unchanged.blocks[0].content[6].text, "was abandoned.");
  assert.equal(unchanged.blocks.find((block) => block.id === "sec").children[0].content[0].text, "The hidden ritual.");
  const kept = store.getDocument("r-tython000000000000000", "doc-overview");
  assert.equal(kept.baseline.blocks[0].content[6].text, "was abandoned.");
  assert.equal(kept.draft.content[0].text, "The temple was destroyed.");

  // 4 and 5. Edit one run and sync it by the original block id.
  const content = structuredClone(baseline.baseline.blocks[0].content);
  content[6] = { ...content[6], text: "was destroyed." };
  const saved = await engine.editParagraph("r-tython000000000000000", "doc-overview", {
    baseVersion: baseline.version,
    blockId: "p1",
    content
  });
  assert.equal(saved.state, "synced");
  assert.deepEqual(saved.operations.map((operation) => operation.op), ["update"]);
  assert.equal(saved.operations[0].blockId, "p1");
  assert.equal(lk.calls.updateBlock, 1);
  assert.equal(lk.calls.deleteBlock, 0);
  assert.equal(lk.calls.replaceBlocks, 0);
  assert.equal(lk.calls.assignBlockIds, 0);

  // 6 and 7. Fetch again. Unrelated runs and blocks, including secret and unsupported, match.
  const after = await lk.getBlocks("r-tython000000000000000", "doc-overview");
  const afterRuns = after.blocks[0].content;
  assert.equal(afterRuns[0].text, "The temple");
  assert.equal(afterRuns[0].bold, true);
  assert.equal(afterRuns[2].mention.resourceId, "r-tython000000000000000");
  assert.equal(afterRuns[2].mention.text, "Tython");
  assert.equal(afterRuns[4].link, "https://legendkeeper.test/temple");
  assert.equal(afterRuns[4].text, "the archive");
  assert.equal(afterRuns[5].break, true);
  assert.equal(afterRuns[6].text, "was destroyed.");
  assert.deepEqual(unchangedBlocksMatch(before.blocks, after.blocks, "p1"), []);
  assert.deepEqual(after.blocks.find((block) => block.id === "uns"), { id: "uns", kind: "unsupported" });
  assert.equal(after.blocks.find((block) => block.id === "sec").children[0].content[0].text, "The hidden ritual.");

  // 8. Restart the service. Mapping and the accepted baseline remain.
  store.close();
  const reopened = openStore(dbPath);
  const survived = reopened.getDocument("r-tython000000000000000", "doc-overview");
  assert.equal(reopened.getResource("r-tython000000000000000").name, "Tython");
  assert.equal(survived.version, after.version);
  assert.equal(survived.baseline.blocks[0].content[6].text, "was destroyed.");
  assert.equal(survived.draft, null);
  assert.deepEqual(survived.baseline.blocks.find((block) => block.id === "uns"), { id: "uns", kind: "unsupported" });
  reopened.close();
});
