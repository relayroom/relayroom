/**
 * Shared between the purge query and the client that renders its results.
 *
 * It lives in its own module with no imports: `purge-queries.ts` pulls in the db
 * handle, so a client component importing the constant from there would drag the
 * database into the browser bundle.
 */

/** Rows `searchProjectThreads` returns before the rest are cut off. */
export const THREAD_SEARCH_LIMIT = 20
