import { getServerBaseConfig } from "@/modules/admin/queries"

/**
 * The PUBLIC base URL that agents reach the RelayRoom MCP server (Hono, :48801)
 * at - the address shown in the connect command. This is deployment-specific:
 * agents on other machines must reach it, so localhost only works for same-machine
 * agents.
 *
 * Resolution order (no-config install: env seeds it, the superuser can override it
 * in Settings -> Environments without redeploying):
 *   1. the value the superuser saved in the dashboard (configurations.server_base)
 *   2. the env var (set at install / in .env)
 *   3. localhost (local dev)
 *
 *   RELAYROOM_PUBLIC_SERVER_BASE=http://10.0.0.240:48801      # on-prem by IP
 *   RELAYROOM_PUBLIC_SERVER_BASE=https://hub.example.com      # domain + TLS proxy
 */
export async function getPublicServerBase(): Promise<string> {
  const fromDb = await getServerBaseConfig().catch(() => null)
  const raw =
    fromDb ??
    process.env.RELAYROOM_PUBLIC_SERVER_BASE ??
    process.env.NEXT_PUBLIC_RELAYROOM_SERVER_BASE ??
    "http://localhost:48801"
  return raw.replace(/\/$/, "")
}

/** The env/default server base, ignoring any DB override. Shown in Settings so the
 *  superuser can see what the deployment was installed with. */
export function getEnvServerBase(): string {
  return (
    process.env.RELAYROOM_PUBLIC_SERVER_BASE ??
    process.env.NEXT_PUBLIC_RELAYROOM_SERVER_BASE ??
    "http://localhost:48801"
  ).replace(/\/$/, "")
}
