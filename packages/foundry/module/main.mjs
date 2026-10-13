import { defineLegendKeeperPageModel } from "./model.mjs";
import { registerSheets } from "./sheets.mjs";
import { DEFAULT_SERVICE_URL, SERVICE_URL_SETTING, createLegendKeeperJournal, importIntoWorld as importWorld, pairService, pollUpdates } from "./client.mjs";
import { MODULE_ID } from "./domain/journal.mjs";
import { applyPolledPageUpdates, startAutomaticSync } from "./review.mjs";
import { runSetup, setupForm } from "./setup.mjs";

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
  game.settings.register(MODULE_ID, "automaticSync", {
    name: "LEGENDKEEPER.AutomaticSync",
    hint: "LEGENDKEEPER.AutomaticSyncHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    restricted: true
  });
  game.settings.register(MODULE_ID, "liveProofAccepted", {
    name: "LEGENDKEEPER.LiveProof",
    hint: "LEGENDKEEPER.LiveProofHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true
  });
});

function serviceUrl() {
  return game.settings.get(MODULE_ID, SERVICE_URL_SETTING) || DEFAULT_SERVICE_URL;
}

function accessToken() {
  return game.settings.get(MODULE_ID, "accessToken");
}

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  const sync = startAutomaticSync({
    automaticSync: game.settings.get(MODULE_ID, "automaticSync") === true,
    liveProofAccepted: game.settings.get(MODULE_ID, "liveProofAccepted") === true,
    poll: async () => {
      const result = await pollUpdates(serviceUrl(), accessToken());
      const pages = game.journal.contents.flatMap((journal) => journal.pages.contents);
      await applyPolledPageUpdates(pages, result.updates ?? [], (page, system) => page.update({ system }));
    }
  });
  if (sync.started) ui.notifications.info("LegendKeeper automatic sync is on for this GM session.");
});

Hooks.on("getJournalDirectoryEntryContext", (_html, entries) => {
  // Context menu stays empty of LegendKeeper credentials.
  void entries;
});

Hooks.on("renderJournalDirectory", (_app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root || root.querySelector("[data-action='createLegendKeeper']")) return;
  const setup = document.createElement("button");
  setup.type = "button";
  setup.dataset.action = "setupLegendKeeper";
  setup.textContent = game.i18n.localize("LEGENDKEEPER.Setup");
  setup.addEventListener("click", () => openSetupDialog());
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
  root.prepend(setup);
});

async function openSetupDialog() {
  if (!game.user.isGM) return;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return;
  const run = (action) => async (event, button) => {
    const form = button?.form ?? event?.target?.closest("form");
    const fields = Object.fromEntries(new FormData(form).entries());
    return runSetup(action, {
      isGM: true,
      serviceUrl: fields.serviceUrl || serviceUrl(),
      pairingCode: fields.pairingCode,
      parentId: fields.parentId,
      clientId: game.user.id,
      token: accessToken()
    }, {
      fetch,
      pair: pairService,
      saveToken: (token) => game.settings.set(MODULE_ID, "accessToken", token),
      importIntoWorld: (url, token, options) => importIntoWorld(options?.parentId ?? null, url, token)
    });
  };
  await DialogV2.wait({
    window: { title: "LegendKeeper setup" },
    content: setupForm({ serviceUrl: serviceUrl(), paired: Boolean(accessToken()) }),
    buttons: [
      { action: "test", label: "Test connection", callback: run("test") },
      { action: "pair", label: "Pair", callback: run("pair") },
      { action: "import", label: "Import branch", callback: run("import") }
    ]
  });
}

async function foundryNamePrompt() {
  if (!foundry.applications?.api?.DialogV2) return "New LegendKeeper journal";
  return foundry.applications.api.DialogV2.prompt({
    window: { title: "Create LegendKeeper Journal" },
    content: `<input name="name" type="text" value="New page">`,
    ok: { callback: (_event, button) => button.form.elements.name.value }
  });
}

export async function importIntoWorld(parentId = null, url = serviceUrl(), token = accessToken()) {
  if (!game.user.isGM) {
    const error = new Error("Import is limited to a GM");
    error.code = "NOT_GM";
    throw error;
  }
  return importWorld({
    createJournal: (data) => JournalEntry.create(data),
    updatePages: (journal, pages) => journal.updateEmbeddedDocuments("JournalEntryPage", pages.map((page) => ({
      _id: page.id,
      system: page.system
    })))
  }, url, token, { parentId });
}
