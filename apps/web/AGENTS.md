# RelayRoom web - contributor & agent conventions

Rules for working on `apps/web` (the dashboard). They are binding: follow them
when adding or changing code here. Human contributors and AI coding agents alike.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · pnpm · Tailwind · shadcn/ui on
[Base UI](https://base-ui.com) · [Better Auth](https://better-auth.com) · Drizzle
ORM (Postgres) · next-intl.

## Hard rules

- **pnpm only.** No npm/yarn. Install the latest stable version of a dependency.
- **No em dashes** in code, copy, or comments - use a hyphen (`-`).
- **Do not read `node_modules` to learn a library.** This Next.js may differ from
  what you remember; find the real behavior in the official docs site
  (nextjs.org, base-ui.com, ui.shadcn.com, better-auth.com, drizzle docs). Going
  into `node_modules` is how you get lost.

## UI components - shadcn/ui on Base UI

- shadcn is installed on the **Base UI** primitive set, not Radix. There is no
  `asChild`; **compose with `render={<Component />}`** instead.
- Prefer existing shadcn components before building custom UI, but hold a
  commercial-grade bar: handle focus, loading, empty, error, and accessibility
  states, not just the happy path.

## API response contract (unified, server included)

- Every API return uses `ApiResult` / `ApiResultWithItem<T>` / `ApiResultWithItems<T>`
  from `@relayroom/shared` (a discriminated union on `result: true | false`).
- This shape is shared by **web module functions, Server Actions, and the Hono
  server routes** so the frontend consumes one format everywhere.
- Pagination/filtering use `ApiPaginationProps`, `ApiPropsWithFilter<T, K>`,
  `ApiPaginationPropsWithFilter<T, K>`.

## `modules/` structure

- Group code by feature/table under `modules/<name>/`. Files are verb+entity
  (`getX.ts`, `listX.ts`, `createX.ts`, `updateX.ts`, `deleteX.ts`) or `queries.ts`.
- Each function returns an `@relayroom/shared` `ApiResult` type; module-local
  Row/Filter types live in the module.
- `page.tsx` calls module queries during SSR; client components call module
  functions through Server Actions. Dependencies flow one way, no cycles.
- Auth schema is owned by `@relayroom/db`; import it from the `@relayroom/db/auth-schema`
  subpath. The web container does **not** run migrations - the server owns them.

## Async, forms, and action UX

- **All async work goes through `toast.promise` (sonner)** with loading/success/error
  toasts. Await the underlying action (not the toast) so pending state is accurate.
- Disable action buttons while pending to prevent double submits.
- **Deletes always go through a confirmation dialog** (a Promise-based AlertDialog
  hook): `if (!(await confirm({ title, description, destructive: true }))) return`.
- Forms use **zod v4 + react-hook-form + @hookform/resolvers** (`import { z } from "zod"`).
- **Do not export a zod schema (a value) from a `"use server"` file.** A use-server
  module may only export async functions; exporting a schema turns it into a server
  reference on the client and `zodResolver` throws "not a Zod schema". Put schemas
  and their inferred types in `modules/<x>/schema.ts` (not use-server) and import
  them from both actions and forms.

## Internationalization (next-intl)

- **No hardcoded user-facing strings** - everything is `t("key")`. Locale is decided
  server-side from the `NEXT_LOCALE` cookie (`i18n/request.ts`), defaulting to `en`.
- Messages are per-area namespace JSON under `messages/{en,ko}/<ns>.json`; a new area
  is just a new JSON file. Server components use `await getTranslations("<ns>")`,
  client components use `useTranslations("<ns>")`. Keep the `en`/`ko` key sets in sync.
- **Server Action `message` fields are user-facing (shown as toasts), so they must be
  i18n too**: `const t = await getErrorTranslations()` then return `t("agent.notFound")`.
  Keys live in `messages/{en,ko}/errors.json`, interpolated as `t("project.slugTaken", { slug })`.

## Layout shell

- The authenticated app shell is a **left sidebar + topbar** (`flex h-screen`):
  global sidebar (dashboard / projects / org switcher / account), topbar (search,
  notifications, avatar/theme), and a main region with a skip-to-content link.
- On entering a project, render a project tab bar (overview, threads, events,
  agents, settings) at the top of the content area.
- Unauthenticated account pages (sign-in, setup, accept-invitation, pending) use a
  centered-card shell with no sidebar.
- Guard pages in the **layout** with `requireSession()` / `requireDashboardAccess()`,
  not middleware. Pages that touch the DB or session must set
  `export const dynamic = "force-dynamic"`.

## Design

- Vercel-leaning tone: a near-white canvas with ink text, **Geist / Geist Mono**
  (mono for technical labels - part badges, token counts, slugs). Gradients are
  decorative only (hero, empty states).
- Dark/light via **`@wrksz/themes`** (next-themes is not React 19 compatible).

## File uploads

- Next.js handles the upload; files are written to the **`storage/` volume mount**,
  never the container filesystem. Go through the storage abstraction (local driver
  now, swappable for S3/R2). Store only a relative key in the DB and serve via
  `/api/media`. Images use `next/image` + sharp, content-hash filenames, EXIF stripped.

## Commit & verify

- Split work into focused commits (English subject; body may be longer-form).
- Before committing, get `pnpm build`, `tsc --noEmit`, and `pnpm test` green.
- Be especially careful with auth and security changes.
