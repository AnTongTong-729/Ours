-- =====================================================================
-- ours 업데이트 7: 썸원 기록 가져오기, 토끼 성장 기준 변경
--  · 썸원에서 가져온 기록(src = 'someone')은 알림을 보내지 않고, 토끼 성장에도 안 쳐요
--  · 토끼: 둘 다 답한 질문 30개 → 아성체, 100개 → 성체
--  · 앱이 "서버 준비됐나요?"를 물어볼 수 있게 버전 함수를 만들어요
-- update-6.sql까지 실행했다면 이것만 SQL Editor에서 한 번 실행하면 돼요. (여러 번 실행해도 괜찮아요)
-- (실행 순서: update-2.sql → update-3.sql → update-6.sql → update-7.sql)
-- =====================================================================

-- 1) 둘 다 답한 질문 수: 썸원에서 가져온 답은 빼고 세요
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
      and coalesce(d.data ->> 'src', '') <> 'someone'
    group by d.data ->> 'date'
    having count(distinct d.data ->> 'uid') >= 2
  ) t;
$$;

-- 2) 토끼 단계: 0 새끼 · 1 아성체(30개) · 2 성체(100개)
create or replace function public.ours_pet_stage()
returns integer
language sql
stable
security definer
set search_path = public, ours_private
as $$
  select case when not public.is_couple() then 0
              when n >= 100 then 2
              when n >= 30 then 1
              else 0 end
  from (select ours_private.pet_done() as n) x;
$$;
revoke all on function public.ours_pet_stage() from public, anon;
grant execute on function public.ours_pet_stage() to authenticated;

-- 3) 앱이 확인하는 서버 버전
create or replace function public.ours_version()
returns integer
language sql
immutable
as $$ select 7 $$;
revoke all on function public.ours_version() from public, anon;
grant execute on function public.ours_version() to authenticated;

-- 4) 새 글 알림 + 토끼가 자라는 순간 알림 (가져온 기록은 조용히)
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
  if coalesce(new.data ->> 'src', '') = 'someone' then
    return new; -- 썸원에서 가져온 기록은 알림을 보내지 않아요
  end if;

  if new.col in ('posts', 'stories', 'comments', 'likes', 'storylikes', 'answers', 'drawings', 'letters', 'plans', 'pings') then
    perform ours_private.send(
      ours_private.base_payload() || jsonb_build_object('type', 'change', 'col', new.col, 'path', new.path, 'data', new.data)
    );
  end if;

  -- 두 번째 사람이 답해서 그날 질문이 완성됐을 때, 딱 30개·100개가 되면 토끼가 자라요
  if new.col = 'answers' and new.data ? 'date' then
    select count(distinct d.data ->> 'uid') into pair
    from public.docs d
    where d.col = 'answers' and d.data ->> 'date' = new.data ->> 'date'
      and coalesce(d.data ->> 'src', '') <> 'someone';
    if pair = 2 then
      n := ours_private.pet_done();
      stage := case when n >= 100 then 2 else 1 end;
      if n in (30, 100) and coalesce(current_setting('ours.petgrow', true), '') <> stage::text then
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

select '업데이트 7 완료' as result;
