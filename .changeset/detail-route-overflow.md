---
"@relayroom/web": patch
---

Detail pages no longer scroll sideways when a thread, agent or knowledge entry contains a long unbroken value.

The first overflow sweep ran against an empty fixture project, so it could only see layout, never content. Re-run with a 200-character thread subject, a 300-character unbroken token, a 71-character agent part name and a long knowledge title, three more routes overflowed: the thread status controls, the agent header, and the knowledge body.

The knowledge one was not a narrow-screen bug at all. `whitespace-pre-wrap` breaks lines at whitespace, and a token, URL or stack frame has none, so a lesson quoting one pushed the page 1608px wide on a 1440px desktop. It now breaks inside the word.

The sweep itself had to be fixed first. It looked for elements whose box sticks out past the viewport, and text overflowing its own box is invisible to that check: the paragraph stayed the right width while its glyphs ran off the screen. It now also compares each element's scroll width against its client width, which is what found the case above.
