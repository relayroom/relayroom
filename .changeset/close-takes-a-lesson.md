---
"@relayroom/server": minor
---

`close` can carry the lesson the thread taught, so the knowledge a thread produced is written by the agent that has it rather than inferred afterwards.

The argument is optional and nothing about an existing call changes, so this is a minor release you can take without editing any caller. Passing `lesson: {title, body, kind}` records that lesson against the thread and marks the thread's knowledge as decided; omitting it leaves the previous behaviour, where the extractor sweep reads the thread later and distills what it can from the subject and the last substantive message.

The two paths cannot both fire. A close carrying a lesson claims the thread's extraction watermark in the same transaction that writes the row, so a sweep arriving afterwards finds the thread already decided and produces nothing. If the lesson cannot be stored - the project's redaction rules changed between reading them and writing, or the thread was already extracted, or a concurrent close won - the claim is rolled back with it, so the thread returns to being extractable rather than being foreclosed by a claim with no row behind it. The refusal is reported with a reason rather than being silent, and the close itself still succeeds: losing the lesson never costs you the close.

This is on by default. Every project's `knowledge_config` is empty today, and a feature that only works in projects that opted in after the fact is a feature nobody has, so absence means on. Set `distillOnClose: false` in a project's `knowledge_config` to turn it off - there is no switch on the settings screen yet.

One response field changes shape in practice: `close` now reports the status the thread actually ended in rather than always saying `closed`. Closing a thread that was canceled underneath you returns `canceled` and refuses the lesson, where before it would report a close that did not happen and leave a lesson on a canceled thread.
