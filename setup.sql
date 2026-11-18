-- =====================================================================
-- ours 커플 앱 — Supabase 설정
-- Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를 붙여넣고 Run 하세요.
-- 실행하기 전에 바로 아래 두 이메일을 두 사람의 실제 로그인 이메일로 바꿔 주세요!
-- 여러 번 실행해도 괜찮아요.
-- =====================================================================

-- 1) 앱을 쓸 수 있는 두 사람
create table if not exists public.couple_members (
  email text primary key
);
alter table public.couple_members enable row level security;
revoke all on public.couple_members from anon, authenticated;

insert into public.couple_members (email) values
  ('me@example.com'),        -- ← 내 이메일
  ('partner@example.com')    -- ← 여자친구 이메일
on conflict do nothing;

-- 지금 로그인한 사람이 위 두 사람 중 하나인지 확인하는 함수
create or replace function public.is_couple()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.couple_members
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_couple() from public, anon;
grant execute on function public.is_couple() to authenticated;

-- 2) 글·답·좋아요·댓글·그림 정보를 담는 표 (path 예: posts/abc123)
create table if not exists public.docs (
  path       text primary key,
  col        text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists docs_col_idx on public.docs (col);
alter table public.docs enable row level security;
revoke all on public.docs from anon;
grant select, insert, update, delete on public.docs to authenticated;

drop policy if exists "couple reads"   on public.docs;
drop policy if exists "couple inserts" on public.docs;
drop policy if exists "couple updates" on public.docs;
drop policy if exists "couple deletes" on public.docs;
create policy "couple reads"   on public.docs for select to authenticated using (public.is_couple());
create policy "couple inserts" on public.docs for insert to authenticated with check (public.is_couple());
create policy "couple updates" on public.docs for update to authenticated using (public.is_couple()) with check (public.is_couple());
create policy "couple deletes" on public.docs for delete to authenticated using (public.is_couple());

-- 상대가 쓴 글이 새로고침 없이 바로 보이게 (Realtime)
do $$
begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null;
end $$;

-- 3) 사진·그림 저장소 (비공개, 파일당 10MB, JPG/PNG만)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "couple photo read"   on storage.objects;
drop policy if exists "couple photo upload" on storage.objects;
drop policy if exists "couple photo update" on storage.objects;
drop policy if exists "couple photo delete" on storage.objects;
create policy "couple photo read"   on storage.objects for select to authenticated using (bucket_id = 'photos' and public.is_couple());
create policy "couple photo upload" on storage.objects for insert to authenticated with check (bucket_id = 'photos' and public.is_couple());
create policy "couple photo update" on storage.objects for update to authenticated using (bucket_id = 'photos' and public.is_couple());
create policy "couple photo delete" on storage.objects for delete to authenticated using (bucket_id = 'photos' and public.is_couple());

-- 확인: 아래 결과에 두 이메일이 보이면 성공이에요.
select email from public.couple_members;
