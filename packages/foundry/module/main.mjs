import { defineLegendKeeperPageModel } from "./model.mjs";
import { registerSheets } from "./sheets.mjs";
import { DEFAULT_SERVICE_URL, SERVICE_URL_SETTING, createLegendKeeperJournal, importJournals, persistImportedJournal } from "./client.mjs";
import { MODULE_ID } from "./domain/journal.mjs";

Hooks.once("init", () => {
  const Model = defineLegendKeeperPageModel(foundry);
  Object.assign(CONFIG.JournalEntryPage.dataModels, {
    [`${MODULE_ID}.page`]: Model
  });
  registerSheets({
    foundry,
    DocumentSheetConfig,
    JournalEntry,
    JournalEntryPage
  });
  game.settings.register(MODULE_ID, SERVICE_URL_SETTING, {
    name: "LEGENDKEEPER.ServiceUrl",
    hint: "LEGENDKEEPER.ServiceUrlHint",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_SERVICE_URL,
    restricted: true
  });
  game.settings.register(MODULE_ID, "accessToken", {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });
});

function serviceUrl() {
  return game.settings.get(MODULE_ID, SERVICE_URL_SETTING) || DEFAULT_SERVICE_URL;
}

function accessToken() {
  return game.settings.get(MODULE_ID, "accessToken");
}

Hooks.on("getJournalDirectoryEntryContext", (_html, entries) => {
  // Context menu stays empty of LegendKeeper credentials.
  void entries;
});

Hooks.on("renderJournalDirectory", (_app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root || root.querySelector("[data-action='createLegendKeeper']")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = "createLegendKeeper";
  button.textContent = game.i18n.localize("LEGENDKEEPER.Create");
  button.addEventListener("click", async () => {
    const name = await foundryNamePrompt();
    if (!name) return;
    await createLegendKeeperJournal(
      { createJournal: (data) => JournalEntry.create(data) },
      serviceUrl(),
      accessToken(),
      { name }
    );
  });
  root.prepend(button);
});

async function foundryNamePrompt() {
  if (!foundry.applications?.api?.DialogV2) return "New LegendKeeper journal";
  return foundry.applications.api.DialogV2.prompt({
    window: { title: "Create LegendKeeper Journal" },
    content: `<input name="name" type="text" value="New page">`,
    ok: { callback: (_event, button) => button.form.elements.name.value }
  });
}

export async function importIntoWorld(parentId = null) {
  const journals = await importJournals(serviceUrl(), accessToken(), { parentId });
  const created = [];
  for (const journal of journals) {
    created.push(await persistImportedJournal({ createJournal: (data) => JournalEntry.create(data) }, journal));
  }
  return created;
}
