import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the live round trip refuses without a project key and Foundry", () => {
  const result = spawnSync(process.execPath, ["scripts/live-round-trip.mjs"], {
    cwd: new URL("../../../", import.meta.url),
    env: { PATH: process.env.PATH },
    encoding: "utf8"
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refused/i);
  assert.match(result.stderr, /Mock tests do not pass this gate/);
});
