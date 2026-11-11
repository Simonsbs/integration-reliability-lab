# HTTP API contract v1

Both the .NET API and the Worker implement these routes. Use UTF-8 `application/json`, with at most 8 KiB per POST. Same-origin browser requests only; localhost Vite preview is allowed only on loopback backend hosts. No permissive CORS is configured. Responses use `Cache-Control: no-store`.

| Method and route | Request | Result |
| --- | --- | --- |
| GET `/api/health` | None | 200, actual backend and contract version |
| POST `/api/labs` | `{}` | 201, one-time capability, real expiry and safe state |
| GET `/api/state` | Bearer capability | 200, safe sandbox snapshot |
| DELETE `/api/lab` | Bearer capability | 200, revoke this sandbox |
| POST `/api/deliveries` | `{payload, fault?}` | 201, deliveryId |
| POST `/api/deliveries/{id}/claim` | `{}` | 200, rawBody and signed headers; 409 if not due |
| POST `/api/receiver` | Exact claimed rawBody and headers | Receiver result, committed before response |
| POST `/api/receiver-mode` | `{mode:"healthy"|"outage"|"throttled"}` | 200 |
| POST `/api/clock` | `{seconds:1..3600}` or `{toNext:true}` | 200, new virtual UTC epoch seconds |
| POST `/api/deliveries/{id}/replay` | `{repair:true|false}` | 200 for a dead letter; 409 otherwise |

All routes after sandbox creation, except health, require `Authorization: Bearer <sandboxId>.<capability>`. A capability can only load its own sandbox. Missing/revoked capabilities return 401, expired capabilities 410 and another sandbox's delivery IDs 404. The create response is the only response containing a capability. Sender claim exposes an individual signature, never the signing key.

## Event

```json
{"eventId":"evt-demo-1","orderId":"ORD-1042","version":1,"status":"packed","note":"Synthetic order"}
```

Event/order IDs contain 1-64 ASCII alphanumeric, underscore or hyphen characters, starting with an alphanumeric character. Version is an integer 1-1000. Status is packed, shipped, delivered or cancelled. Optional note is at most 256 UTF-16 code units. Unknown fields and null faults are rejected.

Faults: `none`, `invalid-signature`, `expired-timestamp`, `future-timestamp`, `tampered-body`, `malformed-json`, `lost-response`. Receiver modes and sender faults are session scoped and visibly intentional simulations.

## Signed delivery

Claim reserves an attempt for 30 virtual seconds. Its envelope contains Content-Type, X-Lab-Timestamp, X-Lab-Signature, X-Lab-Delivery, X-Lab-Attempt and X-Correlation-Id. Send rawBody unchanged, including its exact whitespace, with these headers and the sandbox capability. Signature format is `v1=<64 hexadecimal characters>`, HMAC-SHA256 over UTF-8 `timestamp.rawBody`. The timestamp must be within 300 seconds past or future of the lab clock.

The receiver verifies the lease, timestamp, signature and schema, then evaluates availability, idempotency and order version. A delivered event stores a SHA-256 raw-body digest and its exact response text. Another delivery with the same event ID and bytes returns that text, even if newer order events have since arrived. Different bytes return 409. Repeating the same reserved attempt returns its cached result and does not add an attempt. The receipt and effect are retained for the session lifetime.

Successful responses have accepted, eventId, orderId, version and outcome (`applied` or `ignored-stale`). Error shape is `{"error":{"code":"...","message":"..."}}`. Receiver replies expose X-Lab-Outcome and X-Correlation-Id. Throttled receiver replies include Retry-After: 8.

## Retry and replay

408, 425, 429 and 5xx are retryable. Delays after the first three failed attempts are 5, 15 and 45 virtual seconds, taking the maximum of policy and Retry-After. The fourth failure enters dead letters. Permanent receiver errors immediately enter dead letters. No background action advances time or sends a request.

Replay preserves IDs, payload, original receipt and all attempt evidence. It opens a fresh four-attempt budget, at most three times. `repair:true` clears only the sender fault. A changed payload must be queued as a new event, with a new event ID. Lease expiry is recorded as a 408 when an explicit clock action reaches its deadline.

## Limits and consistency

The snapshot includes orders, receipts, delivery history, receiver mode, virtual clock, audit, backend identity and limits. It excludes signingSecret and capability hashes. Audit is capped at 200 entries. A SQLite optimistic revision update atomically commits each mutation; a conflicting request recomputes from a fresh snapshot up to eight times, then returns 409. There is no cross-sandbox transaction or distributed exactly-once guarantee. Storage and capability lifetimes are documented in BUILD_NOTES.md.
