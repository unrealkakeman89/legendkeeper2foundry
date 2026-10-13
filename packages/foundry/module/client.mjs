import { planParagraphEdit, displaySyncState } from "./domain/editor.mjs";
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

export async function persistImportedJournal(world, envelope, resourceIdToUuid = new Map()) {
  assertPersistable(envelope.persist);
  const pages = envelope.persist.pages.map((page) => ({
    ...page,
    system: {
      ...page.system,
      blocks: linkMentions(page.system.blocks, resourceIdToUuid)
    }
  }));
  const created = await world.createJournal({ ...envelope.persist, pages });
  return created;
}

export async function createLegendKeeperJournal(world, serviceUrl, token, { name }) {
  const created = await request(serviceUrl, token, "/v1/journals", {
    method: "POST",
    mutate: true,
    body: { name }
  });
  assertPersistable(created.journal.persist);
  return world.createJournal(created.journal.persist);
}

export function shareJournal(persist, gmOnly) {
  return grantPlayerVisibility(persist, gmOnly);
}

export async function saveParagraph(serviceUrl, token, { resourceId, documentId, baseVersion, baseline, blockId, text }) {
  const plan = planParagraphEdit(baseline, blockId, text);
  try {
    const result = await request(serviceUrl, token, `/v1/documents/${resourceId}/${documentId}/edits`, {
      method: "POST",
      mutate: true,
      body: { baseVersion, blocks: plan.edited }
    });
    return {
      syncState: displaySyncState(result.state),
      syncError: result.state === "failed" ? result.error : "",
      retained: result.retained ?? null,
      operations: result.operations ?? plan.operations,
      version: result.version ?? baseVersion
    };
  } catch (error) {
    return { syncState: "failed", syncError: error.message, retained: plan.edited, operations: plan.operations, version: baseVersion };
  }
}

export async function authorizeIdMigration(serviceUrl, token, { resourceId, documentId }) {
  return request(serviceUrl, token, `/v1/documents/${resourceId}/${documentId}/migrate-ids`, {
    method: "POST",
    mutate: true,
    body: { confirm: true }
  });
}
