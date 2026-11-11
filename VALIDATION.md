# Validation evidence

Validation is performed by the coding agent against synthetic data. It is not a human usability study, penetration test, production load test or service availability measurement.

## Automated checks

The same `scripts/acceptance.mjs` issues real HTTP requests against ASP.NET Core + SQLite and Cloudflare Worker + D1. Its JSON reports include individual cases, method/path/status timings and canonical LF SHA-256 hashes of the API sources. Capabilities, signing keys and signatures are excluded. It cleans up its own synthetic sessions. Historical failed reports, if any, remain separate from the latest passing evidence.

The suite covers valid UTF-8 signatures, repeated envelopes, exact cached duplicate responses, conflicting bytes, bad signatures, tampering, past/future timestamps, malformed payloads, 503 retry exhaustion, controlled replay, committed-effect response loss, out-of-order versions, 429 Retry-After, concurrent claims and duplicates, lease timeout, tenant isolation, origin/auth/input boundaries, prototype-like identifiers, bounded queues and revocation.

`npm test` adds an independent Node HMAC vector, timestamp boundary tests, replay limits, virtual lease expiry, capability expiry, secret-free views and invalid UTF-8 checks. `npm run verify` starts and stops both real runtimes with fresh SQLite databases, checks persisted capability expiry over HTTP, and proves receipt/order persistence and deduplication after actual process restarts. CI runs these commands on Windows and Linux. Build and dependency checks are separate from browser validation.

Committed measured reports live in [docs/validation](https://github.com/Simonsbs/integration-reliability-lab/tree/main/docs/validation). Each report records its own time, scope and source identity. Public reports are also downloadable under `/validation/`. Timing percentiles are observations of those small sequential synthetic runs, not representative throughput or an SLA. Retries are virtual seconds, not measured real scheduler intervals.

## Release validation status

The final browser, public deployment and CI results are recorded in `docs/validation/release.json` when completed. Until that record exists, local passing results alone do not establish a completed public release.

## Scope limits

The browser sender, fixed local receiver and virtual clock are deliberate demonstration boundaries. There is no customer integration, background queue consumer, real external receiver failure or production credential rotation. The lost-response control intentionally returns a synthetic 503 after an actual database commit. Tests establish behavior of the bounded fixtures and implemented contract only. Multi-region outages, sustained load, malicious traffic and production key management are outside this version.
