import { findBlock } from "./domain/blocks.mjs";
import { describeRuns, isRunArray } from "./domain/runs.mjs";
import { renderPage } from "./domain/render.mjs";
import { redactBlocks } from "./domain/redact.mjs";

const LABELS = { pending: "Pending", synced: "Synced", failed: "Failed" };

export function sheetMode({ isGM = false, token = "" } = {}) {
  return Boolean(isGM) && Boolean(token);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function sourcePayload(paragraph) {
  return {
    id: paragraph?.id ?? "",
    kind: "paragraph",
    content: paragraph?.content ?? []
  };
}

/** JSON escaped for an HTML attribute. The template must not insert the raw string. */
export function encodeSourceAttribute(paragraph) {
  return escapeHtml(JSON.stringify(sourcePayload(paragraph)));
}

export function decodeSourcePayload(value) {
  let parsed;
  try {
    parsed = JSON.parse(decodeHtml(value).trim());
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.kind !== "paragraph" || typeof parsed.id !== "string" || parsed.id.length === 0 || !isRunArray(parsed.content)) {
    const error = new Error("The editor source runs are missing or not a paragraph");
    error.code = "INVALID_SOURCE";
    throw error;
  }
  return parsed;
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
  const baseVersion = system.draft?.baseVersion || system.version || "";
  return {
    syncState: system.syncState || "synced",
    syncLabel: LABELS[system.syncState] ?? LABELS.synced,
    syncError: system.syncError || "",
    rendered: renderPage(shown, editing, mode),
    editable: editable && mode === "gm" && Boolean(paragraph),
    editBlockId: paragraph?.id ?? "",
    baseVersion,
    lkResourceId: system.lkResourceId ?? "",
    lkDocumentId: system.lkDocumentId ?? "",
    sourceRuns: paragraph ? JSON.stringify(sourcePayload(paragraph)) : "",
    runs: describeRuns(paragraph?.content ?? []),
    migrationRequired: false
  };
}
