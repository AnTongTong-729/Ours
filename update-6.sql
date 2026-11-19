-- =====================================================================
-- ours 업데이트 6: 토끼 키우기
--  · 토끼캡슐 편지: 토끼가 다음 단계로 자라는 순간에만 열리게 서버에서 잠가요
--  · 토끼가 자라면 두 사람에게 알림을 보내요
-- update-2.sql, update-3.sql을 이미 실행했다면 이것만 SQL Editor에서 한 번 실행하면 돼요.
-- (실행 순서: update-2.sql → update-3.sql → update-6.sql)
-- (여러 번 실행해도 괜찮아요)
-- =====================================================================

-- 1) 둘 다 답한 질문이 몇 개인지 (같은 날짜에 두 사람 답이 모두 있으면 1개)
create or replace function ours_private.pet_done()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from (
    select d.data ->> 'date'
    from public.docs d
    where d.col = 'answers' and d.data ? 'date' and d.data ? 'uid'
    group by d.data ->> 'date'
    having count(distinct d.data ->> 'uid') >= 2
  ) t;
$$;

-- 2) 토끼 단계: 0 새끼 · 1 아성체(15개) · 2 성체(45개)
create or replace function public.ours_pet_stage()
returns integer
language sql
stable
security definer
set search_path = public, ours_private
as $$
  select case when not public.is_couple() then 0
              when n >= 45 then 2
              when n >= 15 then 1
              else 0 end
  from (select ours_private.pet_done() as n) x;
$$;
revoke all on function public.ours_pet_stage() from public, anon;
grant execute on function public.ours_pet_stage() to authenticated;

-- 3) 편지 내용 잠금: 쓴 사람 · 여는 날이 된 편지 · 토끼가 그 단계까지 자란 토끼캡슐 편지만 읽을 수 있어요
drop policy if exists "couple reads" on public.docs;
create policy "couple reads" on public.docs for select to authenticated using (
  public.is_couple() and (
    col <> 'letterbodies'
    or data ->> 'author' = auth.uid()::text
    or data ->> 'openAt' <= to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')
    or (select public.ours_pet_stage()) >= case when data ->> 'openStage' ~ '^[0-9]+$' then (data ->> 'openStage')::int else 99 end
  )
);

-- 4) 새 글 알림 + 토끼가 자라는 순간 알림
create or replace function ours_private.on_new_doc()
returns trigger
language plpgsql
security definer
set search_path = public, ours_private, extensions
as $$
declare
  pair  integer;
  n     integer;
  stage integer;
begin
  if new.col in ('posts', 'stories', 'comments', 'likes', 'storylikes', 'answers', 'drawings', 'letters', 'plans', 'pings') then
    perform ours_private.send(
      ours_private.base_payload() || jsonb_build_object('type', 'change', 'col', new.col, 'path', new.path, 'data', new.data)
    );
  end if;

  -- 두 번째 사람이 답해서 그날 질문이 완성됐을 때, 딱 15개·45개가 되면 토끼가 자라요
  if new.col = 'answers' and new.data ? 'date' then
    select count(distinct d.data ->> 'uid') into pair
    from public.docs d
    where d.col = 'answers' and d.data ->> 'date' = new.data ->> 'date';
    if pair = 2 then
      n := ours_private.pet_done();
      stage := case when n >= 45 then 2 else 1 end;
      -- 한 번에 여러 답이 들어와도(가져오기 등) 알림은 한 번만
      if n in (15, 45) and coalesce(current_setting('ours.petgrow', true), '') <> stage::text then
        perform set_config('ours.petgrow', stage::text, true);
        perform ours_private.send(
          ours_private.base_payload() || jsonb_build_object(
            'type',   'petgrow',
            'stage',  stage,
            'name',   coalesce((select d.data ->> 'name' from public.docs d where d.path = 'settings/pet'), '토끼'),
            'fur',    coalesce((select d.data ->> 'fur'  from public.docs d where d.path = 'settings/pet'), 'white'),
            'opened', (select count(*) from public.docs d where d.col = 'letters' and d.data ->> 'openStage' = stage::text)
          )
        );
      end if;
    end if;
  end if;
  return new;
exception when others then
  return new; -- 알림이 실패해도 글 저장은 절대 막지 않아요
end;
$$;

select '업데이트 6 완료' as result;
