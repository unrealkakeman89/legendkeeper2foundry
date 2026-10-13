import { LegendKeeper } from "@legendkeeper/sdk";

async function collect(page) {
  const rows = [];
  for await (const item of page) rows.push(item);
  return rows;
}

/** Read and write adapter. Inventory must not use the write methods. */
export function createSdkPort(apiKey) {
  const lk = new LegendKeeper({ apiKey, maxRetries: 2 });
  return {
    async listResources(query = {}) {
      return collect(await lk.resources.list({ limit: 100, ...query }));
    },
    async getResource(resourceId) {
      return lk.resources.get({ resourceId });
    },
    async listDocuments(resourceId) {
      return collect(await lk.documents.list({ resourceId }));
    },
    async getBlocks(resourceId, documentId) {
      return lk.documents.getBlocks({ resourceId, documentId });
    },
    async listProperties(resourceId) {
      return collect(await lk.properties.list({ resourceId }));
    },
    async createResource(body, options = {}) {
      const { padBytes: _pad, ...fields } = body;
      return lk.resources.create({ ...fields, idempotencyKey: options.idempotencyKey });
    },
    async createMany(resources) {
      return lk.resources.createMany({ resources });
    },
    async createDocument(resourceId, body) {
      return lk.documents.create({ resourceId }, body);
    },
    async updateBlock(resourceId, documentId, blockId, body) {
      return lk.blocks.update({ resourceId, documentId, blockId }, body);
    },
    async insertBlock(resourceId, documentId, body) {
      return lk.blocks.insert({ resourceId, documentId }, body);
    },
    async moveBlock(resourceId, documentId, blockId, body) {
      return lk.blocks.move({ resourceId, documentId, blockId }, body);
    },
    async deleteBlock(resourceId, documentId, blockId, body) {
      return lk.blocks.delete({ resourceId, documentId, blockId }, body);
    },
    async assignBlockIds(resourceId, documentId) {
      return lk.documents.assignBlockIds({ resourceId, documentId });
    },
    async deleteResource(resourceId, options = {}) {
      return lk.resources.delete({ resourceId }, options);
    },
    async restoreResource(resourceId) {
      return lk.resources.restore({ resourceId });
    },
    async deleteDocument(resourceId, documentId) {
      return lk.documents.delete({ resourceId, documentId });
    },
    async restoreDocument(resourceId, documentId) {
      return lk.documents.restore({ resourceId, documentId });
    },
    async uploadImage(input) {
      return lk.assets.uploadImage(input);
    }
  };
}

export function createSdkReader(apiKey) {
  const port = createSdkPort(apiKey);
  return {
    listResources: port.listResources,
    getResource: port.getResource,
    listDocuments: port.listDocuments,
    getBlocks: port.getBlocks,
    listProperties: port.listProperties
  };
}
