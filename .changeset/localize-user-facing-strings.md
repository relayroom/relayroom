---
"@relayroom/web": patch
---

Translate the user-facing strings that were hardcoded in Korean. The dashboard defaults to English, so anyone who had not chosen a locale was shown Korean for module query failures, media upload errors, invitation and account setup flows, form validation messages, and the invitation email. All of it now goes through next-intl, with the `en` and `ko` key sets in sync across every namespace.
