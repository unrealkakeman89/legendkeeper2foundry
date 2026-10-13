const required = [
  "FOUNDRY_URL",
  "FOUNDRY_WORLD",
  "FOUNDRY_PASSWORD",
  "LEGENDKEEPER_API_KEY",
  "LEGENDKEEPER_RESOURCE_ID",
  "LEGENDKEEPER_DOCUMENT_ID",
  "LEGENDKEEPER_SERVICE_URL"
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Gate B refused. Missing ${missing.join(", ")}.`);
  console.error("A reachable Foundry URL is not a pass. This gate opens a world, imports a journal, edits one run on the LegendKeeper page sheet, clicks Save, and checks LegendKeeper.");
  console.error("A unit test does not pass this gate, and automatic sync stays off until it does.");
  process.exit(2);
}

function refuse(message) {
  console.error(message);
  console.error("A reachable Foundry URL is not a pass.");
  process.exit(2);
}

async function loadBrowser() {
  try {
    const playwright = await import("playwright");
    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    return { browser, page };
  } catch {
    try {
      const puppeteer = await import("puppeteer");
      const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
      const page = await browser.newPage();
      return { browser, page };
    } catch {
      return null;
    }
  }
}

async function fill(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 20_000 });
  if (typeof page.fill === "function") {
    await page.fill(selector, value);
    return;
  }
  await page.$eval(selector, (element, next) => {
    element.value = next;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

function fail(message) {
  console.error(`Gate B failed: ${message}`);
  process.exit(1);
}

const session = await loadBrowser();
if (!session) {
  refuse("Gate B refused. No browser driver is available, so the Foundry sheet was not opened.");
}

const { browser, page } = session;
const worldId = process.env.FOUNDRY_WORLD;
const username = process.env.FOUNDRY_USERNAME || "Gamemaster";
const documentId = process.env.LEGENDKEEPER_DOCUMENT_ID;
const resourceId = process.env.LEGENDKEEPER_RESOURCE_ID;
try {
  await page.goto(process.env.FOUNDRY_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const joinSelector = `[data-package-id="${worldId}"] button, [data-package-id="${worldId}"] .join`;
  await page.waitForSelector(joinSelector, { timeout: 20_000 });
  await page.click(joinSelector);
  await page.waitForSelector('input[name="password"]', { timeout: 20_000 });
  await page.evaluate((name) => {
    const select = document.querySelector('select[name="userid"]');
    if (!select) return;
    const option = [...select.options].find((item) => item.value === name || item.textContent.trim() === name);
    if (option) select.value = option.value;
  }, username);
  await fill(page, 'input[name="password"]', process.env.FOUNDRY_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 60_000 });

  const present = await page.evaluate((id) => {
    const pages = game.journal.contents.flatMap((journal) => journal.pages?.contents ?? []);
    return pages.some((item) => item.system?.lkDocumentId === id);
  }, documentId);
  if (!present) {
    await page.click("[data-action=setupLegendKeeper]");
    await page.waitForSelector('input[name="parentId"]', { timeout: 20_000 });
    await fill(page, 'input[name="serviceUrl"]', process.env.LEGENDKEEPER_SERVICE_URL);
    if (process.env.LEGENDKEEPER_PAIRING_CODE) {
      await fill(page, 'input[name="pairingCode"]', process.env.LEGENDKEEPER_PAIRING_CODE);
      await page.click('button[data-action="pair"]');
      await page.waitForFunction(() => document.querySelector(".lk-paired")?.dataset.paired === "yes", { timeout: 20_000 });
    }
    await fill(page, 'input[name="parentId"]', resourceId);
    await page.click('button[data-action="import"]');
    await page.waitForFunction((id) => {
      const pages = game.journal?.contents?.flatMap((journal) => journal.pages?.contents ?? []) ?? [];
      return pages.some((item) => item.system?.lkDocumentId === id);
    }, { timeout: 30_000 }, documentId);
  }

  await page.evaluate(async (id) => {
    const pages = game.journal.contents.flatMap((journal) => journal.pages?.contents ?? []);
    const doc = pages.find((item) => item.system?.lkDocumentId === id);
    if (!doc?.sheet?.render) throw new Error("LegendKeeper page sheet is not registered");
    await doc.sheet.render(true);
  }, documentId);
  await page.waitForSelector('.lk-runs[data-block-id] [data-action="saveParagraph"]', { timeout: 20_000 });

  const original = await page.$eval('.lk-runs input[data-run-index="0"]', (input) => input.value);
  const marker = ` [sheet ${Date.now()}]`;
  await fill(page, '.lk-runs input[data-run-index="0"]', `${original}${marker}`);
  await page.click('[data-action="saveParagraph"]');
  await page.waitForFunction(() => document.querySelector(".lk-sync")?.dataset.state === "synced", { timeout: 20_000 });

  const { createSdkPort } = await import("../packages/service/src/sdk-lk.js");
  const lk = createSdkPort(process.env.LEGENDKEEPER_API_KEY);
  const after = await lk.getBlocks(resourceId, documentId);
  const saved = JSON.stringify(after.blocks ?? []).includes(marker);
  if (!saved) fail("LegendKeeper did not show the text saved from the sheet.");

  await fill(page, '.lk-runs input[data-run-index="0"]', original);
  await page.click('[data-action="saveParagraph"]');
  await page.waitForFunction(() => document.querySelector(".lk-sync")?.dataset.state === "synced", { timeout: 20_000 });
  const restored = await lk.getBlocks(resourceId, documentId);
  if (JSON.stringify(restored.blocks ?? []).includes(marker)) {
    fail("The sheet edit was checked, but the original text was not restored.");
  }
} catch (error) {
  fail(error?.message || "The Foundry sheet steps did not finish.");
} finally {
  await browser.close();
}

console.log("Gate B passed: a Foundry sheet save was checked in LegendKeeper. Automatic sync stays off.");
