---
"@relayroom/cli": patch
---

Fix the tmux status bar showing the wrong color on terminals whose `TERM`
resolves to a low terminfo color count (e.g. plain `xterm` = 8 colors, common on
Linux). The pager paints the bar with the agent's 24-bit hex color, but tmux only
renders it true when it knows the terminal supports RGB. The pager now appends
`terminal-overrides ',*:Tc'` (once, non-destructively) before painting, so the
agent color renders correctly instead of being crushed to the nearest ANSI shade.
