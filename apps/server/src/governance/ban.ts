/**
 * Reversible governance ban / unban (phase 09).
 *
 * The implementation lives in @relayroom/db (packages/db/src/governance.ts) so the
 * Hono server and the Next.js web Server Action share one driver-agnostic copy
 * with no web->server dependency. This module re-exports it for locality - server
 * code and tests import from here per the phase-09 plan layout.
 */
export {
  applyBan,
  applyUnban,
  type ApplyBanOpts,
  type ApplyBanResult,
  type ApplyUnbanOpts,
  type BanScope,
} from '@relayroom/db'
