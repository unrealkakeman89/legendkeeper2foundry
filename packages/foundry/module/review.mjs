import { updatesSafeToApply } from "./domain/reconcile.mjs";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function runText(content) {
  return (content ?? []).map((run) => run?.text || run?.mention?.text || (run?.break ? " / " : "")).join("");
}

/** GM review for same-block conflicts and deletions waiting on the authenticated session. */
export function renderReviewPanel({ conflicts = [], deletions = [] } = {}) {
  const openConflicts = conflicts.filter((conflict) => conflict.state === "open");
  const pendingDeletions = deletions.filter((deletion) => deletion.state === "pending");
  const conflictHtml = openConflicts.map((conflict) => `<li class="lk-conflict" data-conflict-id="${conflict.id}">
      <p>Block ${escapeHtml(conflict.blockId)}</p>
      <p class="lk-conflict-lk">${escapeHtml(runText(conflict.legendkeeper?.content))}</p>
      <p class="lk-conflict-foundry">${escapeHtml(runText(conflict.foundry?.content))}</p>
      <button type="button" data-action="keepLegendKeeper" data-conflict-id="${conflict.id}">Keep LegendKeeper</button>
      <button type="button" data-action="keepFoundry" data-conflict-id="${conflict.id}">Keep Foundry</button>
    </li>`).join("");
  const deletionHtml = pendingDeletions.map((deletion) => `<li class="lk-deletion" data-deletion-id="${deletion.id}">
      <p>${escapeHtml(deletion.targetType)} ${escapeHtml(deletion.resourceId)}</p>
      <button type="button" data-action="approveDeletion" data-deletion-id="${deletion.id}">Approve</button>
      <button type="button" data-action="rejectDeletion" data-deletion-id="${deletion.id}">Reject</button>
    </li>`).join("");
  if (!conflictHtml && !deletionHtml) return "";
  return `<section class="lk-review">
    ${conflictHtml ? `<h3>Same-block conflicts</h3><ul>${conflictHtml}</ul>` : ""}
    ${deletionHtml ? `<h3>Deletions awaiting review</h3><ul>${deletionHtml}</ul>` : ""}
  </section>`;
}

export async function performReview(action, { conflictId, deletionId, isGM, token }, deps) {
  if (!isGM || !token) {
    const error = new Error("Review requires a GM and a paired token");
    error.code = "NOT_GM";
    throw error;
  }
  if (action === "keepLegendKeeper") return deps.resolveConflict(conflictId, { choice: "legendkeeper" });
  if (action === "keepFoundry") return deps.resolveConflict(conflictId, { choice: "foundry" });
  if (action === "approveDeletion") return deps.reviewDeletion(deletionId, "approve");
  if (action === "rejectDeletion") return deps.reviewDeletion(deletionId, "reject");
  const error = new Error("Unknown review action");
  error.code = "UNKNOWN_ACTION";
  throw error;
}

/** Pages with an unsynced draft are left untouched. */
export async function applyPolledPageUpdates(pages, updates, updatePage) {
  const safe = updatesSafeToApply(pages, updates);
  const applied = [];
  for (const update of safe) {
    const page = pages.find((item) => item?.system?.lkDocumentId === update.documentId);
    if (!page) continue;
    const system = { ...page.system, ...update.system, draft: page.system.draft ?? null };
    await updatePage(page, system);
    applied.push(update.documentId);
  }
  return applied;
}

/** Automatic polling stays off until a GM accepts the live proof and turns the setting on. */
export function startAutomaticSync({ automaticSync = false, liveProofAccepted = false, poll } = {}) {
  if (!automaticSync || !liveProofAccepted || typeof poll !== "function") return { started: false, stop() {} };
  const timer = setInterval(() => {
    poll().catch(() => {});
  }, 15_000);
  return {
    started: true,
    stop() {
      clearInterval(timer);
    }
  };
}
