import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5175, strictPort: true, proxy: { "/api": { target: process.env.LAB_API_URL ?? "http://127.0.0.1:8788", changeOrigin: true } } },
  build: { outDir: ".runtime/site-client", emptyOutDir: true, sourcemap: true },
});
