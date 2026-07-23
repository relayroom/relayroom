---
"@relayroom/shared": patch
"@relayroom/db": patch
---

Correct the `projectAccessLevel` value domain.

The shared enum listed `readonly_all | readonly | write`. Two of those three facts were wrong about the product: `owner` is a grant the dashboard issues and the enum did not have it, while `readonly_all` exists in no UI option, no label, no migration, and no write path.

`owner` is not cosmetic - project member management keys off it, including the guards that refuse to demote, remove, or ban the last owner. An enum that rejects it describes a different product.

Nothing breaks today and nothing is fixed today: `apps/web` does not import this enum, it declares its own with the right values. The value is in what it prevents. Someone consolidating the two definitions later would reasonably reach for the shared one, `owner` would silently stop validating, and the last-owner guards would be deciding on a level that no longer parses. Making the value sets agree is what makes that consolidation safe.

The same stale list in the db schema comment is corrected too.
