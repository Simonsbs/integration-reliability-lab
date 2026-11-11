import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const read = async (name) => JSON.parse(await readFile(`docs/validation/${name}.json`, "utf8"));
const sources = {};
const api = {};
for (const name of ["aspnet-local", "worker-local", "public-release"]) {
  const report = await read(name); assert.equal(report.summary.total, 25); assert.equal(report.summary.passed, 25);
  for (const [path, expected] of Object.entries(report.sourceHashes)) {
    const actual = createHash("sha256").update((await readFile(path, "utf8")).replace(/\r\n/g, "\n")).digest("hex");
    assert.equal(actual, expected, `${name} evidence must match ${path}`); sources[path] = actual;
  }
  api[name] = { ...report.summary, checkedAt: report.finishedAt, backend: report.backend, baseUrl: report.baseUrl };
}
for (const name of ["aspnet-expiry", "worker-expiry", "aspnet-restart", "worker-restart", "public-redeploy", "public-smoke", "browser"]) assert.equal((await read(name)).passed, true, name);
for (const path of ["src/App.tsx", "src/client.ts", "worker/index.ts", "scripts/build.mjs", "vite.config.ts"]) sources[path] = createHash("sha256").update((await readFile(path, "utf8")).replace(/\r\n/g, "\n")).digest("hex");
const exported = await readFile("docs/validation/browser-session.json", "utf8");
assert.ok(!/signingSecret|tokenHash|[a-f0-9]{32}\.[a-f0-9]{64}/.test(exported));
const snapshot = JSON.parse(exported); assert.equal(snapshot.lab.jobs.length, 3); assert.equal(Object.keys(snapshot.lab.orders).length, 2);
assert.equal(snapshot.lab.jobs.reduce((sum, job) => sum + job.attempts.length, 0), 8);
const ci = JSON.parse(execFileSync("gh", ["run", "view", "43029384381", "--repo", "Simonsbs/integration-reliability-lab", "--json", "conclusion,status,headSha,url,jobs"], { encoding: "utf8" }));
assert.equal(ci.status, "completed"); assert.equal(ci.conclusion, "success"); assert.equal(ci.headSha, "fb897e42741d67bea8a2d8fe685fde11aac6d5e1");
assert.equal(ci.jobs.length, 2); for (const job of ci.jobs) assert.equal(job.conclusion, "success");
const screenshots = {};
for (const name of ["desktop", "mobile"]) { const bytes = await readFile(`docs/validation/screenshots/${name}.png`); screenshots[name] = { path: `screenshots/${name}.png`, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: createHash("sha256").update(bytes).digest("hex") }; }
const report = { release: "Version 1", status: "validated for the documented demonstration scope", generatedAt: new Date().toISOString(), publicUrl: "https://integration.bestdev.co.il/", repository: "https://github.com/Simonsbs/integration-reliability-lab", implementationCommit: ci.headSha,
  testedSiteVersion: 3, testedDeployment: "appgdep_6af46d9a1c788191956c644ec9334ac6", unitChecks: { passed: 14, total: 14, evidence: ci.url }, api,
  persistence: { processRestart: ["ASP.NET Core + SQLite", "Worker + D1"], realCapabilityExpiry: ["ASP.NET Core + SQLite", "Worker + D1"], publicRedeployment: "Site version 1 to version 2, one order effect and identical duplicate receipt retained" },
  publicSmoke: { passed: 6, total: 6 }, browser: { passed: true, evidence: "browser.json", export: "browser-session.json" }, screenshots,
  ci: { url: ci.url, headSha: ci.headSha, jobs: ci.jobs.map(({ name, conclusion, url }) => ({ name, conclusion, url })) }, sourceHashes: sources,
  limits: "Synthetic bounded sessions; explicit virtual retry clock; browser sender; public Worker with D1 and separately runnable ASP.NET Core API. No production availability, throughput or distributed exactly-once claim." };
await writeFile("docs/validation/ci-implementation.json", JSON.stringify(ci, null, 2) + "\n");
await writeFile("docs/validation/release.json", JSON.stringify(report, null, 2) + "\n");
console.log("PASS: source hashes, 75 HTTP scenarios, expiry/restart/redeployment, public smoke, browser evidence and both CI jobs verified");
