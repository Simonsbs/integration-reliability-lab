using IntegrationLab;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 8192);
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
var repository = new Repository(Environment.GetEnvironmentVariable("LAB_DB") ?? ".runtime/integration-lab.db");
var app = builder.Build();

static JsonNode? Parse(string text) { try { return JsonNode.Parse(text); } catch (JsonException) { throw new LabException(400, "invalid-json", "Supply valid JSON."); } }
static async Task<string> Body(HttpRequest request) {
    if (request.ContentType?.Split(';')[0].Trim() != "application/json") throw new LabException(415, "content-type", "Use application/json.");
    using var buffer = new MemoryStream(); var chunk = new byte[2048];
    while (true) { var count = await request.Body.ReadAsync(chunk); if (count == 0) break;
        if (buffer.Length + count > 8192) throw new LabException(413, "body-too-large", "Request bodies are limited to 8 KiB."); buffer.Write(chunk, 0, count); }
    if (buffer.Length == 0) throw new LabException(400, "empty-body", "Supply a JSON body.");
    try { return new UTF8Encoding(false, true).GetString(buffer.ToArray()); } catch (DecoderFallbackException) { throw new LabException(400, "invalid-utf8", "Use UTF-8 JSON."); }
}
static async Task Respond(HttpContext context, Reply reply) {
    context.Response.StatusCode = reply.Status; context.Response.ContentType = "application/json; charset=utf-8";
    context.Response.Headers.CacheControl = "no-store"; context.Response.Headers.XContentTypeOptions = "nosniff";
    if (reply.Headers is not null) foreach (var header in reply.Headers) context.Response.Headers[header.Key] = header.Value;
    await context.Response.WriteAsync(reply.Body is string text ? text : Domain.Stringify(reply.Body));
}
app.Run(async context => {
    try {
        var path = context.Request.Path.Value ?? "/"; var method = context.Request.Method;
        var origin = context.Request.Headers.Origin.ToString(); var ownOrigin = $"{context.Request.Scheme}://{context.Request.Host}";
        var localPreview = context.Request.Host.Host is "127.0.0.1" or "localhost" && origin is "http://127.0.0.1:5175" or "http://localhost:5175";
        if (origin.Length > 0 && origin != ownOrigin && !localPreview) throw new LabException(403, "origin", "Use this application's origin.");
        if (method == "GET" && path == "/api/health") { await Respond(context, new(200, new { ready = true, backend = "ASP.NET Core + SQLite", contractVersion = 1, persistence = "SQLite with optimistic concurrency", clock = "explicit virtual clock", receiverPath = "/api/receiver" })); return; }
        var raw = method == "POST" ? await Body(context.Request) : "";
        if (method == "POST" && path == "/api/labs") {
            Domain.Only(Domain.Obj(Parse(raw))); var labId = Domain.NewId(); var token = labId + "." + Domain.RandomHex(); var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var state = Domain.Fresh(now); var expiresAt = now + 86400; repository.Create(labId, Domain.Digest(token), state, expiresAt);
            await Respond(context, new(201, new { token, expiresAt, lab = Domain.View(state) })); return;
        }
        var auth = Regex.Match(context.Request.Headers.Authorization.ToString(), "^Bearer ([a-f0-9]{32}\\.[a-f0-9]{64})$", RegexOptions.CultureInvariant);
        if (!auth.Success) throw new LabException(401, "unauthorised", "Open a fresh sandbox to get a scoped session capability.");
        var capability = auth.Groups[1].Value; var id = capability.Split('.')[0]; var hash = Domain.Digest(capability);
        for (var retry = 0; retry < 8; retry++) {
            var stored = repository.Load(id, hash) ?? throw new LabException(401, "unauthorised", "This sandbox capability is invalid or revoked.");
            if (stored.ExpiresAt <= DateTimeOffset.UtcNow.ToUnixTimeSeconds()) throw new LabException(410, "session-expired", "This sandbox has expired. Open a new one.");
            var state = stored.State;
            if (method == "GET" && path == "/api/state") { await Respond(context, new(200, Domain.View(state))); return; }
            if (method == "DELETE" && path == "/api/lab") { repository.Remove(id, hash); await Respond(context, new(200, new { revoked = true })); return; }
            Reply result;
            if (method == "POST" && path == "/api/receiver") result = Domain.Receive(state, context.Request.Headers, raw);
            else if (method == "POST" && path == "/api/deliveries") { var job = Domain.Enqueue(state, Parse(raw)); result = new(201, new { deliveryId = job.Id }); }
            else if (method == "POST" && Regex.IsMatch(path, "^/api/deliveries/[a-f0-9]{32}/claim$", RegexOptions.CultureInvariant)) { Domain.Only(Domain.Obj(Parse(raw))); result = new(200, Domain.Claim(state, path.Split('/')[3])); }
            else if (method == "POST" && Regex.IsMatch(path, "^/api/deliveries/[a-f0-9]{32}/replay$", RegexOptions.CultureInvariant)) { Domain.Replay(state, path.Split('/')[3], Parse(raw)); result = new(200, new { replayed = true }); }
            else if (method == "POST" && path == "/api/receiver-mode") {
                var input = Domain.Obj(Parse(raw)); Domain.Only(input, "mode"); var mode = Domain.Text(input["mode"]);
                if (mode is not ("healthy" or "outage" or "throttled")) throw new LabException(400, "invalid-mode", "Choose healthy, outage or throttled.");
                state.Receiver = mode; Domain.Audit(state, "receiver-mode", null, $"Receiver is now {mode}."); result = new(200, new { mode });
            } else if (method == "POST" && path == "/api/clock") { Domain.Advance(state, Parse(raw)); result = new(200, new { clock = state.Clock }); }
            else throw new LabException(404, "route-not-found", "API route not found.");
            if (!repository.Save(id, hash, stored.Revision, state)) continue;
            await Respond(context, result); return;
        }
        throw new LabException(409, "concurrent-update", "Concurrent changes prevented this update. Refresh and try again.");
    } catch (LabException error) { await Respond(context, new(error.Status, new { error = new { code = error.Code, message = error.Message } })); }
    catch (BadHttpRequestException error) when (error.StatusCode == 413) { await Respond(context, new(413, new { error = new { code = "body-too-large", message = "Request bodies are limited to 8 KiB." } })); }
    catch (Exception error) {
        app.Logger.LogError("Lab request failed: {ErrorType}", error.GetType().Name);
        await Respond(context, new(500, new { error = new { code = "internal-error", message = "The lab could not complete this request." } }));
    }
});
await app.RunAsync();
