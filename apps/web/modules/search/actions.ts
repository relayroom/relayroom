"use server"

import { getServerSession } from "@/lib/auth-session"
import { searchDashboard, type SearchResults } from "./queries"

const EMPTY: SearchResults = { threads: [], events: [], agents: [] }

/**
 * Search the current user's accessible projects (threads / events / agents).
 * Returns empty when signed out or the query is too short. Scoping is enforced
 * in the query against the caller's project_access membership.
 */
export async function globalSearch(query: string): Promise<SearchResults> {
  const session = await getServerSession()
  if (!session) return EMPTY
  return searchDashboard(session.user.id, query)
}
