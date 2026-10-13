import { findBlock } from "./domain/blocks.mjs";
import { renderPage } from "./domain/render.mjs";
import { redactBlocks } from "./domain/redact.mjs";

const LABELS = { pending: "Pending", synced: "Synced", failed: "Failed" };

export function preparePageContext(system, { mode = "player", presentation = {}, editable = false, editBlockId = "" } = {}) {
  const blocks = mode === "gm" ? (system.blocks ?? []) : redactBlocks(system.blocks ?? []);
  const paragraph = editBlockId ? findBlock(blocks, editBlockId) : null;
  return {
    syncState: system.syncState || "synced",
    syncLabel: LABELS[system.syncState] ?? LABELS.synced,
    syncError: system.syncError || "",
    rendered: renderPage(presentation, blocks, mode),
    editable: editable && mode === "gm",
    editBlockId,
    paragraphText: paragraph?.content?.[0]?.text ?? "",
    migrationRequired: false
  };
}
