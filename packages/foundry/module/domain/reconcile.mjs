import { findBlock, stableString } from "./blocks.mjs";

/** True when the remote copy changed the same paragraph the draft edited. */
export function sameBlockConflict(baselineBlocks, remoteBlocks, blockId) {
  return stableString(findBlock(baselineBlocks, blockId)) !== stableString(findBlock(remoteBlocks, blockId));
}

/**
 * Poll updates that touch a different block can apply beside a draft.
 * An open draft for the same document stays until that draft is reconciled.
 */
export function updatesSafeToApply(localPages, updates) {
  return (updates ?? []).filter((update) => {
    const page = (localPages ?? []).find((item) => item?.system?.lkDocumentId === update.documentId);
    return !page?.system?.draft;
  });
}
