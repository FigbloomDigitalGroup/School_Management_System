-- pg_cron calls platform-sync with PLATFORM_SYNC_KEY, in its own header.
--
-- On Supabase Cloud the SUPABASE_SERVICE_ROLE_KEY the edge runtime injects
-- isn't always the dashboard's legacy service_role key (seen 2026-11-03), so
-- platform-sync refused the key pg_cron sent. platform-sync now also
-- accepts its own key, PLATFORM_SYNC_KEY (a function secret, at least 32
-- characters).
--
-- The Vault secret keeps its name, platform_service_key, so nothing else has
-- to change; it now holds the PLATFORM_SYNC_KEY value (a service-role or
-- sb_secret_ key there still works). It goes in x-platform-sync-key rather
-- than Authorization: a header of the function's own that nothing in front of
-- it (the API gateway) has a reason to read or rewrite, and no JWT check can
-- trip over.

create or replace function platform_sync_tick(p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_key text;
begin
  if to_regclass('vault.decrypted_secrets') is null or to_regproc('net.http_post') is null then
    raise notice 'platform_sync_tick: Vault or pg_net is not available';
    return;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'platform_functions_url'$q$ into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'platform_service_key'$q$ into v_key;
  if v_url is null or v_key is null then
    raise notice 'platform_sync_tick: set the platform_functions_url and platform_service_key (PLATFORM_SYNC_KEY) Vault secrets';
    return;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 55000)'
    using rtrim(v_url, '/') || '/platform-sync',
          jsonb_build_object('action', p_action),
          jsonb_build_object('content-type', 'application/json', 'x-platform-sync-key', trim(v_key));
end $$;
revoke execute on function platform_sync_tick(text) from public, anon, authenticated;
