/*
 * ours — backend.js
 * 앱(index.html)과 Supabase를 이어 주는 연결부예요.
 *  - 로그인:   Supabase Auth (이메일 + 비밀번호)
 *  - 글·답·좋아요 등: docs 표 하나에 JSON으로 저장 (path = "posts/abc" 같은 주소)
 *  - 사진·그림: 비공개 Storage 버킷 "photos" + 7일짜리 서명 URL
 *  - 실시간 반영: Realtime(postgres_changes)로 상대가 쓴 글이 바로 보여요
 * 앱 쪽 코드는 db / user / assets 세 가지 기능만 알면 돼서, 이 파일만 바꾸면 다른 백엔드로도 옮길 수 있어요.
 */
(function () {
  'use strict';
  const cfg = window.OURS_CONFIG || {};
  const TABLE = 'docs';
  const BUCKET = 'photos';
  const URL_TTL = 7 * 24 * 3600; // 서명 URL 유효기간(초)
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(cfg.SUPABASE_URL || '') &&
    /^[\x21-\x7e]{20,}$/.test(cfg.SUPABASE_ANON_KEY || '');

  let sb = null, uid = null, email = '';

  function client() {
    if (!sb) {
      if (!window.supabase || !window.supabase.createClient) throw new Error('supabase-js를 불러오지 못했어요');
      sb = window.supabase.createClient(cfg.SUPABASE_URL.replace(/\/$/, ''), cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
    }
    return sb;
  }

  /* Supabase 오류를 앱이 이해하는 짧은 코드로 바꿔요 */
  function mapErr(error, fallback) {
    const msg = (error && (error.message || error.error_description || error.error)) || String(error || '');
    const status = Number((error && (error.status || error.statusCode)) || 0);
    let code = fallback || 'error';
    if ((error && error.code === '42501') || status === 401 || status === 403 || /row-level security|permission denied|unauthorized/i.test(msg)) code = 'forbidden';
    else if (status === 413 || /maximum allowed size|too large/i.test(msg)) code = 'too_large';
    else if (status === 415 || /mime type/i.test(msg)) code = 'unsupported_type';
    else if (/failed to fetch|networkerror|network request|load failed|timeout/i.test(msg)) code = 'unavailable';
    return { code, message: msg };
  }

  const rid = () => {
    const a = new Uint8Array(12); (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  };

  /* ---------- db: 컬렉션/문서 방식의 작은 저장소 ---------- */
  const cache = new Map();      // 컬렉션 이름 -> Map(path -> data)
  const loading = new Map();    // 컬렉션 이름 -> 진행 중인 불러오기
  const listeners = new Set();  // onSnapshot 구독자
  const colOf = path => path.split('/').slice(0, -1).join('/');

  function snapshot(col, order, lim) {
    let rows = Array.from((cache.get(col) || new Map()).entries());
    if (order) {
      const [f, dir] = order;
      rows.sort((a, b) => { const x = a[1][f], y = b[1][f]; const r = x === y ? 0 : x == null ? 1 : y == null ? -1 : x < y ? -1 : 1; return dir === 'desc' ? -r : r; });
    } else rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (lim) rows = rows.slice(0, lim);
    const meta = { fromCache: false, hasPendingWrites: false };
    const docs = rows.map(([path, data]) => ({ id: path.split('/').pop(), exists: true, data: () => data, metadata: meta }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta };
  }
  function deliver(l) { if (cache.has(l.col)) { try { l.next(snapshot(l.col, l.order, l.lim)); } catch (e) { console.error(e); } } }
  function emit(col) { listeners.forEach(l => { if (l.col === col) deliver(l); }); }

  async function fetchCol(col) {
    const m = new Map(); let from = 0;
    for (;;) {
      const { data, error } = await client().from(TABLE).select('path,data').eq('col', col).range(from, from + 999);
      if (error) throw mapErr(error, 'unavailable');
      for (const r of data || []) m.set(r.path, r.data);
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    cache.set(col, m); emit(col);
  }
  function ensure(col) {
    if (!loading.has(col)) loading.set(col, fetchCol(col).catch(e => { loading.delete(col); throw e; }));
    return loading.get(col);
  }
  async function refetchAll() {
    const cols = new Set(); listeners.forEach(l => cols.add(l.col));
    for (const c of cols) { try { await fetchCol(c); } catch (e) { console.warn('[ours] 다시 불러오기 실패', c, e); } }
  }
  function applyRemote(p) {
    if (!p) return;
    if (p.eventType === 'DELETE') {
      const path = p.old && p.old.path; if (!path) return;
      const col = colOf(path), m = cache.get(col);
      if (m && m.delete(path)) emit(col);
    } else {
      const r = p.new; if (!r || !r.path) return;
      const col = r.col || colOf(r.path), m = cache.get(col);
      if (!m) return;
      m.set(r.path, r.data); emit(col);
    }
  }

  function docRef(path) {
    const col = colOf(path);
    return {
      id: path.split('/').pop(), path,
      async get() {
        const { data, error } = await client().from(TABLE).select('data').eq('path', path).maybeSingle();
        if (error) throw mapErr(error, 'unavailable');
        return { id: path.split('/').pop(), exists: !!data, data: () => (data ? data.data : undefined), metadata: { fromCache: false, hasPendingWrites: false } };
      },
      async set(body) {
        const data = JSON.parse(JSON.stringify(body));
        const m = cache.get(col), had = !!(m && m.has(path)), prev = had ? m.get(path) : undefined;
        if (m) { m.set(path, data); emit(col); } // 화면에 먼저 반영
        const { error } = await client().from(TABLE).upsert({ path, col, data, updated_at: new Date().toISOString() });
        if (error) { if (m) { if (had) m.set(path, prev); else m.delete(path); emit(col); } throw mapErr(error, 'error'); }
      },
      async delete() {
        const m = cache.get(col), had = !!(m && m.has(path)), prev = had ? m.get(path) : undefined;
        if (had) { m.delete(path); emit(col); }
        const { error } = await client().from(TABLE).delete().eq('path', path);
        if (error) { if (had) { m.set(path, prev); emit(col); } throw mapErr(error, 'error'); }
      }
    };
  }
  function query(col, order, lim) {
    return {
      orderBy(f, dir) { return query(col, [f, dir || 'asc'], lim); },
      limit(n) { return query(col, order, n); },
      where() { throw new Error('where()는 이 앱에서 쓰지 않아요'); },
      async get() { await ensure(col); return snapshot(col, order, lim); },
      onSnapshot(next, error) {
        const l = { col, order, lim, next };
        listeners.add(l);
        ensure(col).then(() => deliver(l)).catch(e => { if (error) error(e); else console.warn(e); });
        return () => listeners.delete(l);
      }
    };
  }
  const db = {
    doc: docRef,
    collection(col) {
      const q = query(col);
      return Object.assign({}, q, {
        path: col,
        doc: id => docRef(col + '/' + (id || rid())),
        async add(body) { const r = docRef(col + '/' + rid()); await r.set(body); return r; }
      });
    }
  };

  /* ---------- 사진: 비공개 버킷 + 서명 URL ---------- */
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const MISSING = 'data:image/png;base64,AA=='; // 일부러 깨진 이미지: 앱이 "불러오지 못했어요"로 표시
  const urls = new Map(); // path -> { u, exp }
  const pending = new Set();
  let flushTimer = 0, onPhotos = null;
  try {
    const saved = JSON.parse(localStorage.getItem('ours-photo-urls') || '{}');
    for (const k in saved) if (saved[k] && saved[k].exp > Date.now() + 864e5) urls.set(k, saved[k]);
  } catch (e) { /* 저장소를 못 쓰면 매번 새로 받아요 */ }
  function saveUrls() {
    try { const o = {}; urls.forEach((v, k) => { if (v.u !== MISSING) o[k] = v; }); localStorage.setItem('ours-photo-urls', JSON.stringify(o)); } catch (e) { /* ignore */ }
  }
  function photoUrl(path) {
    if (!path) return BLANK;
    const v = urls.get(path);
    if (v && v.exp > Date.now() + 36e5) return v.u;
    if (sb && uid) { pending.add(path); if (!flushTimer) flushTimer = setTimeout(flushPhotos, 25); }
    return v ? v.u : BLANK;
  }
  async function flushPhotos() {
    flushTimer = 0;
    const paths = Array.from(pending); pending.clear();
    if (!paths.length) return;
    let changed = false;
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const { data, error } = await client().storage.from(BUCKET).createSignedUrls(chunk, URL_TTL);
      if (error) { console.warn('[ours] 사진 주소 만들기 실패', error); continue; }
      const exp = Date.now() + URL_TTL * 1000;
      for (const d of data || []) {
        const u = d && (d.signedUrl || d.signedURL);
        if (d && d.path && u && !d.error) urls.set(d.path, { u, exp });
        else if (d && d.path) urls.set(d.path, { u: MISSING, exp: Date.now() + 10 * 60e3 });
        changed = true;
      }
    }
    if (changed) { saveUrls(); if (onPhotos) onPhotos(); }
  }
  const assets = {
    async upload(blob, opts) {
      const type = (opts && opts.type) || blob.type || 'image/jpeg';
      const path = `${uid}/${Date.now().toString(36)}-${rid()}.${type === 'image/png' ? 'png' : 'jpg'}`;
      const { error } = await client().storage.from(BUCKET).upload(path, blob, { contentType: type, cacheControl: '31536000', upsert: false });
      if (error) throw mapErr(error, 'upstream_error');
      return { id: path, url: photoUrl(path), sizeBytes: blob.size, contentType: type };
    },
    async delete(path) {
      const { error } = await client().storage.from(BUCKET).remove([path]);
      if (error) throw mapErr(error, 'upstream_error');
      urls.delete(path); saveUrls();
      return { deleted: true };
    },
    async list() {
      let files = 0, bytes = 0;
      const store = client().storage.from(BUCKET);
      const top = await store.list('', { limit: 1000 });
      if (top.error) throw mapErr(top.error, 'upstream_error');
      for (const d of top.data || []) {
        if (d.id) { files++; bytes += (d.metadata && d.metadata.size) || 0; continue; }
        for (let offset = 0; ; offset += 1000) {
          const r = await store.list(d.name, { limit: 1000, offset });
          if (r.error) throw mapErr(r.error, 'upstream_error');
          for (const f of r.data || []) { files++; bytes += (f.metadata && f.metadata.size) || 0; }
          if (!r.data || r.data.length < 1000) break;
        }
      }
      return { assets: [], usage: { files, bytes, maxFiles: 0, maxBytes: 1e9 } };
    }
  };

  /* ---------- 사람 ---------- */
  const user = {
    async me() { return { id: uid, name: '', avatarUrl: '', color: '#ff4f9a', email, isOwner: false, canEdit: true }; },
    async id() { return uid; },
    async isOwner() { return false; },
    async canEdit() { return true; },
    async can() { return true; },
    async profiles(ids) {
      const r = {};
      [].concat(ids || []).forEach(id => { r[id] = { id, name: '', avatarUrl: '', color: '#a08f97', email: null, isMe: id === uid, guest: false }; });
      return r;
    }
  };

  /* ---------- 실시간 ---------- */
  let channel = null, hiddenAt = 0;
  function startRealtime() {
    if (channel) return;
    channel = client().channel('ours-docs')
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, applyRemote)
      .subscribe(status => { if (status === 'SUBSCRIBED') refetchAll(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 30e3) refetchAll();
    });
  }

  /* ---------- 앱에 내보내는 것 ---------- */
  window.OursBackend = {
    configured,
    photoUrl,
    onPhotosReady(fn) { onPhotos = fn; },
    async session() {
      const { data, error } = await client().auth.getSession();
      if (error) console.warn(error);
      return (data && data.session) || null;
    },
    async signIn(mail, password) {
      const { data, error } = await client().auth.signInWithPassword({ email: mail, password });
      if (error) {
        const msg = error.message || '';
        if (/invalid login credentials/i.test(msg)) throw new Error('이메일이나 비밀번호가 맞지 않아요.');
        if (/email not confirmed/i.test(msg)) throw new Error('아직 이메일 확인이 안 된 계정이에요. 대시보드에서 사용자를 확인 처리해 주세요.');
        if (/failed to fetch|network/i.test(msg)) throw new Error('서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
        throw new Error('로그인하지 못했어요: ' + msg);
      }
      return data.session;
    },
    async signOut() { try { await client().auth.signOut(); } finally { try { localStorage.removeItem('ours-photo-urls'); } catch (e) { /* ignore */ } } },
    async changePassword(pw) {
      const { error } = await client().auth.updateUser({ password: pw });
      if (error) throw new Error(/should be different/i.test(error.message || '') ? '지금 비밀번호와 다른 비밀번호를 적어 주세요.' : '비밀번호를 바꾸지 못했어요: ' + (error.message || ''));
    },
    refresh(col) { return fetchCol(col).catch(e => console.warn('[ours] 새로고침 실패', col, e)); },
    async rpc(name, args) { // 서버 함수 부르기 (예: ours_version)
      const { data, error } = await client().rpc(name, args || {});
      if (error) throw error;
      return data;
    },
    async isMember() {
      const { data, error } = await client().rpc('is_couple');
      if (error) { console.warn('[ours] is_couple 확인 실패', error); return null; }
      return data === true;
    },
    connect(session) {
      uid = session.user.id; email = session.user.email || '';
      startRealtime();
      const caps = { db, user, assets };
      return { use: name => Promise.resolve(caps[name] || null) };
    }
  };
})();
