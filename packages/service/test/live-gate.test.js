import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

function run(script, env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8"
  });
}

test("the live command names both gates and does not run them", () => {
  const result = run("scripts/live-round-trip.mjs");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /live-api/);
  assert.match(result.stderr, /live-foundry/);
  assert.match(result.stderr, /not either gate/);
  assert.equal(result.stdout.includes("passed"), false);
});

test("the API gate refuses without a project key and does not mention a sheet", () => {
  const result = run("scripts/live-api-round-trip.mjs");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Gate A refused/);
  assert.match(result.stderr, /LEGENDKEEPER_API_KEY/);
  assert.equal(/foundry/i.test(`${result.stdout}\n${result.stderr}`), false);
  assert.equal(result.stdout.includes("passed"), false);
});

test("the Foundry sheet gate refuses when only a URL is present", () => {
  const result = run("scripts/foundry-sheet-gate.mjs", { FOUNDRY_URL: "http://127.0.0.1:30000" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Gate B refused/);
  assert.match(result.stderr, /not a pass/);
  assert.equal(result.stdout.includes("passed"), false);
});
