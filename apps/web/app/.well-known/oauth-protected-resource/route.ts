/**
 * MCP OAuth Protected Resource Metadata (RFC 9728)
 *
 * Published at /.well-known/oauth-protected-resource so that MCP clients
 * can discover this server's authorization server. better-auth's mcp() plugin
 * serves this at /api/auth/.well-known/oauth-protected-resource; this route
 * proxies it to the canonical root path.
 *
 * F6b (Hono MCP resource server) will also publish its own
 * /.well-known/oauth-protected-resource pointing back to this auth server.
 *
 * Ref: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
 */
import { auth } from "@/lib/auth"
import { oAuthProtectedResourceMetadata } from "better-auth/plugins"

export const GET = oAuthProtectedResourceMetadata(auth)
