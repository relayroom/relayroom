---
"@relayroom/server": patch
---

Pin the MCP tool contract with a snapshot test.

`tools/list` is what every connected agent reads to decide what it can call and how, so a change there changes behaviour for every agent at once - and nothing was pinning it. Renaming an argument, dropping an enum value from a description, or quietly loosening a schema all shipped without anyone having to look.

The snapshot is taken from the normalized reply, after the draft-07 keywords strict clients reject have been stripped, because that is the shape clients actually receive. Tool names are a separate inline snapshot: adding or removing a tool is a much bigger change than editing a description, and separating them makes it visible in a diff without reading three hundred lines of schema. A third test asserts the property directly rather than trusting the snapshot to be read carefully - no banned keyword appears in any advertised schema, since a tool registered without normalization would break Gemini-family clients for everyone.
