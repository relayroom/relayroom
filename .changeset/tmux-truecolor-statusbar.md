---
"@relayroom/cli": patch
---

Make the tmux status bar work out of the box on every machine, not just ones
with a hand-edited `~/.tmux.conf`.

The pager now wires the session's status bar once at startup (`setupStatusBar`),
session-local so it never touches the user's global tmux config:

- **Content:** points `status-right` at the shipped `rr.sh statusline`
  subcommand (`<part> | inbox: N | ● MCP | ● Pager`). Previously this only
  appeared if the user manually added the wiring to `~/.tmux.conf`, so on a fresh
  machine the bar showed tmux's default content.
- **Color:** appends `terminal-overrides ',*:Tc'` so the agent's 24-bit hex bar
  color renders true. On terminals whose `TERM` resolves to a low terminfo color
  count (e.g. plain `xterm` = 8 colors, common on Linux) the hex was being
  crushed to the nearest ANSI shade.
