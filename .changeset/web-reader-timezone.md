---
"@relayroom/web": patch
---

Show absolute timestamps in the reader's timezone instead of a hardcoded one, and label them.

Dates and times were formatted against a fixed zone, so a reader outside it saw times that were not theirs - and in a product whose whole subject is when agents did things, a timestamp in someone else's zone is worse than no timestamp. The browser's zone is now recorded in a cookie and used for server-rendered formatting, with UTC as the first-request fallback.

Timestamps carry a zone label (`2026-07-23 15:41 GMT+9`); date-only values do not, since the zone does not qualify them and would double the column width. A useful consequence is that the fallback stops being a special case: the label is always present, so a page rendered in UTC says so on its face.

Formatting deliberately does not use locale-dependent output. Passing a locale to `Intl` would have replaced one source of non-determinism with another (`07/23/2026` vs `2026. 07. 23.`), so the parts are assembled explicitly and the existing `YYYY-MM-DD` shape is preserved.

The timezone cookie is validated before use. `Intl.DateTimeFormat` throws a `RangeError` on an unknown zone, and the cookie is user-editable, so an unvalidated value would have let anyone turn every page carrying a timestamp into a server-render crash.
