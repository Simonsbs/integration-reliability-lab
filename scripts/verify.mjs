import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { runAcceptance } from "./acceptance.mjs";

const output = resolve(process.env.LAB_REPORT_DIR ?? "artifacts/validation");
const storage = resolve(".runtime", `verify-${process.pid}-${Date.now()}`);
await mkdir(output, { recursive: true }); await mkdir(storage, { recursive: true });
const children = new Set();
function start(command, args, env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  let log = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { log = (log + chunk).slice(-12000); });
  child.labLog = () => log; children.add(child); return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) { children.delete(child); return; }
  if (process.platform === "win32") await new Promise((done) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, done));
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already stopped. */ } }
  await Promise.race([new Promise((done) => child.once("exit", done)), new Promise((done) => setTimeout(done, 1500))]);
  children.delete(child);
}
async function port() { const s = createServer(); await new Promise((done) => s.listen(0, "127.0.0.1", done)); const p = s.address().port; await new Promise((done) => s.close(done)); return p; }
async function ready(base, child) {
  const deadline = Date.now() + 55000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend stopped during startup: ${child.labLog()}`);
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Not ready yet. */ }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Backend startup timed out: ${child.labLog()}`);
}
async function canary(base) {
  const created = await (await fetch(`${base}/api/labs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  assert.equal(typeof created.token, "string");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${created.token}` };
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(r.ok); return r.json();
  };
  const p = { eventId: "evt-restart", orderId: "ORD-RESTART", version: 7, status: "shipped" };
  const job = await call("/api/deliveries", { payload: p });
  const envelope = await call(`/api/deliveries/${job.deliveryId}/claim`, {});
  const received = await fetch(base + "/api/receiver", { method: "POST", headers: { ...headers, ...envelope.headers }, body: envelope.rawBody });
  assert.equal(received.status, 200); const original = await received.text();
  return async () => {
    const saved = await call("/api/state"); assert.equal(saved.orders[p.orderId].effects, 1); assert.equal(saved.jobs[0].status, "delivered");
    const duplicate = await call("/api/deliveries", { payload: p }); const next = await call(`/api/deliveries/${duplicate.deliveryId}/claim`, {});
    const r = await fetch(base + "/api/receiver", { method: "POST", headers: { ...headers, ...next.headers }, body: next.rawBody });
    assert.equal(r.status, 200); assert.equal(await r.text(), original); assert.equal((await call("/api/state")).orders[p.orderId].effects, 1);
    assert.equal((await fetch(base + "/api/lab", { method: "DELETE", headers })).status, 200);
  };
}
async function databases(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(...await databases(resolve(directory, entry.name)));
    else if (entry.name.endsWith(".sqlite") || entry.name.endsWith(".db")) paths.push(resolve(directory, entry.name));
  }
  return paths;
}
async function expiredCapability(base, directory) {
  const response = await fetch(base + "/api/labs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 201); const { token } = await response.json();
  let changed = false;
  for (const path of await databases(directory)) {
    const db = new DatabaseSync(path);
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'labs'").get()) changed = db.prepare("UPDATE labs SET expires_at = 0 WHERE id = ?").run(token.split(".")[0]).changes === 1 || changed;
    } finally { db.close(); }
  }
  assert.ok(changed, "The isolated expiry fixture must update the real local SQLite row");
  const r = await fetch(base + "/api/state", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 410); assert.equal((await r.json()).error.code, "session-expired");
}
try {
  for (const runtime of ["aspnet", "worker"]) {
    const p = await port(), base = `http://127.0.0.1:${p}`;
    const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
    if (runtime === "worker") {
      const migration = start(process.execPath, [wrangler, "d1", "execute", "DB", "--local", "--persist-to", resolve(storage, "d1"), "--file", "drizzle/0000_initial.sql"]);
      const code = await new Promise((done) => migration.once("exit", done)); children.delete(migration);
      assert.equal(code, 0, migration.labLog());
    }
    const launch = () => runtime === "aspnet"
      ? start("dotnet", ["server/IntegrationLab.Api/bin/Release/net10.0/IntegrationLab.Api.dll", "--urls", base], { LAB_DB: resolve(storage, "aspnet.db") })
      : start(process.execPath, [wrangler, "dev", "--ip", "127.0.0.1", "--port", String(p), "--inspector-port", "0", "--persist-to", resolve(storage, "d1")]);
    let child = launch(); await ready(base, child);
    const report = await runAcceptance(base, resolve(output, `${runtime}.json`), `${runtime} contract acceptance`);
    assert.equal(report.summary.passed, report.summary.total);
    await expiredCapability(base, runtime === "aspnet" ? storage : resolve(storage, "d1"));
    await writeFile(resolve(output, `${runtime}-expiry.json`), JSON.stringify({ runtime, passed: true, checkedAt: new Date().toISOString(), checks: ["real persisted capability with expired wall-clock deadline returns HTTP 410"], scope: "Expiry fixture updates only the isolated local database; no test backdoor or adjustable TTL is exposed by the app." }, null, 2) + "\n");
    const verifyPersisted = await canary(base); await stop(child);
    child = launch(); await ready(base, child); await verifyPersisted(); await stop(child);
    await writeFile(resolve(output, `${runtime}-restart.json`), JSON.stringify({ runtime, passed: true, checkedAt: new Date().toISOString(), checks: ["order and completed delivery survive process restart", "idempotency receipt returns identical response after restart", "duplicate after restart leaves one order effect"], scope: "Actual process restart and the same SQLite data directory. Capability retained only in test process memory." }, null, 2) + "\n");
    console.log(`PASS: ${runtime} persistence and deduplication after process restart`);
  }
} finally { for (const child of children) await stop(child); }
