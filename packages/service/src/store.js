import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE checkpoints (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_consistent_op INTEGER,
        updated_at TEXT NOT NULL
      );
      INSERT INTO checkpoints (id, last_consistent_op, updated_at) VALUES (1, 0, '');
      CREATE TABLE tokens (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        client_id TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE resources (
        lk_resource_id TEXT PRIMARY KEY,
        parent_id TEXT,
        name TEXT NOT NULL,
        rank TEXT,
        updated_at TEXT,
        is_hidden INTEGER NOT NULL DEFAULT 0,
        foundry_uuid TEXT,
        raw_json TEXT NOT NULL
      );
      CREATE TABLE documents (
        lk_resource_id TEXT NOT NULL,
        lk_document_id TEXT NOT NULL,
        name TEXT,
        type TEXT NOT NULL,
        rank TEXT,
        is_hidden INTEGER NOT NULL,
        is_full_width INTEGER NOT NULL DEFAULT 0,
        version TEXT,
        updated_at TEXT,
        foundry_uuid TEXT,
        baseline_json TEXT,
        PRIMARY KEY (lk_resource_id, lk_document_id)
      );
      CREATE TABLE properties (
        lk_resource_id TEXT NOT NULL,
        property_id TEXT NOT NULL,
        is_hidden INTEGER NOT NULL,
        baseline_json TEXT NOT NULL,
        PRIMARY KEY (lk_resource_id, property_id)
      );
      CREATE TABLE media (
        asset_id TEXT PRIMARY KEY,
        url TEXT,
        content_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE operations (
        id INTEGER PRIMARY KEY,
        op_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        idempotency_key TEXT,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        response_bytes INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE conflicts (
        id INTEGER PRIMARY KEY,
        lk_resource_id TEXT NOT NULL,
        lk_document_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        lk_json TEXT NOT NULL,
        foundry_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE deletions (
        id INTEGER PRIMARY KEY,
        target_type TEXT NOT NULL,
        lk_resource_id TEXT NOT NULL,
        lk_document_id TEXT,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE TABLE leader (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        client_id TEXT NOT NULL,
        lease_until TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `ALTER TABLE operations ADD COLUMN response_stored INTEGER NOT NULL DEFAULT 0;`
  },
  {
    version: 3,
    sql: `
      ALTER TABLE documents ADD COLUMN draft_json TEXT;
      ALTER TABLE documents ADD COLUMN remote_json TEXT;
    `
  }
];

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString()
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openStore(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return createStore(db, path);
}

function createStore(db, path) {
  const now = () => new Date().toISOString();
  return {
    path,
    db,
    close() {
      db.close();
    },
    migrationVersions() {
      return db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
    },
    backup(dest) {
      const escaped = dest.replaceAll("'", "''");
      db.exec(`VACUUM INTO '${escaped}'`);
    },
    putResource(resource) {
      db.prepare(`INSERT INTO resources
        (lk_resource_id, parent_id, name, rank, updated_at, is_hidden, foundry_uuid, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lk_resource_id) DO UPDATE SET
          parent_id = excluded.parent_id,
          name = excluded.name,
          rank = excluded.rank,
          updated_at = excluded.updated_at,
          is_hidden = excluded.is_hidden,
          foundry_uuid = COALESCE(excluded.foundry_uuid, resources.foundry_uuid),
          raw_json = excluded.raw_json`).run(
        resource.id,
        resource.parentId ?? null,
        resource.name,
        resource.rank ?? "",
        resource.updatedAt ?? null,
        resource.isHidden ? 1 : 0,
        resource.foundryUuid ?? null,
        JSON.stringify(resource)
      );
    },
    getResource(id) {
      const row = db.prepare("SELECT raw_json, foundry_uuid, updated_at FROM resources WHERE lk_resource_id = ?").get(id);
      if (!row) return null;
      return { ...JSON.parse(row.raw_json), foundryUuid: row.foundry_uuid, updatedAt: row.updated_at };
    },
    listResources() {
      return db.prepare("SELECT raw_json, foundry_uuid, updated_at FROM resources").all().map((row) => ({
        ...JSON.parse(row.raw_json),
        foundryUuid: row.foundry_uuid,
        updatedAt: row.updated_at
      }));
    },
    putDocument(resourceId, document, baseline) {
      const baselineJson = JSON.stringify(baseline ?? null);
      db.prepare(`INSERT INTO documents
        (lk_resource_id, lk_document_id, name, type, rank, is_hidden, is_full_width, version, updated_at, foundry_uuid, baseline_json, draft_json, remote_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(lk_resource_id, lk_document_id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          rank = excluded.rank,
          is_hidden = excluded.is_hidden,
          is_full_width = excluded.is_full_width,
          version = excluded.version,
          updated_at = excluded.updated_at,
          foundry_uuid = COALESCE(excluded.foundry_uuid, documents.foundry_uuid),
          baseline_json = excluded.baseline_json,
          draft_json = NULL,
          remote_json = excluded.remote_json`).run(
        resourceId,
        document.id,
        document.name ?? "",
        document.type,
        document.rank ?? "",
        document.isHidden ? 1 : 0,
        document.isFullWidth ? 1 : 0,
        baseline?.version ?? document.version ?? "",
        document.updatedAt ?? null,
        document.foundryUuid ?? null,
        baselineJson,
        baselineJson
      );
    },
    setDraft(resourceId, documentId, draft) {
      db.prepare(`UPDATE documents SET draft_json = ? WHERE lk_resource_id = ? AND lk_document_id = ?`).run(
        JSON.stringify(draft),
        resourceId,
        documentId
      );
    },
    setRemote(resourceId, documentId, remote) {
      db.prepare(`UPDATE documents SET remote_json = ? WHERE lk_resource_id = ? AND lk_document_id = ?`).run(
        JSON.stringify(remote),
        resourceId,
        documentId
      );
    },
    setResourceFoundryUuid(resourceId, foundryUuid) {
      db.prepare("UPDATE resources SET foundry_uuid = ? WHERE lk_resource_id = ?").run(foundryUuid, resourceId);
    },
    setDocumentFoundryUuid(resourceId, documentId, foundryUuid) {
      db.prepare(`UPDATE documents SET foundry_uuid = ? WHERE lk_resource_id = ? AND lk_document_id = ?`).run(
        foundryUuid,
        resourceId,
        documentId
      );
    },
    getDocument(resourceId, documentId) {
      const row = db.prepare(`SELECT * FROM documents WHERE lk_resource_id = ? AND lk_document_id = ?`).get(resourceId, documentId);
      if (!row) return null;
      return {
        resourceId,
        id: documentId,
        name: row.name,
        type: row.type,
        rank: row.rank,
        isHidden: Boolean(row.is_hidden),
        isFullWidth: Boolean(row.is_full_width),
        version: row.version,
        updatedAt: row.updated_at,
        foundryUuid: row.foundry_uuid,
        baseline: row.baseline_json ? JSON.parse(row.baseline_json) : null,
        draft: row.draft_json ? JSON.parse(row.draft_json) : null,
        remote: row.remote_json ? JSON.parse(row.remote_json) : null
      };
    },
    listDocuments(resourceId) {
      return db.prepare("SELECT lk_document_id FROM documents WHERE lk_resource_id = ?").all(resourceId)
        .map((row) => this.getDocument(resourceId, row.lk_document_id));
    },
    putProperty(resourceId, property) {
      db.prepare(`INSERT INTO properties (lk_resource_id, property_id, is_hidden, baseline_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(lk_resource_id, property_id) DO UPDATE SET
          is_hidden = excluded.is_hidden,
          baseline_json = excluded.baseline_json`).run(
        resourceId,
        property.id,
        property.isHidden ? 1 : 0,
        JSON.stringify(property)
      );
    },
    listProperties(resourceId) {
      return db.prepare("SELECT baseline_json FROM properties WHERE lk_resource_id = ?").all(resourceId)
        .map((row) => JSON.parse(row.baseline_json));
    },
    putMedia(asset) {
      db.prepare(`INSERT INTO media (asset_id, url, content_hash, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET url = excluded.url, content_hash = excluded.content_hash`).run(
        asset.id,
        asset.url ?? null,
        asset.hash ?? null,
        now()
      );
    },
    beginOperation({ opKey, kind, idempotencyKey = null, payload }) {
      const timestamp = now();
      const info = db.prepare(`INSERT INTO operations
        (op_key, kind, state, idempotency_key, payload_json, response_bytes, response_stored, error, created_at, updated_at)
        VALUES (?, ?, 'running', ?, ?, NULL, 0, NULL, ?, ?)`).run(
        opKey,
        kind,
        idempotencyKey,
        JSON.stringify(payload),
        timestamp,
        timestamp
      );
      return Number(info.lastInsertRowid);
    },
    completeOperation(id, result, { responseBytes = 0, responseStored = false } = {}) {
      const timestamp = now();
      db.prepare(`UPDATE operations SET state = 'completed', result_json = ?, response_bytes = ?, response_stored = ?, updated_at = ?, error = NULL WHERE id = ?`).run(
        JSON.stringify(result ?? null),
        responseBytes,
        responseStored ? 1 : 0,
        timestamp,
        id
      );
      db.prepare("UPDATE checkpoints SET last_consistent_op = ?, updated_at = ? WHERE id = 1").run(id, timestamp);
    },
    failOperation(id, error) {
      db.prepare("UPDATE operations SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
        error?.message ?? String(error),
        now(),
        id
      );
    },
    markPending(id) {
      db.prepare("UPDATE operations SET state = 'pending', updated_at = ? WHERE id = ?").run(now(), id);
    },
    listOperations(state) {
      const rows = state
        ? db.prepare("SELECT * FROM operations WHERE state = ? ORDER BY id").all(state)
        : db.prepare("SELECT * FROM operations ORDER BY id").all();
      return rows.map(hydrateOperation);
    },
    getOperation(id) {
      const row = db.prepare("SELECT * FROM operations WHERE id = ?").get(id);
      return row ? hydrateOperation(row) : null;
    },
    addConflict(conflict) {
      const info = db.prepare(`INSERT INTO conflicts
        (lk_resource_id, lk_document_id, block_id, lk_json, foundry_json, state, created_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?)`).run(
        conflict.resourceId,
        conflict.documentId,
        conflict.blockId,
        JSON.stringify(conflict.legendkeeper),
        JSON.stringify(conflict.foundry),
        now()
      );
      return Number(info.lastInsertRowid);
    },
    listConflicts() {
      return db.prepare("SELECT * FROM conflicts ORDER BY id").all().map((row) => ({
        id: row.id,
        resourceId: row.lk_resource_id,
        documentId: row.lk_document_id,
        blockId: row.block_id,
        legendkeeper: JSON.parse(row.lk_json),
        foundry: JSON.parse(row.foundry_json),
        state: row.state
      }));
    },
    setConflictState(id, state) {
      db.prepare("UPDATE conflicts SET state = ? WHERE id = ?").run(state, id);
    },
    queueDeletion(deletion) {
      const info = db.prepare(`INSERT INTO deletions
        (target_type, lk_resource_id, lk_document_id, source, state, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)`).run(
        deletion.targetType,
        deletion.resourceId,
        deletion.documentId ?? null,
        deletion.source,
        now()
      );
      return Number(info.lastInsertRowid);
    },
    listDeletions() {
      return db.prepare("SELECT * FROM deletions ORDER BY id").all().map((row) => ({
        id: row.id,
        targetType: row.target_type,
        resourceId: row.lk_resource_id,
        documentId: row.lk_document_id,
        source: row.source,
        state: row.state
      }));
    },
    setDeletionState(id, state) {
      db.prepare("UPDATE deletions SET state = ? WHERE id = ?").run(state, id);
    },
    audit(actor, action, detail) {
      db.prepare("INSERT INTO audit (at, actor, action, detail_json) VALUES (?, ?, ?, ?)").run(
        now(),
        actor,
        action,
        JSON.stringify(detail ?? {})
      );
    },
    acquireLeader(clientId, leaseUntil) {
      const current = db.prepare("SELECT client_id, lease_until FROM leader WHERE id = 1").get();
      const timestamp = now();
      if (current && current.client_id !== clientId && current.lease_until > timestamp) return false;
      db.prepare(`INSERT INTO leader (id, client_id, lease_until) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, lease_until = excluded.lease_until`).run(clientId, leaseUntil);
      return true;
    },
    leader() {
      return db.prepare("SELECT client_id, lease_until FROM leader WHERE id = 1").get() ?? null;
    },
    saveToken(token) {
      db.prepare("INSERT INTO tokens (id, secret_hash, client_id, revoked_at, created_at) VALUES (?, ?, ?, NULL, ?)").run(
        token.id,
        token.secretHash,
        token.clientId,
        now()
      );
    },
    findToken(id) {
      const row = db.prepare("SELECT * FROM tokens WHERE id = ?").get(id);
      if (!row) return null;
      return { id: row.id, secretHash: row.secret_hash, clientId: row.client_id, revokedAt: row.revoked_at };
    },
    revokeToken(id) {
      db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(now(), id);
    }
  };
}

function hydrateOperation(row) {
  return {
    id: row.id,
    opKey: row.op_key,
    kind: row.kind,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    responseBytes: row.response_bytes,
    responseStored: Boolean(row.response_stored),
    error: row.error
  };
}
