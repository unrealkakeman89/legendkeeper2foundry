import { walkBlocks } from "./blocks.mjs";

/** Point public mention runs at the mapped Foundry journal without dropping the LegendKeeper id. */
export function linkMentions(blocks, resourceIdToUuid) {
  const copy = structuredClone(blocks ?? []);
  walkBlocks(copy, (block) => {
    if (!Array.isArray(block.content)) return;
    block.content = block.content.map((run) => {
      const resourceId = run?.mention?.resourceId;
      if (!resourceId) return run;
      const uuid = resourceIdToUuid.get(resourceId);
      return {
        ...run,
        mention: {
          ...run.mention,
          foundryUuid: uuid ?? null
        }
      };
    });
  });
  return copy;
}
