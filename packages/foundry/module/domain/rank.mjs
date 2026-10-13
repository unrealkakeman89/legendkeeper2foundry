/** LegendKeeper sibling order is plain string comparison, not numeric order. */
export function compareRank(a, b) {
  const left = a?.rank ?? "";
  const right = b?.rank ?? "";
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function sortByRank(items) {
  return [...(items ?? [])].sort(compareRank);
}
