using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace IntegrationLab;

public sealed class LabException(int status, string code, string message) : Exception(message) { public int Status { get; } = status; public string Code { get; } = code; }
public sealed record EventPayload(string EventId, string OrderId, int Version, string Status, string Note);
public sealed record Lease(string Id, long ExpiresAt);
public sealed record Attempt(string Id, int Number, int Cycle, long At, int HttpStatus, string Outcome, bool EffectApplied, bool Duplicate, long? NextAt, string ResponseBody);
public sealed record Receipt(string EventId, string BodyHash, string ResponseBody, long At);
public sealed record Order(string OrderId, int Version, string Status, int Effects);
public sealed record AuditEntry(string Id, long At, string Action, string? DeliveryId, string? CorrelationId, string Detail);
public sealed class Job {
    public string Id { get; set; } = ""; public string CorrelationId { get; set; } = "";
    public EventPayload Payload { get; set; } = new("", "", 0, "", ""); public string Fault { get; set; } = "none";
    public string Status { get; set; } = "queued"; public long CreatedAt { get; set; } public long? NextAt { get; set; }
    public int Cycle { get; set; } public Lease? Lease { get; set; } public List<Attempt> Attempts { get; set; } = [];
}
public sealed class LabState {
    public long Clock { get; set; } public long StartedAt { get; set; } public string Receiver { get; set; } = "healthy";
    public string SigningSecret { get; set; } = ""; public List<Job> Jobs { get; set; } = [];
    public Dictionary<string, Receipt> Receipts { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, Order> Orders { get; set; } = new(StringComparer.Ordinal);
    public List<AuditEntry> Audit { get; set; } = [];
}
public sealed record Reply(int Status, object Body, Dictionary<string, string>? Headers = null);

public static class Domain {
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public static readonly int[] RetryDelays = [5, 15, 45];
    public static readonly string[] Faults = ["none", "invalid-signature", "expired-timestamp", "future-timestamp", "tampered-body", "malformed-json", "lost-response"];
    public static string NewId() => Guid.NewGuid().ToString("N");
    public static string RandomHex() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public static string Digest(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    public static string Stringify(object value) => JsonSerializer.Serialize(value, Json);
    public static string Sign(string secret, string timestamp, string body) => "v1=" + Convert.ToHexString(HMACSHA256.HashData(Convert.FromHexString(secret), Encoding.UTF8.GetBytes(timestamp + "." + body))).ToLowerInvariant();
    public static bool ValidSignature(string secret, string timestamp, string body, string signature) {
        if (!Regex.IsMatch(signature, "^v1=[a-f0-9]{64}$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) return false;
        return CryptographicOperations.FixedTimeEquals(Convert.FromHexString(Sign(secret, timestamp, body)[3..]), Convert.FromHexString(signature[3..]));
    }
    public static JsonObject Obj(JsonNode? value) => value as JsonObject ?? throw new LabException(400, "invalid-json", "Supply a JSON object.");
    public static void Only(JsonObject obj, params string[] keys) {
        if (obj.Any(pair => !keys.Contains(pair.Key, StringComparer.Ordinal))) throw new LabException(400, "unknown-field", "The request contains an unsupported field.");
    }
    public static string? Text(JsonNode? value) => value is JsonValue v && v.TryGetValue<string>(out var text) ? text : null;
    public static double? Number(JsonNode? value) => value is JsonValue v && v.TryGetValue<double>(out var number) ? number : null;
    public static bool? Boolean(JsonNode? value) => value is JsonValue v && v.TryGetValue<bool>(out var boolean) ? boolean : null;
    public static EventPayload Payload(JsonNode? value) {
        var obj = Obj(value); Only(obj, "eventId", "orderId", "version", "status", "note");
        var eventId = Text(obj["eventId"]); var orderId = Text(obj["orderId"]); var version = Number(obj["version"]); var status = Text(obj["status"]); var note = Text(obj["note"]);
        if (eventId is null || orderId is null || !Regex.IsMatch(eventId, "^[a-z0-9][a-z0-9_-]{0,63}$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) ||
            !Regex.IsMatch(orderId, "^[a-z0-9][a-z0-9_-]{0,63}$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) ||
            version is null || version < 1 || version > 1000 || Math.Floor(version.Value) != version ||
            !new[] { "packed", "shipped", "delivered", "cancelled" }.Contains(status, StringComparer.Ordinal) ||
            (obj.ContainsKey("note") && (note is null || note.Length > 256)))
            throw new LabException(400, "invalid-payload", "Use short event/order IDs, a version from 1 to 1000, a supported status and up to 256 note characters.");
        return new(eventId, orderId, (int)version.Value, status!, note ?? "");
    }
    public static void Audit(LabState state, string action, Job? job, string detail) {
        state.Audit.Add(new(NewId(), state.Clock, action, job?.Id, job?.CorrelationId, detail));
        if (state.Audit.Count > 200) state.Audit.RemoveRange(0, state.Audit.Count - 200);
    }
    public static LabState Fresh(long clock) {
        var state = new LabState { Clock = clock, StartedAt = clock, SigningSecret = RandomHex() };
        Audit(state, "sandbox-created", null, "Synthetic orders only. Retry time advances only through explicit lab actions."); return state;
    }
    public static object View(LabState state) => new { state.Clock, state.StartedAt, state.Receiver, state.Jobs, state.Receipts, state.Orders, state.Audit,
        backend = "ASP.NET Core + SQLite", contractVersion = 1, limits = new { maxJobs = 24, maxReplays = 3, maxAttemptsPerCycle = 4, retryDelays = RetryDelays, signatureWindowSeconds = 300 } };
    public static Job Enqueue(LabState state, JsonNode? input) {
        var obj = Obj(input); Only(obj, "payload", "fault"); var data = Payload(obj["payload"]); var fault = obj.ContainsKey("fault") ? Text(obj["fault"]) : "none";
        if (fault is null || !Faults.Contains(fault, StringComparer.Ordinal)) throw new LabException(400, "invalid-fault", "Choose a supported synthetic sender fault.");
        if (state.Jobs.Count >= 24) throw new LabException(429, "sandbox-full", "This sandbox holds at most 24 deliveries. Reset it to start again.");
        var job = new Job { Id = NewId(), CorrelationId = NewId(), Payload = data, Fault = fault, CreatedAt = state.Clock, NextAt = state.Clock };
        state.Jobs.Add(job); Audit(state, "enqueued", job, $"Event {data.EventId} for {data.OrderId}, version {data.Version}."); return job;
    }
    public static Job Find(LabState state, string jobId) => state.Jobs.Find(job => job.Id == jobId) ?? throw new LabException(404, "delivery-not-found", "This delivery is not in your sandbox.");
    private static Reply Record(LabState state, Job job, string attemptId, int status, string outcome, object body, bool applied = false, bool duplicate = false, int retryAfter = 0) {
        var count = job.Attempts.Count(attempt => attempt.Cycle == job.Cycle) + 1;
        var retryable = status is 408 or 425 or 429 || status >= 500;
        long? next = retryable && count <= RetryDelays.Length ? state.Clock + Math.Max(RetryDelays[count - 1], retryAfter) : null;
        var responseBody = body is string text ? text : Stringify(body);
        job.Attempts.Add(new(attemptId, job.Attempts.Count + 1, job.Cycle, state.Clock, status, outcome, applied, duplicate, next, responseBody));
        job.Lease = null; job.NextAt = next; job.Status = status is >= 200 and < 300 ? "delivered" : next is not null ? "retrying" : "dead-letter";
        Audit(state, job.Status == "dead-letter" ? "dead-lettered" : next is not null ? "retry-scheduled" : outcome, job,
            $"HTTP {status}; {outcome}" + (next is not null ? $"; retry in {next - state.Clock}s" : "") + ".");
        var headers = new Dictionary<string, string> { ["X-Lab-Outcome"] = outcome, ["X-Correlation-Id"] = job.CorrelationId };
        if (retryAfter > 0) headers["Retry-After"] = retryAfter.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new(status, responseBody, headers);
    }
    private static object Error(string code, string message) => new { error = new { code, message } };
    public static void ExpireLeases(LabState state) {
        foreach (var job in state.Jobs) if (job.Lease is { } lease && lease.ExpiresAt <= state.Clock)
            Record(state, job, lease.Id, 408, "sender-timeout", Error("sender-timeout", "The reserved attempt was not completed before its virtual lease expired."));
    }
    public static object Claim(LabState state, string jobId) {
        ExpireLeases(state); var job = Find(state, jobId);
        if (job.Lease is not null || job.Status is not ("queued" or "retrying") || job.NextAt is null || job.NextAt > state.Clock)
            throw new LabException(409, "not-due", "This delivery is not due, is already reserved, or needs dead-letter replay.");
        job.Lease = new(NewId(), state.Clock + 30); job.Status = "in-flight"; job.NextAt = null;
        var body = job.Fault == "malformed-json" ? "{" : Stringify(job.Payload);
        var timestamp = (state.Clock + (job.Fault == "expired-timestamp" ? -301 : job.Fault == "future-timestamp" ? 301 : 0)).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var signature = job.Fault == "invalid-signature" ? "v1=" + new string('0', 64) : Sign(state.SigningSecret, timestamp, body);
        if (job.Fault == "tampered-body") body += " ";
        Audit(state, "attempt-reserved", job, "A signed delivery envelope was issued to the browser sender for a real HTTP request.");
        return new { deliveryId = job.Id, rawBody = body, headers = new Dictionary<string, string> { ["Content-Type"] = "application/json", ["X-Lab-Timestamp"] = timestamp,
            ["X-Lab-Signature"] = signature, ["X-Lab-Delivery"] = job.Id, ["X-Lab-Attempt"] = job.Lease.Id, ["X-Correlation-Id"] = job.CorrelationId } };
    }
    public static Reply Receive(LabState state, IHeaderDictionary headers, string raw) {
        var job = Find(state, headers["X-Lab-Delivery"].ToString()); var attemptId = headers["X-Lab-Attempt"].ToString();
        var prior = job.Attempts.Find(attempt => attempt.Id == attemptId);
        if (prior is not null) return new(prior.HttpStatus, prior.ResponseBody, new() { ["X-Lab-Outcome"] = prior.Outcome, ["X-Correlation-Id"] = job.CorrelationId });
        if (job.Lease is null || job.Lease.Id != attemptId) throw new LabException(409, "invalid-lease", "Reserve this delivery before sending it.");
        Reply Fail(int status, string code, string message, int retryAfter = 0) => Record(state, job, attemptId, status, code, Error(code, message), retryAfter: retryAfter);
        if (job.Lease.ExpiresAt <= state.Clock) return Fail(408, "sender-timeout", "The virtual attempt lease expired.");
        var timestamp = headers["X-Lab-Timestamp"].ToString();
        if (!Regex.IsMatch(timestamp, "^\\d{10,12}$", RegexOptions.CultureInvariant) || !long.TryParse(timestamp, out var time) || Math.Abs(state.Clock - time) > 300)
            return Fail(401, "expired-timestamp", "The signed timestamp is outside the five-minute past/future window.");
        if (!ValidSignature(state.SigningSecret, timestamp, raw, headers["X-Lab-Signature"].ToString())) return Fail(401, "invalid-signature", "HMAC-SHA256 verification of the raw request bytes failed.");
        EventPayload data;
        try { data = Payload(JsonNode.Parse(raw)); } catch (Exception error) when (error is JsonException or LabException) { return Fail(400, "invalid-payload", "The verified request body is not a valid order event."); }
        if (data.EventId != job.Payload.EventId || data.OrderId != job.Payload.OrderId) return Fail(400, "envelope-mismatch", "The event does not match its reserved delivery.");
        if (state.Receiver == "outage") return Fail(503, "receiver-unavailable", "Synthetic receiver outage.");
        if (state.Receiver == "throttled") return Fail(429, "receiver-throttled", "Synthetic receiver rate limit.", 8);
        var hash = Digest(raw);
        if (state.Receipts.TryGetValue(data.EventId, out var receipt)) {
            if (receipt.BodyHash != hash) return Fail(409, "idempotency-conflict", "This event ID was already used with different request bytes.");
            return Record(state, job, attemptId, 200, "duplicate-suppressed", receipt.ResponseBody, duplicate: true);
        }
        state.Orders.TryGetValue(data.OrderId, out var existing);
        var applied = existing is null || data.Version > existing.Version;
        if (applied) state.Orders[data.OrderId] = new(data.OrderId, data.Version, data.Status, (existing?.Effects ?? 0) + 1);
        var responseBody = Stringify(new { accepted = true, eventId = data.EventId, orderId = data.OrderId, version = data.Version, outcome = applied ? "applied" : "ignored-stale" });
        state.Receipts[data.EventId] = new(data.EventId, hash, responseBody, state.Clock);
        if (job.Fault == "lost-response" && applied) {
            Audit(state, "effect-applied", job, "The receiver committed the effect and idempotency receipt before simulating a lost success response.");
            return Record(state, job, attemptId, 503, "response-lost-after-commit", Error("simulated-response-loss", "The effect was committed but the sender did not receive success. This response loss is intentionally simulated."), applied: true);
        }
        return Record(state, job, attemptId, 200, applied ? "applied" : "ignored-stale", responseBody, applied);
    }
    public static void Replay(LabState state, string jobId, JsonNode? input) {
        var obj = Obj(input); Only(obj, "repair"); var repair = Boolean(obj["repair"]);
        if (repair is null) throw new LabException(400, "invalid-replay", "Specify whether to repair the synthetic sender fault.");
        var job = Find(state, jobId);
        if (job.Status != "dead-letter") throw new LabException(409, "not-dead-letter", "Only dead-letter deliveries can be replayed.");
        if (job.Cycle >= 3) throw new LabException(429, "replay-limit", "Reset the sandbox after three replay cycles.");
        job.Cycle++; job.Status = "queued"; job.NextAt = state.Clock; job.Lease = null; if (repair.Value) job.Fault = "none";
        Audit(state, "replayed", job, $"Replay cycle {job.Cycle}; prior attempts retained; sender fault {(repair.Value ? "repaired" : "preserved")}.");
    }
    public static void Advance(LabState state, JsonNode? input) {
        var obj = Obj(input); Only(obj, "seconds", "toNext"); long seconds;
        if (Boolean(obj["toNext"]) == true && !obj.ContainsKey("seconds")) {
            var times = state.Jobs.Select(job => job.Lease?.ExpiresAt ?? job.NextAt).Where(time => time > state.Clock).Select(time => time!.Value).ToList();
            if (times.Count == 0) throw new LabException(409, "nothing-scheduled", "No future retry or lease expiry is scheduled."); seconds = times.Min() - state.Clock;
        } else {
            var number = Number(obj["seconds"]);
            if (obj.ContainsKey("toNext") || number is null || number < 1 || number > 3600 || Math.Floor(number.Value) != number) throw new LabException(400, "invalid-clock", "Advance 1-3600 virtual seconds, or select the next deadline.");
            seconds = (long)number.Value;
        }
        state.Clock += seconds; Audit(state, "clock-advanced", null, $"Advanced {seconds} virtual seconds. Real wall-clock time is unchanged."); ExpireLeases(state);
    }
}
