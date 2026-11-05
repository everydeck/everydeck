-- everydeck outbox: schedule on Supabase. pg_cron calls the Edge Function `everydeck-outbox-relay` through pg_net: every 5 minutes with the job heartbeat,
-- and every 5 seconds only while rows wait, without a heartbeat (a result reaches everydeck within seconds; an idle app costs no extra calls).
-- Copy as a migration after everydeck_outbox.sql. Supabase only (needs the pg_cron and pg_net extensions).
--
-- The function runs without Supabase's JWT check (supabase/config.toml: [functions.everydeck-outbox-relay] verify_jwt = false), as Supabase documents
-- for a function that a schedule calls, and as everydeck deploys it in a hosted project the owner connected. Its own check is the invoke token from
-- Vault, sent in the header `x-everydeck-invoke-token`: a call without it is turned away. `everydeck_outbox_gateway_key` is optional and only for a
-- relay deployed with the JWT check before @everydeck/sdk 0.5.14: where the Vault has it, the call also carries the app's public key as `apikey`
-- (a legacy anon key also as `Authorization: Bearer`), so such a relay keeps working until it is deployed again.
--
-- No key, token or URL is written here. They come from Supabase Vault and are created by the owner, in the SQL editor of the
-- project, never in a migration, never in the repository:
--   select vault.create_secret('https://<project>.supabase.co/functions/v1/everydeck-outbox-relay', 'everydeck_outbox_relay_url');
--   select vault.create_secret('<random token, at least 32 characters>', 'everydeck_outbox_invoke_token');
--   select vault.create_secret('<everydeck server key of this environment>', 'everydeck_ingest_key');
-- Without the URL the scheduled call does nothing and the job heartbeat stays away; everydeck reports
-- "job has not reported" after two periods, so a missing secret is visible, not silent.

-- Only adds: cron.schedule with the name of an existing job replaces that job (pg_cron 1.3+), so applying this again needs no unschedule.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- the heartbeat schedule: every 5 minutes (everydeck Free: heartbeat every 300 s), delivers what waits and sends the job heartbeat.
SELECT cron.schedule('everydeck-outbox-relay', '*/5 * * * *', $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_relay_url'),
    headers := jsonb_strip_nulls(jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_gateway_key'),
      'Authorization', (SELECT 'Bearer ' || decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_gateway_key' AND decrypted_secret LIKE 'eyJ%'),
      'x-everydeck-invoke-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_invoke_token'))),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
  WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_relay_url');
$cron$);

-- the short schedule: every 5 seconds, only while rows wait (one cheap query, no call otherwise), without the job heartbeat.
SELECT cron.schedule('everydeck-outbox-relay-fast', '5 seconds', $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_relay_url'),
    headers := jsonb_strip_nulls(jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_gateway_key'),
      'Authorization', (SELECT 'Bearer ' || decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_gateway_key' AND decrypted_secret LIKE 'eyJ%'),
      'x-everydeck-invoke-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_invoke_token'))),
    body := '{"heartbeat": false}'::jsonb,
    timeout_milliseconds := 25000)
  WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_relay_url')
    AND EXISTS (SELECT 1 FROM everydeck_outbox.event WHERE rejected_at IS NULL);
$cron$);
