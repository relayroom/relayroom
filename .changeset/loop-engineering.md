---
"@relayroom/server": minor
"@relayroom/web": minor
"@relayroom/cli": minor
"@relayroom/db": minor
---

Project Knowledge: turn the message stream into a knowledge layer agents read before they act, and measure whether it compounds.

Between runs, nothing accumulated. One agent worked out how migrations run in this repo and said so in a thread; the thread closed; next week another agent asked the same question, because the answer was sitting somewhere nobody re-reads. This release closes that loop on the Postgres you already own.

Agents `recall` validated project facts before non-trivial work and `learn` durable ones they discover. Closed threads are distilled into candidate entries automatically. Recurring failures become proposed knowledge and playbook changes a human approves. Trusted facts are served back in the playbook every agent reads. The dashboard reports whether repeat errors are actually falling.

The property that makes this safe rather than merely convenient is that **an agent can never promote its own claim**. Promotion requires independent signals from distinct issuers, and all of CI counts as one issuer, so a hundred green runs cannot make a claim trusted on their own. A contradiction demotes. Automation widens what gets captured, never what gets trusted, so a wrong fact cannot amplify as fast as a right one.

This is a typed, provenance-tracked knowledge table, not a semantic or temporal graph. Relationship modeling is not built here and the feature is not named as though it were.
