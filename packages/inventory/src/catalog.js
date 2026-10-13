/** Classifications for the public LegendKeeper block model. Phase 1 does not write. */
export const BLOCK_CATALOG = [
  ["paragraph", "supported", "Rendered as a paragraph. Editable with blocks.update."],
  ["heading", "supported", "Levels 1 through 6."],
  ["quote", "supported", "Children stay in order."],
  ["code", "supported", "Language is preserved."],
  ["rule", "supported", "Horizontal rule."],
  ["bulletList", "supported", "List items stay addressable."],
  ["orderedList", "supported", "Start value is preserved."],
  ["listItem", "supported", "Nested lists stay nested."],
  ["taskList", "supported", "Checklists stay checklists."],
  ["taskItem", "supported", "Checked state is preserved."],
  ["table", "supported", "Rows and cells stay in the block tree."],
  ["tableRow", "supported", "Row order is preserved."],
  ["tableCell", "supported", "Header, colspan, and rowspan are preserved."],
  ["callout", "supported", "Tone, and custom icon or color, are preserved."],
  ["expand", "supported", "Collapsible title and children are preserved."],
  ["layout", "supported", "Column row."],
  ["layoutColumn", "supported", "Width percentage is preserved."],
  ["image", "supported", "Project asset URL, alt, fill, layout, and width. Data URLs are rejected."],
  ["keyValue", "supported", "Public rows render in the page or sidebar."],
  ["infobox", "supported", "Public property rows render. Hidden rows stay in SQLite."],
  ["meter", "supported", "Mode, items, and layout are preserved."],
  ["textField", "supported", "Rich-text property body."],
  ["resourceLink", "supported", "Resource ids are mapped to Foundry journal links."],
  ["secret", "gm-only", "Supported kind. Stored in SQLite and omitted from the player projection."],
  ["embed", "placeholder", "Preserved. Not reconstructed as an embedded player in this release."],
  ["resourceCollection", "placeholder", "Preserved. Collection views are a later phase."],
  ["map", "placeholder", "Preserved. Map documents and map blocks are not interactive in this release."],
  ["unsupported", "preserve", "Read-only placeholder. The id is echoed and the block is never deleted or rewritten."]
];

export const DOCUMENT_TYPES = [
  ["page", "sync", "Typed blocks round-trip with surgical writes."],
  ["blank", "sync", "A new resource already has one blank document. The first typed write makes it a page."],
  ["map", "placeholder", "Imported as a GM-only placeholder tab. Pins are not rewritten."],
  ["board", "placeholder", "Imported as a placeholder. tldraw records stay in LegendKeeper."],
  ["time", "placeholder", "Timeline documents stay in LegendKeeper. The tab is a placeholder."]
];

export const LOSS_PREVENTION_RULES = [
  "Canonical content is the typed block tree, not HTML.",
  "Unsupported blocks are preserved by id. A save that would drop one is rejected.",
  "documents.assignBlockIds is not called during inventory or import. It runs only after a GM authorizes a one-time edit migration, and the document is fetched again before edits.",
  "documents.replaceBlocks is not used while a document contains an unsupported block.",
  "Secret blocks, hidden documents, and hidden properties are omitted from Foundry journal data, flags, world settings, sockets, and search text.",
  "Imported journals are GM-only until a GM grants player visibility.",
  "Hidden document titles and image URLs are not written onto Foundry documents.",
  "Images must be LegendKeeper asset URLs. data: and blob: URLs are invalid.",
  "Timestamps are a polling hint. Block identity uses the version from documents.getBlocks.",
  "Creates verify the client-generated resource id before a retry, because idempotent replay is not stored for responses larger than 64 KiB.",
  "A Member API key cannot see hidden documents. Setup requires an Admin key."
];

export function renderMatrix() {
  const lines = [
    "# LegendKeeper compatibility matrix",
    "",
    "Pinned SDK: `@legendkeeper/sdk@4.1.0`. Node: `22.14.0`.",
    "This inventory is read-only. It does not assign block ids or write documents.",
    "",
    "## Block kinds",
    ""
  ];
  for (const [kind, status, note] of BLOCK_CATALOG) {
    lines.push(`- \`${kind}\` — **${status}**. ${note}`);
  }
  lines.push("", "## Document types", "");
  for (const [type, status, note] of DOCUMENT_TYPES) {
    lines.push(`- \`${type}\` — **${status}**. ${note}`);
  }
  lines.push("", "## Loss-prevention rules", "");
  for (const rule of LOSS_PREVENTION_RULES) lines.push(`- ${rule}`);
  lines.push("");
  return lines.join("\n");
}

export function summarizeLive(resources) {
  const counts = new Map();
  let hiddenDocuments = 0;
  let unsupported = 0;
  let secret = 0;
  const note = (kind) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const walk = (blocks) => {
    for (const block of blocks ?? []) {
      note(block.kind ?? "unknown");
      if (block.kind === "unsupported") unsupported += 1;
      if (block.kind === "secret") secret += 1;
      walk(block.children);
      walk(block.rows);
    }
  };
  for (const resource of resources) {
    for (const document of resource.documents ?? []) {
      if (document.isHidden) hiddenDocuments += 1;
      walk(document.blocks);
    }
    for (const property of resource.properties ?? []) {
      if (property.isHidden) note("hiddenProperty");
      else note(property.kind ?? "property");
    }
  }
  return {
    resources: resources.length,
    hiddenDocuments,
    unsupported,
    secret,
    kinds: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
  };
}
