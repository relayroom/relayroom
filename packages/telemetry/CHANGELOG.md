# @relayroom/telemetry

## 0.8.5

### Patch Changes

- 9d63242: Security: pin the container base image to node:24.22.1-alpine (Brotli out-of-bounds write CVE-2026-111497, TLS hostname checks, DNS NUL truncation) and lift the vulnerable dependencies the October 2026 Node/React advisories named. Next.js 16.2.9 -> 16.4.3 (five critical RCEs in the image optimizer, next/og and `use cache`, plus the 16.2.11 SSRF/DoS set), @modelcontextprotocol/sdk 1.29 -> 1.32 (clears the proxy-addr, fast-uri and body-parser advisories), better-auth 1.6.16 -> 1.6.33 (magic-link/email-OTP pre-account hijack and the oidc/mcp fixes; the 1.7 line is a plugin-package migration and is deferred), nodemailer 8 -> 10, sharp 0.35.5, zod 4.6.7, dompurify 3.4.17, mermaid 11.17. No behaviour change intended; the images are rebuilt on release.
- Updated dependencies [9d63242]
  - @relayroom/db@0.8.5

## 0.8.4

### Patch Changes

- @relayroom/db@0.8.4

## 0.8.3

### Patch Changes

- @relayroom/db@0.8.3

## 0.8.2

### Patch Changes

- @relayroom/db@0.8.2

## 0.8.1

### Patch Changes

- @relayroom/db@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [31932bd]
  - @relayroom/db@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [4009795]
  - @relayroom/db@0.7.0

## 0.6.2

### Patch Changes

- @relayroom/db@0.6.2

## 0.6.1

### Patch Changes

- @relayroom/db@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [7d41930]
  - @relayroom/db@0.6.0

## 0.5.5

### Patch Changes

- @relayroom/db@0.5.5

## 0.5.4

### Patch Changes

- @relayroom/db@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [525b430]
- Updated dependencies [030214e]
- Updated dependencies [6db0a47]
  - @relayroom/db@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies [cb69e67]
- Updated dependencies [21a100c]
  - @relayroom/db@0.5.2

## 0.5.1

### Patch Changes

- @relayroom/db@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [5b6705f]
- Updated dependencies [2f5f75d]
- Updated dependencies [2c1aa99]
- Updated dependencies [f1ed68a]
- Updated dependencies [cc2f4e1]
- Updated dependencies [d1b5dcd]
- Updated dependencies [31b3279]
- Updated dependencies [c791ead]
- Updated dependencies [c791ead]
- Updated dependencies [f37f9fa]
- Updated dependencies [c791ead]
  - @relayroom/db@0.5.0
