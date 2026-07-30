---
"@relayroom/web": minor
---

Project owners can configure secret redaction from the knowledge settings screen: a denylist of exact text that is removed from anything distilled into knowledge from that point on.

The card states what it does not do. Redaction applies from the next distillation onward and never touches entries already stored, so it sits beside Purge, which is the tool for what was stored earlier. It also removes rather than masks: matching text is never written, so there is nothing to reveal later and nothing to restore if a rule was wrong. That is stated above the controls rather than below them, because a warning read after the save has already missed its moment.

The screen does not decide which rules are valid. It calls the same shared resolver the extractor uses before it compiles anything, so the two cannot disagree about what a valid rule is - the screen can only be more informative than the extractor, never more permissive. A configuration the resolver refuses is not saved at all: storing one would stop the project's distillation while the operator believed they had just configured protection.

Built-in credential formats are not shipped yet, and the screen says so plainly along with the fact that exact text works today and is not a stopgap while they are absent. Where a project has selected a format that has since been revised, it is told rather than upgraded: a revised detector usually widens what gets deleted, and redaction deletes, so choosing to take it is the owner's.
