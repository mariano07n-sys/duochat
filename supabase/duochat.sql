-- DuoChat : historique des messages.
-- À exécuter une seule fois dans Supabase > SQL Editor. Ré-exécutable sans risque.

create table if not exists public.duochat_messages (
  id uuid primary key,
  room text not null check (room ~ '^[0-9a-f]{64}$'),
  user_id text not null,
  name text not null,
  color text not null,
  kind text not null check (kind in ('text', 'location')),
  body text not null,
  meta jsonb,
  ts bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists duochat_messages_room_ts on public.duochat_messages (room, ts desc);

-- Aucun accès direct à la table : tout passe par les deux fonctions ci-dessous.
alter table public.duochat_messages enable row level security;
revoke all on public.duochat_messages from anon, authenticated;

create or replace function public.duochat_history(p_room text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(m.msg order by m.ts), '[]'::jsonb)
  from (
    select ts,
           jsonb_strip_nulls(jsonb_build_object(
             't', 'msg', 'id', id, 'userId', user_id, 'name', name, 'color', color,
             'kind', kind, 'text', body, 'meta', meta, 'ts', ts
           )) as msg
    from public.duochat_messages
    where room = p_room
    order by ts desc
    limit 200
  ) m;
$$;

create or replace function public.duochat_post(p_room text, p_message jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text := coalesce(p_message->>'kind', 'text');
  v_name text := left(btrim(coalesce(p_message->>'name', '')), 32);
  v_user text := left(btrim(coalesce(p_message->>'userId', '')), 64);
  v_color text := p_message->>'color';
  v_body text := left(btrim(coalesce(p_message->>'text', '')), 4000);
  v_meta jsonb;
  v_file text;
  v_line integer;
  v_ts bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  v_cutoff bigint;
begin
  if p_room is null or p_room !~ '^[0-9a-f]{64}$' then
    raise exception 'duochat: salon invalide' using errcode = '22023';
  end if;
  if v_kind not in ('text', 'location') or v_name = '' or v_user = '' then
    raise exception 'duochat: message invalide' using errcode = '22023';
  end if;
  if v_color is null or v_color !~ '^#[0-9a-fA-F]{6}$' then
    v_color := '#22d3ee';
  end if;

  if v_kind = 'location' then
    v_file := left(btrim(coalesce(p_message->'meta'->>'file', '')), 512);
    v_line := case
      when (p_message->'meta'->>'line') ~ '^[0-9]{1,7}$' then (p_message->'meta'->>'line')::integer
    end;
    if v_file = '' or v_line is null or v_line < 1 or v_line > 1000000 then
      raise exception 'duochat: référence invalide' using errcode = '22023';
    end if;
    v_meta := jsonb_build_object('file', v_file, 'line', v_line);
    v_body := v_file || ':' || v_line;
  elsif v_body = '' then
    raise exception 'duochat: message vide' using errcode = '22023';
  end if;

  insert into public.duochat_messages (id, room, user_id, name, color, kind, body, meta, ts)
  values ((p_message->>'id')::uuid, p_room, v_user, v_name, v_color, v_kind, v_body, v_meta, v_ts)
  on conflict (id) do nothing;

  -- Conserver les 500 derniers messages par salon.
  select ts into v_cutoff
  from public.duochat_messages
  where room = p_room
  order by ts desc
  offset 499 limit 1;
  if v_cutoff is not null then
    delete from public.duochat_messages where room = p_room and ts < v_cutoff;
  end if;
end;
$$;

revoke execute on function public.duochat_history(text) from public;
revoke execute on function public.duochat_post(text, jsonb) from public;
grant execute on function public.duochat_history(text) to anon, authenticated;
grant execute on function public.duochat_post(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
