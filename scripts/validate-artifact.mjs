import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const manifest = JSON.parse(await readFile("dist/.openai/hosting.json", "utf8"));
assert.equal(manifest.d1, "DB"); assert.ok(!manifest.static);
assert.deepEqual((await readdir("dist")).sort(), [".openai", "server"], "Static fast paths must not bypass Worker security headers");
const { default: worker } = await import(pathToFileURL(resolve("dist/server/index.js")).href + `?verify=${Date.now()}`);
const response = await worker.fetch(new Request("https://lab.invalid/"), {});
assert.equal(response.status, 200); assert.match(response.headers.get("content-security-policy"), /script-src 'self'/); assert.equal(response.headers.get("x-frame-options"), "DENY");
const html = await response.text(); const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((m) => m[1]);
assert.ok(assets.length >= 2);
for (const asset of assets) { const r = await worker.fetch(new Request("https://lab.invalid" + asset), {}); assert.equal(r.status, 200); assert.match(r.headers.get("cache-control"), /immutable/); assert.ok((await r.arrayBuffer()).byteLength > 0); }
for (const path of ["/docs/BUILD_NOTES.md", "/docs/VALIDATION.md", "/docs/CONTRACT.md", "/favicon.svg"]) assert.equal((await worker.fetch(new Request("https://lab.invalid" + path), {})).status, 200);
assert.equal((await worker.fetch(new Request("https://lab.invalid/missing"), {})).status, 404);
assert.equal((await worker.fetch(new Request("https://lab.invalid/", { method: "POST" }), {})).status, 405);
console.log("PASS: packaged Worker serves the UI, assets, docs, cache policy and security headers without a static bypass");
