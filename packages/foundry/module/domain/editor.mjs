import { findBlock } from "./blocks.mjs";
import { contentFromRunEdits, describeRuns } from "./runs.mjs";

export { contentFromRunEdits, describeRuns };

export function paragraphContent(blocks, blockId) {
  const block = findBlock(blocks, blockId);
  if (!block || block.kind !== "paragraph") {
    const error = new Error("Only an existing paragraph can be edited in this pass");
    error.code = "NOT_A_PARAGRAPH";
    throw error;
  }
  return block.content ?? [];
}

/** Change the text of existing runs. Marks, mentions, links, and breaks stay on those runs. */
export function planRunEdit(blocks, blockId, textsByIndex) {
  const content = contentFromRunEdits(paragraphContent(blocks, blockId), textsByIndex);
  return { blockId, content, operations: [{ op: "update", blockId }] };
}

export function replaceParagraphContent(blocks, blockId, content) {
  return (blocks ?? []).map((block) => {
    if (block?.id !== blockId) {
      return {
        ...block,
        ...(Array.isArray(block?.children) ? { children: replaceParagraphContent(block.children, blockId, content) } : {}),
        ...(Array.isArray(block?.rows) ? { rows: replaceParagraphContent(block.rows, blockId, content) } : {})
      };
    }
    return { ...block, content };
  });
}

export const SYNC_STATES = ["pending", "synced", "failed"];

export function displaySyncState(operationState) {
  if (operationState === "completed" || operationState === "synced") return "synced";
  if (operationState === "failed") return "failed";
  return "pending";
}
