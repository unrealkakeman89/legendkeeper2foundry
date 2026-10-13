import { sortByRank } from "./rank.mjs";
import { assertNoRestrictedContent, projectDocument, publicProperties, redactBlocks } from "./redact.mjs";

export const MODULE_ID = "legendkeeper";
export const PAGE_TYPE = "legendkeeper.page";
export const OWNERSHIP_NONE = 0;
export const OWNERSHIP_OBSERVER = 2;

export const PAGE_SYSTEM_FIELDS = [
  "lkResourceId",
  "lkDocumentId",
  "version",
  "isFullWidth",
  "placeholder",
  "blocks",
  "syncState",
  "syncError"
];

function pageData(document, blocks) {
  const system = projectDocument(document, blocks);
  if (!system) return null;
  return {
    name: document.name || "Page",
    type: PAGE_TYPE,
    sort: sortIndex(document.rank),
    system
  };
}

function sortIndex(rank) {
  return typeof rank === "string" ? rank : "";
}

/**
 * Foundry journal create payload. Hidden documents are omitted.
 * Ownership starts at NONE so players see nothing until a GM grants visibility.
 */
export function buildFoundryJournal(resource, documents, blocksByDocumentId = new Map()) {
  const ordered = sortByRank(documents);
  const pages = [];
  const hiddenDocuments = [];
  for (const document of ordered) {
    const stored = { ...document, resourceId: document.resourceId ?? resource.id };
    if (stored.isHidden) {
      hiddenDocuments.push({ id: stored.id, name: stored.name ?? "" });
      continue;
    }
    const blocks = blocksByDocumentId.get(stored.id) ?? { blocks: stored.blocks ?? [], version: stored.version ?? "" };
    const page = pageData(stored, blocks);
    if (page) pages.push(page);
  }
  const banner = resource?.banner?.enabled ? { url: resource.banner.url, yPosition: resource.banner.yPosition ?? 50 } : null;
  const persist = {
    name: resource.name,
    ownership: { default: OWNERSHIP_NONE },
    flags: {
      legendkeeper: {
        managed: true,
        resourceId: resource.id
      }
    },
    pages,
    systemPresentation: {
      banner,
      properties: publicProperties(resource.properties)
    }
  };
  assertNoRestrictedContent(persist.pages, "Imported journal");
  assertNoRestrictedContent(persist.systemPresentation, "Imported presentation");
  return {
    persist,
    gmOnly: {
      resourceId: resource.id,
      hiddenDocuments,
      isHiddenResource: Boolean(resource.isHidden)
    }
  };
}

export function assertPersistable(persist) {
  if (persist?.ownership?.default !== OWNERSHIP_NONE) {
    const error = new Error("Imported journals must start GM-only");
    error.code = "VISIBILITY";
    throw error;
  }
  if (persist?.flags?.legendkeeper?.managed !== true) {
    const error = new Error("Journal is not marked LegendKeeper-managed");
    error.code = "UNMANAGED";
    throw error;
  }
  const token = persist?.flags?.legendkeeper?.accessToken ?? persist?.flags?.legendkeeper?.apiKey;
  if (token) {
    const error = new Error("Credentials must not be stored on the journal");
    error.code = "SECRET_FLAG";
    throw error;
  }
  assertNoRestrictedContent(persist.pages, "Journal pages");
  assertNoRestrictedContent(persist.systemPresentation, "Journal presentation");
  const encoded = JSON.stringify(persist);
  if (encoded.includes("\"kind\":\"secret\"") || encoded.includes("\"isHidden\":true")) {
    const error = new Error("Restricted content reached the Foundry payload");
    error.code = "RESTRICTED_LEAK";
    throw error;
  }
}

/** Explicit GM action. Refuses hidden resources and any projection that still holds secrets. */
export function grantPlayerVisibility(persist, gmOnly = {}) {
  assertPersistable(persist);
  if (gmOnly.isHiddenResource) {
    const error = new Error("A hidden LegendKeeper resource cannot be shown to players");
    error.code = "HIDDEN_RESOURCE";
    throw error;
  }
  const pages = persist.pages.map((page) => ({
    ...page,
    system: {
      ...page.system,
      blocks: redactBlocks(page.system?.blocks ?? [])
    }
  }));
  const next = {
    ...persist,
    ownership: { default: OWNERSHIP_OBSERVER },
    pages
  };
  assertNoRestrictedContent(next.pages, "Shared journal");
  return next;
}
