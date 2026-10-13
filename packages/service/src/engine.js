import { missingBlockIds, findBlock } from "../../foundry/module/domain/blocks.mjs";
import { diffBlocks } from "../../foundry/module/domain/diff.mjs";
import { buildFoundryJournal } from "../../foundry/module/domain/journal.mjs";
import { projectDocument } from "../../foundry/module/domain/redact.mjs";
import { sameBlockConflict } from "../../foundry/module/domain/reconcile.mjs";
import { applyTextEdits, isRunArray, runEditProblem } from "../../foundry/module/domain/runs.mjs";
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

  function knownVersion(stored, baseVersion) {
    return [stored?.version, stored?.baseline?.version, stored?.remote?.version].includes(baseVersion);
  }

  async function confirmParagraph(resourceId, documentId, blockId, content, version, opId, actor) {
    await lk.updateBlock(resourceId, documentId, blockId, { content, ifMatch: version });
    const fresh = await lk.getBlocks(resourceId, documentId);
    const stored = store.getDocument(resourceId, documentId);
    store.putDocument(resourceId, { ...stored, version: fresh.version }, fresh);
    store.completeOperation(opId, { version: fresh.version });
    store.audit(actor, "edit", { resourceId, documentId, blockIds: [blockId] });
    return fresh;
  }

  async function reconcileParagraph(resourceId, documentId, blockId, content, actor, opId) {
    const stored = store.getDocument(resourceId, documentId);
    const remote = await lk.getBlocks(resourceId, documentId);
    store.setRemote(resourceId, documentId, remote);
    if (!sameBlockConflict(stored.baseline.blocks, remote.blocks, blockId)) {
      try {
        const fresh = await confirmParagraph(resourceId, documentId, blockId, content, remote.version, opId, actor);
        return { state: "synced", version: fresh.version, operations: [{ op: "update", blockId }], merged: true };
      } catch (error) {
        if (!isVersionMismatch(error)) {
          store.failOperation(opId, error);
          return { state: "failed", error: error.message, code: error.code ?? "ERROR", retained: content, operations: [] };
        }
      }
    }
    const conflictId = store.addConflict({
      resourceId,
      documentId,
      blockId,
      legendkeeper: findBlock(remote.blocks, blockId),
      foundry: { id: blockId, kind: "paragraph", content }
    });
    store.failOperation(opId, syncError("VERSION_MISMATCH", "LegendKeeper changed this block before the save was accepted"));
    store.audit(actor, "conflict", { conflictId, resourceId, documentId, blockId });
    return {
      state: "failed",
      error: "LegendKeeper changed this block before the save was accepted",
      code: "VERSION_MISMATCH",
      conflictId,
      retained: content,
      operations: []
    };
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
      const remote = await lk.getBlocks(resourceId, documentId);
      const stored = store.getDocument(resourceId, documentId);
      if (stored) store.setRemote(resourceId, documentId, remote);
      const baseline = stored?.baseline ?? null;
      return {
        version: stored?.version ?? remote.version,
        blocks: baseline?.blocks ?? remote.blocks,
        baseline,
        draft: stored?.draft ?? null,
        remote,
        remoteVersion: remote.version,
        isHidden: Boolean(stored?.isHidden),
        missingIds: diffSafe(baseline?.blocks ?? remote.blocks)
      };
    },

    async editDocument() {
      return {
        state: "failed",
        code: "FULL_TREE_REFUSED",
        error: "Saves must update one paragraph's content. A full block tree is not accepted.",
        retained: null,
        operations: []
      };
    },

    async editParagraph(resourceId, documentId, { baseVersion, blockId, content, actor = "gm" }) {
      const stored = store.getDocument(resourceId, documentId);
      if (!stored?.baseline) throw syncError("NO_BASELINE", "Import the page before editing it");
      const baselineBlock = findBlock(stored.baseline.blocks, blockId);
      if (!isRunArray(content)) {
        return { state: "failed", code: "INVALID_CONTENT", error: "Paragraph content must be an array of runs", retained: content ?? null, operations: [] };
      }
      if (!baselineBlock) {
        const missing = missingBlockIds(stored.baseline.blocks);
        if (missing.length > 0) {
          return { state: "failed", code: "NEEDS_ID_MIGRATION", error: "This page needs a one-time block id migration before it can be edited", retained: content, operations: [] };
        }
        return { state: "failed", code: "NOT_A_PARAGRAPH", error: "Only an existing paragraph can be edited in this pass", retained: content, operations: [] };
      }
      if (baselineBlock.kind !== "paragraph") {
        return { state: "failed", code: "NOT_A_PARAGRAPH", error: "Only an existing paragraph can be edited in this pass", retained: content, operations: [] };
      }
      const problem = runEditProblem(baselineBlock.content ?? [], content);
      const draft = { blockId, baseVersion, content };
      store.setDraft(resourceId, documentId, draft);
      if (problem) {
        const message = problem === "FORMAT_LOSS"
          ? "Refusing to collapse a formatted paragraph into plain text"
          : problem === "RUN_STRUCTURE"
            ? "Refusing to add, remove, or retarget runs"
            : "Paragraph content must be an array of runs";
        return { state: "failed", code: problem, error: message, retained: content, operations: [] };
      }
      const written = applyTextEdits(baselineBlock.content ?? [], content);
      const opId = store.beginOperation({
        opKey: newOperationKey("edit"),
        kind: "edit",
        payload: { resourceId, documentId, baseVersion, blockId, content: written }
      });
      try {
        if (!knownVersion(stored, baseVersion)) {
          return await reconcileParagraph(resourceId, documentId, blockId, written, actor, opId);
        }
        const fresh = await confirmParagraph(resourceId, documentId, blockId, written, baseVersion, opId, actor);
        return { state: "synced", version: fresh.version, operations: [{ op: "update", blockId }] };
      } catch (error) {
        if (error.code === "CRASH_AFTER_WRITE") throw error;
        if (isVersionMismatch(error)) return reconcileParagraph(resourceId, documentId, blockId, written, actor, opId);
        try {
          store.setRemote(resourceId, documentId, await lk.getBlocks(resourceId, documentId));
        } catch {
          // The baseline and the draft stay as they were.
        }
        store.failOperation(opId, error);
        return { state: "failed", error: error.message, code: error.code ?? "ERROR", retained: written, operations: [] };
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
          if (stored?.baseline && stored.version === blocks.version && !stored.draft) continue;
          const open = store.listConflicts().some((conflict) => conflict.state === "open" && conflict.documentId === document.id);
          if (open || stored?.draft) {
            store.setRemote(resource.id, document.id, blocks);
            continue;
          }
          store.putDocument(resource.id, { ...document, resourceId: resource.id }, blocks);
          const system = projectDocument({ ...document, resourceId: resource.id }, blocks);
          if (system) updates.push({ resourceId: resource.id, documentId: document.id, system });
        }
      }
      store.audit(leaderClientId, full ? "reconcile" : "poll", { updates: updates.length });
      return { updates };
    },

    async resolveConflict(id, { choice, content, leaderClientId, actor = "gm" }) {
      assertLeader(leaderClientId);
      const conflict = store.listConflicts().find((item) => item.id === id);
      if (!conflict || conflict.state !== "open") throw syncError("NO_CONFLICT", "That conflict is not open");
      const fresh = await lk.getBlocks(conflict.resourceId, conflict.documentId);
      store.setRemote(conflict.resourceId, conflict.documentId, fresh);
      if (choice === "legendkeeper") {
        const stored = store.getDocument(conflict.resourceId, conflict.documentId);
        store.putDocument(conflict.resourceId, { ...stored, version: fresh.version }, fresh);
        store.setConflictState(id, "kept-legendkeeper");
        store.audit(actor, "resolve-conflict", { id, choice });
        return { state: "synced", version: fresh.version, system: projectDocument(stored, fresh) };
      }
      const nextContent = choice === "foundry" ? conflict.foundry?.content : content;
      if (!Array.isArray(nextContent)) throw syncError("MERGE_REQUIRED", "Manual merge requires the merged paragraph runs");
      const result = await this.editParagraph(conflict.resourceId, conflict.documentId, {
        baseVersion: fresh.version,
        blockId: conflict.blockId,
        content: nextContent,
        actor
      });
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
    },

    registerFoundryMapping(resourceId, { foundryUuid = null, pages = [] } = {}) {
      const resource = store.getResource(resourceId);
      if (!resource) throw syncError("NOT_FOUND", "Import the journal before registering Foundry ids");
      if (foundryUuid) store.setResourceFoundryUuid(resourceId, foundryUuid);
      const registered = [];
      for (const page of pages) {
        if (!page?.documentId || !page.foundryUuid) continue;
        const document = store.getDocument(resourceId, page.documentId);
        if (!document) continue;
        store.setDocumentFoundryUuid(resourceId, page.documentId, page.foundryUuid);
        registered.push({ documentId: page.documentId, foundryUuid: page.foundryUuid });
      }
      store.audit("foundry", "register-uuids", { resourceId, foundryUuid, pages: registered.length });
      return { resourceId, foundryUuid, pages: registered };
    },

    listConflicts() {
      return store.listConflicts();
    },

    listDeletions() {
      return store.listDeletions();
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

