import { fetchEditorTree, fetchGmView, fetchReviews, localPageUpdate, paragraphSaveUpdate, resolveConflict, reviewDeletion, saveParagraph } from "./client.mjs";
import { preparePageContext, sheetMode } from "./context.mjs";
import { paragraphContent } from "./domain/editor.mjs";
import { MODULE_ID } from "./domain/journal.mjs";
import { contentFromRunEdits } from "./domain/runs.mjs";
import { performReview, renderReviewPanel } from "./review.mjs";

function serviceSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function readRunTexts(root) {
  const values = [];
  for (const input of root.querySelectorAll("input[data-run-index]")) {
    values[Number(input.dataset.runIndex)] = input.value;
  }
  return values;
}

export async function commitParagraphSave({ system, root, serviceUrl, token, isGM, save = saveParagraph }) {
  if (!sheetMode({ isGM, token })) {
    const error = new Error("Saving requires a GM and a paired token");
    error.code = "NOT_GM";
    throw error;
  }
  const blockId = root.querySelector("[data-block-id]")?.dataset.blockId ?? "";
  const source = system.draft?.blockId === blockId ? system.draft.content : paragraphContent(system.blocks, blockId);
  const content = contentFromRunEdits(source, readRunTexts(root));
  const result = await save(serviceUrl, token, {
    resourceId: system.lkResourceId,
    documentId: system.lkDocumentId,
    baseVersion: system.version,
    blockId,
    content
  });
  return { result, system: paragraphSaveUpdate(system, blockId, result) };
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
      let system = localPageUpdate(this.document.system, this.document.system.blocks);
      system = { ...this.document.system, blocks: system.blocks };
      let remoteNote = "";
      if (gm && system.lkResourceId && system.lkDocumentId) {
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
        syncState: "synced",
        syncLabel: "Synced",
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
