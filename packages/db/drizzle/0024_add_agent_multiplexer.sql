-- What a part's pager asked for, and what it actually got.
--
-- Two columns rather than one, because the state worth seeing is the DISAGREEMENT:
-- a part that asked for herdr and fell back to tmux still receives its wakes, but
-- not the way it was configured to, and one column cannot represent that at all.
--
-- Both NULLABLE with NO default. NULL means "this pager has not reported", which is
-- a different fact from "tmux": every pager on the previous release sends neither
-- field, and defaulting them would fabricate a measurement for every existing part -
-- the dashboard would then draw a confident tmux badge for parts nobody has asked.
alter table "agent" add column if not exists "multiplexer_intent" text;
alter table "agent" add column if not exists "multiplexer_active" text;
