import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const labs = sqliteTable("labs", {
  id: text("id").primaryKey(), tokenHash: text("token_hash").notNull(),
  state: text("state").notNull(), revision: integer("revision").notNull().default(0),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("labs_expiry").on(table.expiresAt)]);
