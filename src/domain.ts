export const RETRY_DELAYS = [5, 15, 45] as const;
export const MAX_JOBS = 24;
export const FAULTS = ["none", "invalid-signature", "expired-timestamp", "future-timestamp", "tampered-body", "malformed-json", "lost-response"] as const;
export type Fault = typeof FAULTS[number];
export type ReceiverMode = "healthy" | "outage" | "throttled";
export interface Payload { eventId: string; orderId: string; version: number; status: string; note: string }
export interface Attempt {
  id: string; number: number; cycle: number; at: number; httpStatus: number;
  outcome: string; effectApplied: boolean; duplicate: boolean; nextAt: number | null; responseBody: string;
}
export interface Job {
  id: string; correlationId: string; payload: Payload; fault: Fault; status: "queued" | "retrying" | "in-flight" | "delivered" | "dead-letter";
  createdAt: number; nextAt: number | null; cycle: number; lease: { id: string; expiresAt: number } | null; attempts: Attempt[];
}
export interface Receipt { eventId: string; bodyHash: string; responseBody: string; at: number }
export interface Order { orderId: string; version: number; status: string; effects: number }
export interface Audit { id: string; at: number; action: string; deliveryId: string | null; correlationId: string | null; detail: string }
export interface LabState {
  clock: number; startedAt: number; receiver: ReceiverMode; signingSecret: string;
  jobs: Job[]; receipts: Record<string, Receipt>; orders: Record<string, Order>; audit: Audit[];
}
export interface Reply { status: number; body: unknown; headers?: Record<string, string> }
export class LabError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const encoder = new TextEncoder();
export const randomHex = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const id = () => crypto.randomUUID().replaceAll("-", "");
export const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const digest = async (text: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
const keyBytes = (value: string) => Uint8Array.from(value.match(/../g)!.map((part) => parseInt(part, 16)));
export async function sign(secret: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `v1=${hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)))}`;
}
async function validSignature(secret: string, timestamp: string, body: string, signature: string) {
  if (!/^v1=[a-f0-9]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, keyBytes(signature.slice(3)), encoder.encode(`${timestamp}.${body}`));
}
export function audit(state: LabState, action: string, job: Job | null, detail: string) {
  state.audit.push({ id: id(), at: state.clock, action, deliveryId: job?.id ?? null, correlationId: job?.correlationId ?? null, detail });
  state.audit = state.audit.slice(-200);
}
export function fresh(clock: number): LabState {
  const state: LabState = { clock, startedAt: clock, receiver: "healthy", signingSecret: randomHex(), jobs: [], receipts: {}, orders: {}, audit: [] };
  audit(state, "sandbox-created", null, "Synthetic orders only. Retry time advances only through explicit lab actions.");
  return state;
}
export function view(state: LabState, backend: string) {
  const { signingSecret: _secret, ...safe } = state;
  return { ...safe, backend, contractVersion: 1, limits: { maxJobs: MAX_JOBS, maxReplays: 3, maxAttemptsPerCycle: 4, retryDelays: RETRY_DELAYS, signatureWindowSeconds: 300 } };
}
export function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LabError(400, "invalid-json", "Supply a JSON object.");
}
export function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new LabError(400, "unknown-field", "The request contains an unsupported field.");
}
export function payload(value: unknown): Payload {
  object(value);
  onlyKeys(value, ["eventId", "orderId", "version", "status", "note"]);
  if (typeof value.eventId !== "string" || typeof value.orderId !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.eventId) || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.orderId) ||
      !Number.isInteger(value.version) || Number(value.version) < 1 || Number(value.version) > 1000 ||
      !["packed", "shipped", "delivered", "cancelled"].includes(String(value.status)) ||
      (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 256))) {
    throw new LabError(400, "invalid-payload", "Use short event/order IDs, a version from 1 to 1000, a supported status and up to 256 note characters.");
  }
  return { eventId: value.eventId, orderId: value.orderId, version: Number(value.version), status: String(value.status), note: String(value.note ?? "") };
}
export function enqueue(state: LabState, input: unknown): Job {
  object(input); onlyKeys(input, ["payload", "fault"]);
  const data = payload(input.payload);
  const fault = input.fault === undefined ? "none" : input.fault;
  if (!FAULTS.includes(fault as Fault)) throw new LabError(400, "invalid-fault", "Choose a supported synthetic sender fault.");
  if (state.jobs.length >= MAX_JOBS) throw new LabError(429, "sandbox-full", "This sandbox holds at most 24 deliveries. Reset it to start again.");
  const job: Job = { id: id(), correlationId: id(), payload: data, fault: fault as Fault, status: "queued", createdAt: state.clock,
    nextAt: state.clock, cycle: 0, lease: null, attempts: [] };
  state.jobs.push(job); audit(state, "enqueued", job, `Event ${data.eventId} for ${data.orderId}, version ${data.version}.`);
  return job;
}
export function findJob(state: LabState, jobId: string) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) throw new LabError(404, "delivery-not-found", "This delivery is not in your sandbox.");
  return job;
}
function record(state: LabState, job: Job, attemptId: string, status: number, outcome: string, body: unknown, effectApplied = false, duplicate = false, retryAfter = 0): Reply {
  const count = job.attempts.filter((attempt) => attempt.cycle === job.cycle).length + 1;
  const retryable = [408, 425, 429].includes(status) || status >= 500;
  const nextAt = retryable && count <= RETRY_DELAYS.length ? state.clock + Math.max(RETRY_DELAYS[count - 1], retryAfter) : null;
  const responseBody = typeof body === "string" ? body : JSON.stringify(body);
  job.attempts.push({ id: attemptId, number: job.attempts.length + 1, cycle: job.cycle, at: state.clock, httpStatus: status,
    outcome, effectApplied, duplicate, nextAt, responseBody });
  job.lease = null; job.nextAt = nextAt;
  job.status = status >= 200 && status < 300 ? "delivered" : nextAt !== null ? "retrying" : "dead-letter";
  audit(state, job.status === "dead-letter" ? "dead-lettered" : nextAt !== null ? "retry-scheduled" : outcome, job,
    `HTTP ${status}; ${outcome}${nextAt !== null ? `; retry in ${nextAt - state.clock}s` : ""}.`);
  return { status, body: responseBody, headers: { "X-Lab-Outcome": outcome, "X-Correlation-Id": job.correlationId,
    ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } };
}
export function expireLeases(state: LabState) {
  for (const job of state.jobs) if (job.lease && job.lease.expiresAt <= state.clock) {
    record(state, job, job.lease.id, 408, "sender-timeout", { error: { code: "sender-timeout", message: "The reserved attempt was not completed before its virtual lease expired." } });
  }
}
export async function claim(state: LabState, jobId: string) {
  expireLeases(state);
  const job = findJob(state, jobId);
  if (job.lease || !["queued", "retrying"].includes(job.status) || job.nextAt === null || job.nextAt > state.clock) {
    throw new LabError(409, "not-due", "This delivery is not due, is already reserved, or needs dead-letter replay.");
  }
  job.lease = { id: id(), expiresAt: state.clock + 30 }; job.status = "in-flight"; job.nextAt = null;
  let body = job.fault === "malformed-json" ? "{" : JSON.stringify(job.payload);
  const timestamp = String(state.clock + (job.fault === "expired-timestamp" ? -301 : job.fault === "future-timestamp" ? 301 : 0));
  let signature = await sign(state.signingSecret, timestamp, body);
  if (job.fault === "invalid-signature") signature = `v1=${"0".repeat(64)}`;
  if (job.fault === "tampered-body") body += " ";
  audit(state, "attempt-reserved", job, "A signed delivery envelope was issued to the browser sender for a real HTTP request.");
  return { deliveryId: job.id, rawBody: body, headers: { "Content-Type": "application/json", "X-Lab-Timestamp": timestamp,
    "X-Lab-Signature": signature, "X-Lab-Delivery": job.id, "X-Lab-Attempt": job.lease.id, "X-Correlation-Id": job.correlationId } };
}
export async function receive(state: LabState, headers: Headers, raw: string): Promise<Reply> {
  const job = findJob(state, headers.get("X-Lab-Delivery") ?? "");
  const attemptId = headers.get("X-Lab-Attempt") ?? "";
  const prior = job.attempts.find((attempt) => attempt.id === attemptId);
  if (prior) return { status: prior.httpStatus, body: prior.responseBody, headers: { "X-Lab-Outcome": prior.outcome, "X-Correlation-Id": job.correlationId,
    ...(prior.outcome === "receiver-throttled" ? { "Retry-After": "8" } : {}) } };
  if (!job.lease || job.lease.id !== attemptId) throw new LabError(409, "invalid-lease", "Reserve this delivery before sending it.");
  const fail = (status: number, code: string, message: string, retryAfter = 0) => record(state, job, attemptId, status, code, { error: { code, message } }, false, false, retryAfter);
  if (job.lease.expiresAt <= state.clock) return fail(408, "sender-timeout", "The virtual attempt lease expired.");
  const timestamp = headers.get("X-Lab-Timestamp") ?? "";
  if (!/^\d{10,12}$/.test(timestamp) || Math.abs(state.clock - Number(timestamp)) > 300) return fail(401, "expired-timestamp", "The signed timestamp is outside the five-minute past/future window.");
  if (!await validSignature(state.signingSecret, timestamp, raw, headers.get("X-Lab-Signature") ?? "")) return fail(401, "invalid-signature", "HMAC-SHA256 verification of the raw request bytes failed.");
  let data: Payload;
  try { data = payload(JSON.parse(raw)); } catch { return fail(400, "invalid-payload", "The verified request body is not a valid order event."); }
  // Bind a reserved sender job to its event; caller text cannot redirect an attempt.
  if (data.eventId !== job.payload.eventId || data.orderId !== job.payload.orderId) return fail(400, "envelope-mismatch", "The event does not match its reserved delivery.");
  if (state.receiver === "outage") return fail(503, "receiver-unavailable", "Synthetic receiver outage.");
  if (state.receiver === "throttled") return fail(429, "receiver-throttled", "Synthetic receiver rate limit.", 8);
  const bodyHash = await digest(raw);
  const receipt = Object.hasOwn(state.receipts, data.eventId) ? state.receipts[data.eventId] : undefined;
  if (receipt) {
    if (receipt.bodyHash !== bodyHash) return fail(409, "idempotency-conflict", "This event ID was already used with different request bytes.");
    return record(state, job, attemptId, 200, "duplicate-suppressed", receipt.responseBody, false, true);
  }
  const existing = Object.hasOwn(state.orders, data.orderId) ? state.orders[data.orderId] : undefined;
  const applied = !existing || data.version > existing.version;
  if (applied) state.orders[data.orderId] = { orderId: data.orderId, version: data.version, status: data.status, effects: (existing?.effects ?? 0) + 1 };
  const responseBody = JSON.stringify({ accepted: true, eventId: data.eventId, orderId: data.orderId, version: data.version, outcome: applied ? "applied" : "ignored-stale" });
  state.receipts[data.eventId] = { eventId: data.eventId, bodyHash, responseBody, at: state.clock };
  if (job.fault === "lost-response" && applied) {
    audit(state, "effect-applied", job, "The receiver committed the effect and idempotency receipt before simulating a lost success response.");
    return record(state, job, attemptId, 503, "response-lost-after-commit", { error: { code: "simulated-response-loss", message: "The effect was committed but the sender did not receive success. This response loss is intentionally simulated." } }, true);
  }
  return record(state, job, attemptId, 200, applied ? "applied" : "ignored-stale", responseBody, applied);
}
export function replay(state: LabState, jobId: string, input: unknown) {
  object(input); onlyKeys(input, ["repair"]);
  if (typeof input.repair !== "boolean") throw new LabError(400, "invalid-replay", "Specify whether to repair the synthetic sender fault.");
  const job = findJob(state, jobId);
  if (job.status !== "dead-letter") throw new LabError(409, "not-dead-letter", "Only dead-letter deliveries can be replayed.");
  if (job.cycle >= 3) throw new LabError(429, "replay-limit", "Reset the sandbox after three replay cycles.");
  job.cycle++; job.status = "queued"; job.nextAt = state.clock; job.lease = null;
  if (input.repair) job.fault = "none";
  audit(state, "replayed", job, `Replay cycle ${job.cycle}; prior attempts retained; sender fault ${input.repair ? "repaired" : "preserved"}.`);
}
export function advance(state: LabState, input: unknown) {
  object(input); onlyKeys(input, ["seconds", "toNext"]);
  let seconds: number;
  if (input.toNext === true && input.seconds === undefined) {
    const times = state.jobs.flatMap((job) => job.lease ? [job.lease.expiresAt] : job.nextAt !== null ? [job.nextAt] : []).filter((at) => at > state.clock);
    if (!times.length) throw new LabError(409, "nothing-scheduled", "No future retry or lease expiry is scheduled.");
    seconds = Math.min(...times) - state.clock;
  } else {
    if (input.toNext !== undefined || !Number.isInteger(input.seconds) || Number(input.seconds) < 1 || Number(input.seconds) > 3600) throw new LabError(400, "invalid-clock", "Advance 1-3600 virtual seconds, or select the next deadline.");
    seconds = Number(input.seconds);
  }
  state.clock += seconds; audit(state, "clock-advanced", null, `Advanced ${seconds} virtual seconds. Real wall-clock time is unchanged.`); expireLeases(state);
}
