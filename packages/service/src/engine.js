import { diffBlocks } from "../../foundry/module/domain/diff.mjs";
import { findBlock } from "../../foundry/module/domain/blocks.mjs";
import { projectDocument } from "../../foundry/module/domain/redact.mjs";
import { buildFoundryJournal } from "../../foundry/module/domain/journal.mjs";
import { newOperationKey, newResourceId } from "./ids.js";

function syncError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isNotFound(error) {
  return error?.status === 404 || error?.code === "NOT_FOUND";
}

function isVersionMismatch(error) {
  return error?.status === 412 || error?.code === "VERSION_MISMATCH";
}

export function createEngine({ lk, store }) {
  function assertLeader(clientId) {
    const leader = store.leader();
    const timestamp = new Date().toISOString();
    if (!leader || leader.client_id !== clientId || leader.lease_until <= timestamp) {
      throw syncError("NOT_LEADER", "An authorized synchronization leader is required");
    }
  }

  async function rememberResource(resource) {
    store.putResource(resource);
    for (const property of resource.properties ?? []) store.putProperty(resource.id, property);
    const blocksByDocumentId = new Map();
    for (const document of resource.documents ?? []) {
      const withResource = { ...document, resourceId: resource.id };
      if (withResource.type === "page" || withResource.type === "blank") {
        const blocks = await lk.getBlocks(resource.id, withResource.id);
        blocksByDocumentId.set(withResource.id, blocks);
        store.putDocument(resource.id, withResource, blocks);
      } else {
        store.putDocument(resource.id, withResource, { version: "", blocks: [], schema: 1 });
      }
    }
    return buildFoundryJournal(resource, resource.documents ?? [], blocksByDocumentId);
  }

  function branchIds(listed, parentId) {
    if (!parentId) return new Set(listed.map((resource) => resource.id));
    const children = new Map();
    for (const resource of listed) {
      const key = resource.parentId ?? "";
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(resource.id);
    }
    const ids = new Set([parentId]);
    const stack = [parentId];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const child of children.get(current) ?? []) {
        if (!ids.has(child)) {
          ids.add(child);
          stack.push(child);
        }
      }
    }
    return ids;
  }

  async function applyOperation(resourceId, documentId, operation, version) {
    if (operation.op === "update") {
      const written = await lk.updateBlock(resourceId, documentId, operation.blockId, { ...operation.fields, ifMatch: version });
      return written.version;
    }
    if (operation.op === "insert") {
      const written = await lk.insertBlock(resourceId, documentId, { block: operation.block, after: operation.after, ifMatch: version });
      return written.version;
    }
    if (operation.op === "move") {
      const written = await lk.moveBlock(resourceId, documentId, operation.blockId, { after: operation.after, ifMatch: version });
      return written.version;
    }
    if (operation.op === "delete") {
      const written = await lk.deleteBlock(resourceId, documentId, operation.blockId, { ifMatch: version });
      return written.version;
    }
    throw syncError("UNKNOWN_OP", `Unknown block operation ${operation.op}`);
  }

  return {
    async importBranch({ parentId = null, actor = "gm" } = {}) {
      const listed = await lk.listResources();
      const ids = branchIds(listed, parentId);
      const journals = [];
      for (const summary of listed) {
        if (!ids.has(summary.id)) continue;
        const resource = await lk.getResource(summary.id);
        journals.push(await rememberResource(resource));
      }
      store.audit(actor, "import", { count: journals.length, parentId });
      return { journals };
    },

    async createJournal({ name, id = newResourceId(), padBytes, actor = "gm" } = {}) {
      const idempotencyKey = `create-${id}`;
      const opId = store.beginOperation({
        opKey: idempotencyKey,
        kind: "create-resource",
        idempotencyKey,
        payload: { id, name, padBytes }
      });
      try {
        const created = await lk.createResource({ id, name, padBytes }, { idempotencyKey });
        const journal = await rememberResource(created);
        store.completeOperation(opId, { id: created.id }, {
          responseBytes: created.responseBytes ?? 0,
          responseStored: created.idempotencyStored !== false
        });
        store.audit(actor, "create-resource", { id });
        return { resourceId: created.id, journal };
      } catch (error) {
        if (error.code !== "CRASH_AFTER_WRITE") store.failOperation(opId, error);
        throw error;
      }
    },

    async exportJournals(resources, actor = "gm") {
      if (!Array.isArray(resources) || resources.length === 0 || resources.length > 100) {
        throw syncError("BATCH_SIZE", "Bulk export accepts 1 to 100 new resources");
      }
      const result = await lk.createMany(resources);
      store.audit(actor, "create-many", { count: resources.length });
      return result;
    },

    async createDocument(resourceId, { name, type = "page", actor = "gm" } = {}) {
      const document = await lk.createDocument(resourceId, { name, type });
      const blocks = document.type === "page" || document.type === "blank"
        ? await lk.getBlocks(resourceId, document.id)
        : { version: "", blocks: [], schema: 1 };
      store.putDocument(resourceId, { ...document, resourceId }, blocks);
      store.audit(actor, "create-document", { resourceId, documentId: document.id });
      const resource = store.getResource(resourceId);
      return {
        document,
        page: projectDocument({ ...document, resourceId }, blocks),
        journalName: resource?.name ?? ""
      };
    },

    async editorTree(resourceId, documentId) {
      const blocks = await lk.getBlocks(resourceId, documentId);
      const stored = store.getDocument(resourceId, documentId);
      return {
        version: blocks.version,
        blocks: blocks.blocks,
        isHidden: Boolean(stored?.isHidden),
        missingIds: diffSafe(blocks.blocks)
      };
    },

    async editDocument(resourceId, documentId, { baseVersion, blocks, actor = "gm" }) {
      const stored = store.getDocument(resourceId, documentId);
      if (!stored?.baseline) throw syncError("NO_BASELINE", "Import the page before editing it");
      let operations;
      try {
        operations = diffBlocks(stored.baseline.blocks, blocks);
      } catch (error) {
        const opId = store.beginOperation({
          opKey: newOperationKey("edit"),
          kind: "edit",
          payload: { resourceId, documentId, baseVersion, blocks }
        });
        store.failOperation(opId, error);
        return { state: "failed", error: error.message, code: error.code, retained: blocks, operations: [] };
      }
      const opId = store.beginOperation({
        opKey: newOperationKey("edit"),
        kind: "edit",
        payload: { resourceId, documentId, baseVersion, operations, blocks }
      });
      try {
        let version = baseVersion;
        for (const operation of operations) version = await applyOperation(resourceId, documentId, operation, version);
        const fresh = await lk.getBlocks(resourceId, documentId);
        store.putDocument(resourceId, { ...stored, version: fresh.version }, fresh);
        store.completeOperation(opId, { version: fresh.version });
        store.audit(actor, "edit", { resourceId, documentId, blockIds: operations.map((item) => item.blockId).filter(Boolean) });
        return { state: "synced", version: fresh.version, operations };
      } catch (error) {
        if (isVersionMismatch(error)) {
          const fresh = await lk.getBlocks(resourceId, documentId);
          const blockId = operations.find((item) => item.op === "update")?.blockId ?? operations[0]?.blockId ?? "document";
          const conflictId = store.addConflict({
            resourceId,
            documentId,
            blockId,
            legendkeeper: findBlock(fresh.blocks, blockId) ?? fresh.blocks,
            foundry: findBlock(blocks, blockId) ?? blocks
          });
          store.failOperation(opId, error);
          store.audit(actor, "conflict", { conflictId, resourceId, documentId, blockId });
          return { state: "failed", error: "LegendKeeper changed this block before the save was accepted", code: "VERSION_MISMATCH", conflictId, retained: blocks };
        }
        if (error.code !== "CRASH_AFTER_WRITE") store.failOperation(opId, error);
        if (error.code === "CRASH_AFTER_WRITE") throw error;
        return { state: "failed", error: error.message, code: error.code, retained: blocks };
      }
    },

    async migrateIds(resourceId, documentId, { confirm = false, actor = "gm" } = {}) {
      if (confirm !== true) throw syncError("MIGRATION_UNCONFIRMED", "Block id migration requires explicit authorization");
      const assigned = await lk.assignBlockIds(resourceId, documentId);
      const fresh = await lk.getBlocks(resourceId, documentId);
      const stored = store.getDocument(resourceId, documentId);
      store.putDocument(resourceId, { ...(stored ?? { id: documentId, type: "page", name: "" }), version: fresh.version }, fresh);
      store.audit(actor, "assign-block-ids", { resourceId, documentId, assigned: assigned.assigned, version: fresh.version });
      return { assigned: assigned.assigned, version: fresh.version, blocks: fresh.blocks };
    },

    acquireLeader(clientId, ttlMs = 30_000) {
      const leaseUntil = new Date(Date.now() + ttlMs).toISOString();
      const acquired = store.acquireLeader(clientId, leaseUntil);
      return { acquired, clientId, leaseUntil };
    },

    async poll({ full = false, leaderClientId }) {
      assertLeader(leaderClientId);
      const remote = await lk.listResources();
      const updates = [];
      for (const summary of remote) {
        const local = store.getResource(summary.id);
        const candidate = !local || local.updatedAt !== summary.updatedAt;
        if (!candidate && !full) {
          store.audit("poll", "skipped-unconfirmed", { id: summary.id });
          continue;
        }
        const resource = await lk.getResource(summary.id);
        store.putResource({ ...resource, foundryUuid: local?.foundryUuid ?? null });
        for (const document of resource.documents ?? []) {
          if (document.type !== "page" && document.type !== "blank") continue;
          const blocks = await lk.getBlocks(resource.id, document.id);
          const stored = store.getDocument(resource.id, document.id);
          if (stored?.baseline && stored.version === blocks.version) continue;
          const open = store.listConflicts().some((conflict) => conflict.state === "open" && conflict.documentId === document.id);
          if (open) continue;
          store.putDocument(resource.id, { ...document, resourceId: resource.id }, blocks);
          const system = projectDocument({ ...document, resourceId: resource.id }, blocks);
          if (system) updates.push({ resourceId: resource.id, documentId: document.id, system });
        }
      }
      store.audit(leaderClientId, full ? "reconcile" : "poll", { updates: updates.length });
      return { updates };
    },

    async resolveConflict(id, { choice, blocks, leaderClientId, actor = "gm" }) {
      assertLeader(leaderClientId);
      const conflict = store.listConflicts().find((item) => item.id === id);
      if (!conflict || conflict.state !== "open") throw syncError("NO_CONFLICT", "That conflict is not open");
      const fresh = await lk.getBlocks(conflict.resourceId, conflict.documentId);
      if (choice === "legendkeeper") {
        const stored = store.getDocument(conflict.resourceId, conflict.documentId);
        store.putDocument(conflict.resourceId, { ...stored, version: fresh.version }, fresh);
        store.setConflictState(id, "kept-legendkeeper");
        store.audit(actor, "resolve-conflict", { id, choice });
        return { state: "synced", version: fresh.version, system: projectDocument(stored, fresh) };
      }
      const nextBlocks = choice === "foundry" ? replaceBlock(fresh.blocks, conflict.blockId, conflict.foundry) : blocks;
      if (!nextBlocks) throw syncError("MERGE_REQUIRED", "Manual merge requires the merged block tree");
      const stored = store.getDocument(conflict.resourceId, conflict.documentId);
      store.putDocument(conflict.resourceId, stored, { ...fresh, blocks: fresh.blocks });
      const result = await this.editDocument(conflict.resourceId, conflict.documentId, { baseVersion: fresh.version, blocks: nextBlocks, actor });
      if (result.state === "synced") store.setConflictState(id, choice === "foundry" ? "kept-foundry" : "merged");
      return result;
    },

    requestDeletion(deletion) {
      const id = store.queueDeletion(deletion);
      store.audit(deletion.source ?? "gm", "queue-deletion", deletion);
      return { id, state: "pending" };
    },

    async reviewDeletion(id, decision, { leaderClientId }) {
      assertLeader(leaderClientId);
      const deletion = store.listDeletions().find((item) => item.id === id);
      if (!deletion || deletion.state !== "pending") throw syncError("NO_DELETION", "That deletion is not awaiting review");
      if (decision !== "approve") {
        store.setDeletionState(id, "rejected");
        return { id, state: "rejected" };
      }
      if (deletion.targetType === "resource") await lk.deleteResource(deletion.resourceId, { cascade: Boolean(deletion.cascade) });
      else await lk.deleteDocument(deletion.resourceId, deletion.documentId);
      store.setDeletionState(id, "approved");
      return { id, state: "approved" };
    },

    async restore(target, { leaderClientId }) {
      assertLeader(leaderClientId);
      if (target.documentId) return lk.restoreDocument(target.resourceId, target.documentId);
      return lk.restoreResource(target.resourceId);
    },

    async recover() {
      const running = store.listOperations("running");
      const report = [];
      for (const operation of running) {
        if (operation.kind !== "create-resource") {
          store.markPending(operation.id);
          report.push({ id: operation.id, state: "pending" });
          continue;
        }
        try {
          const existing = await lk.getResource(operation.payload.id);
          await rememberResource(existing);
          store.completeOperation(operation.id, { id: existing.id }, { responseStored: false, responseBytes: operation.responseBytes ?? 0 });
          report.push({ id: operation.id, state: "completed", verifiedId: existing.id });
        } catch (error) {
          if (!isNotFound(error)) throw error;
          store.markPending(operation.id);
          report.push({ id: operation.id, state: "pending" });
        }
      }
      store.audit("recovery", "startup", { operations: report.length });
      return report;
    },

    backup(dest) {
      store.backup(dest);
    },

    listOperations() {
      return store.listOperations();
    },

    gmView(resourceId) {
      return {
        resourceId,
        hiddenDocuments: store.listDocuments(resourceId)
          .filter((document) => document.isHidden)
          .map((document) => ({ id: document.id, name: document.name }))
      };
    }
  };
}

function diffSafe(blocks) {
  try {
    diffBlocks(blocks, blocks);
    return [];
  } catch (error) {
    if (error.code === "NEEDS_ID_MIGRATION") return error.paths;
    throw error;
  }
}

function replaceBlock(blocks, blockId, replacement) {
  const next = structuredClone(blocks);
  const walk = (list) => {
    for (let index = 0; index < list.length; index += 1) {
      if (list[index]?.id === blockId) {
        list[index] = structuredClone(replacement);
        return true;
      }
      if (Array.isArray(list[index].children) && walk(list[index].children)) return true;
      if (Array.isArray(list[index].rows) && walk(list[index].rows)) return true;
    }
    return false;
  };
  if (!walk(next)) return null;
  return next;
}
