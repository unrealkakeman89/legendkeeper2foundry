import { fetchEditorTree, fetchGmView, fetchReviews, localPageUpdate, paragraphSaveUpdate, resolveConflict, reviewDeletion, saveParagraph } from "./client.mjs";
import { decodeSourcePayload, preparePageContext, sheetMode } from "./context.mjs";
import { MODULE_ID } from "./domain/journal.mjs";
import { contentFromRunEdits } from "./domain/runs.mjs";
import { currentSyncStatus, performReview, renderReviewPanel, renderSyncStatus } from "./review.mjs";

function serviceSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function readRunTexts(root) {
  const values = [];
  const inputs = root?.querySelectorAll?.("input[data-run-index]") ?? [];
  for (const input of inputs) {
    values[Number(input.dataset.runIndex)] = input.value;
  }
  return values;
}

function editorFieldset(root) {
  return root?.querySelector?.(".lk-runs[data-block-id]") ?? null;
}

/** Keep text the GM is typing when Foundry rebuilds the sheet. */
export function captureTypedDraft(root) {
  const fieldset = editorFieldset(root);
  if (!fieldset) return null;
  const hidden = fieldset.querySelector?.('input[name="sourceRuns"]');
  let source;
  try {
    source = decodeSourcePayload(hidden?.value ?? "");
  } catch {
    return null;
  }
  if (source.id !== fieldset.dataset.blockId) return null;
  const content = contentFromRunEdits(source.content, readRunTexts(fieldset));
  const dirty = content.some((run, index) => JSON.stringify(run) !== JSON.stringify(source.content[index]));
  if (!dirty) return null;
  return { blockId: source.id, baseVersion: fieldset.dataset.baseVersion || "", content };
}

export async function commitParagraphSave({ system, root, serviceUrl, token, isGM, save = saveParagraph }) {
  if (!sheetMode({ isGM, token })) {
    const error = new Error("Saving requires a GM and a paired token");
    error.code = "NOT_GM";
    throw error;
  }
  const fieldset = editorFieldset(root);
  if (!fieldset?.dataset?.blockId) {
    const error = new Error("The editor paragraph is missing");
    error.code = "INVALID_SOURCE";
    throw error;
  }
  const hidden = fieldset.querySelector?.('input[name="sourceRuns"]');
  const source = decodeSourcePayload(hidden?.value ?? "");
  if (source.id !== fieldset.dataset.blockId) {
    const error = new Error("The editor source does not match the paragraph being saved");
    error.code = "INVALID_SOURCE";
    throw error;
  }
  const blockId = fieldset.dataset.blockId;
  const baseVersion = fieldset.dataset.baseVersion || "";
  const content = contentFromRunEdits(source.content, readRunTexts(fieldset));
  const result = await save(serviceUrl, token, {
    resourceId: fieldset.dataset.resourceId,
    documentId: fieldset.dataset.documentId,
    baseVersion,
    blockId,
    content
  });
  return { result, system: paragraphSaveUpdate(system, blockId, result, baseVersion) };
}

export function registerSheets({ foundry, DocumentSheetConfig, JournalEntry, JournalEntryPage }) {
  const { HandlebarsApplicationMixin } = foundry.applications.api;
  const { JournalEntryPageSheet, JournalEntrySheet } = foundry.applications.sheets.journal;

  class LegendKeeperPageSheet extends HandlebarsApplicationMixin(JournalEntryPageSheet) {
    static DEFAULT_OPTIONS = {
      classes: ["legendkeeper", "sheet"],
      actions: {
        migrateIds: LegendKeeperPageSheet.#migrate,
        saveParagraph: LegendKeeperPageSheet.#save
      }
    };

    static PARTS = {
      content: { template: "modules/legendkeeper/templates/page.hbs" }
    };

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const token = serviceSetting("accessToken");
      const gm = sheetMode({ isGM: Boolean(game.user?.isGM), token });
      const typed = captureTypedDraft(this.element);
      let system = localPageUpdate(this.document.system, this.document.system.blocks);
      system = { ...this.document.system, blocks: system.blocks };
      if (typed) system = { ...system, draft: typed };
      let remoteNote = "";
      if (gm && system.lkResourceId && system.lkDocumentId && !typed) {
        try {
          const tree = await fetchEditorTree(serviceSetting("serviceUrl"), token, system.lkResourceId, system.lkDocumentId);
          if (tree.remoteVersion && tree.remoteVersion !== system.version && system.draft) {
            remoteNote = "LegendKeeper has a newer copy. Your draft is still here.";
          }
          if (!system.draft && Array.isArray(tree.blocks)) {
            system = { ...system, blocks: tree.blocks };
          }
        } catch {
          system = { ...this.document.system, blocks: localPageUpdate(this.document.system, this.document.system.blocks).blocks };
        }
      }
      const prepared = preparePageContext(system, { mode: gm ? "gm" : "player", editable: this.isEditable && gm });
      if (remoteNote && !prepared.syncError) prepared.syncError = remoteNote;
      return { ...context, ...prepared };
    }

    static async #migrate() {
      ui.notifications.info("Block id migration runs through the companion service after you confirm it.");
    }

    static async #save(_event, target) {
      const root = target.closest(".legendkeeper") ?? this.element;
      const token = serviceSetting("accessToken");
      const outcome = await commitParagraphSave({
        system: this.document.system,
        root,
        serviceUrl: serviceSetting("serviceUrl"),
        token,
        isGM: Boolean(game.user?.isGM)
      });
      await this.document.update({ system: outcome.system });
    }
  }

  class LegendKeeperJournalSheet extends HandlebarsApplicationMixin(JournalEntrySheet) {
    static DEFAULT_OPTIONS = {
      classes: ["legendkeeper", "journal-sheet"],
      actions: {
        keepLegendKeeper: LegendKeeperJournalSheet.#review,
        keepFoundry: LegendKeeperJournalSheet.#review,
        approveDeletion: LegendKeeperJournalSheet.#review,
        rejectDeletion: LegendKeeperJournalSheet.#review
      }
    };

    static async #review(_event, target) {
      const token = serviceSetting("accessToken");
      await performReview(target.dataset.action, {
        conflictId: target.dataset.conflictId,
        deletionId: target.dataset.deletionId,
        isGM: Boolean(game.user?.isGM),
        token
      }, {
        resolveConflict: (id, body) => resolveConflict(serviceSetting("serviceUrl"), token, id, body),
        reviewDeletion: (id, decision) => reviewDeletion(serviceSetting("serviceUrl"), token, id, decision)
      });
      this.render();
    }
    static PARTS = {
      content: { template: "modules/legendkeeper/templates/journal.hbs" }
    };

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const token = serviceSetting("accessToken");
      const gm = sheetMode({ isGM: Boolean(game.user?.isGM), token });
      const resourceId = this.document.getFlag(MODULE_ID, "resourceId");
      let hiddenDocuments = [];
      let review = "";
      if (gm && resourceId) {
        try {
          const view = await fetchGmView(serviceSetting("serviceUrl"), token, resourceId);
          hiddenDocuments = view.hiddenDocuments ?? [];
        } catch {
          hiddenDocuments = [];
        }
        try {
          review = renderReviewPanel(await fetchReviews(serviceSetting("serviceUrl"), token));
        } catch {
          review = "";
        }
      }
      return {
        ...context,
        name: this.document.name,
        hiddenDocuments,
        review,
        syncStatus: renderSyncStatus(currentSyncStatus()),
        syncState: currentSyncStatus().state || "synced",
        syncLabel: currentSyncStatus().label || "Synced",
        rendered: ""
      };
    }
  }

  DocumentSheetConfig.registerSheet(JournalEntryPage, MODULE_ID, LegendKeeperPageSheet, {
    types: [`${MODULE_ID}.page`],
    makeDefault: true,
    label: "LegendKeeper Page"
  });
  DocumentSheetConfig.registerSheet(JournalEntry, MODULE_ID, LegendKeeperJournalSheet, {
    makeDefault: false,
    label: "LegendKeeper Journal"
  });
  return { LegendKeeperPageSheet, LegendKeeperJournalSheet };
}
