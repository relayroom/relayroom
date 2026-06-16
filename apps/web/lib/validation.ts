import { z } from "zod"

/**
 * Shared credential schema for account creation (name + password).
 *
 * Server actions are an untrusted boundary: client-side zod can be bypassed by
 * calling the action directly. Both the setup (first admin) and accept-invitation
 * flows MUST `.parse()` their inputs with this schema BEFORE calling
 * auth.api.createUser — better-auth's admin createUser accepts an empty password
 * and creates a user with NO credential account, which would leave the install
 * bricked (admin) or the invited email permanently "taken" (invite).
 *
 * Constraints match the client forms (setup-form.tsx, accept-form.tsx):
 *   - name: min 1
 *   - password: min 8
 */
export const credentialSchema = z.object({
  name: z.string().min(1, "이름을 입력해주세요."),
  password: z.string().min(8, "비밀번호는 8자 이상이어야 합니다."),
})

export type Credential = z.infer<typeof credentialSchema>
