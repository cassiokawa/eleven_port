import { failed, runDoctor } from "./doctor.ts";

const icon = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" } as const;
const checks = await runDoctor();
for (const c of checks) console.log(`${icon[c.level]}  ${c.name}: ${c.detail}`);
process.exit(failed(checks) ? 1 : 0);
