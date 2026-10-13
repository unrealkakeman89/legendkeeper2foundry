import { cloneBlocks, findBlock } from "./blocks.mjs";
import { diffBlocks } from "./diff.mjs";

export function setParagraphText(blocks, blockId, text) {
  const next = cloneBlocks(blocks);
  const block = findBlock(next, blockId);
  if (!block || block.kind !== "paragraph") {
    const error = new Error("Only an existing paragraph can be edited in this pass");
    error.code = "NOT_A_PARAGRAPH";
    throw error;
  }
  block.content = [{ text }];
  return next;
}

export function planParagraphEdit(baseline, blockId, text) {
  const edited = setParagraphText(baseline, blockId, text);
  return { edited, operations: diffBlocks(baseline, edited) };
}

export const SYNC_STATES = ["pending", "synced", "failed"];

export function displaySyncState(operationState) {
  if (operationState === "completed" || operationState === "synced") return "synced";
  if (operationState === "failed") return "failed";
  return "pending";
}
