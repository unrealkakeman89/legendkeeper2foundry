import { findBlock, stableString, stripSyncMetadata, walkBlocks } from "./blocks.mjs";

function differences(path, left, right, out) {
  const a = stripSyncMetadata(left);
  const b = stripSyncMetadata(right);
  if (stableString(a) === stableString(b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path, message: `length ${a.length} != ${b.length}` });
      return;
    }
    a.forEach((item, index) => differences(`${path}[${index}]`, item, b[index], out));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) differences(path ? `${path}.${key}` : key, a[key], b[key], out);
    return;
  }
  out.push({ path, left: a, right: b });
}

/** Content differences, ignoring document version and modification timestamps. */
export function contentDifferences(before, after) {
  const out = [];
  differences("", before, after, out);
  return out;
}

export function unchangedBlocksMatch(beforeBlocks, afterBlocks, editedId) {
  const problems = [];
  walkBlocks(beforeBlocks, (block) => {
    if (!block?.id || block.id === editedId) return;
    const current = findBlock(afterBlocks, block.id);
    if (!current) {
      problems.push({ path: block.id, message: "missing after sync" });
      return;
    }
    const diff = contentDifferences(block, current);
    for (const item of diff) problems.push({ path: `${block.id}.${item.path}`, ...item });
  });
  return problems;
}
