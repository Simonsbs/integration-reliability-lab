import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const base = option("--url", "https://integration.bestdev.co.il");
const output = resolve(option("--output", "docs/validation/public-redeploy.json"));
if (!process.stdin.isTTY) throw new Error("Run the deployment canary in an interactive terminal so it can retain its private capability between deployments.");
const before = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const created = await fetch(base + "/api/labs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
assert.equal(created.status, 201); const { token } = await created.json();
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
async function call(path, body) {
  const r = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  assert.ok(r.ok); return r.json();
}
async function send(id) {
  const envelope = await call(`/api/deliveries/${id}/claim`, {});
  const r = await fetch(base + "/api/receiver", { method: "POST", headers: { ...headers, ...envelope.headers }, body: envelope.rawBody });
  assert.equal(r.status, 200); return r.text();
}
try {
  const payload = { eventId: "evt-deploy-canary", orderId: "ORD-DEPLOY-CANARY", version: 5, status: "shipped" };
  const job = await call("/api/deliveries", { payload }); const original = await send(job.deliveryId);
  console.log("Canary committed. Deploy the next version, then enter verify. Capability stays only in this process memory.");
  const input = createInterface({ input: process.stdin, output: process.stdout }); const answer = await input.question(""); input.close(); assert.equal(answer.trim(), "verify");
  const state = await call("/api/state"); assert.equal(state.orders[payload.orderId].effects, 1); assert.equal(state.jobs[0].status, "delivered");
  const duplicate = await call("/api/deliveries", { payload }); assert.equal(await send(duplicate.deliveryId), original); assert.equal((await call("/api/state")).orders[payload.orderId].effects, 1);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ passed: true, url: base, checkedAt: new Date().toISOString(), beforeSource: before, afterSource: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), checks: ["public D1 order and delivery survive deployment", "cached receipt returns identical response after deployment", "duplicate after deployment leaves one effect"], scope: "Actual public API before and after a Site version change. Capability retained in process memory only." }, null, 2) + "\n");
  console.log("PASS: public D1 persistence and deduplication across deployment");
} finally { await fetch(base + "/api/lab", { method: "DELETE", headers }); }
