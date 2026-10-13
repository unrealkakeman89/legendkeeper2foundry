import { displaySyncState, replaceParagraphContent } from "./domain/editor.mjs";
import { assertPersistable, grantPlayerVisibility } from "./domain/journal.mjs";
import { linkMentions } from "./domain/mentions.mjs";
import { redactBlocks } from "./domain/redact.mjs";

export const SERVICE_URL_SETTING = "serviceUrl";
export const DEFAULT_SERVICE_URL = "http://127.0.0.1:8787";

export function headers(token, { mutate = false } = {}) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(mutate ? { "x-legendkeeper-request": "1" } : {})
  };
}

async function request(serviceUrl, token, path, { method = "GET", body, mutate = false } = {}) {
  const response = await fetch(`${serviceUrl}${path}`, {
    method,
    headers: headers(token, { mutate }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || response.statusText);
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function pairService(serviceUrl, { pairingCode, clientId }, fetchImpl = fetch) {
  const response = await fetchImpl(`${serviceUrl}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-legendkeeper-request": "1" },
    body: JSON.stringify({ pairingCode, clientId })
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "Pairing failed");
    error.status = response.status;
    throw error;
  }
  return payload.token;
}

export async function fetchEditorTree(serviceUrl, token, resourceId, documentId) {
  return request(serviceUrl, token, `/v1/documents/${resourceId}/${documentId}`);
}

export async function fetchGmView(serviceUrl, token, resourceId) {
  return request(serviceUrl, token, `/v1/journals/${resourceId}/gm`);
}

/** Journal data written back to Foundry. Secrets and hidden rows never stay on the document. */
export function localPageUpdate(system, blocks) {
  return {
    ...system,
    blocks: redactBlocks(blocks)
  };
}

export async function importJournals(serviceUrl, token, { parentId = null } = {}) {
  const result = await request(serviceUrl, token, "/v1/import", {
    method: "POST",
    mutate: true,
    body: { parentId }
  });
  return result.journals.map((journal) => {
    assertPersistable(journal.persist);
    return journal;
  });
}

export function journalPages(created) {
  const pages = created?.pages?.contents ?? created?.pages ?? [];
  return [...pages].map((page) => ({
    id: page.id,
    uuid: page.uuid ?? null,
    system: page.system
  }));
}

export async function persistImportedJournal(world, envelope, resourceIdToUuid = new Map()) {
  assertPersistable(envelope.persist);
  const pages = envelope.persist.pages.map((page) => ({
    ...page,
    system: {
      ...page.system,
      blocks: linkMentions(page.system.blocks, resourceIdToUuid)
    }
  }));
  return world.createJournal({ ...envelope.persist, pages });
}

export function mentionPageUpdates(pages, resourceIdToUuid) {
  return journalPages({ pages }).map((page) => ({
    ...page,
    system: {
      ...page.system,
      blocks: linkMentions(page.system?.blocks ?? [], resourceIdToUuid)
    }
  }));
}

export async function registerFoundryMapping(serviceUrl, token, mapping) {
  return request(serviceUrl, token, "/v1/mappings", {
    method: "POST",
    mutate: true,
    body: mapping
  });
}

export async function importIntoWorld(world, serviceUrl, token, { parentId = null } = {}) {
  const journals = await importJournals(serviceUrl, token, { parentId });
  const created = [];
  const resourceIdToUuid = new Map();
  for (const envelope of journals) {
    const doc = await persistImportedJournal(world, envelope, resourceIdToUuid);
    const resourceId = envelope.persist.flags.legendkeeper.resourceId;
    if (doc?.uuid) resourceIdToUuid.set(resourceId, doc.uuid);
    created.push({ envelope, doc, resourceId });
  }
  for (const item of created) {
    const pages = mentionPageUpdates(journalPages(item.doc), resourceIdToUuid);
    if (world.updatePages) await world.updatePages(item.doc, pages);
    await registerFoundryMapping(serviceUrl, token, {
      resourceId: item.resourceId,
      foundryUuid: item.doc?.uuid ?? null,
      pages: pages.map((page) => ({
        documentId: page.system?.lkDocumentId,
        foundryUuid: page.uuid
      })).filter((page) => page.documentId && page.foundryUuid)
    });
    item.doc = { ...item.doc, pages };
  }
  return created.map((item) => item.doc);
}

export function newClientResourceId() {
  return `r${crypto.randomUUID().replaceAll("-", "").slice(0, 23)}`;
}

export async function createLegendKeeperJournal(world, serviceUrl, token, { name, id = newClientResourceId() }) {
  const created = await request(serviceUrl, token, "/v1/journals", {
    method: "POST",
    mutate: true,
    body: { name, id }
  });
  assertPersistable(created.journal.persist);
  const resourceId = created.journal.persist.flags.legendkeeper.resourceId;
  let doc = world.findJournal ? await world.findJournal(resourceId) : null;
  if (!doc) {
    try {
      doc = await world.createJournal(created.journal.persist);
    } catch (error) {
      error.resourceId = resourceId;
      throw error;
    }
  }
  const pages = journalPages(doc);
  try {
    await registerFoundryMapping(serviceUrl, token, {
      resourceId,
      foundryUuid: doc.uuid ?? null,
      pages: pages.map((page) => ({
        documentId: page.system?.lkDocumentId,
        foundryUuid: page.uuid
      })).filter((page) => page.documentId && page.foundryUuid)
    });
  } catch (error) {
    error.resourceId = resourceId;
    error.journal = doc;
    throw error;
  }
  return doc;
}

export function shareJournal(persist, gmOnly) {
  return grantPlayerVisibility(persist, gmOnly);
}

export async function saveParagraph(serviceUrl, token, { resourceId, documentId, baseVersion, blockId, content }) {
  try {
    const result = await request(serviceUrl, token, `/v1/documents/${resourceId}/${documentId}/edits`, {
      method: "POST",
      mutate: true,
      body: { baseVersion, blockId, content }
    });
    return {
      syncState: displaySyncState(result.state),
      syncError: result.state === "failed" ? result.error : "",
      retained: result.retained ?? content,
      operations: result.operations ?? [{ op: "update", blockId }],
      version: result.version ?? baseVersion,
      code: result.code ?? null
    };
  } catch (error) {
    return { syncState: "failed", syncError: error.message, retained: content, operations: [{ op: "update", blockId }], version: baseVersion, code: error.code ?? null };
  }
}

export function paragraphSaveUpdate(system, blockId, result, baseVersion = system.version) {
  const failed = result.syncState !== "synced";
  return {
    ...system,
    syncState: result.syncState,
    syncError: failed ? result.syncError : "",
    draft: failed ? { blockId, baseVersion, content: result.retained } : null,
    version: failed ? system.version : result.version,
    blocks: failed ? system.blocks : redactBlocks(replaceParagraphContent(system.blocks, blockId, result.retained))
  };
}

export async function pollUpdates(serviceUrl, token, { full = false } = {}) {
  return request(serviceUrl, token, "/v1/sync/poll", {
    method: "POST",
    mutate: true,
    body: { full }
  });
}

export async function fetchReviews(serviceUrl, token) {
  const [conflicts, deletions] = await Promise.all([
    request(serviceUrl, token, "/v1/conflicts"),
    request(serviceUrl, token, "/v1/deletions")
  ]);
  return { conflicts: conflicts.conflicts ?? [], deletions: deletions.deletions ?? [] };
}

export async function resolveConflict(serviceUrl, token, conflictId, { choice, content }) {
  return request(serviceUrl, token, `/v1/conflicts/${conflictId}/resolve`, {
    method: "POST",
    mutate: true,
    body: { choice, content }
  });
}

export async function requestDeletion(serviceUrl, token, deletion) {
  return request(serviceUrl, token, "/v1/deletions", {
    method: "POST",
    mutate: true,
    body: {
      targetType: deletion.targetType,
      resourceId: deletion.resourceId,
      documentId: deletion.documentId
    }
  });
}

export async function reviewDeletion(serviceUrl, token, deletionId, decision) {
  return request(serviceUrl, token, `/v1/deletions/${deletionId}/review`, {
    method: "POST",
    mutate: true,
    body: { decision }
  });
}

export async function acquireLeader(serviceUrl, token, ttlMs) {
  return request(serviceUrl, token, "/v1/sync/leader", {
    method: "POST",
    mutate: true,
    body: { ttlMs }
  });
}

export async function authorizeIdMigration(serviceUrl, token, { resourceId, documentId }) {
  return request(serviceUrl, token, `/v1/documents/${resourceId}/${documentId}/migrate-ids`, {
    method: "POST",
    mutate: true,
    body: { confirm: true }
  });
}
