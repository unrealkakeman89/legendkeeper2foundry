/** Remember a 429 long enough that the next call fails closed instead of spinning. */
export function withRateLimit(port, now = Date.now) {
  let blockedUntil = 0;
  const wrap = (fn) => async (...args) => {
    const clock = now();
    if (clock < blockedUntil) {
      const error = new Error("Rate limit has not elapsed");
      error.code = "RATE_LIMITED";
      error.status = 429;
      error.retryAfterMs = blockedUntil - clock;
      throw error;
    }
    try {
      return await fn(...args);
    } catch (error) {
      if (error?.status === 429 || error?.code === "RATE_LIMITED") {
        blockedUntil = now() + (error.retryAfterMs ?? 1000);
      }
      throw error;
    }
  };
  const method = (name) => (typeof port[name] === "function" ? wrap(port[name].bind(port)) : undefined);
  return {
    listResources: method("listResources"),
    getResource: method("getResource"),
    listDocuments: method("listDocuments"),
    getBlocks: method("getBlocks"),
    listProperties: method("listProperties"),
    createResource: method("createResource"),
    createMany: method("createMany"),
    createDocument: method("createDocument"),
    updateBlock: method("updateBlock"),
    insertBlock: method("insertBlock"),
    moveBlock: method("moveBlock"),
    deleteBlock: method("deleteBlock"),
    assignBlockIds: method("assignBlockIds"),
    deleteResource: method("deleteResource"),
    restoreResource: method("restoreResource"),
    deleteDocument: method("deleteDocument"),
    restoreDocument: method("restoreDocument"),
    uploadImage: method("uploadImage"),
    debugSetBlocks: port.debugSetBlocks?.bind(port),
    get calls() {
      return port.calls;
    },
    set crashAfterWrite(value) {
      port.crashAfterWrite = value;
    },
    get crashAfterWrite() {
      return port.crashAfterWrite;
    }
  };
}
