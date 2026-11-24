// @ts-nocheck
// =====================================================================
// ours — 알림 보내는 서버 코드 (Supabase Edge Function: ours-push)
// Supabase 대시보드 > Edge Functions > Deploy a new function > Via Editor 에
// 이 파일 전체를 붙여넣고, 함수 이름은 ours-push 로 해 주세요.
//
// 데이터베이스가 "새 글이 생겼어요" / "한 시간이 지났어요" 하고 이 함수를 부르면,
// 누구에게 어떤 알림을 보낼지 정해서 휴대폰으로 웹 푸시를 보내요.
// 비밀 키는 이 파일에 없어요. 데이터베이스가 요청할 때마다 함께 보내고,
// 아래 공개 키와 짝이 맞는지 확인한 뒤에만 보내요.
// 표준 웹 푸시(RFC 8291 암호화 + VAPID 서명)를 외부 라이브러리 없이 직접 구현했어요.
// =====================================================================

const VAPID_PUBLIC = 'BMdps_eoP3MFWjiqAffFf0uYL9v7W0Wc96MJldrgmLGN3gP4eFHZVwL-1Vmuv4-nS7aKoLQhloanxblZlmIWFR4';
const DEFAULT_PREFS = { post: true, comment: true, like: true, qa: true, daily: true, dates: true, hour: 9 };
const te = new TextEncoder();

/* ---------- 작은 도구들 ---------- */
function b64u(bytes) {
  let s = '';
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/* ---------- VAPID 서명 (RFC 8292) ---------- */
async function importVapid(privateD, publicRaw) {
  const pub = fromB64u(publicRaw);
  const x = b64u(pub.slice(1, 33)), y = b64u(pub.slice(33, 65));
  const signKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, d: privateD, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const verifyKey = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  // 개인 키가 공개 키와 짝인지 확인 (짝이 아니면 다른 사람이 보낸 요청)
  const probe = te.encode('ours-key-check');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, probe);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, probe);
  if (!ok) throw new Error('key mismatch');
  return signKey;
}
async function vapidAuth(signKey, endpoint, subject) {
  const header = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const unsigned = header + '.' + claims;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, te.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${VAPID_PUBLIC}`;
}

/* ---------- 내용 암호화 (RFC 8291, aes128gcm) ---------- */
async function encryptPayload(p256dh, authSecret, plaintext) {
  const uaPublic = fromB64u(p256dh), auth = fromB64u(authSecret);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(te.encode(plaintext), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPublic.length;
  return concat(head, asPublic, cipher);
}
async function sendPush(signKey, subject, sub, message) {
  const body = await encryptPayload(sub.keys.p256dh, sub.keys.auth, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Urgency: 'normal',
      Authorization: await vapidAuth(signKey, sub.endpoint, subject)
    },
    body
  });
  return res.status;
}

/* ---------- 날짜와 말투 ---------- */
const KST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function kstParts(ms) { const p = {}; for (const x of KST.formatToParts(new Date(ms))) p[x.type] = x.value; return { key: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) }; }
const dayNum = key => { const [y, m, d] = key.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86400000); };
const md = key => { const [, m, d] = key.split('-').map(Number); return `${m}월 ${d}일`; };
const weekday = key => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
function ga(w) {
  const ch = String(w).trim().slice(-1); const c = ch.charCodeAt(0);
  if (c >= 0xAC00 && c <= 0xD7A3) return (c - 0xAC00) % 28 !== 0 ? '이' : '가';
  if (/[0-9]/.test(ch)) return '013678'.includes(ch) ? '이' : '가';
  return /[a-z]/i.test(ch) && !/[aeiouy]/i.test(ch) ? '이' : '가';
}
const ieyo = w => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 === 0 ? '예요' : '이에요'; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const sameMD = (a, b) => a.slice(5) === b.slice(5);
function birthdayKeyFor(bday, year) { // 'YYYY-MM-DD' 또는 'MM-DD' → 그 해의 생일
  if (!bday) return null;
  let mmdd = bday.length === 5 ? bday : bday.slice(5);
  if (mmdd === '02-29' && !((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) mmdd = '02-28';
  return `${year}-${mmdd}`;
}

/* ---------- 어떤 알림을 누구에게 ---------- */
function people(p) {
  const map = {};
  for (const pr of p.profiles || []) if (pr && pr.uid) map[pr.uid] = pr;
  return map;
}
const nick = (map, uid) => (map[uid] && map[uid].nickname) || '상대';
const prefsOf = (map, uid) => Object.assign({}, DEFAULT_PREFS, (map[uid] && map[uid].notify) || {});

const PET_STAGE = ['새끼', '아성체', '성체'];
function petgrowMessages(p) { // 둘 다 답한 질문이 15개·45개가 되는 순간
  const stage = Number(p.stage) || 1, opened = Number(p.opened) || 0;
  const pet = clip(p.name || '토끼', 12), dragon = p.fur === 'dragon';
  const body = `${pet}${ga(pet)} ${PET_STAGE[stage] || '성체'}가 됐어요!${opened ? ` 토끼캡슐 편지 ${opened}통이 열렸어요 💌` : stage === 2 ? ' 둘이 함께 답한 덕분이에요 ♥' : ''}`;
  return Object.keys(people(p)).map(u => ({ to: u, cat: 'qa', title: dragon ? '드래곤이 자랐어요 🐉' : '토끼가 자랐어요 🐰', body, url: opened ? './#letters' : './#rabbit', tag: 'petgrow-' + stage }));
}

function changeMessages(p) {
  const map = people(p); const d = p.data || {}; const col = p.col;
  const actor = d.author || d.uid; const name = nick(map, actor); const j = ga(name);
  const others = Object.keys(map).filter(u => u !== actor);
  const to = list => list.filter(Boolean);
  const men = Array.isArray(d.mentions) ? d.mentions : [];
  switch (col) {
    case 'posts': return others.map(u => ({ to: u, cat: 'post', title: 'ours', body: men.includes(u) ? `${name}${j} 게시물에서 나를 언급했어요${d.caption ? ' · ' + clip(d.caption, 40) : ''}` : `${name}${j} 새 사진을 올렸어요${d.caption ? ' · ' + clip(d.caption, 40) : ''}`, url: './#home', tag: 'post-' + actor }));
    case 'stories': return others.map(u => ({ to: u, cat: 'post', title: 'ours', body: men.includes(u) ? `${name}${j} 스토리에서 나를 언급했어요` : `${name}${j} 스토리를 올렸어요`, url: './#home', tag: 'story-' + actor }));
    case 'comments': {
      const title = d.storyId ? (d.parentId ? '스토리 답장에 답글' : '스토리 답장') : d.parentId ? '새 답글' : '새 댓글';
      const who = d.storyId && !d.parentId && d.storyAuthor ? [d.storyAuthor] : d.parentId && d.replyTo ? [d.replyTo] : others;
      return [...new Set(to([...who, ...men]))].filter(u => u !== actor).map(u => ({ to: u, cat: 'comment', title: men.includes(u) ? '나를 언급했어요' : title, body: `${name}: ${clip(d.text, 60)}`, url: './#home', tag: 'comment-' + (d.postId || d.storyId || '') }));
    }
    case 'likes': case 'storylikes': {
      // here d.author is the owner of the photo; the person who tapped the heart is d.uid
      const liker = d.uid, ln = nick(map, liker), lj = ga(ln);
      const owners = to(d.author ? [d.author] : Object.keys(map)).filter(u => u !== liker);
      return owners.map(u => ({ to: u, cat: 'like', title: 'ours', body: col === 'likes' ? `${ln}${lj} 내 사진을 좋아해요 ♥` : `${ln}${lj} 내 스토리에 하트를 보냈어요 ♥`, url: './#home', tag: (col === 'likes' ? 'like-' + (d.postId || '') : 'storylike-' + (d.storyId || '')) }));
    }
    case 'answers': return others.map(u => ({ to: u, cat: 'qa', title: '오늘의 질문', body: `${name}${j} 질문에 답했어요. 내 답을 쓰면 볼 수 있어요`, url: './#question', tag: 'answer-' + (d.date || '') }));
    case 'drawings': return others.map(u => ({ to: u, cat: 'qa', title: '오늘의 그림', body: `${name}${j} 그림을 그렸어요. 내 그림을 올리면 볼 수 있어요`, url: './#drawing', tag: 'drawing-' + (d.date || '') }));
    case 'letters': {
      const when = d.openStage ? `토끼가 ${PET_STAGE[d.openStage] || '다음 단계'}가 되면 열려요` : d.openAt ? md(d.openAt) + '에 열려요' : '';
      return to([d.to]).filter(u => u !== actor).map(u => ({ to: u, cat: 'dates', title: d.openStage ? '토끼캡슐 편지' : '타임캡슐 편지', body: `${name}${j} 편지를 남겼어요. ${when}`.trim(), url: './#letters', tag: 'letter-' + (d.openStage ? 'pet' + d.openStage : d.openAt || '') }));
    }
    case 'plans': { // who: 'us' = 우리 약속, 아니면 그 사람의 일정
      const who = d.who && d.who !== 'us' ? d.who : 'us';
      return others.map(u => {
        const what = who === 'us' ? '약속' : who === u ? '내 일정' : who === actor ? '일정' : nick(map, who) + ' 일정';
        return { to: u, cat: 'dates', title: who === 'us' ? '새 약속' : '새 일정', body: `${name}${j} ${what}을 추가했어요: ${clip(d.title, 30)}${d.date ? ' (' + md(d.date) + ')' : ''}`, url: './#calendar', tag: 'plan-' + (p.path || d.date || '') };
      });
    }
    case 'pings': return to([d.to]).map(u => ({ to: u, cat: 'test', title: 'ours', body: '알림이 잘 와요! 이제 소식을 놓치지 않을 거예요 ♥', url: './#profile', tag: 'ping' }));
    default: return [];
  }
}

function anniversariesOn(key, p, map) {
  const out = [];
  const start = p.couple && p.couple.startDate;
  if (start && key >= start) {
    const n = dayNum(key) - dayNum(start) + 1;
    if (n > 1 && n % 100 === 0) out.push(`우리 ${n}일`);
    const years = Number(key.slice(0, 4)) - Number(start.slice(0, 4));
    if (years > 0 && sameMD(key, start)) out.push(`우리 ${years}주년`);
  }
  for (const a of p.anniversaries || []) {
    if (!a || !a.date || !a.title) continue;
    if (a.date === key || (a.yearly && key > a.date && sameMD(key, a.date))) out.push(clip(a.title, 30));
  }
  return out;
}

function tickMessages(p, nowMs) {
  const map = people(p); const now = kstParts(nowMs);
  const today = now.key, tomorrow = kstParts(nowMs + 86400000).key;
  const msgs = [];
  for (const uid of Object.keys(map)) {
    const pr = prefsOf(map, uid);
    if (Number(pr.hour) !== now.hour) continue;
    if (pr.daily) {
      const friday = weekday(today) === 5;
      msgs.push({ to: uid, cat: 'daily', title: friday ? '금요일은 우리만의 질문!' : '오늘의 질문 도착', body: friday ? '우리가 직접 만든 질문이 열렸어요. 답을 남겨 보세요' : '오늘의 질문이 도착했어요. 답을 쓰면 상대의 답도 열려요', url: './#question', tag: 'daily-' + today });
    }
    for (const t of anniversariesOn(today, p, map)) msgs.push({ to: uid, cat: 'dates', title: '오늘은 기념일', body: `오늘은 ${t}${ieyo(t)}! 축하해요 ♥`, url: './#calendar', tag: 'anniv-' + today });
    for (const t of anniversariesOn(tomorrow, p, map)) msgs.push({ to: uid, cat: 'dates', title: '내일은 기념일', body: `내일은 ${t}${ieyo(t)}. 준비됐나요?`, url: './#calendar', tag: 'anniv-' + tomorrow });
    for (const other of Object.keys(map)) {
      if (other === uid || !map[other].birthday) continue;
      const nm = nick(map, other);
      if (birthdayKeyFor(map[other].birthday, Number(today.slice(0, 4))) === today) msgs.push({ to: uid, cat: 'dates', title: '생일', body: `오늘은 ${nm} 생일이에요! 축하해 주세요`, url: './#calendar', tag: 'bday-' + today });
      if (birthdayKeyFor(map[other].birthday, Number(tomorrow.slice(0, 4))) === tomorrow) msgs.push({ to: uid, cat: 'dates', title: '생일', body: `내일은 ${nm} 생일이에요`, url: './#calendar', tag: 'bday-' + tomorrow });
    }
    // 하루에 일정이 여러 개면 한 알림에 모아서 보내요 (같은 tag라 따로 보내면 마지막 것만 남아요)
    for (const [key, word] of [[today, '오늘'], [tomorrow, '내일']]) {
      const list = (p.plans || []).filter(pl => pl && pl.date === key && pl.title)
        .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
      if (!list.length) continue;
      const line = pl => {
        const who = pl.who && pl.who !== 'us' ? pl.who : 'us';
        const tag = who === 'us' ? '' : who === uid ? '[내 일정] ' : `[${nick(map, who)}] `;
        const when = [pl.time ? pl.time + (pl.endTime ? '~' + pl.endTime : '') : '', pl.place].filter(Boolean).join(' · ');
        return `${tag}${clip(pl.title, 30)}${when ? ' (' + when + ')' : ''}`;
      };
      const allUs = list.every(pl => !pl.who || pl.who === 'us');
      const title = list.length > 1 ? `${word} 일정 ${list.length}개` : `${word} ${allUs ? '약속' : '일정'}`;
      msgs.push({ to: uid, cat: 'dates', title, body: list.map(line).join('\n'), url: './#calendar', tag: 'plan-' + key });
    }
    for (const lt of p.letters || []) {
      if (lt && lt.openAt === today && lt.to === uid) msgs.push({ to: uid, cat: 'dates', title: '편지가 열렸어요', body: `${nick(map, lt.author)}의 타임캡슐 편지가 오늘 열렸어요`, url: './#letters', tag: 'letter-open-' + today });
    }
  }
  return msgs;
}

/* ---------- 요청 처리 ---------- */
async function handler(req) {
  if (req.method !== 'POST') return new Response('ours-push is running');
  let p;
  try { p = await req.json(); } catch (_) { return new Response('bad json', { status: 400 }); }
  let signKey;
  try { signKey = await importVapid(p.vapidPrivate, VAPID_PUBLIC); }
  catch (_) { return new Response('forbidden', { status: 403 }); }
  const map = people(p);
  const msgs = p.type === 'tick' ? tickMessages(p, Date.now()) : p.type === 'petgrow' ? petgrowMessages(p) : (p.data && p.data.src === 'someone') ? [] : changeMessages(p); // 썸원에서 가져온 기록은 알림 없음
  const fresh = Date.now() - 120 * 86400000;
  const subs = (p.subs || []).filter(s => s && s.uid && s.endpoint && s.keys && s.keys.p256dh && s.keys.auth && (s.updatedAt || 0) > fresh);
  const jobs = [];
  for (const m of msgs) {
    if (m.cat !== 'test' && !prefsOf(map, m.to)[m.cat]) continue;
    const message = { title: m.title, body: m.body, url: m.url, tag: m.tag };
    for (const s of subs.filter(x => x.uid === m.to)) {
      jobs.push(sendPush(signKey, p.subject || 'https://antongtong-729.github.io', s, message).then(status => ({ status, endpoint: s.endpoint })).catch(e => ({ status: 0, error: String(e), endpoint: s.endpoint })));
    }
  }
  const results = await Promise.all(jobs);
  return Response.json({ messages: msgs.length, sent: results.filter(r => r.status >= 200 && r.status < 300).length, results: results.map(r => ({ status: r.status, error: r.error, host: (() => { try { return new URL(r.endpoint).host; } catch (_) { return ''; } })() })) });
}

if (typeof Deno !== 'undefined') Deno.serve(handler);
export { handler, encryptPayload, vapidAuth, importVapid, changeMessages, tickMessages, petgrowMessages };
