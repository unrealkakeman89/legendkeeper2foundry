import { summarizeLive } from "./catalog.js";

const READ_METHODS = ["listResources", "getResource", "listDocuments", "getBlocks", "listProperties"];

export function assertReadOnlyPort(port) {
  for (const method of READ_METHODS) {
    if (typeof port[method] !== "function") {
      const error = new Error(`Inventory reader is missing ${method}`);
      error.code = "READER";
      throw error;
    }
  }
}

/**
 * Read a project branch. Calls list, get, and getBlocks only.
 * Hidden documents are counted and are not copied into a player-facing structure.
 */
export async function inventoryProject(port, { parentId = null } = {}) {
  assertReadOnlyPort(port);
  const listed = await port.listResources(parentId ? { parentId } : {});
  const resources = [];
  for (const summary of listed) {
    const resource = await port.getResource(summary.id);
    const documents = [];
    for (const document of resource.documents ?? []) {
      if (document.isHidden) {
        const content = document.type === "page" || document.type === "blank"
          ? await port.getBlocks(resource.id, document.id)
          : { blocks: [] };
        documents.push({
          id: document.id,
          type: document.type,
          isHidden: true,
          blocks: content.blocks ?? []
        });
        continue;
      }
      if (document.type === "page" || document.type === "blank") {
        const content = await port.getBlocks(resource.id, document.id);
        documents.push({ ...document, blocks: content.blocks ?? [], version: content.version });
      } else {
        documents.push({ ...document, blocks: [], placeholder: true });
      }
    }
    let properties = resource.properties ?? [];
    if (typeof port.listProperties === "function" && properties.length === 0) {
      try {
        properties = await port.listProperties(resource.id);
      } catch {
        properties = resource.properties ?? [];
      }
    }
    resources.push({ ...resource, documents, properties });
  }
  return { resources, summary: summarizeLive(resources) };
}
