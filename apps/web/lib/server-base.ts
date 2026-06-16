/**
 * The PUBLIC base URL that agents reach the RelayRoom MCP server (Hono, :48801)
 * at - the address shown in the connect command. This is deployment-specific:
 * agents on other machines must reach it, so localhost only works for same-machine
 * agents. Read at request time on the server (NOT a NEXT_PUBLIC build-time var), so
 * a single prebuilt image works across deployments by setting the env:
 *
 *   RELAYROOM_PUBLIC_SERVER_BASE=http://10.0.0.240:48801      # on-prem by IP
 *   RELAYROOM_PUBLIC_SERVER_BASE=https://hub.example.com      # domain + TLS proxy
 *
 * Falls back to localhost for local development.
 */
export function getPublicServerBase(): string {
  return (
    process.env.RELAYROOM_PUBLIC_SERVER_BASE ??
    process.env.NEXT_PUBLIC_RELAYROOM_SERVER_BASE ??
    "http://localhost:48801"
  ).replace(/\/$/, "")
}
