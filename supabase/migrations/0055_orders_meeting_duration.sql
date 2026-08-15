-- Store the actual meeting length so the calendar renders the real block size.
-- Before this, /api/events hard-coded every online meeting as a 1-hour block,
-- so a 40-minute Zoom consultation looked like an hour. The AI schedule_meeting
-- tool now writes the real duration here (from MEETING_DURATION_MIN); older rows
-- stay NULL and the calendar falls back to 60 minutes for them.
alter table public.orders
    add column if not exists meeting_duration_min int;
