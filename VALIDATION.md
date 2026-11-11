# Validation evidence

Validation is performed by the coding agent against synthetic data. It is not a human usability study, penetration test, production load test or service availability measurement.

## Automated checks

The same `scripts/acceptance.mjs` issues real HTTP requests against ASP.NET Core + SQLite and Cloudflare Worker + D1. Its JSON reports include individual cases, method/path/status timings and canonical LF SHA-256 hashes of the API sources. Capabilities, signing keys and signatures are excluded. It cleans up its own synthetic sessions. Historical failed reports, if any, remain separate from the latest passing evidence.

The suite covers valid UTF-8 signatures, repeated envelopes, exact cached duplicate responses, conflicting bytes, bad signatures, tampering, past/future timestamps, malformed payloads, 503 retry exhaustion, controlled replay, committed-effect response loss, out-of-order versions, 429 Retry-After, concurrent claims and duplicates, lease timeout, tenant isolation, origin/auth/input boundaries, prototype-like identifiers, bounded queues and revocation.

`npm test` adds an independent Node HMAC vector, timestamp boundary tests, replay limits, virtual lease expiry, capability expiry, secret-free views and invalid UTF-8 checks. `npm run verify` starts and stops both real runtimes with fresh SQLite databases, checks persisted capability expiry over HTTP, and proves receipt/order persistence and deduplication after actual process restarts. CI runs these commands on Windows and Linux. Build and dependency checks are separate from browser validation.

Committed measured reports live in [docs/validation](https://github.com/Simonsbs/integration-reliability-lab/tree/main/docs/validation). Each report records its own time, scope and source identity. Public reports are also downloadable under `/validation/`. Timing percentiles are observations of those small sequential synthetic runs, not representative throughput or an SLA. Retries are virtual seconds, not measured real scheduler intervals.

## Version 1 results, 11 November 2026

| Check | Recorded result |
| --- | --- |
| Unit and client error recovery | 14/14 passed |
| ASP.NET Core + SQLite HTTP contract | 25/25 passed, 216 requests |
| Worker + local D1 HTTP contract | 25/25 passed, 216 requests |
| Public custom-domain HTTP contract | 25/25 passed, 216 requests |
| Real expired capability | HTTP 410 from both actual local runtimes |
| Actual process restart | Orders, delivery status and exact duplicate receipts persisted in both runtimes |
| Public deployment change | D1 order and receipt persisted from Site version 1 to version 2 |
| HTTPS, headers, static assets, docs and route boundaries | 6/6 public smoke checks passed |
| GitHub Actions | Both Windows and Linux passed build, unit checks and both runtime suites |
| Browser operations | Outage, recovery, lost-response deduplication, refresh, audit, evidence export and reset checked |
| Mobile browser | 390 × 844 viewport; signature rejection, repaired replay, filters and contained audit scrolling checked |

Machine-readable results are in `docs/validation/release.json`, the individual JSON reports and the linked CI logs. Browser evidence is agent-observed; screenshots accompany it. The public run recorded median HTTP response time of 189.189 ms and p95 222.699 ms on this client. These figures include different API operations and test cleanup, and describe this run only. The final throttle case also checks that a repeated attempt retains its original Retry-After header.

The initial public smoke check found that the hosting layer served separately packaged static files before the Worker, bypassing its headers. The build now embeds all assets and packages only the Worker. A build-time artifact check prevents that layout regression. The first retry after deployment still saw the previous cached static responses while the host propagated the change; the subsequent bare-URL check passed all six checks. Both earlier smoke reports are retained, rather than replaced with passing results.

## Scope limits

The browser sender, fixed local receiver and virtual clock are deliberate demonstration boundaries. There is no customer integration, background queue consumer, real external receiver failure or production credential rotation. The lost-response control intentionally returns a synthetic 503 after an actual database commit. Tests establish behavior of the bounded fixtures and implemented contract only. Multi-region outages, sustained load, malicious traffic and production key management are outside this version.
