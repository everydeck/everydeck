-- everydeck outbox: the only part you write: one trigger per declared result (or failure/alternative end) whose evidence is a
-- committed database write. Save it as its own migration (e.g. `<timestamp>_everydeck_outbox_triggers.sql`) after everydeck_outbox.sql.
--
-- Rules
--  * AFTER INSERT or AFTER UPDATE OF <the column that changes>, FOR EACH ROW, with a WHEN clause that is exactly the state change
--    the code proves to be the result (old state differs, new state is the result), never "any update".
--  * CREATE OR REPLACE TRIGGER, never DROP: the migration only adds, applying it again replaces the trigger (PostgreSQL 14+).
--  * Name the trigger everydeck_outbox_<table>_<event>; declare the signal in the manifest with
--    location { path: "<this migration>", symbol: "<trigger name>", commit } and allowed_source "server".
--  * Arguments of everydeck_outbox.capture: signal, run id prefix, run id column, person column, account column, object type,
--    object ref column ('' = none). The run id must be the same value the rest of the flow uses (browser actions, other signals).
--
-- Example: a work order is completed when its status changes to 'done'.

CREATE OR REPLACE TRIGGER everydeck_outbox_work_order_completed
  AFTER UPDATE OF status ON public.work_order
  FOR EACH ROW WHEN (NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done')
  EXECUTE FUNCTION everydeck_outbox.capture('work_order.completed', 'work_order:', 'id', 'assignee_id', '', 'work_order', 'id');

-- Example: a result that is a new row (a booking request created directly from the browser).
-- CREATE OR REPLACE TRIGGER everydeck_outbox_booking_requested
--   AFTER INSERT ON public.booking
--   FOR EACH ROW EXECUTE FUNCTION everydeck_outbox.capture('booking.requested', 'booking:', 'id', 'guest_id', '', 'booking', 'id');
