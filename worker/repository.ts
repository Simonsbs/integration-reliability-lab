import { LabError } from "../src/domain.ts";
import type { LabState } from "../src/domain.ts";
import type { Repository, StoredLab } from "./api.ts";

export class D1Repository implements Repository {
  private database: D1DatabaseSession;
  constructor(database: D1Database) { this.database = database.withSession("first-primary"); }
  async create(labId: string, tokenHash: string, state: LabState, expiresAt: number) {
    await this.database.prepare("DELETE FROM labs WHERE expires_at < ?").bind(Math.floor(Date.now() / 1000)).run();
    const result = await this.database.prepare("INSERT INTO labs (id, token_hash, state, revision, expires_at) SELECT ?, ?, ?, 0, ? WHERE (SELECT COUNT(*) FROM labs) < 200")
      .bind(labId, tokenHash, JSON.stringify(state), expiresAt).run();
    if (result.meta.changes !== 1) throw new LabError(429, "lab-capacity", "The public lab is at its bounded sandbox capacity. Try again later.");
  }
  async load(labId: string, tokenHash: string): Promise<StoredLab | null> {
    const row = await this.database.prepare("SELECT state, revision, expires_at FROM labs WHERE id = ? AND token_hash = ?")
      .bind(labId, tokenHash).first<{ state: string; revision: number; expires_at: number }>();
    return row ? { state: JSON.parse(row.state) as LabState, revision: row.revision, expiresAt: row.expires_at } : null;
  }
  async save(labId: string, tokenHash: string, revision: number, state: LabState) {
    const json = JSON.stringify(state);
    if (new TextEncoder().encode(json).length > 512 * 1024) throw new LabError(429, "sandbox-full", "Reset this sandbox before adding more evidence.");
    const result = await this.database.prepare("UPDATE labs SET state = ?, revision = revision + 1 WHERE id = ? AND token_hash = ? AND revision = ?")
      .bind(json, labId, tokenHash, revision).run();
    return result.meta.changes === 1;
  }
  async remove(labId: string, tokenHash: string) {
    await this.database.prepare("DELETE FROM labs WHERE id = ? AND token_hash = ?").bind(labId, tokenHash).run();
  }
}
