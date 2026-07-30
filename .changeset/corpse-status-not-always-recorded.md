---
"@relayroom/cli": patch
---

Stop the corpse test waiting for an exit status tmux usually never records, and correct the measurement that claimed otherwise.

Measured over 40 dead panes: `#{pane_dead_status}` held a value 18 times and was **permanently empty the other 22**. Re-sampling the empty ones for a further 2s never filled them, and `#{pane_dead_signal}` was empty too - so it is neither a late write nor a signal death. tmux simply does not always record it.

An earlier fix had made the test helper wait for that status, on the strength of a probe showing it arrive *late* in 11 of 20 samples. The probe was right about "late" and "eventually" was inferred from it without being measured. So the helper waited 5s for something that was never coming, in 3 of 8 suite runs - converting a wrong-value flake into a timeout flake at a similar rate, while the timeout said less than the wrong value had.

The helper now waits only for the condition that always arrives (the pane being dead, ~60ms) and reports whether a status came with it, so the test asserts `status 3` when tmux supplied one and `status ?` when it did not - which is the honest output, not a defect. Its failure message now names which of the three states it saw (still running / dead without status / session gone); the previous message collapsed all three, which is why the first occurrence could not be diagnosed.

The comment on `session_dead` in the generated `rr.sh` is corrected too: the `?` branch is the **majority** path, not a narrow window.
