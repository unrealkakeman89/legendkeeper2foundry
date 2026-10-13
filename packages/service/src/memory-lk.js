const IDEMPOTENCY_STORE_LIMIT = 64 * 1024;

function notFound(message = "Not found") {
  const error = new Error(message);
  error.status = 404;
  error.code = "NOT_FOUND";
  return error;
}

function conflict(code, message) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

function versionMismatch(currentVersion) {
  const error = new Error("The document changed since you read it");
  error.status = 412;
  error.code = "VERSION_MISMATCH";
  error.currentVersion = currentVersion;
  return error;
}

function walk(blocks, visit) {
  for (const block of blocks ?? []) {
    visit(block);
    if (Array.isArray(block.children)) walk(block.children, visit);
    if (Array.isArray(block.rows)) walk(block.rows, visit);
  }
}

function find(blocks, id) {
  let found;
  walk(blocks, (block) => {
    if (block.id === id) found = block;
  });
  return found;
}

function unsupportedIds(blocks) {
  const ids = [];
  walk(blocks, (block) => {
    if (block.kind === "unsupported" && block.id) ids.push(block.id);
  });
  return ids;
}

export function createMemoryLegendKeeper() {
  const resources = new Map();
  const idempotency = new Map();
  const calls = {
    listResources: 0,
    getResource: 0,
    getBlocks: 0,
    createResource: 0,
    createMany: 0,
    createDocument: 0,
    updateBlock: 0,
    insertBlock: 0,
    moveBlock: 0,
    deleteBlock: 0,
    replaceBlocks: 0,
    assignBlockIds: 0,
    deleteResource: 0,
    restoreResource: 0
  };
  let sequence = 0;

  function nextVersion() {
    sequence += 1;
    return `v${sequence}`;
  }

  function stamp(entity) {
    entity.updatedAt = new Date().toISOString();
    return entity;
  }

  function requireResource(id) {
    const resource = resources.get(id);
    if (!resource || resource.deleted) throw notFound();
    return resource;
  }

  function requireDocument(resourceId, documentId) {
    const resource = requireResource(resourceId);
    const document = resource.documents.find((item) => item.id === documentId);
    if (!document || document.deleted) throw notFound();
    return { resource, document };
  }

  function assertMatch(document, ifMatch) {
    if (ifMatch !== undefined && ifMatch !== document.version) throw versionMismatch(document.version);
  }

  function replay(key, body, execute) {
    if (!key) return { value: execute(), replayed: false, stored: false, responseBytes: 0 };
    const prior = idempotency.get(key);
    if (prior?.stored) {
      return { value: structuredClone(prior.body), replayed: true, stored: true, responseBytes: prior.responseBytes };
    }
    const value = execute();
    const responseBytes = Buffer.byteLength(JSON.stringify(value));
    const stored = responseBytes <= IDEMPOTENCY_STORE_LIMIT;
    idempotency.set(key, stored ? { stored: true, body: structuredClone(value), responseBytes } : { stored: false, responseBytes });
    return { value, replayed: false, stored, responseBytes };
  }

  function blankDocument(name = "Main") {
    return {
      id: `d${crypto.randomUUID().replaceAll("-", "").slice(0, 23)}`,
      name,
      type: "blank",
      rank: "a0",
      isHidden: false,
      isFullWidth: false,
      version: nextVersion(),
      blocks: [],
      deleted: false
    };
  }

  function rememberCreate(body) {
    if (resources.has(body.id)) throw conflict("DUPLICATE_ID", "That id is already used");
    const resource = stamp({
      id: body.id,
      name: body.name,
      parentId: body.parentId ?? null,
      tags: body.tags ?? [],
      aliases: body.aliases ?? [],
      rank: body.rank ?? `a${resources.size}`,
      isHidden: Boolean(body.isHidden),
      updatedAt: null,
      deleted: false,
      banner: body.banner ?? null,
      properties: body.properties ?? [],
      documents: []
    });
    if (Array.isArray(body.documents) && body.documents.length > 0) {
      for (const [index, document] of body.documents.entries()) {
        const created = blankDocument(document.name ?? "Main");
        created.rank = `a${index}`;
        created.type = document.type ?? (document.blocks ? "page" : "blank");
        created.isHidden = Boolean(document.isHidden);
        created.blocks = structuredClone(document.blocks ?? []);
        created.version = nextVersion();
        resource.documents.push(created);
      }
    } else {
      resource.documents.push(blankDocument());
    }
    resources.set(resource.id, resource);
    calls.createResource += 1;
    const created = publicResource(resource);
    if (body.padBytes) created.pad = "x".repeat(body.padBytes);
    return created;
  }

  function publicResource(resource) {
    return {
      id: resource.id,
      name: resource.name,
      parentId: resource.parentId,
      tags: resource.tags,
      aliases: resource.aliases,
      rank: resource.rank,
      isHidden: resource.isHidden,
      updatedAt: resource.updatedAt,
      banner: resource.banner,
      properties: resource.properties,
      documents: resource.documents.filter((document) => !document.deleted).map(publicDocument)
    };
  }

  function publicDocument(document) {
    return {
      id: document.id,
      name: document.name,
      type: document.type,
      rank: document.rank,
      isHidden: document.isHidden,
      isFullWidth: document.isFullWidth,
      updatedAt: resourceUpdated(document),
      version: document.version
    };
  }

  function resourceUpdated(document) {
    return document.updatedAt ?? null;
  }

  return {
    calls,
    idempotencyLimit: IDEMPOTENCY_STORE_LIMIT,
    crashAfterWrite: false,
    seed(resource) {
      const stored = {
        deleted: false,
        tags: [],
        aliases: [],
        properties: [],
        banner: null,
        isHidden: false,
        parentId: null,
        rank: "a0",
        updatedAt: new Date().toISOString(),
        ...resource,
        documents: (resource.documents ?? []).map((document, index) => ({
          deleted: false,
          isHidden: false,
          isFullWidth: false,
          type: "page",
          rank: `a${index}`,
          blocks: [],
          version: document.version ?? nextVersion(),
          ...document
        }))
      };
      stored.updatedAt = stored.updatedAt ?? new Date().toISOString();
      resources.set(stored.id, stored);
      return publicResource(stored);
    },
    async listResources() {
      calls.listResources += 1;
      return [...resources.values()].filter((resource) => !resource.deleted).map(publicResource);
    },
    async getResource(resourceId) {
      calls.getResource += 1;
      return publicResource(requireResource(resourceId));
    },
    async listDocuments(resourceId) {
      return requireResource(resourceId).documents.filter((document) => !document.deleted).map(publicDocument);
    },
    async listProperties(resourceId) {
      return requireResource(resourceId).properties;
    },
    async getBlocks(resourceId, documentId) {
      calls.getBlocks += 1;
      const { document } = requireDocument(resourceId, documentId);
      return {
        id: document.id,
        version: document.version,
        schema: 1,
        blocks: structuredClone(document.blocks),
        updatedAt: document.updatedAt ?? null
      };
    },
    async createResource(body, options = {}) {
      const outcome = replay(options.idempotencyKey, body, () => rememberCreate(body));
      if (this.crashAfterWrite) {
        const error = new Error("crash after write");
        error.code = "CRASH_AFTER_WRITE";
        error.partial = outcome;
        throw error;
      }
      return { ...outcome.value, idempotencyStored: outcome.stored, responseBytes: outcome.responseBytes, replayed: outcome.replayed };
    },
    async createMany(items) {
      calls.createMany += 1;
      const created = [];
      for (const item of items) created.push(rememberCreate(item));
      calls.createResource -= created.length;
      return { resources: created };
    },
    async createDocument(resourceId, body) {
      calls.createDocument += 1;
      const resource = requireResource(resourceId);
      const document = blankDocument(body.name);
      document.type = body.type ?? "page";
      document.isHidden = Boolean(body.isHidden);
      document.rank = `a${resource.documents.length}`;
      document.blocks = structuredClone(body.blocks ?? []);
      if (document.blocks.length > 0 && document.type === "blank") document.type = "page";
      resource.documents.push(document);
      stamp(resource);
      return publicDocument(document);
    },
    async updateBlock(resourceId, documentId, blockId, body) {
      calls.updateBlock += 1;
      const { resource, document } = requireDocument(resourceId, documentId);
      assertMatch(document, body.ifMatch);
      const block = find(document.blocks, blockId);
      if (!block) throw notFound("Block not found");
      if (block.kind === "unsupported") {
        const error = new Error("Unsupported blocks are read-only");
        error.code = "UNSUPPORTED_KIND";
        throw error;
      }
      const fields = { ...body };
      delete fields.ifMatch;
      Object.assign(block, fields);
      document.version = nextVersion();
      stamp(document);
      stamp(resource);
      return { ...structuredClone(block), version: document.version };
    },
    async insertBlock(resourceId, documentId, body) {
      calls.insertBlock += 1;
      const { resource, document } = requireDocument(resourceId, documentId);
      assertMatch(document, body.ifMatch);
      const block = structuredClone(body.block);
      if (!block.id) block.id = `b${crypto.randomUUID().replaceAll("-", "").slice(0, 23)}`;
      const index = body.after ? document.blocks.findIndex((item) => item.id === body.after) : document.blocks.length - 1;
      document.blocks.splice(index + 1, 0, block);
      if (document.type === "blank") document.type = "page";
      document.version = nextVersion();
      stamp(document);
      stamp(resource);
      return { ...block, version: document.version };
    },
    async moveBlock(resourceId, documentId, blockId, body) {
      calls.moveBlock += 1;
      const { resource, document } = requireDocument(resourceId, documentId);
      assertMatch(document, body.ifMatch);
      const index = document.blocks.findIndex((item) => item.id === blockId);
      if (index < 0) throw notFound("Block not found");
      const [block] = document.blocks.splice(index, 1);
      const anchor = document.blocks.findIndex((item) => item.id === body.after);
      document.blocks.splice(anchor + 1, 0, block);
      document.version = nextVersion();
      stamp(document);
      stamp(resource);
      return { version: document.version };
    },
    async deleteBlock(resourceId, documentId, blockId, body) {
      calls.deleteBlock += 1;
      const { resource, document } = requireDocument(resourceId, documentId);
      assertMatch(document, body.ifMatch);
      const block = find(document.blocks, blockId);
      if (!block) throw notFound("Block not found");
      if (block.kind === "unsupported") {
        const error = new Error("Refusing to delete an unsupported block");
        error.code = "UNSUPPORTED_LOSS";
        throw error;
      }
      document.blocks = document.blocks.filter((item) => item.id !== blockId);
      document.version = nextVersion();
      stamp(document);
      stamp(resource);
      return { version: document.version };
    },
    async replaceBlocks(resourceId, documentId, body) {
      calls.replaceBlocks += 1;
      const { document } = requireDocument(resourceId, documentId);
      assertMatch(document, body.ifMatch);
      const previous = unsupportedIds(document.blocks);
      const next = new Set(unsupportedIds(body.blocks));
      for (const id of next) {
        if (!previous.includes(id)) {
          const error = new Error("Cannot create an unsupported block");
          error.code = "UNSUPPORTED_KIND";
          throw error;
        }
      }
      document.blocks = structuredClone(body.blocks).filter((block) => block.kind !== "unsupported" || previous.includes(block.id));
      document.version = nextVersion();
      return { version: document.version, blocks: structuredClone(document.blocks) };
    },
    async assignBlockIds(resourceId, documentId) {
      calls.assignBlockIds += 1;
      const { resource, document } = requireDocument(resourceId, documentId);
      let assigned = 0;
      walk(document.blocks, (block) => {
        if (!block.id) {
          block.id = `b${crypto.randomUUID().replaceAll("-", "").slice(0, 23)}`;
          assigned += 1;
        }
      });
      document.version = nextVersion();
      stamp(document);
      stamp(resource);
      return { assigned, version: document.version };
    },
    async deleteResource(resourceId, options = {}) {
      calls.deleteResource += 1;
      const resource = requireResource(resourceId);
      const children = [...resources.values()].filter((item) => item.parentId === resourceId && !item.deleted);
      if (children.length > 0 && !options.cascade) throw conflict("HAS_CHILDREN", "Resource has children");
      resource.deleted = true;
      if (options.cascade) {
        for (const child of children) child.deleted = true;
      }
    },
    async restoreResource(resourceId) {
      calls.restoreResource += 1;
      const resource = resources.get(resourceId);
      if (!resource) throw notFound();
      resource.deleted = false;
      return publicResource(resource);
    },
    async deleteDocument(resourceId, documentId) {
      const { document } = requireDocument(resourceId, documentId);
      document.deleted = true;
    },
    async restoreDocument(resourceId, documentId) {
      const resource = requireResource(resourceId);
      const document = resource.documents.find((item) => item.id === documentId);
      if (!document) throw notFound();
      document.deleted = false;
      return publicDocument(document);
    },
    async uploadImage({ name }) {
      return { id: `asset_${name}`, url: `https://assets.legendkeeper.test/${encodeURIComponent(name)}`, type: "image" };
    },
    debugSetBlocks(resourceId, documentId, blocks, { stampResource = true } = {}) {
      const { resource, document } = requireDocument(resourceId, documentId);
      document.blocks = structuredClone(blocks);
      document.version = nextVersion();
      if (stampResource) {
        stamp(document);
        stamp(resource);
      }
      return document.version;
    }
  };
}

export { IDEMPOTENCY_STORE_LIMIT };
