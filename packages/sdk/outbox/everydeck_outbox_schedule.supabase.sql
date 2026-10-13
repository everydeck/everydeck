-- everydeck outbox: schedule on Supabase. pg_cron calls the Edge Function `everydeck-outbox-relay` through pg_net: every minute with the job heartbeat,
-- and every 5 seconds only while rows wait, without a heartbeat (a result reaches everydeck within seconds; an idle app costs no extra calls).
-- Copy as a migration after everydeck_outbox.sql. Supabase only (needs the pg_cron and pg_net extensions).
--
-- No key, token or URL is written here. They come from Supabase Vault and are created by the owner, in the SQL editor of the
-- project, never in a migration, never in the repository:
--   select vault.create_secret('https://<project>.supabase.co/functions/v1/everydeck-outbox-relay', 'everydeck_outbox_relay_url');
--   select vault.create_secret('<random token, at least 32 characters>', 'everydeck_outbox_invoke_token');
--   select vault.create_secret('<everydeck server key of this environment>', 'everydeck_ingest_key');
-- Without these secrets the scheduled call does nothing (the URL is null) and the job heartbeat stays away; everydeck reports
-- "job has not reported" after two periods, so a missing secret is visible, not silent.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'everydeck-outbox-relay';
SELECT cron.schedule('everydeck-outbox-relay', '* * * * *', $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_relay_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_invoke_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
  WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_relay_url');
$cron$);

-- the short schedule: every 5 seconds, only while rows wait (one cheap query, no call otherwise), without the job heartbeat.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'everydeck-outbox-relay-fast';
SELECT cron.schedule('everydeck-outbox-relay-fast', '5 seconds', $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_relay_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_invoke_token')),
    body := '{"heartbeat": false}'::jsonb,
    timeout_milliseconds := 25000)
  WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_relay_url')
    AND EXISTS (SELECT 1 FROM everydeck_outbox.event WHERE rejected_at IS NULL);
$cron$);
