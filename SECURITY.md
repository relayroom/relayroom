# Security Policy

## Supported versions

RelayRoom releases the server, web app, and client packages (`@relayroom/cli`) in
lockstep under one version (see [CHANGELOG.md](./CHANGELOG.md)). Only the **latest
published minor version** is supported with security fixes. If you are self-hosting,
stay current with the latest release - there is no long-term-support branch.

## Scope

In scope:

- This repository (`relayroom/relayroom`): the Next.js auth/dashboard app, the Hono
  resource server, the MCP OAuth flow, and the pager/CLI.
- Published Docker images for this project.
- The `@relayroom/cli` package on npm.

Out of scope:

- Misconfiguration of your own self-hosted instance (for example, exposing Postgres
  to the public internet, disabling TLS on your reverse proxy, or reusing default
  credentials in production).
- Behavior that is part of RelayRoom's documented trust model (for example, that a
  project owner's wake budget is a cooperative rate limit, not a hard multi-tenant
  security boundary - see the architecture docs and `.claude/reviews` if you have
  access to them). If you are unsure whether something is a documented trade-off or
  a bug, report it anyway and we'll triage.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports.

Use GitHub's private vulnerability reporting instead: go to the
[Security tab](https://github.com/relayroom/relayroom/security) of this repository
and click **"Report a vulnerability"**. This opens a private advisory thread with
maintainers only.

Include, where possible:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (a minimal repro is ideal).
- The version/commit you tested against.

### Response SLA

- **Initial response within 72 hours** of a report being filed.
- We will keep you updated as we investigate and work on a fix, and credit you in
  the advisory/release notes unless you prefer to stay anonymous.

Thank you for helping keep RelayRoom and its users safe.
