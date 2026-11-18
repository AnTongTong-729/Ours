# ours — 우리 둘만의 커플 앱

사진, 문구, 댓글, 좋아요, 리포스트, 매일 바뀌는 커플 질문, 오늘의 그림을 두 사람만 함께 쓰는 웹앱이에요.

- **사이트 올리는 곳:** GitHub Pages (무료)
- **로그인, 글, 사진 저장:** Supabase (무료 플랜)
- **들어올 수 있는 사람:** `setup.sql`에 적은 두 사람만

처음 설정은 30분 정도 걸려요. 아래 순서대로만 하시면 돼요.
(Supabase나 GitHub 화면은 업데이트되면서 메뉴 이름이 조금씩 바뀔 수 있어요. 비슷한 이름을 찾아 주세요.)

---

## 파일 구성

| 파일 | 하는 일 |
|---|---|
| `index.html` | 화면과 기능 전부 (피드, 질문, 그림판, 프로필, 로그인 화면) |
| `backend.js` | Supabase 연결 (로그인, 저장, 사진, 실시간 반영) |
| `config.js` | 내 Supabase 프로젝트 주소와 키 ← **직접 채워야 해요** |
| `setup.sql` | 데이터 표, 보안 규칙, 사진 저장소를 한 번에 만드는 SQL ← **이메일 두 개를 바꿔야 해요** |
| `icon.png`, `manifest.webmanifest` | 홈 화면에 추가했을 때 보이는 아이콘 |

---

## 1. Supabase 프로젝트 만들기

1. [supabase.com](https://supabase.com)에서 **Start your project**를 눌러 가입해요. GitHub 계정으로 가입하면 편해요.
2. **New project**를 눌러요.
   - Name: `ours`
   - Database Password: 아무거나 길게 적고 따로 메모해 두세요. 이 앱에서는 쓰지 않아요.
   - Region: **Northeast Asia (Seoul)**
3. **Create new project**를 누르고 1~2분 기다려요.

## 2. 표와 사진 저장소 만들기 (`setup.sql`)

1. `setup.sql`을 메모장으로 열고, 위쪽의 이메일 두 개를 **두 사람이 로그인할 실제 이메일**로 바꿔요.
   ```sql
   ('me@example.com'),        -- ← 내 이메일
   ('partner@example.com')    -- ← 여자친구 이메일
   ```
2. Supabase 왼쪽 메뉴에서 **SQL Editor** → **New query**를 눌러요.
3. `setup.sql` 내용을 **전부** 붙여넣고 **Run**을 눌러요.
4. 아래 결과 칸에 이메일 두 개가 보이면 성공이에요.

## 3. 두 사람 계정 만들고, 다른 사람 가입 막기

1. 왼쪽 메뉴에서 **Authentication** → **Users** → **Add user** → **Create new user**를 눌러요.
   - 이메일: 2단계에 적은 이메일과 똑같이
   - 비밀번호: 6자 이상
   - **Auto Confirm User** 체크
   - 같은 방법으로 두 번 만들어요. 내 계정 하나, 여자친구 계정 하나요.
2. **Authentication** → **Sign In / Providers**로 가서 **Allow new users to sign up**을 **끄고** 저장해요.
   이제 두 사람 말고는 아무도 가입할 수 없어요.

> 여자친구 비밀번호는 처음에 정해서 알려 주고, 앱에 들어간 뒤 **프로필 → 프로필 편집 → 새 비밀번호**에서 바꾸게 하면 돼요.

## 4. `config.js` 채우기

1. Supabase 위쪽의 **Connect** 버튼을 누르거나, **Project Settings → API Keys / Data API**로 가요.
2. 아래 두 값을 복사해서 `config.js`에 붙여넣어요.
   - **Project URL**: `https://abcdefgh.supabase.co` 같은 주소
   - **Publishable key**: `sb_publishable_...`로 시작하는 키 (옛날 화면이면 **anon public** 키)
   ```js
   window.OURS_CONFIG = {
     SUPABASE_URL: 'https://abcdefgh.supabase.co',
     SUPABASE_ANON_KEY: 'sb_publishable_xxxxxxxx'
   };
   ```
3. ⚠️ **secret**이나 **service_role**이라고 적힌 키는 절대 넣지 마세요. 그 키는 모든 보안 규칙을 무시해요.

## 5. GitHub Pages에 올리기

1. [github.com](https://github.com)에 로그인한 뒤 오른쪽 위 **+** → **New repository**를 눌러요.
   - Repository name: `ours`
   - **Public** 선택 → **Create repository**
2. 새 저장소 화면에서 **uploading an existing file**을 눌러요.
3. 이 폴더의 파일을 **전부** 끌어다 놓고 **Commit changes**를 눌러요.
4. 저장소의 **Settings** → 왼쪽 **Pages**로 가서 아래처럼 고르고 **Save**를 눌러요.
   - Source: **Deploy from a branch**
   - Branch: **main**, 폴더 **/ (root)**
5. 1~2분 뒤 `https://내아이디.github.io/ours/`로 들어가면 로그인 화면이 나와요.

## 6. 카톡 공지와 홈 화면 아이콘

- 주소를 카톡으로 보내서 **공지**로 올려 두세요. 이메일과 비밀번호로 로그인하는 방식이라 카톡 안의 브라우저에서도 로그인할 수 있어요.
- 아이폰은 **사파리 → 공유 → 홈 화면에 추가**를 하면 앱처럼 아이콘이 생겨요. 홈 화면 아이콘으로 처음 열 때는 한 번 더 로그인해야 할 수 있어요.

---

## 알아 두면 좋은 것

- **무료 플랜 한도:** 데이터 500MB, 사진 저장 1GB, 월 전송량 5GB예요. 앱이 사진을 올리기 전에 크기를 줄여서 한 장에 보통 0.3~0.5MB예요. 그래서 사진 수천 장까지 넉넉해요.
- **일주일 동안 둘 다 안 열면** 무료 프로젝트가 잠들어요. 앱에 "데이터를 불러오지 못했어요"가 뜨면 Supabase 대시보드에 들어가서 프로젝트를 다시 켜(Restore) 주세요.
- **보안:** `config.js`의 키는 원래 공개용이라 GitHub에 올라가도 괜찮아요. 글과 사진은 `setup.sql`의 규칙 때문에 두 사람 계정으로만 보고 쓸 수 있어요. 사진은 비공개 저장소에 있고, 7일짜리 임시 주소로만 열려요.
- **코드 고치기:** 파일을 고친 뒤 GitHub 저장소에서 **Add file → Upload files**로 같은 이름의 파일을 다시 올리면, 1~2분 뒤 사이트에 반영돼요.

## 문제가 생기면

| 화면에 뜨는 말 | 해결 방법 |
|---|---|
| "미리보기 화면이에요" | `config.js`의 주소와 키를 다시 확인해 주세요. |
| "이메일이나 비밀번호가 맞지 않아요" | Authentication → Users에서 계정이 있는지 확인하고, 필요하면 비밀번호를 다시 정해 주세요. |
| "커플 멤버로 등록되지 않았어요" | `setup.sql`에 적은 이메일과 로그인 이메일이 같은지 확인해 주세요. 잘못 적었다면 Table Editor → `couple_members`에서 고쳐 주세요. |
| 상대가 쓴 글이 바로 안 보여요 | 새로고침해 보세요. 그래도 안 되면 Database → Publications → `supabase_realtime`에 `docs`가 켜져 있는지 확인해 주세요. |
