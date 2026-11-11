import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fresh, enqueue, claim, sign, receive, advance, replay, view, LabError } from "../src/domain.ts";
import { api, readBody } from "../worker/api.ts";

const body = { eventId: "evt-test", orderId: "ORD-1042", version: 1, status: "packed", note: "שלום / München" };
const request = (state) => enqueue(state, { payload: body });
test("HMAC agrees with an independent Node crypto vector over UTF-8", async () => {
  const key = "0b".repeat(32), time = "1794400000", raw = JSON.stringify(body);
  assert.equal(await sign(key, time, raw), `v1=${createHmac("sha256", Buffer.from(key, "hex")).update(`${time}.${raw}`, "utf8").digest("hex")}`);
  assert.notEqual(await sign(key, time, raw + " "), await sign(key, time, raw));
});
for (const offset of [-301, -300, 300, 301]) test(`signature timestamp boundary ${offset} seconds`, async () => {
  const state = fresh(1794400000), job = request(state), envelope = await claim(state, job.id);
  const timestamp = String(state.clock + offset);
  envelope.headers["X-Lab-Timestamp"] = timestamp;
  envelope.headers["X-Lab-Signature"] = await sign(state.signingSecret, timestamp, envelope.rawBody);
  assert.equal((await receive(state, new Headers(envelope.headers), envelope.rawBody)).status, Math.abs(offset) > 300 ? 401 : 200);
  assert.equal(Object.keys(state.orders).length, Math.abs(offset) > 300 ? 0 : 1);
});
test("replay budget cannot erase evidence or exceed three cycles", async () => {
  const state = fresh(1794400000), job = enqueue(state, { payload: body, fault: "invalid-signature" });
  for (let cycle = 0; cycle <= 3; cycle++) {
    const envelope = await claim(state, job.id);
    assert.equal((await receive(state, new Headers(envelope.headers), envelope.rawBody)).status, 401);
    assert.equal(job.attempts.length, cycle + 1);
    if (cycle < 3) replay(state, job.id, { repair: false });
  }
  assert.throws(() => replay(state, job.id, { repair: true }), (e) => e instanceof LabError && e.code === "replay-limit");
  assert.equal(job.attempts.length, 4);
});
test("virtual clock never runs from wall time and lease expiry retains the original attempt", async () => {
  const state = fresh(1794400000), job = request(state), envelope = await claim(state, job.id);
  assert.equal(state.clock, state.startedAt);
  advance(state, { seconds: 30 });
  assert.equal(job.attempts[0].id, envelope.headers["X-Lab-Attempt"]);
  assert.equal(job.attempts[0].httpStatus, 408);
  assert.equal(job.nextAt, state.clock + 5);
});
test("real session expiry cannot be bypassed by virtual time", async () => {
  const token = `${"a".repeat(32)}.${"b".repeat(64)}`;
  const repository = { load: async () => ({ state: fresh(1794400000), expiresAt: 0, revision: 0 }) };
  const response = await api(new Request("https://lab.invalid/api/state", { headers: { Authorization: `Bearer ${token}` } }), repository, "test");
  assert.equal(response.status, 410);
});
test("public view never exposes the signing key", () => {
  const state = fresh(1794400000);
  assert.ok(!JSON.stringify(view(state, "test")).includes(state.signingSecret));
});
test("body validation rejects invalid UTF-8 before cryptographic processing", async () => {
  const request = new Request("https://lab.invalid/api/receiver", { method: "POST", headers: { "Content-Type": "application/json" }, body: new Uint8Array([0xc3, 0x28]) });
  await assert.rejects(readBody(request), (e) => e.code === "invalid-utf8");
});
test("null fault and unknown payload fields fail closed", () => {
  const state = fresh(1794400000);
  assert.throws(() => enqueue(state, { payload: body, fault: null }), (e) => e.code === "invalid-fault");
  assert.throws(() => enqueue(state, { payload: { ...body, admin: true } }), (e) => e.code === "unknown-field");
  assert.equal(state.jobs.length, 0);
});
