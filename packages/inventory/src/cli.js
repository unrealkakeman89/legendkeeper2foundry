import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMatrix } from "./catalog.js";
import { inventoryProject } from "./run.js";

const matrixPath = resolve(process.argv[2] ?? "docs/compatibility.md");
const matrix = renderMatrix();
writeFileSync(matrixPath, matrix);

const apiKey = process.env.LEGENDKEEPER_API_KEY;
if (!apiKey) {
  console.log(`Wrote ${matrixPath} from the pinned block catalog. Set LEGENDKEEPER_API_KEY to an Admin key to inventory a live project.`);
  process.exit(0);
}

const { createSdkReader } = await import("../../service/src/sdk-lk.js");
const report = await inventoryProject(createSdkReader(apiKey), {
  parentId: process.env.LEGENDKEEPER_PARENT_ID ?? null
});
const livePath = resolve(process.argv[3] ?? "docs/live-inventory.json");
writeFileSync(livePath, `${JSON.stringify(report.summary, null, 2)}\n`);
console.log(`Inventoried ${report.summary.resources} resources. Summary written to ${livePath}.`);
