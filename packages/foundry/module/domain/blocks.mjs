/** Walk a LegendKeeper block tree, including list children and infobox rows. */
export function walkBlocks(blocks, visit, path = "blocks") {
  if (!Array.isArray(blocks)) return;
  blocks.forEach((block, index) => {
    const here = `${path}[${index}]`;
    visit(block, here);
    if (Array.isArray(block?.children)) walkBlocks(block.children, visit, `${here}.children`);
    if (Array.isArray(block?.rows)) walkBlocks(block.rows, visit, `${here}.rows`);
  });
}

export function findBlock(blocks, id) {
  let found;
  walkBlocks(blocks, (block) => {
    if (block?.id === id) found = block;
  });
  return found;
}

export function cloneBlocks(blocks) {
  return structuredClone(blocks ?? []);
}

/** Blocks written before LegendKeeper assigned stable ids. */
export function missingBlockIds(blocks) {
  const missing = [];
  walkBlocks(blocks, (block, path) => {
    if (!block || block.kind === "unsupported") return;
    if (typeof block.id !== "string" || block.id.length === 0) missing.push(path);
  });
  return missing;
}

export function unsupportedIds(blocks) {
  const ids = [];
  walkBlocks(blocks, (block) => {
    if (block?.kind === "unsupported" && block.id) ids.push(block.id);
  });
  return ids;
}

const METADATA_KEYS = new Set(["version", "updatedAt", "createdAt"]);

/** Drop sync metadata so content comparisons ignore version and timestamps. */
export function stripSyncMetadata(value) {
  if (Array.isArray(value)) return value.map(stripSyncMetadata);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (METADATA_KEYS.has(key)) continue;
    out[key] = stripSyncMetadata(child);
  }
  return out;
}

export function stableString(value) {
  return JSON.stringify(stripSyncMetadata(value));
}

export function ownFields(block) {
  const fields = {};
  for (const [key, value] of Object.entries(block ?? {})) {
    if (key === "id" || key === "kind" || key === "children" || key === "rows") continue;
    if (METADATA_KEYS.has(key)) continue;
    fields[key] = value;
  }
  return fields;
}
