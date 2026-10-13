import { findBlock } from "./domain/blocks.mjs";
import { describeRuns } from "./domain/runs.mjs";
import { renderPage } from "./domain/render.mjs";
import { redactBlocks } from "./domain/redact.mjs";

const LABELS = { pending: "Pending", synced: "Synced", failed: "Failed" };

export function sheetMode({ isGM = false, token = "" } = {}) {
  return Boolean(isGM) && Boolean(token);
}

function editorSource(system) {
  const blocks = system.blocks ?? [];
  const draft = system.draft;
  if (!draft?.blockId || !Array.isArray(draft.content)) return blocks;
  return blocks.map((block) => block?.id === draft.blockId ? { ...block, content: draft.content } : block);
}

export function preparePageContext(system, { mode = "player", presentation = {}, editable = false, editBlockId = "" } = {}) {
  const stored = mode === "gm" ? (system.blocks ?? []) : redactBlocks(system.blocks ?? []);
  const editing = editorSource({ ...system, blocks: stored });
  const paragraph = (editBlockId && findBlock(editing, editBlockId))
    || editing.find((block) => block?.kind === "paragraph")
    || null;
  const shown = presentation.banner || presentation.properties
    ? presentation
    : { banner: system.banner ?? null, properties: system.properties ?? [] };
  return {
    syncState: system.syncState || "synced",
    syncLabel: LABELS[system.syncState] ?? LABELS.synced,
    syncError: system.syncError || "",
    rendered: renderPage(shown, editing, mode),
    editable: editable && mode === "gm" && Boolean(paragraph),
    editBlockId: paragraph?.id ?? "",
    runs: describeRuns(paragraph?.content ?? []),
    migrationRequired: false
  };
}
