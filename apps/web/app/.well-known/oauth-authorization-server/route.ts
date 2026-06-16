/**
 * MCP OAuth 2.1 Authorization Server Metadata (RFC 8414)
 *
 * The MCP specification requires the authorization server metadata to be
 * discoverable at the ROOT /.well-known/oauth-authorization-server path
 * (RFC 8414 §3). better-auth's mcp() plugin serves this at
 * /api/auth/.well-known/oauth-authorization-server; this route proxies it
 * to the canonical root path so MCP clients (e.g. Claude Code) can discover
 * it without knowing the /api/auth prefix.
 *
 * Ref: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
 */
import { auth } from "@/lib/auth"
import { oAuthDiscoveryMetadata } from "better-auth/plugins"

export const GET = oAuthDiscoveryMetadata(auth)
