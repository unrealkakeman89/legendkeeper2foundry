import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createEngine } from "./engine.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hashSecret(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function send(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createApp({ lk, store, pairingCode, allowedOrigins = [] }) {
  const engine = createEngine({ lk, store });
  const origins = new Set(allowedOrigins);

  function corsHeaders(origin) {
    if (!origin || !origins.has(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, content-type, x-legendkeeper-request",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      vary: "Origin"
    };
  }

  function authorize(request) {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const [id, secret] = token.split(".");
    if (!id || !secret) return null;
    const record = store.findToken(id);
    if (!record || record.revokedAt) return null;
    if (!safeEqual(record.secretHash, hashSecret(secret))) return null;
    return record;
  }

  async function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    const origin = request.headers.origin;
    const headers = corsHeaders(origin);
    if (origin && !origins.has(origin)) {
      send(response, 403, { error: "Origin is not allowlisted" }, headers);
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (MUTATING.has(request.method) && request.headers["x-legendkeeper-request"] !== "1") {
      send(response, 403, { error: "Missing request validation header" }, headers);
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { ok: true }, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/pair") {
        const body = await readJson(request);
        if (!pairingCode || body.pairingCode !== pairingCode) {
          send(response, 401, { error: "Pairing code rejected" }, headers);
          return;
        }
        const secret = randomBytes(32).toString("hex");
        const id = randomBytes(8).toString("hex");
        store.saveToken({ id, secretHash: hashSecret(secret), clientId: body.clientId || "gm" });
        store.audit(body.clientId || "gm", "pair", { tokenId: id });
        send(response, 201, { token: `${id}.${secret}`, tokenId: id }, headers);
        return;
      }
      const session = authorize(request);
      if (!session) {
        send(response, 401, { error: "Unauthorized" }, headers);
        return;
      }
      const body = MUTATING.has(request.method) ? await readJson(request) : {};
      if (request.method === "POST" && url.pathname === "/v1/tokens/revoke") {
        store.revokeToken(body.tokenId || session.id);
        send(response, 200, { revoked: true }, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/import") {
        send(response, 200, await engine.importBranch({ parentId: body.parentId ?? null, actor: session.clientId }), headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/journals" && !url.pathname.endsWith("/bulk")) {
        send(response, 201, await engine.createJournal({ name: body.name, id: body.id, actor: session.clientId }), headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/journals/bulk") {
        send(response, 201, await engine.exportJournals(body.resources, session.clientId), headers);
        return;
      }
      const gmView = url.pathname.match(/^\/v1\/journals\/([^/]+)\/gm$/);
      if (request.method === "GET" && gmView) {
        send(response, 200, engine.gmView(gmView[1]), headers);
        return;
      }
      const documentCreate = url.pathname.match(/^\/v1\/journals\/([^/]+)\/documents$/);
      if (request.method === "POST" && documentCreate) {
        send(response, 201, await engine.createDocument(documentCreate[1], { name: body.name, type: body.type, actor: session.clientId }), headers);
        return;
      }
      const editor = url.pathname.match(/^\/v1\/documents\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && editor) {
        send(response, 200, await engine.editorTree(editor[1], editor[2]), headers);
        return;
      }
      const edit = url.pathname.match(/^\/v1\/documents\/([^/]+)\/([^/]+)\/edits$/);
      if (request.method === "POST" && edit) {
        if (body.blocks !== undefined) {
          send(response, 200, await engine.editDocument(), headers);
          return;
        }
        send(response, 200, await engine.editParagraph(edit[1], edit[2], {
          baseVersion: body.baseVersion,
          blockId: body.blockId,
          content: body.content,
          actor: session.clientId
        }), headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mappings") {
        send(response, 200, engine.registerFoundryMapping(body.resourceId, { foundryUuid: body.foundryUuid, pages: body.pages }), headers);
        return;
      }
      const migrate = url.pathname.match(/^\/v1\/documents\/([^/]+)\/([^/]+)\/migrate-ids$/);
      if (request.method === "POST" && migrate) {
        send(response, 200, await engine.migrateIds(migrate[1], migrate[2], { confirm: body.confirm === true, actor: session.clientId }), headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sync/leader") {
        send(response, 200, engine.acquireLeader(session.clientId, body.ttlMs), headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sync/poll") {
        send(response, 200, await engine.poll({ full: Boolean(body.full), leaderClientId: session.clientId }), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/conflicts") {
        send(response, 200, { conflicts: engine.listConflicts() }, headers);
        return;
      }
      const conflict = url.pathname.match(/^\/v1\/conflicts\/(\d+)\/resolve$/);
      if (request.method === "POST" && conflict) {
        send(response, 200, await engine.resolveConflict(Number(conflict[1]), {
          choice: body.choice,
          content: body.content,
          leaderClientId: session.clientId,
          actor: session.clientId
        }), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/deletions") {
        send(response, 200, { deletions: engine.listDeletions() }, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/deletions") {
        send(response, 202, engine.requestDeletion({
          targetType: body.targetType,
          resourceId: body.resourceId,
          documentId: body.documentId,
          source: session.clientId
        }), headers);
        return;
      }
      const review = url.pathname.match(/^\/v1\/deletions\/(\d+)\/review$/);
      if (request.method === "POST" && review) {
        send(response, 200, await engine.reviewDeletion(Number(review[1]), body.decision, { leaderClientId: session.clientId }), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/operations") {
        send(response, 200, { operations: engine.listOperations() }, headers);
        return;
      }
      send(response, 404, { error: "Not found" }, headers);
    } catch (error) {
      const status = error.code === "NOT_LEADER" || error.code === "MIGRATION_UNCONFIRMED" ? 409 : 400;
      send(response, status, { error: error.message, code: error.code ?? "ERROR" }, headers);
    }
  }

  return { handle, engine };
}

export function listen(app, { host = "127.0.0.1", port = 0 } = {}) {
  const server = createServer((request, response) => {
    app.handle(request, response).catch((error) => {
      send(response, 500, { error: error.message });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        url: `http://${host}:${address.port}`,
        close() {
          return new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
        }
      });
    });
  });
}
