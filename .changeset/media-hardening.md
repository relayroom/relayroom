---
"@relayroom/web": patch
---

Harden the media upload/serve routes: `sharp` now caps decoded pixel count (`limitInputPixels: 50_000_000`, `failOn: "truncated"`) and runs at decode concurrency 1 to prevent pixel-flood DoS, and the upload route rejects an oversized `Content-Length` before buffering the request body (413). The `/api/media/[...key]` serve route now requires a session and verifies the caller's org membership for the project resolved from the storage key (or ownership for pre-project `upload/<userId>/` staging keys), and responses add `X-Content-Type-Options: nosniff`, an `inline` `Content-Disposition` with filename, and `Cache-Control: private`.
