function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

export function setupForm({ serviceUrl = "", paired = false } = {}) {
  return `<div class="legendkeeper-setup">
    <label>Service URL <input name="serviceUrl" type="url" value="${escapeHtml(serviceUrl)}"></label>
    <label>Pairing code <input name="pairingCode" type="password" autocomplete="off"></label>
    <label>Branch resource id <input name="parentId" type="text" placeholder="Leave empty for the whole project"></label>
    <p class="lk-paired" data-paired="${paired ? "yes" : "no"}">${paired ? "This browser has a client token." : "Pair before importing."}</p>
  </div>`;
}

export async function runSetup(action, input, deps) {
  if (!input?.isGM) {
    const error = new Error("LegendKeeper setup is limited to a GM");
    error.code = "NOT_GM";
    throw error;
  }
  if (action === "test") {
    const response = await deps.fetch(`${input.serviceUrl}/health`);
    const body = await response.json();
    if (!response.ok || body?.ok !== true) {
      const error = new Error("Companion service did not answer");
      error.code = "UNREACHABLE";
      throw error;
    }
    return { ok: true };
  }
  if (action === "pair") {
    const token = await deps.pair(input.serviceUrl, { pairingCode: input.pairingCode, clientId: input.clientId });
    await deps.saveToken(token);
    return { paired: true };
  }
  if (action === "import") {
    if (!input.token) {
      const error = new Error("Pair before importing");
      error.code = "UNPAIRED";
      throw error;
    }
    const journals = await deps.importIntoWorld(input.serviceUrl, input.token, { parentId: input.parentId || null });
    return { imported: journals.length };
  }
  const error = new Error("Unknown setup action");
  error.code = "UNKNOWN_ACTION";
  throw error;
}
