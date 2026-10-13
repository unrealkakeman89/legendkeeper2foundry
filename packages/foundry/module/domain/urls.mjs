function hasWhitespace(value) {
  return /[\s]/.test(value);
}

/** Link targets LegendKeeper can store: http, https, mailto, and internal lk links. */
export function safeLink(value) {
  const href = String(value ?? "").trim();
  if (!href || hasWhitespace(href)) return "";
  const lower = href.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("blob:")) return "";
  if (lower.startsWith("https:") || lower.startsWith("http:") || lower.startsWith("mailto:") || lower.startsWith("lk:")) return href;
  return "";
}

/** Images and banners stay on https. */
export function safeImageUrl(value) {
  const href = String(value ?? "").trim();
  if (!href || hasWhitespace(href)) return "";
  if (href.toLowerCase().startsWith("https:")) return href;
  return "";
}
