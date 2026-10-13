import { walkBlocks } from "./blocks.mjs";

function redactBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (block.isHidden === true) return null;
  if (block.kind === "secret") return null;
  if (block.kind === "unsupported") {
    return { kind: "unsupported", id: block.id ?? null };
  }
  const copy = { ...block };
  delete copy.isHidden;
  if (Array.isArray(block.children)) {
    copy.children = redactBlocks(block.children);
  }
  if (Array.isArray(block.rows)) {
    copy.rows = redactBlocks(block.rows);
  }
  return copy;
}

/** Player-safe block tree. Secret blocks and hidden properties are omitted. */
export function redactBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    const redacted = redactBlock(block);
    if (redacted) out.push(redacted);
  }
  return out;
}

export function containsRestrictedContent(value) {
  const hits = [];
  const scan = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => scan(child, `${path}[${index}]`));
      return;
    }
    if (node.kind === "secret" || node.isHidden === true) hits.push(path || node.kind);
    for (const [key, child] of Object.entries(node)) {
      if (key === "kind" || key === "isHidden") continue;
      scan(child, path ? `${path}.${key}` : key);
    }
  };
  scan(value, "");
  return hits;
}

export function assertNoRestrictedContent(value, label = "Foundry document") {
  const hits = containsRestrictedContent(value);
  if (hits.length > 0) {
    const error = new Error(`${label} would expose restricted LegendKeeper content`);
    error.code = "RESTRICTED_LEAK";
    error.paths = hits;
    throw error;
  }
}

/** Public page projection. Hidden documents are not pages. */
export function projectDocument(document, blocks) {
  if (!document || document.isHidden) return null;
  const type = document.type ?? "page";
  if (type !== "page" && type !== "blank") {
    return {
      lkResourceId: document.resourceId,
      lkDocumentId: document.id,
      version: "",
      isFullWidth: false,
      placeholder: type,
      blocks: [],
      syncState: "synced",
      syncError: ""
    };
  }
  return {
    lkResourceId: document.resourceId,
    lkDocumentId: document.id,
    version: blocks?.version ?? "",
    isFullWidth: Boolean(document.isFullWidth),
    blocks: redactBlocks(blocks?.blocks ?? []),
    syncState: "synced",
    syncError: ""
  };
}

export function publicProperties(properties) {
  const out = [];
  for (const property of properties ?? []) {
    if (!property || property.isHidden === true) continue;
    if (property.kind === "unsupported") {
      out.push({ kind: "unsupported", id: property.id ?? null });
      continue;
    }
    const redacted = redactBlock(property);
    if (redacted) out.push(redacted);
  }
  return out;
}

export function collectText(value) {
  const parts = [];
  walkBlocks(Array.isArray(value) ? value : [], (block) => {
    if (Array.isArray(block.content)) {
      for (const run of block.content) {
        if (typeof run?.text === "string") parts.push(run.text);
        if (typeof run?.mention?.text === "string") parts.push(run.mention.text);
      }
    }
    if (typeof block.text === "string") parts.push(block.text);
    if (typeof block.title === "string") parts.push(block.title);
  });
  return parts.join("\n");
}
