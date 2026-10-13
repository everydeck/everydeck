-- everydeck outbox: durable server-side source for results that the browser writes straight into the database.
-- Copy this file unchanged as a new migration of the app. Plain PostgreSQL 13+ (Supabase included); idempotent.
--
-- What it does: a trigger on the app's own table writes one row into everydeck_outbox.event in the SAME transaction as the
-- business write. A rolled-back write leaves no row, so only committed results ever reach everydeck. The relay
-- (Edge Function `everydeck-outbox-relay` or `npx everydeck-outbox-relay`, both from @everydeck/sdk) sends the rows to everydeck and deletes each row only after everydeck
-- accepted it (202). everydeck de-duplicates by event_id, so a row sent twice is counted once.
--
-- Only references leave the database: signal name, run id, person, account and object references. No column values,
-- no texts, no personal data beyond the references the manifest declares.

CREATE SCHEMA IF NOT EXISTS everydeck_outbox;
REVOKE ALL ON SCHEMA everydeck_outbox FROM PUBLIC;

CREATE TABLE IF NOT EXISTS everydeck_outbox.event (
  id           bigserial PRIMARY KEY,
  event_id     uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name         text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_.-]{0,95}$'),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  operation_id text CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 128),
  subject_ref  text CHECK (subject_ref IS NULL OR length(subject_ref) BETWEEN 1 AND 128),
  account_ref  text CHECK (account_ref IS NULL OR length(account_ref) BETWEEN 1 AND 128),
  object_type  text CHECK (object_type IS NULL OR object_type ~ '^[a-z][a-z0-9_-]{0,31}$'),
  object_ref   text CHECK (object_ref IS NULL OR length(object_ref) BETWEEN 1 AND 128),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  rejected_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_pending_idx ON everydeck_outbox.event (id) WHERE rejected_at IS NULL;
-- SDK 0.4.0: the app platform of the browser request (x-everydeck-platform, sent by the browser SDK); added to outboxes of earlier versions
ALTER TABLE everydeck_outbox.event ADD COLUMN IF NOT EXISTS platform text CHECK (platform IS NULL OR platform IN ('web', 'ios', 'android', 'desktop', 'extension'));

-- Nobody but the owner (the trigger function below and the relay's database role) can read or write the outbox:
-- RLS without policies, no grants. On Supabase this keeps it away from anon/authenticated and the Data API.
ALTER TABLE everydeck_outbox.event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON everydeck_outbox.event FROM PUBLIC;
REVOKE ALL ON SEQUENCE everydeck_outbox.event_id_seq FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON SCHEMA everydeck_outbox FROM anon, authenticated'; EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA everydeck_outbox FROM anon, authenticated'; END IF;
END $$;

-- Trigger function. Arguments (all text, '' = none):
--   0 signal name (as declared in the manifest, e.g. 'work_order.completed')
--   1 run id prefix (e.g. 'work_order:')    2 run id column (e.g. 'id')  → operation_id = prefix || NEW.<column>;
--     with an empty column: the browser's x-everydeck-operation-id from the PostgREST request headers (same run as the browser action);
--     x-everydeck-platform of the same request is kept as the row's platform (web, ios, android, desktop, extension);
--     without that header (import, service role, the app bridge, a cron job): the row is its own run '<object type>:<object ref>';
--     everydeck needs a run for every result signal, a row without one would be rejected and stay in the outbox
--   3 person column (subject_ref, e.g. 'assignee_id' or 'user_id')      4 account column (account_ref, '' if none)
--   5 object type (as declared, e.g. 'work_order')                      6 object ref column (e.g. 'id')
-- SECURITY DEFINER: the browser's database role may write the business row; it never gets rights on the outbox itself.
CREATE OR REPLACE FUNCTION everydeck_outbox.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r jsonb := to_jsonb(NEW);
  run text;
  hdr json := nullif(current_setting('request.headers', true), '')::json;
  pf text := hdr ->> 'x-everydeck-platform';
BEGIN
  -- TG_ARGV is 0-based
  IF TG_NARGS < 7 THEN RAISE EXCEPTION 'everydeck_outbox.capture needs 7 arguments (signal, run prefix, run column, person column, account column, object type, object ref column)'; END IF;
  -- run id from the row; with an empty column argument from the browser's correlation header (PostgREST request), else the object itself
  run := CASE WHEN nullif(TG_ARGV[2], '') IS NOT NULL THEN TG_ARGV[1] || nullif(r ->> TG_ARGV[2], '')
              ELSE coalesce(nullif(left(hdr ->> 'x-everydeck-operation-id', 128), ''),
                            CASE WHEN nullif(TG_ARGV[5], '') IS NOT NULL AND nullif(TG_ARGV[6], '') IS NOT NULL AND nullif(r ->> TG_ARGV[6], '') IS NOT NULL THEN TG_ARGV[5] || ':' || (r ->> TG_ARGV[6]) END) END;
  -- the platform the browser SDK names (x-everydeck-platform): only a known app platform; no header (import, server) = no platform
  IF pf IS NULL OR pf NOT IN ('web', 'ios', 'android', 'desktop', 'extension') THEN pf := NULL; END IF;
  INSERT INTO everydeck_outbox.event (name, operation_id, subject_ref, account_ref, object_type, object_ref, platform)
  VALUES (
    TG_ARGV[0],
    left(run, 128),
    CASE WHEN nullif(TG_ARGV[3], '') IS NULL THEN NULL ELSE left(nullif(r ->> TG_ARGV[3], ''), 128) END,
    CASE WHEN nullif(TG_ARGV[4], '') IS NULL THEN NULL ELSE left(nullif(r ->> TG_ARGV[4], ''), 128) END,
    nullif(TG_ARGV[5], ''),
    CASE WHEN nullif(TG_ARGV[6], '') IS NULL THEN NULL ELSE left(nullif(r ->> TG_ARGV[6], ''), 128) END,
    pf
  );
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION everydeck_outbox.capture() FROM PUBLIC;
