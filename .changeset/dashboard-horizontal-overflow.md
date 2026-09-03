---
"@relayroom/web": patch
---

Dashboard pages no longer scroll sideways on narrow screens, and the project tab bar now shows you which tab you are on.

Every dashboard route was rendered at widths from 1440px down to 375px and checked for a page-level horizontal scrollbar. Four routes had one, each from a different element: the telemetry consent banner's button row, the Organizations header button, and on the threads page both the header row and the status filter strip. All four are fixed by letting the offending element shrink or wrap, never by hiding overflow on the page.

The status filter on the threads page was the interesting one. The same strip exists on the knowledge and proposals pages and already scrolled inside its own container; the threads copy did not, which is why the bug appeared on exactly one of the three.

The project tab bar itself was not causing the page to scroll - it has contained its own overflow since the first public release. What it did not do was scroll the active tab into view, so opening Settings on a phone showed a tab row starting at Overview with the active tab 400px off-screen and nothing indicating the row could be scrolled. Containing overflow and revealing where you are turn out to be two separate jobs, and only the first had been done.
