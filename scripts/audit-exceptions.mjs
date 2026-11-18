// Every advisory ignored by `pnpm audit` (package.json pnpm.auditConfig.ignoreGhsas) must be recorded in
// audit-exceptions.json with an owner and a review date, and fails CI once that date has passed.
// Same check as the other WorkEasy360 repositories (AI-CRM: frontend/scripts/audit-exceptions.mjs).
//   node scripts/audit-exceptions.mjs            # the CI check (run from the repository root)
//   node scripts/audit-exceptions.mjs --ids      # the ignored IDs, one per line
import { readFileSync } from "node:fs";

const ignored = JSON.parse(readFileSync("package.json", "utf8")).pnpm?.auditConfig?.ignoreGhsas ?? [];
if (process.argv[2] === "--ids") {
  for (const id of ignored) console.log(id);
  process.exit(0);
}
const records = JSON.parse(readFileSync("audit-exceptions.json", "utf8"));
const now = new Date();
let failed = false;
for (const id of ignored) {
  const record = records[id];
  if (!record?.owner || !record.reviewBy) {
    console.log(`${id} is ignored by pnpm audit but has no owner and review date in audit-exceptions.json`);
    failed = true;
  } else if (now > new Date(`${record.reviewBy}T23:59:59Z`)) {
    console.log(`${id}: acceptance expired on ${record.reviewBy} (owner: ${record.owner}), review it`);
    failed = true;
  } else {
    console.log(`${id}: accepted until ${record.reviewBy} (owner: ${record.owner}): ${record.package}`);
  }
}
for (const id of Object.keys(records)) {
  if (!ignored.includes(id)) console.log(`${id} is recorded but no longer ignored: delete its record`);
}
if (failed) process.exit(1);
