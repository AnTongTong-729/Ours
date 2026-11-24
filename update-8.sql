-- =====================================================================
-- ours 업데이트 9: 스토리 동영상 (SQL 파일 이름은 update-8.sql)
--  · 사진 저장소(photos)에 짧은 동영상(MP4, MOV, WebM)도 올릴 수 있게 해요
--  · 파일 하나 크기 제한을 10MB → 50MB로 올려요 (Supabase 무료 플랜의 최대치)
--    앱에서는 30초 이하, 50MB 이하 동영상만 고를 수 있어요
-- update-7.sql까지 실행했다면 이것만 SQL Editor에서 한 번 실행하면 돼요. (여러 번 실행해도 괜찮아요)
-- (실행 순서: update-2.sql → update-3.sql → update-6.sql → update-7.sql → update-8.sql)
-- =====================================================================

update storage.buckets
set file_size_limit    = 52428800, -- 50MB
    allowed_mime_types = array['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'video/webm']
where id = 'photos';

-- 앱이 확인하는 서버 버전
create or replace function public.ours_version()
returns integer
language sql
immutable
as $$ select 8 $$;
revoke all on function public.ours_version() from public, anon;
grant execute on function public.ours_version() to authenticated;

-- 확인: 아래 결과에 video/mp4가 보이면 성공이에요.
select '업데이트 9 완료' as result, file_size_limit, allowed_mime_types from storage.buckets where id = 'photos';
