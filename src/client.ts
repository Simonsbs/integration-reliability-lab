import type { Audit, Fault, Job, Order, Payload, Receipt, ReceiverMode } from "./domain.ts";

export interface Snapshot {
  clock: number; startedAt: number; receiver: ReceiverMode; jobs: Job[]; orders: Record<string, Order>;
  receipts: Record<string, Receipt>; audit: Audit[]; backend: string; contractVersion: number;
  limits: { maxJobs: number; maxReplays: number; maxAttemptsPerCycle: number; retryDelays: number[]; signatureWindowSeconds: number };
}
const STORAGE_KEY = "integration-lab-capability-v1";
let token = "";
try { token = sessionStorage.getItem(STORAGE_KEY) ?? ""; } catch { /* The in-memory session still works when browser storage is disabled. */ }
function keep(value: string) { token = value; try { if (value) sessionStorage.setItem(STORAGE_KEY, value); else sessionStorage.removeItem(STORAGE_KEY); } catch { /* No persistence is required to operate the current session. */ } }

export async function request<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, { method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  const data: unknown = await response.json();
  if (!response.ok) {
    const failure = data as { error?: { message?: string } };
    throw new Error(failure?.error?.message ?? `HTTP ${response.status}`);
  }
  return data as T;
}
export async function connect(): Promise<Snapshot> {
  if (token) {
    const response = await fetch("/api/state", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (response.ok) return response.json() as Promise<Snapshot>;
    if (![401, 410].includes(response.status)) throw new Error("The saved sandbox could not be loaded. Try refreshing.");
    keep("");
  }
  const data = await request<{ token: string; lab: Snapshot }>("/api/labs", {}); keep(data.token); return data.lab;
}
export const reload = () => request<Snapshot>("/api/state");
export async function reset(): Promise<Snapshot> {
  if (token) {
    const response = await fetch("/api/lab", { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok && ![401, 410].includes(response.status)) throw new Error("The sandbox could not be reset. Try again when the connection recovers.");
  }
  keep(""); return connect();
}
export const createDelivery = (payload: Payload, fault: Fault) => request<{ deliveryId: string }>("/api/deliveries", { payload, fault });
export async function deliver(deliveryId: string) {
  const envelope = await request<{ rawBody: string; headers: Record<string, string> }>(`/api/deliveries/${deliveryId}/claim`, {});
  // The browser is the demo sender. This fetch is a real HTTP request to the fixed receiver.
  const response = await fetch("/api/receiver", { method: "POST", headers: { ...envelope.headers, Authorization: `Bearer ${token}` },
    body: envelope.rawBody, signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  return { status: response.status, result, outcome: response.headers.get("X-Lab-Outcome") };
}
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
