/**
 * Unit tests for resolveActiveOrgId (AC-4).
 *
 * Previously the session-stored `activeOrganizationId` was trusted outright: if a
 * member switched into an org and was later removed (or the value was stale/
 * forged), resolveActiveOrgId kept resolving to that org, and every "org-scoped"
 * read/write downstream (getProjectBySlug via the project layout, etc) inherited
 * that false membership. resolveActiveOrgId must now re-confirm membership via
 * isOrgMember before trusting the session value, falling back to the caller's
 * real orgs (or null) otherwise.
 *
 * getServerSession / getOrganizations / isOrgMember are all mocked here (rather
 * than kept "real" via importOriginal) because isOrgMember calls the SAME
 * module's own getServerSession internally - a same-module self-reference that a
 * mocked override on the external binding cannot intercept. This test therefore
 * exercises resolveActiveOrgId's own control flow (call isOrgMember, fall back
 * when it's false) rather than isOrgMember's DB query, which is unit-tested
 * indirectly wherever it gates a real Server Action (see the modules/ actions
 * test suites).
 */
import { describe, expect, it, vi, beforeEach } from "vitest"

const state = {
  session: null as { user: { id: string }; session: { activeOrganizationId?: string } } | null,
  orgs: [] as Array<{ id: string }>,
  isMember: new Set<string>(),
}

vi.mock("@/lib/auth-session", () => ({
  getServerSession: vi.fn(async () => state.session),
  getOrganizations: vi.fn(async () => state.orgs),
  isOrgMember: vi.fn(async (orgId: string) => state.isMember.has(orgId)),
}))

import { resolveActiveOrgId } from "./active-org"

beforeEach(() => {
  state.session = null
  state.orgs = []
  state.isMember = new Set()
})

describe("resolveActiveOrgId (AC-4)", () => {
  it("returns null with no session", async () => {
    expect(await resolveActiveOrgId()).toBeNull()
  })

  it("trusts activeOrganizationId when the caller is still a member", async () => {
    state.session = { user: { id: "u1" }, session: { activeOrganizationId: "org-a" } }
    state.isMember = new Set(["org-a"])
    expect(await resolveActiveOrgId()).toBe("org-a")
  })

  it("does NOT trust a stale/forged activeOrganizationId the caller no longer belongs to", async () => {
    state.session = { user: { id: "u1" }, session: { activeOrganizationId: "org-removed" } }
    state.isMember = new Set() // not a member of org-removed anymore
    state.orgs = [{ id: "org-fallback" }]
    expect(await resolveActiveOrgId()).toBe("org-fallback")
  })

  it("falls back to null when the stale org is not a member and there are no other orgs", async () => {
    state.session = { user: { id: "u1" }, session: { activeOrganizationId: "org-removed" } }
    state.isMember = new Set()
    state.orgs = []
    expect(await resolveActiveOrgId()).toBeNull()
  })

  it("falls back to the first real org when no activeOrganizationId is set", async () => {
    state.session = { user: { id: "u1" }, session: {} }
    state.orgs = [{ id: "org-first" }, { id: "org-second" }]
    expect(await resolveActiveOrgId()).toBe("org-first")
  })
})
