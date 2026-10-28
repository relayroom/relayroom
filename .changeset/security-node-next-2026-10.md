---
"@relayroom/server": patch
"@relayroom/web": patch
"@relayroom/cli": patch
"@relayroom/install": patch
"@relayroom/db": patch
"@relayroom/shared": patch
"@relayroom/telemetry": patch
---

Security: pin the container base image to node:24.22.1-alpine (Brotli out-of-bounds write CVE-2026-111497, TLS hostname checks, DNS NUL truncation) and lift the vulnerable dependencies the October 2026 Node/React advisories named. Next.js 16.2.9 -> 16.4.3 (five critical RCEs in the image optimizer, next/og and `use cache`, plus the 16.2.11 SSRF/DoS set), @modelcontextprotocol/sdk 1.29 -> 1.32 (clears the proxy-addr, fast-uri and body-parser advisories), better-auth 1.6.16 -> 1.6.33 (magic-link/email-OTP pre-account hijack and the oidc/mcp fixes; the 1.7 line is a plugin-package migration and is deferred), nodemailer 8 -> 10, sharp 0.35.5, zod 4.6.7, dompurify 3.4.17, mermaid 11.17. No behaviour change intended; the images are rebuilt on release.
