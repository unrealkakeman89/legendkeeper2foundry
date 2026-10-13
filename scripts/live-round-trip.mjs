import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkBlocks } from "../packages/foundry/module/domain/blocks.mjs";
import { unchangedBlocksMatch } from "../packages/foundry/module/domain/compare.mjs";
import { contentFromRunEdits } from "../packages/foundry/module/domain/editor.mjs";

const required = ["LEGENDKEEPER_API_KEY", "FOUNDRY_URL", "LEGENDKEEPER_RESOURCE_ID", "LEGENDKEEPER_DOCUMENT_ID"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Live round trip refused. Missing ${missing.join(", ")}.`);
  console.error("This script is the acceptance gate for a disposable LegendKeeper project and a Foundry V14 world.");
  console.error("Mock tests do not pass this gate, and automatic sync stays off until it does.");
  process.exit(2);
}

function findKind(blocks, kind) {
  let found = null;
  walkBlocks(blocks, (block) => {
    if (block?.kind === kind) found = block;
  });
  return found;
}

const { createSdkPort } = await import("../packages/service/src/sdk-lk.js");
const { createEngine } = await import("../packages/service/src/engine.js");
const { openStore } = await import("../packages/service/src/store.js");

const resourceId = process.env.LEGENDKEEPER_RESOURCE_ID;
const documentId = process.env.LEGENDKEEPER_DOCUMENT_ID;
const foundry = await fetch(process.env.FOUNDRY_URL);
if (foundry.status >= 500) {
  console.error(`Foundry at ${process.env.FOUNDRY_URL} returned ${foundry.status}.`);
  process.exit(1);
}

const directory = mkdtempSync(join(tmpdir(), "lk-live-"));
const store = openStore(join(directory, "sync.sqlite"));
const lk = createSdkPort(process.env.LEGENDKEEPER_API_KEY);
const engine = createEngine({ lk, store });

const imported = await engine.importBranch({ parentId: resourceId });
const journal = imported.journals.find((item) => item.persist.flags.legendkeeper.resourceId === resourceId);
if (!journal) {
  console.error(`Resource ${resourceId} was not imported.`);
  process.exit(1);
}
const page = journal.persist.pages.find((item) => item.system.lkDocumentId === documentId);
if (!page || !Number.isInteger(page.sort) || page.sort % 100000 !== 0) {
  console.error("The Foundry page payload is missing an integer sort value.");
  process.exit(1);
}
if (journal.persist.systemPresentation !== undefined) {
  console.error("Presentation must live on the page, not a journal system field.");
  process.exit(1);
}

const before = await lk.getBlocks(resourceId, documentId);
const paragraph = (before.blocks ?? []).find((block) => {
  const content = block?.content ?? [];
  return block?.kind === "paragraph"
    && content.some((run) => run?.bold)
    && content.some((run) => run?.mention)
    && content.some((run) => run?.link);
});
const unsupported = findKind(before.blocks, "unsupported");
const secret = findKind(before.blocks, "secret");
if (!paragraph || !unsupported || !secret) {
  console.error("The fixture page must already contain a formatted paragraph, a secret block, and an unsupported block.");
  process.exit(1);
}
const persisted = JSON.stringify(journal.persist);
if (persisted.includes("\"kind\":\"secret\"") || !persisted.includes("\"kind\":\"unsupported\"")) {
  console.error("The Foundry payload leaked a secret or dropped the unsupported placeholder.");
  process.exit(1);
}

const editIndex = paragraph.content.findIndex((run) => typeof run?.text === "string" && !run.mention && !run.break);
const texts = paragraph.content.map((run, index) => {
  if (index !== editIndex) return run?.mention?.text ?? run?.text ?? "";
  return `${run.text} [foundry]`;
});
const content = contentFromRunEdits(paragraph.content, texts);
const saved = await engine.editParagraph(resourceId, documentId, {
  baseVersion: before.version,
  blockId: paragraph.id,
  content
});
if (saved.state !== "synced") {
  console.error(`Paragraph save did not sync: ${saved.code ?? ""} ${saved.error ?? ""}`);
  process.exit(1);
}
const after = await lk.getBlocks(resourceId, documentId);
const edited = after.blocks.find((block) => block.id === paragraph.id);
if (edited.content[editIndex].text !== texts[editIndex]) {
  console.error("The edited run text did not round-trip.");
  process.exit(1);
}
const problems = unchangedBlocksMatch(before.blocks, after.blocks, paragraph.id);
if (problems.length > 0) {
  console.error(`Unrelated blocks changed: ${JSON.stringify(problems)}`);
  process.exit(1);
}
for (let index = 0; index < paragraph.content.length; index += 1) {
  if (index === editIndex) continue;
  if (JSON.stringify(paragraph.content[index]) !== JSON.stringify(edited.content[index])) {
    console.error(`Run ${index} changed during a single-run edit.`);
    process.exit(1);
  }
}
if (!findKind(after.blocks, "unsupported") || !findKind(after.blocks, "secret")) {
  console.error("The secret or unsupported block was not preserved.");
  process.exit(1);
}

const restored = contentFromRunEdits(edited.content, paragraph.content.map((run) => run?.mention?.text ?? run?.text ?? ""));
const rollback = await engine.editParagraph(resourceId, documentId, {
  baseVersion: after.version,
  blockId: paragraph.id,
  content: restored
});
if (rollback.state !== "synced") {
  console.error("The fixture edit could not be restored.");
  process.exit(1);
}

console.log("Live round trip passed. Automatic sync is still off until a GM enables it after this result.");
store.close();
