/** 24-character ids in the shape the LegendKeeper SDK examples use. */
export function newResourceId() {
  return `r${crypto.randomUUID().replaceAll("-", "").slice(0, 23)}`;
}

export function newOperationKey(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}
