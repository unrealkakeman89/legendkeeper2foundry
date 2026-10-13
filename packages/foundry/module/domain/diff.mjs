import { missingBlockIds, ownFields, stableString, unsupportedIds } from "./blocks.mjs";

function sameOwn(left, right) {
  return stableString(ownFields(left)) === stableString(ownFields(right));
}

function diffList(before, after, ops) {
  const beforeById = new Map((before ?? []).filter((block) => block?.id).map((block) => [block.id, block]));
  const afterIds = new Set((after ?? []).filter((block) => block?.id).map((block) => block.id));

  for (const block of before ?? []) {
    if (block?.kind === "unsupported") {
      if (!block.id || !afterIds.has(block.id)) {
        const error = new Error("Refusing to save because an unsupported block would be dropped");
        error.code = "UNSUPPORTED_LOSS";
        throw error;
      }
      continue;
    }
    if (block?.id && !afterIds.has(block.id)) ops.push({ op: "delete", blockId: block.id });
  }

  let previousId = null;
  const sharedBefore = (before ?? []).filter((block) => block?.id && afterIds.has(block.id)).map((block) => block.id);
  const beforeIdSet = new Set(sharedBefore);
  const sharedAfter = [];

  for (const block of after ?? []) {
    if (block?.kind === "unsupported") {
      const prior = beforeById.get(block.id);
      if (!prior || prior.kind !== "unsupported") {
        const error = new Error("Refusing to create an unsupported block the document does not already hold");
        error.code = "UNSUPPORTED_KIND";
        throw error;
      }
      previousId = block.id;
      sharedAfter.push(block.id);
      continue;
    }
    const prior = block?.id ? beforeById.get(block.id) : undefined;
    if (!prior) {
      ops.push({ op: "insert", block, after: previousId });
    } else {
      sharedAfter.push(block.id);
      if (!sameOwn(prior, block)) ops.push({ op: "update", blockId: block.id, fields: ownFields(block) });
      if (Array.isArray(prior.children) || Array.isArray(block.children)) {
        diffList(prior.children ?? [], block.children ?? [], ops);
      }
      if (Array.isArray(prior.rows) || Array.isArray(block.rows)) {
        diffList(prior.rows ?? [], block.rows ?? [], ops);
      }
    }
    previousId = block.id ?? previousId;
  }

  if (sharedBefore.join("\0") !== sharedAfter.filter((id) => beforeIdSet.has(id)).join("\0")) {
    let anchor = null;
    for (const id of sharedAfter) {
      ops.push({ op: "move", blockId: id, after: anchor });
      anchor = id;
    }
  }
}

/**
 * Surgical operations from the last accepted baseline to the edited tree.
 * Editing is refused until every supported block has an id.
 */
export function diffBlocks(before, after) {
  const missing = missingBlockIds(before);
  if (missing.length > 0) {
    const error = new Error("This page needs a one-time block id migration before it can be edited");
    error.code = "NEEDS_ID_MIGRATION";
    error.paths = missing;
    throw error;
  }
  const kept = new Set(unsupportedIds(after));
  for (const id of unsupportedIds(before)) {
    if (!kept.has(id)) {
      const error = new Error("Refusing to save because an unsupported block would be dropped");
      error.code = "UNSUPPORTED_LOSS";
      throw error;
    }
  }
  const ops = [];
  diffList(before ?? [], after ?? [], ops);
  return ops;
}
