import { access, writeFile } from "node:fs/promises";
try { await access("worker/assets.generated.ts"); }
catch { await writeFile("worker/assets.generated.ts", "export const assets: Record<string, {type: string; body: string}> = {};\n"); }
