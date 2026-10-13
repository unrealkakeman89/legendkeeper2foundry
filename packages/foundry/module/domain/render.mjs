import { safeImageUrl, safeLink } from "./urls.mjs";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function layoutAttributes(block) {
  const layout = block.layout && block.layout !== "default" ? block.layout : "";
  const width = layout && block.width ? ` style="width:${Number(block.width)}%"` : "";
  const attr = layout ? ` data-layout="${escapeHtml(layout)}"${width}` : "";
  return attr;
}

function renderRuns(content) {
  return (content ?? []).map((run) => {
    if (run?.break) return "<br>";
    if (run?.mention) {
      const label = escapeHtml(run.mention.text || run.mention.name || "Linked page");
      const uuid = run.mention.foundryUuid;
      if (uuid) return `<a class="lk-mention content-link" data-uuid="${escapeHtml(uuid)}" data-lk-resource="${escapeHtml(run.mention.resourceId)}">${label}</a>`;
      return `<span class="lk-mention" data-lk-resource="${escapeHtml(run.mention.resourceId)}">${label}</span>`;
    }
    let text = escapeHtml(run?.text ?? "");
    if (run?.code) text = `<code>${text}</code>`;
    if (run?.bold) text = `<strong>${text}</strong>`;
    if (run?.italic) text = `<em>${text}</em>`;
    if (run?.underline) text = `<u>${text}</u>`;
    if (run?.strike) text = `<s>${text}</s>`;
    if (run?.sub) text = `<sub>${text}</sub>`;
    if (run?.sup) text = `<sup>${text}</sup>`;
    const href = safeLink(run?.link);
    if (href) text = `<a href="${escapeHtml(href)}" rel="noreferrer">${text}</a>`;
    return text;
  }).join("");
}

function placeholder(block, label) {
  const id = escapeHtml(block.id ?? "");
  return `<aside class="lk-placeholder" data-block-id="${id}" data-kind="${escapeHtml(block.kind)}">
    <p>${escapeHtml(label)}</p>
    <a class="lk-open" data-action="openLegendKeeper" href="#">Open in LegendKeeper</a>
  </aside>`;
}

function renderOne(block, mode) {
  if (!block) return "";
  if (block.kind === "secret") {
    if (mode !== "gm") return "";
    return `<section class="lk-secret" data-block-id="${escapeHtml(block.id)}" data-gm-only="true">${renderBlocks(block.children, mode)}</section>`;
  }
  if (block.isHidden) return "";
  const id = ` data-block-id="${escapeHtml(block.id ?? "")}"`;
  const layout = layoutAttributes(block);
  switch (block.kind) {
    case "paragraph":
      return `<p class="lk-paragraph"${id}>${renderRuns(block.content)}</p>`;
    case "heading":
      return `<h${block.level || 1} class="lk-heading"${id}>${renderRuns(block.content)}</h${block.level || 1}>`;
    case "quote":
      return `<blockquote class="lk-quote"${id}>${renderBlocks(block.children, mode)}</blockquote>`;
    case "code":
      return `<pre class="lk-code"${id} data-language="${escapeHtml(block.language ?? "")}"><code>${escapeHtml(block.text ?? "")}</code></pre>`;
    case "rule":
      return `<hr class="lk-rule"${id}>`;
    case "bulletList":
      return `<ul class="lk-list"${id}>${renderBlocks(block.children, mode)}</ul>`;
    case "orderedList":
      return `<ol class="lk-list"${id} start="${Number(block.start ?? 1)}">${renderBlocks(block.children, mode)}</ol>`;
    case "listItem":
      return `<li class="lk-list-item"${id}>${renderBlocks(block.children, mode)}</li>`;
    case "taskList":
      return `<ul class="lk-tasks"${id}>${renderBlocks(block.children, mode)}</ul>`;
    case "taskItem":
      return `<li class="lk-task"${id}><input type="checkbox" disabled ${block.checked ? "checked" : ""}>${renderRuns(block.content)}</li>`;
    case "table":
      return `<table class="lk-table"${id}>${renderBlocks(block.children, mode)}</table>`;
    case "tableRow":
      return `<tr class="lk-row"${id}>${renderBlocks(block.children, mode)}</tr>`;
    case "tableCell": {
      const tag = block.header ? "th" : "td";
      return `<${tag} class="lk-cell"${id} colspan="${Number(block.colspan ?? 1)}" rowspan="${Number(block.rowspan ?? 1)}">${renderBlocks(block.children, mode)}</${tag}>`;
    }
    case "callout":
      return `<aside class="lk-callout" data-tone="${escapeHtml(block.tone ?? "note")}"${id}>${renderBlocks(block.children, mode)}</aside>`;
    case "expand":
      return `<details class="lk-expand"${id}><summary>${escapeHtml(block.title ?? "")}</summary>${renderBlocks(block.children, mode)}</details>`;
    case "layout":
      return `<div class="lk-layout"${id}>${renderBlocks(block.children, mode)}</div>`;
    case "layoutColumn":
      return `<div class="lk-column"${id} style="width:${Number(block.width ?? 50)}%">${renderBlocks(block.children, mode)}</div>`;
    case "image": {
      const title = block.isTitleHidden ? "" : `<figcaption>${escapeHtml(block.title || "Image")}</figcaption>`;
      const fill = block.fill ? " lk-image-fill" : "";
      const src = safeImageUrl(block.url);
      const image = src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt ?? "")}">` : `<p class="lk-image-omitted">Image omitted because its URL is not https.</p>`;
      return `<figure class="lk-image${fill}"${id}${layout}>${image}${title}</figure>`;
    }
    case "keyValue": {
      const rows = (block.rows ?? []).map((row) => `<div class="lk-kv-row"><dt>${escapeHtml(row.key)}</dt><dd>${escapeHtml(row.text ?? "")}</dd></div>`).join("");
      const title = block.isTitleHidden ? "" : `<h3>${escapeHtml(block.title || "Stats")}</h3>`;
      return `<dl class="lk-keyvalue" data-display="${escapeHtml(block.display ?? "list")}"${id}${layout}>${title}${rows}</dl>`;
    }
    case "infobox":
      return `<aside class="lk-infobox"${id}${layout}>${renderBlocks(block.rows, mode)}</aside>`;
    case "textField":
      return `<div class="lk-text-field"${id}${layout}>${block.title && !block.isTitleHidden ? `<h3>${escapeHtml(block.title)}</h3>` : ""}${renderBlocks(block.children, mode)}</div>`;
    case "meter": {
      const items = (block.items ?? []).map((item) => {
        const pct = item.max ? Math.round((item.current / item.max) * 100) : 0;
        return `<div class="lk-meter-item" data-mode="${escapeHtml(block.mode)}"><span>${escapeHtml(item.name)}</span><span class="lk-meter-bar" style="width:${pct}%"></span></div>`;
      }).join("");
      return `<div class="lk-meter"${id}${layout}>${items}</div>`;
    }
    case "resourceLink": {
      const items = (block.items ?? []).map((item) => `<li data-lk-resource="${escapeHtml(item.resourceId || item)}">${escapeHtml(item.text || item.resourceId || item)}</li>`).join("");
      return `<nav class="lk-links"${id}${layout}><ul>${items}</ul></nav>`;
    }
    case "unsupported":
      return placeholder(block, "This block is preserved in LegendKeeper and cannot be edited here.");
    case "embed":
    case "resourceCollection":
    case "map":
      return placeholder(block, "This LegendKeeper block is kept as a placeholder.");
    default:
      return placeholder(block, "Unsupported LegendKeeper content is preserved and was not rewritten.");
  }
}

export function renderBlocks(blocks, mode = "player") {
  return (blocks ?? []).map((block) => renderOne(block, mode)).join("");
}

export function renderPage(presentation, blocks, mode = "player") {
  const bannerUrl = safeImageUrl(presentation?.banner?.url);
  const banner = bannerUrl
    ? `<header class="lk-banner" style="background-image:url('${escapeHtml(bannerUrl)}');background-position:center ${Number(presentation.banner.yPosition ?? 50)}%"></header>`
    : "";
  const properties = (presentation?.properties ?? []).map((property) => renderOne(property, mode)).join("");
  const sidebar = properties ? `<aside class="lk-sidebar">${properties}</aside>` : "";
  return `<article class="legendkeeper lk-page">${banner}<div class="lk-columns">${sidebar}<div class="lk-content">${renderBlocks(blocks, mode)}</div></div></article>`;
}
