function blockIds(html) {
  return [...String(html ?? "").matchAll(/data-block-id="([^"]*)"/g)].map((match) => match[1]);
}

/**
 * Compare structural markers on two renders.
 * This is not a visual sign-off. Layout parity is a separate side-by-side check.
 */
export function visualFidelityCheck(foundryHtml, legendkeeperHtml) {
  const leftIds = blockIds(foundryHtml);
  const rightIds = blockIds(legendkeeperHtml);
  return {
    visualSignOff: false,
    note: "Structural comparison is not a visual sign-off. Compare the Foundry journal beside the LegendKeeper page before treating the layouts as equivalent.",
    sameBlockIds: leftIds.join("\0") === rightIds.join("\0"),
    leftIds,
    rightIds
  };
}
