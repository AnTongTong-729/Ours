-- =====================================================================
-- ours 업데이트 2 — 알림, 타임캡슐 편지 잠금, 매시간 알림 확인
-- Supabase > SQL Editor > New query 에 전체를 붙여넣고 Run 하세요.
-- (Run 버튼 옆이 "Logs"가 아니라 데이터베이스로 되어 있는지 확인!)
-- 여러 번 실행해도 괜찮아요.
-- =====================================================================

-- 0) 필요한 기능 켜기: 데이터베이스에서 인터넷 요청 보내기(pg_net), 정해진 시간마다 실행(pg_cron)
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- 1) 앱에서는 보이지 않는 비공개 설정 칸
create schema if not exists ours_private;
revoke all on schema ours_private from public;
create table if not exists ours_private.config (
  key   text primary key,
  value text not null
);
insert into ours_private.config (key, value) values
  ('function_url', 'https://ogzhqtlfclbvbahzqfcq.supabase.co/functions/v1/ours-push'),
  ('subject',      'https://antongtong-729.github.io')
on conflict (key) do update set value = excluded.value;

-- 알림용 비밀 키를 저장하는 함수 (키 값은 안내 메시지로 따로 받은 한 줄을 실행해요)
create or replace function ours_private.set_push_key(private_key text)
returns text
language plpgsql
security definer
set search_path = ours_private
as $$
begin
  insert into ours_private.config (key, value) values ('vapid_private', private_key)
  on conflict (key) do update set value = excluded.value;
  return '알림 키를 저장했어요';
end;
$$;

-- 2) 앱이 알림을 신청할 때 쓰는 공개 키 (공개돼도 괜찮은 값)
insert into public.docs (path, col, data) values
  ('config/push', 'config', jsonb_build_object('vapidPublicKey', 'BMdps_eoP3MFWjiqAffFf0uYL9v7W0Wc96MJldrgmLGN3gP4eFHZVwL-1Vmuv4-nS7aKoLQhloanxblZlmIWFR4'))
on conflict (path) do update set data = excluded.data, updated_at = now();

-- 3) 타임캡슐 편지 잠금: 편지 내용(letterbodies)은 쓴 사람만, 또는 여는 날이 된 뒤에만 읽을 수 있어요
drop policy if exists "couple reads"   on public.docs;
drop policy if exists "couple inserts" on public.docs;
drop policy if exists "couple updates" on public.docs;
drop policy if exists "couple deletes" on public.docs;
create policy "couple reads" on public.docs for select to authenticated using (
  public.is_couple() and (
    col <> 'letterbodies'
    or data ->> 'author' = auth.uid()::text
    or data ->> 'openAt' <= to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')
  )
);
create policy "couple inserts" on public.docs for insert to authenticated with check (
  public.is_couple() and (col <> 'letterbodies' or data ->> 'author' = auth.uid()::text)
);
create policy "couple updates" on public.docs for update to authenticated
  using      (public.is_couple() and (col <> 'letterbodies' or data ->> 'author' = auth.uid()::text))
  with check (public.is_couple() and (col <> 'letterbodies' or data ->> 'author' = auth.uid()::text));
create policy "couple deletes" on public.docs for delete to authenticated using (
  public.is_couple() and (col <> 'letterbodies' or data ->> 'author' = auth.uid()::text)
);

-- 4) 알림 서버로 보낼 공통 정보 (두 사람 프로필, 알림 받을 기기들)
create or replace function ours_private.base_payload()
returns jsonb
language sql
stable
security definer
set search_path = public, ours_private
as $$
  select jsonb_build_object(
    'vapidPrivate', (select value from ours_private.config where key = 'vapid_private'),
    'subject',      (select value from ours_private.config where key = 'subject'),
    'profiles',     coalesce((select jsonb_agg(d.data) from public.docs d where d.col = 'profiles'), '[]'::jsonb),
    'subs',         coalesce((select jsonb_agg(d.data) from public.docs d where d.col = 'push'), '[]'::jsonb)
  );
$$;

create or replace function ours_private.send(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public, ours_private, extensions
as $$
declare
  url text := (select value from ours_private.config where key = 'function_url');
begin
  if url is null or payload ->> 'vapidPrivate' is null then
    return; -- 아직 알림 키를 넣지 않았으면 조용히 건너뛰어요
  end if;
  perform net.http_post(
    url := url,
    body := payload,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 8000
  );
end;
$$;

-- 5) 새 사진·스토리·댓글·답·그림·편지·약속이 생기면 바로 알림
create or replace function ours_private.on_new_doc()
returns trigger
language plpgsql
security definer
set search_path = public, ours_private, extensions
as $$
begin
  if new.col in ('posts', 'stories', 'comments', 'answers', 'drawings', 'letters', 'plans', 'pings') then
    perform ours_private.send(
      ours_private.base_payload() || jsonb_build_object('type', 'change', 'col', new.col, 'path', new.path, 'data', new.data)
    );
  end if;
  return new;
exception when others then
  return new; -- 알림이 실패해도 글 저장은 절대 막지 않아요
end;
$$;
drop trigger if exists ours_notify on public.docs;
create trigger ours_notify after insert on public.docs
  for each row execute function ours_private.on_new_doc();

-- 6) 매시간: 오늘의 질문, 기념일·생일, 약속, 편지 열리는 날 알림 (각자 정한 시간에만 보내요)
create or replace function ours_private.tick()
returns void
language plpgsql
security definer
set search_path = public, ours_private, extensions
as $$
declare
  today    text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD');
  tomorrow text := to_char((now() at time zone 'Asia/Seoul') + interval '1 day', 'YYYY-MM-DD');
begin
  perform ours_private.send(
    ours_private.base_payload() || jsonb_build_object(
      'type', 'tick',
      'couple', (select d.data from public.docs d where d.path = 'settings/couple'),
      'anniversaries', coalesce((select jsonb_agg(d.data) from public.docs d where d.col = 'anniversaries'), '[]'::jsonb),
      'plans', coalesce((select jsonb_agg(d.data) from public.docs d where d.col = 'plans' and d.data ->> 'date' in (today, tomorrow)), '[]'::jsonb),
      'letters', coalesce((select jsonb_agg(d.data) from public.docs d where d.col = 'letters' and d.data ->> 'openAt' = today), '[]'::jsonb)
    )
  );
end;
$$;
select cron.schedule('ours-hourly', '0 * * * *', 'select ours_private.tick()');

-- 확인: 아래에 "준비 완료"가 보이면 성공이에요.
select '준비 완료' as result;
