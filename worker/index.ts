import { api } from "./api.ts";
import { D1Repository } from "./repository.ts";
import { assets } from "./assets.generated.ts";

const securityHeaders = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'",
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname.startsWith("/api/")) response = await api(request, new D1Repository(env.DB), "Cloudflare Worker + D1");
    else {
      const asset = assets[url.pathname === "/" ? "/index.html" : url.pathname];
      if (!["GET", "HEAD"].includes(request.method)) response = new Response("Method not allowed", { status: 405 });
      else if (!asset) response = new Response("Not found", { status: 404 });
      else {
        const bytes = Uint8Array.from(atob(asset.body), (char) => char.charCodeAt(0));
        response = new Response(request.method === "HEAD" ? null : bytes, { headers: { "Content-Type": asset.type, "Cache-Control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" } });
      }
    }
    const safe = new Response(response.body, response);
    for (const [key, value] of Object.entries(securityHeaders)) safe.headers.set(key, value);
    return safe;
  },
} satisfies ExportedHandler<Env>;
