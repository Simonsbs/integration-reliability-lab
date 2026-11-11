import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const base = option("--url", "https://integration.bestdev.co.il");
const output = resolve(option("--output", "docs/validation/public-smoke.json"));
const checks = [];
async function check(name, action) { try { await action(); checks.push({ name, passed: true }); } catch (e) { checks.push({ name, passed: false, error: e.message }); } }
let html = "";
await check("HTTPS opens the standalone application without sign-in", async () => {
  assert.equal(new URL(base).protocol, "https:"); const r = await fetch(base, { redirect: "error" }); assert.equal(r.status, 200); html = await r.text(); assert.match(html, /Integration Lab/); assert.match(r.headers.get("content-type"), /text\/html/);
});
await check("security headers constrain scripts, connections and framing", async () => {
  const r = await fetch(base); assert.match(r.headers.get("content-security-policy"), /connect-src 'self'/); assert.match(r.headers.get("content-security-policy"), /script-src 'self'/); assert.equal(r.headers.get("x-frame-options"), "DENY"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});
await check("hashed application assets load with immutable caching", async () => {
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((m) => m[1]); assert.ok(assets.length >= 2);
  for (const asset of assets) { const r = await fetch(base + asset); assert.equal(r.status, 200); assert.match(r.headers.get("cache-control"), /immutable/); assert.ok((await r.arrayBuffer()).byteLength > 0); }
});
await check("build notes, API contract and validation are available", async () => {
  for (const path of ["/docs/BUILD_NOTES.md", "/docs/CONTRACT.md", "/docs/VALIDATION.md", "/favicon.svg"]) { const r = await fetch(base + path); assert.equal(r.status, 200); assert.ok((await r.text()).length > 0); }
});
await check("unknown assets are 404 and static POST is 405", async () => { assert.equal((await fetch(base + "/missing-file.svg")).status, 404); assert.equal((await fetch(base + "/", { method: "POST" })).status, 405); });
await check("API reports Worker with no-store and rejects a foreign origin", async () => {
  const r = await fetch(base + "/api/health"); const data = await r.json(); assert.equal(data.backend, "Cloudflare Worker + D1"); assert.match(r.headers.get("cache-control"), /no-store/); assert.equal((await fetch(base + "/api/health", { headers: { Origin: "https://untrusted.invalid" } })).status, 403);
});
await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ url: base, checkedAt: new Date().toISOString(), checks, passed: checks.every((c) => c.passed) }, null, 2) + "\n");
console.log(JSON.stringify(checks)); process.exitCode = checks.every((c) => c.passed) ? 0 : 1;
