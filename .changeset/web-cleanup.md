---
"@relayroom/web": patch
---

Remove a deprecated Server Action that was still reachable, delete an orphaned settings page, and confirm before cancelling an invitation. `disconnectAgent` was marked deprecated with no callers left, but a `"use server"` export is a live network endpoint regardless - and its query ordering was reversed, so it revoked the oldest connection while its comment said latest. Cancelling an invitation now goes through the confirmation dialog and `toast.promise` the rest of the app uses, since it cannot be undone.
