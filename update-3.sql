-- =====================================================================
-- ours 업데이트 3: 좋아요·스토리 하트도 알림으로 보내기
-- update-2.sql을 이미 실행했다면 이것만 SQL Editor에서 한 번 실행하면 돼요.
-- (여러 번 실행해도 괜찮아요)
-- =====================================================================
create or replace function ours_private.on_new_doc()
returns trigger
language plpgsql
security definer
set search_path = public, ours_private, extensions
as $$
begin
  if new.col in ('posts', 'stories', 'comments', 'likes', 'storylikes', 'answers', 'drawings', 'letters', 'plans', 'pings') then
    perform ours_private.send(
      ours_private.base_payload() || jsonb_build_object('type', 'change', 'col', new.col, 'path', new.path, 'data', new.data)
    );
  end if;
  return new;
exception when others then
  return new; -- 알림이 실패해도 글 저장은 절대 막지 않아요
end;
$$;

select '업데이트 3 완료' as result;
