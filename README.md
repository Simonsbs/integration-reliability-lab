# Integration and Webhook Reliability Lab

A standalone operations console for diagnosing duplicate, delayed, unauthenticated and failed webhook deliveries. All orders are synthetic. This is a demonstrator, separate from customer systems and from Simon Stirling's portfolio.

**[Public demo](https://integration.bestdev.co.il/)** · **[Source](https://github.com/Simonsbs/integration-reliability-lab)** · [Validation](VALIDATION.md) · [Architecture and runbook](BUILD_NOTES.md) · [API contract](CONTRACT.md)

## Five-minute demonstration

1. Select **Run outage scenario**. The browser sends four actual HTTP requests to the unavailable receiver, advancing the explicitly virtual retry clock by 5, 15 and 45 seconds. The delivery becomes a dead letter.
2. Inspect its correlation ID, HTTP responses, attempt history and empty order ledger.
3. Select **Healthy**, then **Replay & repair sender** and **Send next attempt**. The receiver persists one order effect. Previous failed attempts remain visible.
4. Select **Queue duplicate**, then send it. The receiver returns its stored success response and suppresses the duplicate effect.
5. Try **Lose response after committing** on a new order. The synthetic 503 occurs after the receipt and order effect commit. Advance the clock and retry: the order still has one effect.

The audit tab records server transitions. Export evidence downloads the safe session snapshot. Reset revokes only your sandbox capability. Browser refresh retains the current sandbox for up to 24 hours; a separate browser session starts an isolated sandbox.

## Two actual runtimes

| Implementation | Runtime and storage | Purpose |
| --- | --- | --- |
| `server/IntegrationLab.Api` | ASP.NET Core 10, Microsoft.Data.Sqlite | Runnable .NET reference API |
| `worker` and `src/domain.ts` | Cloudflare Worker, D1 SQLite | Public demo API and static application host |
| `src/App.tsx` | React, TypeScript, Vite | Shared operations console and HTTP sender |

The public host runs the Worker implementation. Both APIs implement [contract version 1](CONTRACT.md) and run the same HTTP acceptance suite. SQLite is the documented SQL Server substitute. The receiver's receipt, business effect, delivery status and audit transition commit in one optimistic SQLite update.

## Local setup

Requirements: Node 22.18 or newer and .NET SDK 10. A supported SDK can be selected through `global.json`. Dependencies are pinned in `package-lock.json` and the .NET project file.

```sh
npm ci
npm run check
npm test
npm run build
npm run verify
```

`verify` starts each real API on an available loopback port, uses fresh isolated SQLite databases, runs the shared HTTP suite, checks actual session expiry, restarts each process and checks persisted receipts and deduplication. It stops its child processes and writes reports under `artifacts/validation`. It requires no Cloudflare login. Stored test data stays under ignored `.runtime/`.

Run these in separate terminals for the .NET-backed development UI:

```sh
npm run dev:api
npm run dev
```

Open `http://127.0.0.1:5175`. For the Worker API, first run `npm run db:local` once for a fresh local database, then `npm run dev:edge`. Set `LAB_API_URL=http://127.0.0.1:8789` in the Vite process environment to use that API. After `npm run build`, the Worker at port 8789 also serves the compiled UI directly.

```sh
npm run test:api -- --url http://127.0.0.1:8788 --label aspnet --output artifacts/aspnet.json
npm run test:api -- --url http://127.0.0.1:8789 --label worker --output artifacts/worker.json
```

## Delivery limits

This demo uses explicit virtual time and a browser sender. Closing the tab does not continue background deliveries. Outages, throttling and lost success responses are intentional fault injection. Actual HTTP, HMAC verification, SQLite persistence and concurrent-update checks still run on the server. No arbitrary destination, production webhook secret, customer data, uptime guarantee or distributed exactly-once claim is involved.

The open demo has bounded sessions and queues. See the [runbook](BUILD_NOTES.md) for capacity, data retention, diagnosis and deployment. Test measurements describe recorded synthetic runs, not a production throughput benchmark.
