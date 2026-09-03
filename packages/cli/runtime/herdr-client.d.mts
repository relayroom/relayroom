/**
 * Types for the herdr socket client, which ships as plain .mjs (the runtime directory is
 * copied, not built - see src/runtime.ts). Declared here so `src/` can import it with the
 * same checking as any other module rather than an `any` behind a suppression comment.
 */
export declare const HERDR_CALL_TIMEOUT_MS: number
export declare const HERDR_MIN_VERSION: string
export declare const HERDR_KNOWN_PROTOCOL: number

export declare function herdrSocketPath(env?: NodeJS.ProcessEnv): string
export declare function herdrSocketPresent(env?: NodeJS.ProcessEnv): boolean
export declare function versionAtLeast(actual: string, minimum: string): boolean

export declare class HerdrError extends Error {
  code: string
  constructor(code: string, message: string)
}

export declare function herdrCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  opts?: { socketPath?: string; timeoutMs?: number },
): Promise<T>

export declare function handshake(opts?: { socketPath?: string; timeoutMs?: number }): Promise<{
  ok: boolean
  reason?: string
  version?: string
  protocol?: number | null
  protocolNote?: string | null
}>

export declare function herdrAgentName(agent: string, part: string): string
