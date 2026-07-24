---
"@relayroom/web": patch
---

Default the agent connect instructions to bypass mode.

These sessions are unattended by design. An agent that stops at an approval prompt waits for someone who is not watching, which is a worse outcome in this setting than the checks the flag skips. The label still says plainly that it skips all permission checks, and the hint now describes what turning it off costs, since that is the decision a reader actually faces once it is on by default.
