using Microsoft.Data.Sqlite;
using System.Text;
using System.Text.Json;

namespace IntegrationLab;

public sealed record StoredLab(LabState State, long Revision, long ExpiresAt);
public sealed class Repository {
    private readonly string connectionString;
    public Repository(string filename) {
        var path = Path.GetFullPath(filename); Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        connectionString = new SqliteConnectionStringBuilder { DataSource = path, DefaultTimeout = 10 }.ToString();
        using var connection = Open();
        using var wal = connection.CreateCommand(); wal.CommandText = "PRAGMA journal_mode=WAL;"; wal.ExecuteNonQuery();
        using var metadata = connection.CreateCommand(); metadata.CommandText = "CREATE TABLE IF NOT EXISTS lab_migrations (name TEXT PRIMARY KEY NOT NULL);"; metadata.ExecuteNonQuery();
        var assembly = typeof(Repository).Assembly;
        foreach (var name in assembly.GetManifestResourceNames().Where(name => name.EndsWith(".sql", StringComparison.Ordinal)).Order(StringComparer.Ordinal)) {
            using var exists = connection.CreateCommand(); exists.CommandText = "SELECT COUNT(*) FROM lab_migrations WHERE name = $name"; exists.Parameters.AddWithValue("$name", name);
            if (Convert.ToInt64(exists.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) > 0) continue;
            using var stream = assembly.GetManifestResourceStream(name)!; using var reader = new StreamReader(stream);
            using var transaction = connection.BeginTransaction();
            using var migration = connection.CreateCommand(); migration.Transaction = transaction; migration.CommandText = reader.ReadToEnd(); migration.ExecuteNonQuery();
            using var mark = connection.CreateCommand(); mark.Transaction = transaction; mark.CommandText = "INSERT INTO lab_migrations (name) VALUES ($name)"; mark.Parameters.AddWithValue("$name", name); mark.ExecuteNonQuery(); transaction.Commit();
        }
    }
    private SqliteConnection Open() { var connection = new SqliteConnection(connectionString); connection.Open(); return connection; }
    public void Create(string labId, string tokenHash, LabState state, long expiresAt) {
        using var connection = Open();
        using var cleanup = connection.CreateCommand(); cleanup.CommandText = "DELETE FROM labs WHERE expires_at < $now"; cleanup.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToUnixTimeSeconds()); cleanup.ExecuteNonQuery();
        using var insert = connection.CreateCommand(); insert.CommandText = "INSERT INTO labs (id, token_hash, state, revision, expires_at) SELECT $id, $token, $state, 0, $expires WHERE (SELECT COUNT(*) FROM labs) < 200";
        insert.Parameters.AddWithValue("$id", labId); insert.Parameters.AddWithValue("$token", tokenHash); insert.Parameters.AddWithValue("$state", Domain.Stringify(state)); insert.Parameters.AddWithValue("$expires", expiresAt);
        if (insert.ExecuteNonQuery() != 1) throw new LabException(429, "lab-capacity", "The public lab is at its bounded sandbox capacity. Try again later.");
    }
    public StoredLab? Load(string labId, string tokenHash) {
        using var connection = Open(); using var query = connection.CreateCommand();
        query.CommandText = "SELECT state, revision, expires_at FROM labs WHERE id = $id AND token_hash = $token";
        query.Parameters.AddWithValue("$id", labId); query.Parameters.AddWithValue("$token", tokenHash); using var reader = query.ExecuteReader();
        return reader.Read() ? new(JsonSerializer.Deserialize<LabState>(reader.GetString(0), Domain.Json)!, reader.GetInt64(1), reader.GetInt64(2)) : null;
    }
    public bool Save(string labId, string tokenHash, long revision, LabState state) {
        var json = Domain.Stringify(state);
        if (Encoding.UTF8.GetByteCount(json) > 512 * 1024) throw new LabException(429, "sandbox-full", "Reset this sandbox before adding more evidence.");
        using var connection = Open(); using var update = connection.CreateCommand();
        update.CommandText = "UPDATE labs SET state = $state, revision = revision + 1 WHERE id = $id AND token_hash = $token AND revision = $revision";
        update.Parameters.AddWithValue("$state", json); update.Parameters.AddWithValue("$id", labId); update.Parameters.AddWithValue("$token", tokenHash); update.Parameters.AddWithValue("$revision", revision);
        return update.ExecuteNonQuery() == 1;
    }
    public void Remove(string labId, string tokenHash) {
        using var connection = Open(); using var remove = connection.CreateCommand(); remove.CommandText = "DELETE FROM labs WHERE id = $id AND token_hash = $token";
        remove.Parameters.AddWithValue("$id", labId); remove.Parameters.AddWithValue("$token", tokenHash); remove.ExecuteNonQuery();
    }
}
