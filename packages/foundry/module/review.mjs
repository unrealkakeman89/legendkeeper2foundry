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

const STATUS_LABELS = {
  synced: "Synced",
  failed: "Sync failed",
  held: "Another GM is synchronizing",
  pending: "Pending"
};

let syncStatus = { state: "", error: "", label: "" };

export function noteSyncStatus(status) {
  syncStatus = {
    state: status?.state || "",
    error: status?.error || "",
    label: STATUS_LABELS[status?.state] || ""
  };
  return syncStatus;
}

export function currentSyncStatus() {
  return syncStatus;
}

export function renderSyncStatus(status = currentSyncStatus()) {
  if (!status?.state) return "";
  const label = status.label || STATUS_LABELS[status.state] || status.state;
  const error = status.error ? `<p class="lk-sync-error">${escapeHtml(status.error)}</p>` : "";
  return `<p class="lk-sync-status" data-state="${escapeHtml(status.state)}">${escapeHtml(label)}</p>${error}`;
}

export function clampPollInterval(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value)) return 90_000;
  return Math.min(120_000, Math.max(60_000, value));
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

/**
 * Automatic polling stays off until a GM accepts both live gates and turns the setting on.
 * One tick runs at a time. A lease held by another GM is not reported as a service failure.
 */
export function startAutomaticSync({
  automaticSync = false,
  liveProofAccepted = false,
  poll,
  acquireLeader,
  intervalMs = 90_000,
  onStatus = noteSyncStatus
} = {}) {
  if (!automaticSync || !liveProofAccepted || typeof poll !== "function" || typeof acquireLeader !== "function") {
    return { started: false, stop() {} };
  }
  const interval = clampPollInterval(intervalMs);
  let running = false;
  let stopped = false;
  async function tick() {
    if (stopped) return { skipped: true };
    if (running) return { skipped: true };
    running = true;
    try {
      const lease = await acquireLeader(interval * 2);
      if (!lease?.acquired) {
        onStatus?.({ state: "held", error: "Another GM holds the synchronization lease." });
        return { skipped: false, state: "held" };
      }
      await poll();
      onStatus?.({ state: "synced", error: "" });
      return { skipped: false, state: "synced" };
    } catch (error) {
      if (error?.code === "NOT_LEADER") {
        onStatus?.({ state: "held", error: "Another GM holds the synchronization lease." });
        return { skipped: false, state: "held" };
      }
      onStatus?.({ state: "failed", error: error?.message || "Synchronization failed" });
      return { skipped: false, state: "failed" };
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => {
    tick();
  }, interval);
  return {
    started: true,
    interval,
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
