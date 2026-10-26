-- everydeck read bridge: schedule on Supabase. The read bridge fetches its requests from everydeck itself (outbound only, like a CI runner): pg_cron starts
-- the Edge Function `everydeck-read-bridge` through pg_net every minute, and each start fetches requests for about two minutes (pullHandler, under the
-- wall clock limit of Edge Functions), so two starts overlap and one is always connected. everydeck needs no address of the app and no key from it.
-- Copy as a migration. Supabase only (needs the pg_cron and pg_net extensions). 1 440 starts a day, about 43 200 a month, on the project's quota.
--
-- The function keeps Supabase's JWT check (no verify_jwt setting): the call carries the app's public key as `apikey`; a legacy anon key is a JWT and also
-- goes as `Authorization: Bearer`. Where everydeck deploys the function itself (a hosted project the owner connected), it runs without the JWT check and
-- there is no public key: the call goes without `apikey`.
--
-- No key or URL is written here. They come from Supabase Vault:
--   select vault.create_secret('https://<project>.supabase.co/functions/v1/everydeck-read-bridge', 'everydeck_read_bridge_url');
--   select vault.create_secret('<the app's public key: the publishable or anon key its browser uses>', 'everydeck_outbox_gateway_key');   -- shared with the outbox
-- Without the URL the schedule does nothing, and everydeck shows the read bridge as not connected.

-- Only adds: cron.schedule with the name of an existing job replaces that job (pg_cron 1.3+), so applying this again needs no unschedule.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule('everydeck-read-bridge', '* * * * *', $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_read_bridge_url'),
    headers := jsonb_strip_nulls(jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_gateway_key'),
      'Authorization', (SELECT 'Bearer ' || decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_outbox_gateway_key' AND decrypted_secret LIKE 'eyJ%'))),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000)
  WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'everydeck_read_bridge_url');
$cron$);
