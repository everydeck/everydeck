-- everydeck read bridge: the app's pg_cron jobs and their runs, read only, for Operations › Schedules in everydeck. Like the Supabase dashboard (Integrations ›
-- Cron), which reads cron.job and cron.job_run_details: no heartbeat in the app's code, nothing the app's own jobs have to do.
-- Two views in the schema everydeck_read, owned by the role that applies this (postgres on Supabase), with only the columns everydeck needs:
--   everydeck_read.cron_job   jobid, jobname, schedule, active                       (never `command`: it can hold an address or a key)
--   everydeck_read.cron_run   runid, jobid, status, start_time, end_time, message    (return_message, at most 200 characters)
-- pg_cron keeps row security on both tables (policy username = current_user). A view reads them with the rights of its owner; on Supabase postgres has
-- BYPASSRLS, so every job of the project shows, whoever scheduled it (checked 8.11.2026 on a Supabase project with pg_cron 1.6.4).
-- The read bridge reads the views over the connection it already has, in a read-only transaction, only when everydeck's signed read scope names them.
-- Nobody else reaches them: no USAGE on the schema for PUBLIC, anon or authenticated, and the Supabase API does not expose everydeck_read.
-- Only adds or replaces these two views; without pg_cron it does nothing. Applying it again changes nothing. everydeck applies it after "Allow" under
-- Settings › Changes from everydeck, without an entry in supabase_migrations (the app's own migrations stay as they are).
DO $everydeck_cron$
BEGIN
  IF to_regclass('cron.job') IS NULL OR to_regclass('cron.job_run_details') IS NULL THEN RETURN; END IF;
  CREATE SCHEMA IF NOT EXISTS everydeck_read;
  CREATE OR REPLACE VIEW everydeck_read.cron_job WITH (security_barrier) AS
    SELECT j.jobid, j.jobname, j.schedule, j.active FROM cron.job j;
  CREATE OR REPLACE VIEW everydeck_read.cron_run WITH (security_barrier) AS
    SELECT d.runid, d.jobid, d.status, d.start_time, d.end_time, left(d.return_message, 200) AS message FROM cron.job_run_details d;
  REVOKE ALL ON SCHEMA everydeck_read FROM PUBLIC;
  REVOKE ALL ON everydeck_read.cron_job, everydeck_read.cron_run FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA everydeck_read FROM anon; REVOKE ALL ON everydeck_read.cron_job, everydeck_read.cron_run FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA everydeck_read FROM authenticated; REVOKE ALL ON everydeck_read.cron_job, everydeck_read.cron_run FROM authenticated;
  END IF;
END $everydeck_cron$;
