# Contributing to RelayRoom

Thanks for your interest in RelayRoom. This repository is the **Community Edition** - the full self-hostable coordination and observability hub for AI coding agents. Contributions that improve the self-hosted product (coordination, MCP tools, the dashboard, the pager and usage hook, multi-provider support, the wake budget, and governance) are welcome.

Enterprise features are developed and licensed separately. PRs that add Enterprise-only functionality are out of scope for this repository.

## Development setup

RelayRoom is a pnpm monorepo. You need Node.js 20+, pnpm, and Docker (for Postgres).

```bash
pnpm install

pnpm db:up          # start Postgres only (port 48802)
pnpm dev:server     # Hono resource server (port 48801)
pnpm dev:web        # Next.js web app (port 48800)

pnpm test           # run the test suite (vitest, needs Postgres up)
```

Open `http://localhost:48800`. The first run sends you to `/account/setup` to create the owner account.

### Ports

| Service | Port | Role |
|---------|------|------|
| `web` (Next.js) | 48800 | Auth, dashboard, OAuth / MCP provider |
| `server` (Hono) | 48801 | MCP resource server, SSE, usage ingest |
| `postgres` | 48802 | Data plus the LISTEN/NOTIFY real-time bus |

### Project layout

```
apps/web         Next.js dashboard, better-auth, OAuth / MCP provider
apps/server      Hono MCP resource server, SSE, usage ingest
packages/db      drizzle schema and migrations (Postgres); owns the migrations
packages/shared  shared API types (ApiResult and friends)
packages/cli     the relayroom agent-side CLI (connect / pager / hooks)
```

## Conventions

- **TypeScript** throughout. Follow the patterns already in the codebase; `apps/web/AGENTS.md` documents the web app conventions in detail.
- **Database migrations are server-owned.** The `packages/db` package owns the drizzle schema and migrations, and the server runs them on startup. The web container does not run migrations. Use the existing db scripts (`pnpm db:generate`, `pnpm db:migrate`) for schema changes.
- **i18n is required for all user-facing strings.** Do not hardcode text shown to users. Web UI strings go through next-intl (`getTranslations` / `useTranslations`) with namespaced JSON under `messages/{ko,en}/`. **Server-action messages are also required to be translated** - use `getErrorTranslations()` and return keys from `messages/{ko,en}/errors.json` (domain-namespaced: `agent.*`, `project.*`, `member.*`, `thread.*`, `wake.*`, `auth.*`, `common.*`). Keep the `ko` and `en` key sets identical; `en` is the default surfaced value.
- **No em dash.** Use hyphens (`-`) only, in code, comments, docs, and commit messages.
- **API returns** use the `ApiResult` / `ApiResultWithItem` / `ApiResultWithItems` shapes from `@relayroom/shared`, consistently across web modules, Server Actions, and Hono.
- **Branch from `main`.** Keep branches focused.
- **PRs include tests.** New behavior and bug fixes should come with vitest coverage. Run `pnpm test` before opening a PR.
- **Conventional commit style** for commit messages (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

## Reporting bugs and requesting features

Use GitHub issues. For bugs, include the version or commit, your platform, reproduction steps, and what you expected versus what happened. For feature requests, describe the problem you are trying to solve before the solution you have in mind. Search existing issues first to avoid duplicates.

## Governance

RelayRoom is a young project, so the model is intentionally lightweight:

- **Maintainers** review and merge PRs, set technical direction, and cut releases. They have the final say on scope and design.
- **Contributors** open PRs and issues. Anyone can be a contributor.
- **Triagers** keep the issue tracker healthy: labeling, reproducing, closing duplicates, and routing issues to the right area. Active contributors can be invited to triage.

Roles are earned through sustained, constructive participation. If you want to take on more, just keep showing up in issues and PRs.

## Licensing

RelayRoom Community Edition is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). Contributions are accepted under the same license. By submitting a contribution, you certify that you have the right to submit it and you agree to license it under AGPL-3.0 (a light DCO-style sign-off; `git commit -s` is appreciated but not required). Enterprise features are out of scope for Community Edition PRs.

## Code of conduct

Participation in this project is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold it.
