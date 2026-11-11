import test from "node:test";
import assert from "node:assert/strict";

for (const status of [401, 410, 503]) test(`reset handles HTTP ${status} without trapping or silently discarding the sandbox`, async () => {
  const savedFetch = globalThis.fetch, savedStorage = globalThis.sessionStorage;
  const original = "test-capability"; const calls = []; let stored = original;
  globalThis.sessionStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; }, removeItem: () => { stored = ""; } };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, method: options.method });
    return path === "/api/lab" ? new Response("{}", { status }) : Response.json({ token: "fresh-capability", lab: { jobs: [] } }, { status: 201 });
  };
  try {
    const client = await import(`../src/client.ts?reset=${status}`);
    if (status === 503) { await assert.rejects(client.reset(), /could not be reset/); assert.equal(stored, original); assert.equal(calls.length, 1); }
    else { assert.deepEqual(await client.reset(), { jobs: [] }); assert.equal(stored, "fresh-capability"); assert.equal(calls[1].path, "/api/labs"); }
  } finally { globalThis.fetch = savedFetch; if (savedStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = savedStorage; }
});
