import { advance, audit, claim, digest, enqueue, fresh, id, LabError, object, onlyKeys, randomHex, receive, replay, view } from "../src/domain.ts";
import type { LabState, Reply, ReceiverMode } from "../src/domain.ts";

export interface StoredLab { state: LabState; revision: number; expiresAt: number }
export interface Repository {
  create(labId: string, tokenHash: string, state: LabState, expiresAt: number): Promise<void>;
  load(labId: string, tokenHash: string): Promise<StoredLab | null>;
  save(labId: string, tokenHash: string, revision: number, state: LabState): Promise<boolean>;
  remove(labId: string, tokenHash: string): Promise<void>;
}
export async function readBody(request: Request) {
  if ((request.headers.get("content-type") ?? "").split(";")[0].trim() !== "application/json") throw new LabError(415, "content-type", "Use application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new LabError(400, "empty-body", "Supply a JSON body.");
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 8192) { await reader.cancel(); throw new LabError(413, "body-too-large", "Request bodies are limited to 8 KiB."); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new LabError(400, "invalid-utf8", "Use UTF-8 JSON."); }
}
function parse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new LabError(400, "invalid-json", "Supply valid JSON."); }
}
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function response(reply: Reply) {
  return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status, headers: { ...headers, ...reply.headers } });
}
export async function api(request: Request, repository: Repository, backend: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const localPreview = ["127.0.0.1", "localhost"].includes(url.hostname) && ["http://127.0.0.1:5175", "http://localhost:5175"].includes(origin ?? "");
    if (origin && origin !== url.origin && !localPreview) throw new LabError(403, "origin", "Use this application's origin.");
    if (request.method === "GET" && url.pathname === "/api/health") return response({ status: 200, body: { ready: true, backend, contractVersion: 1, persistence: "SQLite with optimistic concurrency", clock: "explicit virtual clock", receiverPath: "/api/receiver" } });
    const raw = request.method === "POST" ? await readBody(request) : "";
    if (url.pathname === "/api/labs" && request.method === "POST") {
      const input = parse(raw); object(input); onlyKeys(input, []);
      const labId = id(); const token = `${labId}.${randomHex()}`;
      const now = Math.floor(Date.now() / 1000); const state = fresh(now); const expiresAt = now + 86400;
      await repository.create(labId, await digest(token), state, expiresAt);
      return response({ status: 201, body: { token, expiresAt, lab: view(state, backend) } });
    }
    const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{32}\.[a-f0-9]{64})$/)?.[1];
    if (!token) throw new LabError(401, "unauthorised", "Open a fresh sandbox to get a scoped session capability.");
    const labId = token.split(".")[0]; const tokenHash = await digest(token);
    for (let retry = 0; retry < 8; retry++) {
      const stored = await repository.load(labId, tokenHash);
      if (!stored) throw new LabError(401, "unauthorised", "This sandbox capability is invalid or revoked.");
      if (stored.expiresAt <= Math.floor(Date.now() / 1000)) throw new LabError(410, "session-expired", "This sandbox has expired. Open a new one.");
      const state = stored.state;
      if (request.method === "GET" && url.pathname === "/api/state") return response({ status: 200, body: view(state, backend) });
      if (request.method === "DELETE" && url.pathname === "/api/lab") {
        await repository.remove(labId, tokenHash); return response({ status: 200, body: { revoked: true } });
      }
      let result: Reply;
      if (request.method === "POST" && url.pathname === "/api/receiver") {
        result = await receive(state, request.headers, raw);
      } else if (request.method === "POST" && url.pathname === "/api/deliveries") {
        const job = enqueue(state, parse(raw)); result = { status: 201, body: { deliveryId: job.id } };
      } else if (request.method === "POST" && /^\/api\/deliveries\/[a-f0-9]{32}\/claim$/.test(url.pathname)) {
        const input = parse(raw); object(input); onlyKeys(input, []);
        result = { status: 200, body: await claim(state, url.pathname.split("/")[3]) };
      } else if (request.method === "POST" && /^\/api\/deliveries\/[a-f0-9]{32}\/replay$/.test(url.pathname)) {
        replay(state, url.pathname.split("/")[3], parse(raw)); result = { status: 200, body: { replayed: true } };
      } else if (request.method === "POST" && url.pathname === "/api/receiver-mode") {
        const input = parse(raw); object(input); onlyKeys(input, ["mode"]);
        if (!["healthy", "outage", "throttled"].includes(String(input.mode))) throw new LabError(400, "invalid-mode", "Choose healthy, outage or throttled.");
        state.receiver = input.mode as ReceiverMode; audit(state, "receiver-mode", null, `Receiver is now ${state.receiver}.`);
        result = { status: 200, body: { mode: state.receiver } };
      } else if (request.method === "POST" && url.pathname === "/api/clock") {
        advance(state, parse(raw)); result = { status: 200, body: { clock: state.clock } };
      } else throw new LabError(404, "route-not-found", "API route not found.");
      if (await repository.save(labId, tokenHash, stored.revision, state)) return response(result);
    }
    throw new LabError(409, "concurrent-update", "Concurrent changes prevented this update. Refresh and try again.");
  } catch (error) {
    if (error instanceof LabError) return response({ status: error.status, body: { error: { code: error.code, message: error.message } } });
    // Do not log tokens, signing secrets, raw event bodies or response payloads.
    console.error(JSON.stringify({ component: "integration-lab", event: "request-failed", errorType: error instanceof Error ? error.name : "Unknown" }));
    return response({ status: 500, body: { error: { code: "internal-error", message: "The lab could not complete this request." } } });
  }
}
