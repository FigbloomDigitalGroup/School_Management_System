-- Bloom chat searches the web: the ai-assist "chat" task offers the model
-- its provider's hosted web search tool (OpenAI's Responses API web_search,
-- or Anthropic's web_search server tool), and the answer comes back with its
-- sources. Only Bloom chat: the study helper (its users are children) and the
-- drafting tasks never get the tool.
--
--   tenants.ai_web_search_enabled   the school lets Bloom chat search the web
--                                   (on by default); off, the toggle is hidden
--                                   and the edge function never sends the tool
--   ai_chats.web_search             the composer's "Search the web" toggle,
--                                   remembered per chat (on by default)
--   ai_chat_messages.sources        an answer's sources, [{title, url}, ...],
--                                   saved with it so history shows them too.
--                                   Written by the app as the person, like the
--                                   message; the app shows http(s) links only.
--   ai_usage.searches               searches the provider ran for the request;
--                                   null when the tool wasn't offered
--
-- Hosted search costs per search on top of tokens, so each search counts
-- against the school's monthly allowance as a fixed number of tokens,
-- ai_tokens_per_search() below: the one place that number lives. 2,500 is
-- roughly what one search costs ($10 per 1,000) in input tokens at the default
-- models' prices. ai_month_tokens (the edge function's check) and ai_status
-- (the settings screen) both count it.
--
-- ai_usage's task check is unchanged ('chat' and 'paper_import' stay, see
-- 20261027110000).

alter table tenants
  add column ai_web_search_enabled boolean not null default true;

alter table ai_chats
  add column web_search boolean not null default true;

alter table ai_chat_messages
  add column sources jsonb
    check (sources is null or (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 20));

alter table ai_usage
  add column searches int check (searches >= 0);

-- What one web search costs the school's allowance, in tokens.
create or replace function ai_tokens_per_search() returns int
language sql immutable set search_path = public as $$
  select 2500
$$;

-- Tokens this school has used since the 1st, searches included, for the edge function's allowance check.
create or replace function ai_month_tokens(p_tenant_id uuid) returns bigint
language sql stable security definer set search_path = public as $$
  -- sum() of a bigint is numeric; cast back to the declared bigint
  select coalesce(sum(input_tokens + output_tokens + coalesce(searches, 0)::bigint * ai_tokens_per_search()), 0)::bigint
    from ai_usage where tenant_id = p_tenant_id and created_at >= date_trunc('month', now())
$$;
revoke execute on function ai_month_tokens(uuid) from public, anon, authenticated;
grant execute on function ai_month_tokens(uuid) to service_role;

-- The settings screen's view, now with the web search switch and this month's
-- searches. The returned columns change, so the function is dropped and made again.
drop function ai_status(uuid);
create function ai_status(p_tenant_id uuid)
returns table (ai_enabled boolean, ai_tutor_enabled boolean, ai_web_search_enabled boolean,
               monthly_tokens int, used_tokens bigint, used_searches bigint)
language sql stable security definer set search_path = public as $$
  select t.ai_enabled, t.ai_tutor_enabled, t.ai_web_search_enabled, t.ai_monthly_tokens,
         coalesce((select sum(u.input_tokens + u.output_tokens + coalesce(u.searches, 0)::bigint * ai_tokens_per_search())
                     from ai_usage u
                    where u.tenant_id = t.id and u.created_at >= date_trunc('month', now())), 0)::bigint,
         coalesce((select sum(u.searches) from ai_usage u
                    where u.tenant_id = t.id and u.created_at >= date_trunc('month', now())), 0)
    from tenants t
   where t.id = p_tenant_id and (t.id = my_tenant() or may_administer(t.id) or is_super())
$$;
revoke execute on function ai_status(uuid) from public, anon;
grant execute on function ai_status(uuid) to authenticated;

-- The office's three switches. The three-argument set_ai_settings
-- (20261026040000) stays as it was, so an app built before this keeps
-- working; this one also sets web search. No defaults, so a call naming
-- three arguments can only mean the old one.
create or replace function set_ai_settings(p_tenant_id uuid, p_enabled boolean, p_tutor_enabled boolean, p_web_search_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not may_administer(p_tenant_id) then
    raise exception 'Only the school office can change AI settings.' using errcode = '42501';
  end if;
  update tenants set ai_enabled = p_enabled, ai_tutor_enabled = p_tutor_enabled, ai_web_search_enabled = p_web_search_enabled
   where id = p_tenant_id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p_tenant_id, auth.uid(), my_actor_label(),
          format('AI assist %s, study helper %s, web search %s', case when p_enabled then 'on' else 'off' end,
                 case when p_enabled and p_tutor_enabled then 'on' else 'off' end,
                 case when p_enabled and p_web_search_enabled then 'on' else 'off' end),
          'access', jsonb_build_object('ai_enabled', p_enabled, 'ai_tutor_enabled', p_tutor_enabled,
                                       'ai_web_search_enabled', p_web_search_enabled));
end $$;
revoke execute on function set_ai_settings(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function set_ai_settings(uuid, boolean, boolean, boolean) to authenticated;
