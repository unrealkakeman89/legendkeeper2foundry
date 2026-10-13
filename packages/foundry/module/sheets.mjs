import { fetchEditorTree, fetchGmView, localPageUpdate } from "./client.mjs";
import { preparePageContext } from "./context.mjs";
import { MODULE_ID } from "./domain/journal.mjs";

function serviceSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function registerSheets({ foundry, DocumentSheetConfig, JournalEntry, JournalEntryPage }) {
  const { HandlebarsApplicationMixin } = foundry.applications.api;
  const { JournalEntryPageSheet, JournalEntrySheet } = foundry.applications.sheets.journal;

  class LegendKeeperPageSheet extends HandlebarsApplicationMixin(JournalEntryPageSheet) {
    static DEFAULT_OPTIONS = {
      classes: ["legendkeeper", "sheet"],
      actions: {
        migrateIds: LegendKeeperPageSheet.#migrate
      }
    };

    static PARTS = {
      content: { template: "modules/legendkeeper/templates/page.hbs" }
    };

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const token = serviceSetting("accessToken");
      let system = localPageUpdate(this.document.system, this.document.system.blocks);
      if (token && system.lkResourceId && system.lkDocumentId) {
        try {
          const tree = await fetchEditorTree(serviceSetting("serviceUrl"), token, system.lkResourceId, system.lkDocumentId);
          system = { ...system, blocks: tree.blocks, version: tree.version };
        } catch {
          system = localPageUpdate(this.document.system, this.document.system.blocks);
        }
      }
      const mode = token ? "gm" : "player";
      return { ...context, ...preparePageContext(system, { mode, editable: this.isEditable && Boolean(token) }) };
    }

    static async #migrate() {
      ui.notifications.info("Block id migration runs through the companion service after you confirm it.");
    }
  }

  class LegendKeeperJournalSheet extends HandlebarsApplicationMixin(JournalEntrySheet) {
    static DEFAULT_OPTIONS = { classes: ["legendkeeper", "journal-sheet"] };
    static PARTS = {
      content: { template: "modules/legendkeeper/templates/journal.hbs" }
    };

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const token = serviceSetting("accessToken");
      const resourceId = this.document.getFlag(MODULE_ID, "resourceId");
      let hiddenDocuments = [];
      if (token && resourceId) {
        try {
          const view = await fetchGmView(serviceSetting("serviceUrl"), token, resourceId);
          hiddenDocuments = view.hiddenDocuments ?? [];
        } catch {
          hiddenDocuments = [];
        }
      }
      return {
        ...context,
        name: this.document.name,
        hiddenDocuments,
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
