import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSdkReader } from "../../service/src/sdk-lk.js";
import { createMemoryLegendKeeper } from "../../service/src/memory-lk.js";
import { LOSS_PREVENTION_RULES, renderMatrix } from "../src/catalog.js";
import { inventoryProject } from "../src/run.js";

test("inventory is read-only and the matrix records loss-prevention rules", async () => {
  const runSource = readFileSync(new URL("../src/run.js", import.meta.url), "utf8");
  const cliSource = readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  assert.equal(/assignBlockIds|replaceBlocks|createMany/.test(runSource), false);
  assert.equal(/assignBlockIds|replaceBlocks|createMany/.test(cliSource), false);

  const matrix = renderMatrix();
  assert.match(matrix, /@legendkeeper\/sdk@4\.1\.0/);
  assert.match(matrix, /22\.14\.0/);
  for (const rule of LOSS_PREVENTION_RULES) assert.ok(matrix.includes(rule));
  const committed = readFileSync(new URL("../../../docs/compatibility.md", import.meta.url), "utf8");
  assert.equal(committed, matrix);

  const reader = createSdkReader("test-key");
  assert.deepEqual(Object.keys(reader).sort(), ["getBlocks", "getResource", "listDocuments", "listProperties", "listResources"]);

  const lk = createMemoryLegendKeeper();
  lk.seed({
    id: "r-inv0000000000000000000",
    name: "Inventory",
    documents: [
      { id: "doc-public", name: "Overview", type: "page", rank: "a1", blocks: [{ id: "p", kind: "paragraph", content: [{ text: "Public" }] }, { id: "u", kind: "unsupported" }] },
      { id: "doc-hidden", name: "GM only stash", type: "page", rank: "a0", isHidden: true, blocks: [{ id: "s", kind: "secret", children: [{ id: "sp", kind: "paragraph", content: [{ text: "hidden body" }] }] }] },
      { id: "doc-board", name: "Board", type: "board", rank: "a2" }
    ]
  });
  const port = {
    listResources: () => lk.listResources(),
    getResource: (id) => lk.getResource(id),
    listDocuments: (id) => lk.listDocuments(id),
    getBlocks: (resourceId, documentId) => lk.getBlocks(resourceId, documentId),
    listProperties: (id) => lk.listProperties(id),
    assignBlockIds() {
      throw new Error("inventory must not assign ids");
    }
  };
  const report = await inventoryProject(port);
  assert.equal(report.summary.hiddenDocuments, 1);
  assert.equal(report.summary.unsupported, 1);
  assert.equal(report.summary.secret, 1);
  assert.equal(JSON.stringify(report.summary).includes("GM only stash"), false);
  assert.equal(lk.calls.assignBlockIds, 0);
  const hidden = report.resources[0].documents.find((document) => document.isHidden);
  assert.equal(hidden.name, undefined);
  assert.equal(hidden.blocks[0].kind, "secret");
});
