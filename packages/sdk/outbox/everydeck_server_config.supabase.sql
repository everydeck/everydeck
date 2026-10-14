-- everydeck server settings for an app with a server of its own (FastAPI, Express, Next.js server) next to a hosted Supabase project.
-- The server reads its everydeck settings once at start through the Supabase connection it already has (supabase.rpc('everydeck_server_config')),
-- so no everydeck value has to be copied into the hosting dashboard. Values come from Supabase Vault (written by everydeck after the owner's approval):
--   everydeck_endpoint, everydeck_ingest_key (the server key of this environment), everydeck_manifest_digest
-- Only the server may call it: Supabase gives EXECUTE on new functions in public to anon and authenticated by default privileges, so this file
-- revokes it from PUBLIC, anon and authenticated and grants it to service_role only. everydeck checks these rights again after every apply.
-- Only adds: CREATE OR REPLACE, no DROP.
CREATE OR REPLACE FUNCTION public.everydeck_server_config()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'endpoint', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_endpoint'),
    'server_key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_ingest_key'),
    'manifest_digest', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'everydeck_manifest_digest')
  );
$$;

REVOKE ALL ON FUNCTION public.everydeck_server_config() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.everydeck_server_config() TO service_role;
COMMENT ON FUNCTION public.everydeck_server_config() IS 'everydeck: settings of the app''s own server (service_role only)';
