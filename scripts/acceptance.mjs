import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export async function runAcceptance(baseUrl, output, label = "API") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const report = { schemaVersion: 1, label, baseUrl, startedAt: new Date().toISOString(), finishedAt: null,
    scope: "Real HTTP and SQLite-backed API checks on synthetic data. Retry time is advanced explicitly, not measured as wall-clock delay. Session capabilities and signing secrets are excluded.",
    sourceHashes: {}, cases: [], requests: [] };
  for (const file of ["src/domain.ts", "worker/api.ts", "worker/repository.ts", "server/IntegrationLab.Api/Domain.cs", "server/IntegrationLab.Api/Program.cs", "server/IntegrationLab.Api/Repository.cs"])
    report.sourceHashes[file] = createHash("sha256").update((await readFile(resolve(root, file), "utf8")).replace(/\r\n/g, "\n")).digest("hex");
  const sessions = [];
  const save = async () => { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n"); };
  async function call(path, token, body, options = {}) {
    const method = options.method ?? (body === undefined ? "GET" : "POST");
    const start = performance.now();
    const response = await fetch(new URL(path, baseUrl), { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers },
      ...(body !== undefined ? { body: options.raw ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    const raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { data = { nonJson: true }; }
    report.requests.push({ method, path, status: response.status, elapsedMs: Number((performance.now() - start).toFixed(3)),
      ...(response.headers.get("x-lab-outcome") ? { outcome: response.headers.get("x-lab-outcome") } : {}) });
    return { status: response.status, data, raw, headers: response.headers };
  }
  async function session() {
    const r = await call("/api/labs", null, {}); assert.equal(r.status, 201, "Sandbox creation must succeed");
    assert.equal(typeof r.data.token, "string"); sessions.push(r.data.token); return r.data.token;
  }
  const state = async (token) => { const r = await call("/api/state", token); assert.equal(r.status, 200); return r.data; };
  const fixture = (extra = {}) => ({ eventId: `evt-${randomUUID()}`, orderId: "ORD-DEMO-1042", version: 1, status: "packed", note: "München / שלום", ...extra });
  async function enqueue(token, payload = fixture(), fault = "none") {
    const r = await call("/api/deliveries", token, { payload, fault }); assert.equal(r.status, 201); return r.data.deliveryId;
  }
  async function claim(token, id) { const r = await call(`/api/deliveries/${id}/claim`, token, {}); assert.equal(r.status, 200); return r.data; }
  const sendEnvelope = (token, env) => call("/api/receiver", token, env.rawBody, { raw: true, headers: env.headers });
  const send = async (token, id) => sendEnvelope(token, await claim(token, id));
  const mode = async (token, value) => assert.equal((await call("/api/receiver-mode", token, { mode: value })).status, 200);
  const next = async (token) => assert.equal((await call("/api/clock", token, { toNext: true })).status, 200);
  const job = async (token, id) => (await state(token)).jobs.find((item) => item.id === id);
  async function test(name, action) {
    const started = performance.now();
    try { await action(); report.cases.push({ name, passed: true, elapsedMs: Number((performance.now() - started).toFixed(3)) }); }
    catch (error) { report.cases.push({ name, passed: false, error: String(error.message).replace(/[a-f0-9]{32}\.[a-f0-9]{64}/g, "[redacted capability]") }); }
    await save(); console.log(`${report.cases.at(-1).passed ? "PASS" : "FAIL"}: ${name}`);
  }
  try {
    await test("health declares the real backend, persistence and virtual clock", async () => {
      const r = await call("/api/health"); assert.equal(r.status, 200); assert.equal(r.data.contractVersion, 1); assert.equal(r.data.clock, "explicit virtual clock"); report.backend = r.data.backend;
    });
    await test("sandbox state has no signing secret or capability and starts empty", async () => {
      const token = await session(); const s = await state(token); assert.equal(s.jobs.length, 0); assert.equal(Object.keys(s.orders).length, 0);
      assert.ok(!JSON.stringify(s).includes("signingSecret")); assert.ok(!JSON.stringify(s).includes(token));
    });
    await test("valid HMAC over raw UTF-8 bytes applies a synthetic order once", async () => {
      const token = await session(); const p = fixture(); const id = await enqueue(token, p); const r = await send(token, id);
      assert.equal(r.status, 200); assert.equal(r.data.outcome, "applied"); const s = await state(token); assert.equal(s.orders[p.orderId].effects, 1); assert.equal(s.receipts[p.eventId].bodyHash.length, 64);
      assert.equal(s.jobs[0].status, "delivered"); assert.equal(s.jobs[0].attempts[0].effectApplied, true);
    });
    await test("repeated HTTP envelope returns its original result without another attempt", async () => {
      const token = await session(); const id = await enqueue(token); const envelope = await claim(token, id); const a = await sendEnvelope(token, envelope); const b = await sendEnvelope(token, envelope);
      assert.equal(a.status, 200); assert.equal(b.raw, a.raw); assert.equal((await job(token, id)).attempts.length, 1);
    });
    await test("duplicate event in a new delivery returns the exact cached response", async () => {
      const token = await session(); const p = fixture(); const a = await send(token, await enqueue(token, p)); const secondId = await enqueue(token, p); const b = await send(token, secondId);
      assert.equal(b.status, 200); assert.equal(b.raw, a.raw); assert.equal(b.headers.get("x-lab-outcome"), "duplicate-suppressed");
      assert.equal((await state(token)).orders[p.orderId].effects, 1); assert.equal((await job(token, secondId)).attempts[0].duplicate, true);
    });
    await test("reusing an event ID with different bytes is a permanent conflict", async () => {
      const token = await session(); const p = fixture(); await send(token, await enqueue(token, p)); const id = await enqueue(token, { ...p, version: 2, status: "shipped" });
      const r = await send(token, id); assert.equal(r.status, 409); assert.equal(r.data.error.code, "idempotency-conflict"); assert.equal((await job(token, id)).status, "dead-letter"); assert.equal((await state(token)).orders[p.orderId].effects, 1);
    });
    for (const [fault, expected, code] of [["invalid-signature", 401, "invalid-signature"], ["tampered-body", 401, "invalid-signature"], ["expired-timestamp", 401, "expired-timestamp"], ["future-timestamp", 401, "expired-timestamp"], ["malformed-json", 400, "invalid-payload"]]) {
      await test(`${fault} is rejected without applying an effect`, async () => {
        const token = await session(); const id = await enqueue(token, fixture(), fault); const r = await send(token, id);
        assert.equal(r.status, expected); assert.equal(r.data.error.code, code); const s = await state(token); assert.equal(Object.keys(s.orders).length, 0); assert.equal(s.jobs[0].status, "dead-letter"); assert.equal(s.jobs[0].attempts.length, 1);
      });
    }
    await test("outage schedules exactly 5, 15 and 45 seconds, then dead-letters", async () => {
      const token = await session(); const id = await enqueue(token); await mode(token, "outage");
      for (const [index, delay] of [5, 15, 45, null].entries()) {
        const before = await state(token); assert.equal((await send(token, id)).status, 503); const j = await job(token, id);
        assert.equal(j.attempts.length, index + 1); assert.equal(j.nextAt, delay === null ? null : before.clock + delay);
        if (delay !== null) {
          assert.equal((await call(`/api/deliveries/${id}/claim`, token, {})).status, 409, "Early retry must be rejected"); await next(token);
        }
      }
      const s = await state(token); assert.equal(s.jobs[0].status, "dead-letter"); assert.equal(Object.keys(s.orders).length, 0);
      assert.ok(s.audit.some((entry) => entry.action === "dead-lettered" && entry.correlationId === s.jobs[0].correlationId));
    });
    await test("recovery and replay preserve failed evidence and deliver successfully", async () => {
      const token = await session(); const id = await enqueue(token, fixture(), "invalid-signature"); await send(token, id);
      assert.equal((await call(`/api/deliveries/${id}/replay`, token, { repair: true })).status, 200); assert.equal((await send(token, id)).status, 200);
      const j = await job(token, id); assert.equal(j.cycle, 1); assert.equal(j.attempts.length, 2); assert.equal(j.attempts[0].httpStatus, 401); assert.equal(j.status, "delivered");
    });
    await test("lost success after commit retries without repeating the effect", async () => {
      const token = await session(); const p = fixture(); const id = await enqueue(token, p, "lost-response"); const first = await send(token, id);
      assert.equal(first.status, 503); assert.equal((await state(token)).orders[p.orderId].effects, 1); await next(token);
      assert.equal((await send(token, id)).status, 200); const s = await state(token); assert.equal(s.orders[p.orderId].effects, 1); assert.equal(s.jobs[0].attempts[1].duplicate, true);
    });
    await test("out-of-order versions are acknowledged without rolling back the order", async () => {
      const token = await session(); const latest = fixture({ version: 2, status: "shipped" }); await send(token, await enqueue(token, latest));
      const stale = fixture({ version: 1 }); const result = await send(token, await enqueue(token, stale)); assert.equal(result.status, 200); assert.equal(result.data.outcome, "ignored-stale");
      const s = await state(token); assert.equal(s.orders[latest.orderId].version, 2); assert.equal(s.orders[latest.orderId].status, "shipped"); assert.equal(s.orders[latest.orderId].effects, 1);
    });
    await test("429 Retry-After is honoured when longer than policy backoff", async () => {
      const token = await session(); const id = await enqueue(token); await mode(token, "throttled"); const before = await state(token); const envelope = await claim(token, id); const result = await sendEnvelope(token, envelope);
      assert.equal(result.status, 429); assert.equal(result.headers.get("retry-after"), "8"); assert.equal((await job(token, id)).nextAt, before.clock + 8);
      const repeated = await sendEnvelope(token, envelope); assert.equal(repeated.status, 429); assert.equal(repeated.raw, result.raw); assert.equal(repeated.headers.get("retry-after"), "8");
    });
    await test("concurrent duplicate deliveries commit exactly one order effect", async () => {
      const token = await session(); const p = fixture(); const ids = [await enqueue(token, p), await enqueue(token, p)]; const envelopes = [await claim(token, ids[0]), await claim(token, ids[1])];
      const responses = await Promise.all(envelopes.map((envelope) => sendEnvelope(token, envelope))); assert.deepEqual(responses.map((r) => r.status), [200, 200]);
      const s = await state(token); assert.equal(s.orders[p.orderId].effects, 1); assert.equal(s.jobs.flatMap((j) => j.attempts).filter((a) => a.duplicate).length, 1);
    });
    await test("reservation prevents concurrent claims and expired lease recovers", async () => {
      const token = await session(); const id = await enqueue(token); const responses = await Promise.all([call(`/api/deliveries/${id}/claim`, token, {}), call(`/api/deliveries/${id}/claim`, token, {})]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]); await next(token); const timedOut = await job(token, id);
      assert.equal(timedOut.attempts[0].httpStatus, 408); assert.equal(timedOut.status, "retrying"); await next(token); assert.equal((await send(token, id)).status, 200);
    });
    await test("another sandbox cannot read or claim this sandbox's deliveries", async () => {
      const a = await session(); const b = await session(); const id = await enqueue(a); assert.equal((await call(`/api/deliveries/${id}/claim`, b, {})).status, 404); assert.equal((await state(b)).jobs.length, 0);
    });
    await test("missing capability, cross-origin requests and forged fields are rejected", async () => {
      assert.equal((await call("/api/state")).status, 401); const token = await session();
      assert.equal((await call("/api/state", token, undefined, { headers: { Origin: "https://untrusted.invalid" } })).status, 403);
      assert.equal((await call("/api/receiver-mode", token, { mode: "healthy", signingSecret: "forged" })).status, 400);
      assert.equal((await call("/api/labs", null, { role: "admin" })).status, 400);
    });
    await test("malformed JSON, content type, oversized body and invalid payload fail", async () => {
      const token = await session(); assert.equal((await call("/api/deliveries", token, "{", { raw: true })).status, 400);
      assert.equal((await call("/api/deliveries", token, "{}", { raw: true, headers: { "Content-Type": "text/plain" } })).status, 415);
      assert.equal((await call("/api/deliveries", token, "x".repeat(8193), { raw: true })).status, 413);
      assert.equal((await call("/api/deliveries", token, { payload: fixture({ version: 0 }), fault: "none" })).status, 400);
      assert.equal((await state(token)).jobs.length, 0);
    });
    await test("replay is limited to dead letters and requires explicit repair choice", async () => {
      const token = await session(); const id = await enqueue(token); await send(token, id);
      assert.equal((await call(`/api/deliveries/${id}/replay`, token, { repair: true })).status, 409); assert.equal((await call(`/api/deliveries/${id}/replay`, token, {})).status, 400);
    });
    await test("prototype-like valid identifiers remain ordinary idempotency and order keys", async () => {
      const token = await session(); const p = fixture({ eventId: "constructor", orderId: "constructor" }); assert.equal((await send(token, await enqueue(token, p))).status, 200);
      assert.equal((await state(token)).orders.constructor.effects, 1);
    });
    await test("sandbox limit rejects more work without altering the saved queue", async () => {
      const token = await session(); for (let i = 0; i < 24; i++) await enqueue(token, fixture());
      assert.equal((await call("/api/deliveries", token, { payload: fixture(), fault: "none" })).status, 429); assert.equal((await state(token)).jobs.length, 24);
    });
    await test("revoked capability cannot retrieve persisted sandbox state", async () => {
      const token = await session(); await enqueue(token); assert.equal((await call("/api/lab", token, undefined, { method: "DELETE" })).status, 200); assert.equal((await call("/api/state", token)).status, 401);
    });
  } finally {
    for (const token of sessions) { try { await call("/api/lab", token, undefined, { method: "DELETE" }); } catch { /* Test-only sessions expire after 24 hours if cleanup cannot reach the host. */ } }
    report.finishedAt = new Date().toISOString(); const times = report.requests.map((r) => r.elapsedMs).sort((a, b) => a - b);
    report.summary = { passed: report.cases.filter((c) => c.passed).length, total: report.cases.length, httpRequests: report.requests.length,
      httpP50Ms: times[Math.max(0, Math.ceil(times.length * 0.5) - 1)], httpP95Ms: times[Math.max(0, Math.ceil(times.length * 0.95) - 1)] };
    await save(); console.log(JSON.stringify(report.summary));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
  const report = await runAcceptance(option("--url", "http://127.0.0.1:8788"), option("--output", "docs/validation/aspnet-local.json"), option("--label", "API acceptance"));
  process.exitCode = report.cases.every((c) => c.passed) ? 0 : 1;
}
