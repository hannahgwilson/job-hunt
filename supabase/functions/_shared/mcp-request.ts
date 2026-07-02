/**
 * Common request-handling for job-hunt-mcp: env loading, `key`/`x-access-key`
 * auth, and the Claude Desktop Accept-header patch.
 *
 * Mirrors supabase/functions/_shared/mcp-request.ts in the open-brain-setup
 * repo (job-hunt-mcp used to live there) — kept in sync by hand since these
 * are separate repos/deployments, not a shared package.
 *
 * Pattern: read env + build the Supabase client + register tools ONCE at
 * module scope (cold start), not per request. Each request only needs the
 * auth check + Accept-header patch before handing off to the transport.
 */

import type { Context } from "hono";

/** Read a required env var; throws (failing the function's cold start) if unset. */
export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} not configured`);
  return value;
}

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";

/** `?key=` or `x-access-key` header, checked against MCP_ACCESS_KEY. */
// deno-lint-ignore no-explicit-any
export function isAuthorized(c: Context<any>): boolean {
  const key = c.req.query("key") || c.req.header("x-access-key");
  return !!key && key === MCP_ACCESS_KEY;
}

/**
 * Claude Desktop connectors don't send the `Accept: text/event-stream`
 * header StreamableHTTPTransport requires. Patch it in if missing.
 */
// deno-lint-ignore no-explicit-any
export function patchAcceptHeader(c: Context<any>): void {
  if (c.req.header("accept")?.includes("text/event-stream")) return;
  const headers = new Headers(c.req.raw.headers);
  headers.set("Accept", "application/json, text/event-stream");
  const patched = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers,
    body: c.req.raw.body,
    // @ts-ignore -- duplex required for streaming body in Deno
    duplex: "half",
  });
  Object.defineProperty(c.req, "raw", { value: patched, writable: true });
}

/** Standard MCP tool-result envelope: JSON payload as a single text block. */
export function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
