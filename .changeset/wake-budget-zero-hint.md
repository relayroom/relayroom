---
"@relayroom/web": patch
---

Explain what a wake budget of zero actually does.

The wake budget card let an owner drag "Max auto-wakes per rolling hour" down to zero with nothing next to it saying what zero means. It reads as silence, and it is not: every project keeps a small guaranteed share, so wakes keep arriving, and because that share is per project the total grows with the number of projects the owner is in. Setting zero to be left alone therefore gets noisier as they join more projects, which is the opposite of what they asked for.

Zero now shows a hint saying so, alongside the one the urgent slider already had. The two sit side by side because they genuinely differ: zero urgent really is absolute, zero auto-wakes is only the lowest setting. Nothing about the budget itself changed - the value is still accepted, the floor and the defaults are untouched.

The hint deliberately avoids naming a number. The floor is a server-side constant that this app cannot see change, so a figure printed here would quietly become wrong the day it moves.
