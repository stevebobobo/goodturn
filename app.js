// 好轉燈：龍頭手機（遙控）與車尾手機（方向燈）透過 MQTT 互傳狀態。
// 主題：goodturn/v1/<4位數>/state（龍頭→車尾，retain）、/alert（車尾→龍頭，AI 來車）、/hb/ctrl、/hb/tail（心跳）；/cfg（龍頭→車尾：聲音模式、AI 開關）、/note（車尾→龍頭：錯誤提示）
'use strict';

const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const NS = 'goodturn/v1/';
const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const SSD_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('gt.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('gt.' + k, JSON.stringify(v)); } catch (e) {} },
};
function show(id) { for (const s of document.querySelectorAll('body>section')) s.hidden = s.id !== id; }
let toastT;
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }

// ── 手機能力：語音、震動、螢幕常亮、全螢幕 ─────────────────────────
let lastSpeak = 0, speaking = false, sayId = 0;
// 講話時先關麥克風，講完再開，避免聲控聽到自己的提示語
function say(text) {
  try {
    const id = ++sayId;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW'; u.rate = 1.1;
    u.onend = u.onerror = () => { if (id !== sayId) return; speaking = false; lastSpeak = Date.now(); voiceResume(); };
    speechSynthesis.cancel();
    speaking = true; lastSpeak = Date.now(); voicePause();
    speechSynthesis.speak(u);
  } catch (e) { speaking = false; }
}
function buzz(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} }
let wakeWanted = false;
async function keepAwake() { wakeWanted = true; try { await navigator.wakeLock.request('screen'); } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wakeWanted) keepAwake(); });
function fullscreen() {
  const el = document.documentElement;
  try { const p = (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
function gate(text, fn) {
  $('#gateTxt').textContent = text; $('#gate').hidden = false;
  $('#gateBtn').onclick = async () => { $('#gate').hidden = true; await fn(); };
}

// ── MQTT 連線（連不上就換下一台 broker） ──────────────────────────
function makeLink(code, onMsg, onStatus) {
  let client = null, i = 0;
  const base = NS + code + '/';
  function connect() {
    const url = BROKERS[i++ % BROKERS.length];
    onStatus('connecting');
    const c = mqtt.connect(url, {
      clientId: 'gt-' + Math.random().toString(16).slice(2, 10),
      reconnectPeriod: 0, connectTimeout: 6000, clean: true, keepalive: 20,
    });
    client = c;
    let closed = false;
    c.on('connect', () => { onStatus('online'); c.subscribe(base + '#'); });
    c.on('message', (t, b) => {
      let d; try { d = JSON.parse(b.toString()); } catch (e) { return; }
      onMsg(t.slice(base.length), d);
    });
    c.on('close', () => {
      if (closed) return; closed = true;
      if (client === c) client = null;
      onStatus('offline');
      try { c.end(true); } catch (e) {}
      setTimeout(connect, 2000);
    });
    c.on('error', () => {});
  }
  connect();
  return {
    pub(sub, obj, retain) { if (client && client.connected) client.publish(base + sub, JSON.stringify(obj), { qos: 0, retain: !!retain }); },
    get online() { return !!(client && client.connected); },
  };
}

// ── 首頁 ────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
function home() {
  show('home');
  const last = store.get('last', null);
  const r = $('#resume');
  if (last && /^\d{4}$/.test(last.code)) {
    r.hidden = false;
    r.innerHTML = '';
    r.append(`繼續上次：${last.role === 'ctrl' ? '龍頭' : '車尾'}　${last.code}`);
    const s = document.createElement('small'); s.textContent = '同一組手機不用重新配對'; r.append(s);
    r.onclick = () => last.role === 'ctrl' ? startCtrl(last.code) : startTail(last.code);
  } else r.hidden = true;
}
$('#goCtrl').onclick = () => openPair();
$('#goTail').onclick = () => startTail(store.get('tailCode', null) || String(1000 + Math.floor(Math.random() * 9000)));

// ── 配對鍵盤 ────────────────────────────────────────────────────
let entry = '';
function openPair() {
  entry = ''; renderDigits(); show('pair');
}
function renderDigits() { [...document.querySelectorAll('#digits span')].forEach((s, i) => s.textContent = entry[i] || ''); }
(function buildKeys() {
  const k = $('#keys');
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '清除', '0', '←'].forEach(t => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = t;
    if (t.length > 1) b.style.fontSize = '1.1rem';
    b.onclick = () => {
      if (t === '清除') entry = '';
      else if (t === '←') entry = entry.slice(0, -1);
      else if (entry.length < 4) entry += t;
      renderDigits();
      if (entry.length === 4) setTimeout(() => startCtrl(entry), 200);
    };
    k.append(b);
  });
})();
$('#pairBack').onclick = home;

// ═══ 龍頭手機 ═══════════════════════════════════════════════════
const C = { state: 'off', code: '', link: null, tailSeen: 0, auto: true, voice: false, rec: null,
  head: null, base: null, maxD: 0, lastD: 0, stableT: 0, onAt: 0, lastVoice: 0, blink: false };
const SAY = { left: '左轉', right: '右轉', hazard: '警示燈', off: '關燈' };
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

function startCtrl(code) {
  C.code = code;
  store.set('last', { role: 'ctrl', code });
  show('ctrl');
  gate('龍頭手機會用到震動、語音提示和指南針（轉完彎自動關燈）。按下開始後，請把手機固定在龍頭上。', async () => {
    fullscreen(); keepAwake();
    try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission(); } catch (e) {}
    const ev = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(ev, e => {
      const h = e.webkitCompassHeading != null ? e.webkitCompassHeading : e.alpha;
      if (h != null) C.head = h;
    });
    say('好轉燈已啟動');
    if (!C.link) C.link = makeLink(code, onCtrlMsg, s => { C.net = s; renderCtrl(); });
  });
  renderCtrl();
}

function setState(s, why) {
  C.state = s; C.onAt = Date.now(); C.base = C.head; C.maxD = 0; C.lastD = 0; C.stableT = 0;
  if (C.link) C.link.pub('state', { s, t: Date.now() }, true);
  buzz({ left: [90], right: [90, 80, 90], hazard: [300], off: [40] }[s]);
  say(why === 'auto' ? '方向燈已自動關閉' : SAY[s]);
  renderCtrl();
}

function renderCtrl() {
  const L = $('#padL'), R = $('#padR'), s = C.state;
  const lOn = s === 'left' || s === 'hazard', rOn = s === 'right' || s === 'hazard';
  L.classList.toggle('on', lOn); R.classList.toggle('on', rOn);
  L.classList.toggle('blink', lOn && C.blink); R.classList.toggle('blink', rOn && C.blink);
  L.classList.toggle('hz', s === 'hazard'); R.classList.toggle('hz', s === 'hazard');
  const dot = $('#cDot'), lk = $('#cLink');
  if (C.net !== 'online') { dot.className = 'dot wait'; lk.textContent = '連線中…'; }
  else if (!tailOk()) { dot.className = 'dot bad'; lk.textContent = `找不到車尾手機（${C.code}）`; }
  else { dot.className = 'dot ok'; lk.textContent = `車尾燈已連線（${C.code}）`; }
  $('#aBtn').classList.toggle('act', C.auto);
  $('#vBtn').classList.toggle('act', C.voice);
  $('#vBtn').textContent = C.voice ? '聲控：開' : '聲控';
  $('#tsBtn').textContent = '車尾聲音：' + (C.tsnd ? SND_NAME[C.tsnd] : '—');
  $('#tAiBtn').textContent = '來車偵測：' + ({ on: '開', loading: '啟動中…', off: '關' }[C.tai]);
  $('#tAiBtn').classList.toggle('act', C.tai === 'on');
  $('#tsBtn').classList.toggle('act', C.tsnd && C.tsnd !== 'mute');
}

// 點一下切換、長按＝警示燈
function bindPad(el, side) {
  let t = null, long = false;
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); long = false;
    t = setTimeout(() => { long = true; setState(C.state === 'hazard' ? 'off' : 'hazard'); }, 700);
  });
  const up = () => {
    if (t === null) return;
    clearTimeout(t); t = null;
    if (!long) setState(C.state === side ? 'off' : side);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', () => { clearTimeout(t); t = null; });
  el.addEventListener('contextmenu', e => e.preventDefault());
}
bindPad($('#padL'), 'left');
bindPad($('#padR'), 'right');
$('#aBtn').onclick = () => { C.auto = !C.auto; say(C.auto ? '自動關燈開啟' : '自動關燈關閉'); renderCtrl(); };
$('#vBtn').onclick = () => { C.voice ? stopVoice() : startVoice(); renderCtrl(); };
$('#cExit').onclick = () => { if (C.link) C.link.pub('state', { s: 'off', t: Date.now() }, true); setTimeout(() => location.href = location.pathname, 300); };

// 遠端設定車尾：聲音模式、AI 來車偵測
C.tsnd = null; C.tai = 'off';
const tailOk = () => Date.now() - C.tailSeen < 8000;
$('#tsBtn').onclick = () => {
  if (!tailOk() || !C.link) return say('找不到車尾手機');
  const n = SND[(SND.indexOf(C.tsnd || 'tick') + 1) % SND.length];
  C.tsnd = n; C.link.pub('cfg', { snd: n, t: Date.now() });
  say('車尾聲音，' + SND_NAME[n]); renderCtrl();
};
$('#tAiBtn').onclick = () => {
  if (!tailOk() || !C.link) return say('找不到車尾手機');
  const on = C.tai === 'off'; C.tai = on ? 'loading' : 'off';
  C.link.pub('cfg', { ai: on, t: Date.now() });
  say(on ? '開啟來車偵測' : '關閉來車偵測'); renderCtrl();
};

function onCtrlMsg(sub, d) {
  if (sub === 'hb/tail') {
    C.tailSeen = Date.now();
    if (SND.includes(d.snd)) C.tsnd = d.snd;
    if (['off', 'loading', 'on'].includes(d.ai)) C.tai = d.ai;
    return;
  }
  if (sub === 'note' && Date.now() - (d.t || 0) < 10000) { say(d.msg); toast(d.msg, 3500); return; }
  if (sub === 'alert' && Date.now() - (d.t || 0) < 5000) {
    buzz([400, 120, 400]);
    say(d.lvl > 1 ? '後方來車，很近' : '後方來車');
    const a = $('#cAlert'); a.hidden = false; clearTimeout(C.alertT); C.alertT = setTimeout(() => a.hidden = true, 2500);
  }
}

// 每 250 毫秒：閃爍、自動關燈判斷；每 3 秒送心跳
setInterval(() => {
  if ($('#ctrl').hidden) return;
  const blinking = C.state !== 'off';
  C.tick = (C.tick || 0) + 1;
  C.blink = blinking && (C.tick % 3 !== 0);
  if ((C.state === 'left' || C.state === 'right') && C.auto) {
    if (C.head != null) {
      if (C.base == null) C.base = C.head;
      const d = Math.abs(angDiff(C.head, C.base));
      C.maxD = Math.max(C.maxD, d);
      // 車頭轉超過 45 度，之後方向穩定 1.5 秒＝轉彎完成
      if (C.maxD >= 45) {
        if (Math.abs(d - C.lastD) < 3) { C.stableT += 250; if (C.stableT >= 1500) { setState('off', 'auto'); return; } }
        else C.stableT = 0;
      }
      C.lastD = d;
    }
    if (Date.now() - C.onAt > 30000) { setState('off', 'auto'); return; }
  }
  if (C.tick % 12 === 0 && C.link) C.link.pub('hb/ctrl', { t: Date.now() });
  // 聲控看門狗：語音播完卻沒收到結束事件，或麥克風停了沒重開，就補開
  if (C.voice) {
    if (speaking && !speechSynthesis.speaking && Date.now() - lastSpeak > 4000) { speaking = false; }
    if (!speaking && !C.recOn && Date.now() - Math.max(C.recEnd || 0, lastSpeak) > 1500) voiceListen();
  }
  renderCtrl();
}, 250);

// 語音指令：「左轉」「右轉」「取消／關燈」「警示」
// 取句子裡「最後出現」的指令詞，例如「左轉…不對右轉」→ 右轉
const CMD_WORDS = [[/取消|關|停|好了|結束/g, 'off'], [/警示|危險|雙黃|閃/g, 'hazard'], [/左/g, 'left'], [/右/g, 'right']];
function parseCmd(t) {
  let best = null, at = -1;
  for (const [re, cmd] of CMD_WORDS) for (const m of t.matchAll(re)) if (m.index > at) { at = m.index; best = cmd; }
  return best;
}
const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
function voicePause() {
  if (!C.voice) return;
  clearTimeout(C.vT);
  const r = C.rec; C.rec = null; C.recOn = false;   // 先解除關聯，舊辨識的結束事件就不會干擾
  try { r && r.abort(); } catch (e) {}
}
function voiceResume() { if (!C.voice) return; clearTimeout(C.vT); C.vT = setTimeout(voiceListen, 350); }
// 每次都開一個新的辨識，執行一個指令後就重來，避免 Android 把前後句黏在一起
function voiceListen() {
  if (!C.voice || speaking || C.recOn) return;
  const r = new SRClass();
  r.lang = 'zh-TW'; r.continuous = true; r.interimResults = true;
  r.onresult = e => {
    if (r !== C.rec || speaking) return;
    const cmd = parseCmd(e.results[e.results.length - 1][0].transcript);
    if (!cmd || cmd === C.state) return;
    C.lastVoice = Date.now();
    setState(cmd, 'voice');   // setState 會講話 → 自動關麥克風 → 講完開新的辨識
  };
  r.onend = () => { if (r === C.rec) { C.recOn = false; C.recEnd = Date.now(); if (!speaking) voiceResume(); } };
  r.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { C.voice = false; renderCtrl(); toast('沒有麥克風權限，聲控已關閉'); }
  };
  C.rec = r; C.recOn = true;
  try { r.start(); } catch (e) { C.rec = null; C.recOn = false; C.recEnd = Date.now(); }
}
function startVoice() {
  if (!SRClass) { toast('這支手機的瀏覽器不支援語音辨識，請改用 Chrome'); return; }
  C.voice = true; C.recOn = false;
  say('聲控開啟');   // 不含指令詞；講完才開始聽
}
function stopVoice() { C.voice = false; clearTimeout(C.vT); try { C.rec && C.rec.abort(); } catch (e) {} C.rec = null; C.recOn = false; say('聲控關閉'); }

// ═══ 車尾手機 ═══════════════════════════════════════════════════
const T = { state: 'off', code: '', link: null, ctrlSeen: 0, sound: true, ai: false, cam: false,
  phase: 0, ac: null, model: null, hist: [], lastAlert: 0, carLvl: 0, paired: false };

function startTail(code) {
  T.code = code;
  store.set('tailCode', code);
  store.set('last', { role: 'tail', code });
  $('#tBig').textContent = code;
  $('#tCode').innerHTML = '';
  $('#tCode').append('號碼 '); const b = document.createElement('b'); b.textContent = code; $('#tCode').append(b);
  show('tail');
  gate('車尾手機會保持螢幕常亮並發出方向燈聲。按下開始後，把手機橫放、螢幕朝後，固定在座墊下方。', async () => {
    fullscreen(); keepAwake();
    try { T.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) {}   // 在使用者點擊時先解鎖語音
    if (!T.link) T.link = makeLink(code, onTailMsg, s => { T.net = s; });
  });
}

function onTailMsg(sub, d) {
  if (sub === 'hb/ctrl') { T.ctrlSeen = Date.now(); paired(); return; }
  if (sub === 'cfg') {   // 龍頭遠端設定：聲音模式、AI 開關
    if (Date.now() - (d.t || 0) > 10000) return;
    if (SND.includes(d.snd) && d.snd !== T.snd) setSnd(d.snd);
    if (d.ai === true && !T.ai) startAI();
    if (d.ai === false && T.ai) stopAI();
    pubTailHb();
    return;
  }
  if (sub === 'state') {
    if (Date.now() - (d.t || 0) > 120000) return;   // 很久以前保留的狀態不採用
    if (!['left', 'right', 'hazard', 'off'].includes(d.s)) return;
    T.ctrlSeen = Date.now(); paired();
    if (d.s !== T.state) { T.state = d.s; T.phase = 0; T.lastSay = 0; }
  }
}
function paired() { if (!T.paired) { T.paired = true; $('#tPair').hidden = true; } }

// 方向燈聲音：答答（大聲滴答）／語音（腳踏車左轉、右轉）／嗶嗶（三連嗶）／關
const SND = ['tick', 'voice', 'bbb', 'mute'];
const SND_NAME = { tick: '答答', voice: '語音', bbb: '嗶嗶', mute: '關' };
const SND_SAY = { left: '腳踏車左轉', right: '腳踏車右轉', hazard: '腳踏車注意' };
T.snd = SND.includes(store.get('snd', 'tick')) ? store.get('snd', 'tick') : 'tick';
T.lastSay = 0;
function sndLabel() { $('#sBtn').textContent = '聲音：' + SND_NAME[T.snd]; $('#sBtn').classList.toggle('act', T.snd !== 'mute'); }

function tone(f, at, dur, type = 'square') {
  if (!T.ac) return;
  try {
    if (T.ac.state === 'suspended') T.ac.resume();
    const o = T.ac.createOscillator(), g = T.ac.createGain(), t = T.ac.currentTime + at;
    o.frequency.value = f; o.type = type;
    g.gain.setValueAtTime(1, t); g.gain.setValueAtTime(1, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(T.ac.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch (e) {}
}
// 每個流水循環的第 0 格與第 4 格呼叫一次
function turnSound(s, phase) {
  if (T.snd === 'tick') {
    if (phase === 0) { tone(1900, 0, 0.09); tone(950, 0, 0.09, 'triangle'); }
    if (phase === 4) { tone(1400, 0, 0.09); tone(700, 0, 0.09, 'triangle'); }
  } else if (T.snd === 'bbb') {
    if (phase === 0) { tone(2600, 0, 0.08); tone(2600, 0.13, 0.08); tone(2600, 0.26, 0.08); }
  } else if (T.snd === 'voice') {
    if (phase === 0 && Date.now() - T.lastSay > 2600) { T.lastSay = Date.now(); say(SND_SAY[s]); }
  }
}

// 流水箭頭：6 格一循環（約 660 毫秒，每分鐘 90 次），由內往外依序亮起
setInterval(() => {
  if ($('#tail').hidden) return;
  const s = T.state;
  const L = $('#arrowL'), R = $('#arrowR');
  // SVG 元素沒有 .hidden 屬性，要直接改 hidden 屬性標籤
  L.toggleAttribute('hidden', !(s === 'left' || s === 'hazard'));
  R.toggleAttribute('hidden', !(s === 'right' || s === 'hazard'));
  $('#pos').hidden = s !== 'off';
  const lit = T.phase < 3 ? T.phase + 1 : (T.phase === 3 ? 3 : 0);
  for (const svg of [L, R]) for (const p of svg.querySelectorAll('path')) p.classList.toggle('lit', +p.dataset.i < lit);
  if (s !== 'off') turnSound(s, T.phase);
  T.phase = (T.phase + 1) % 6;
  $('#tail').classList.toggle('warn', T.carLvl > 0);
  if (!T.paired) $('#tWait').textContent = T.net === 'online' ? '已連上網路，等待龍頭手機輸入號碼…' : '連線網路中…';
}, 110);
setInterval(() => { if (!$('#tail').hidden) pubTailHb(); }, 3000);

// 車尾心跳附帶目前設定，龍頭據此顯示按鈕狀態
function pubTailHb() { if (T.link) T.link.pub('hb/tail', { t: Date.now(), snd: T.snd, ai: T.aiState }); }
function setSnd(m) {
  T.snd = m; store.set('snd', m); sndLabel(); T.lastSay = 0;
  toast('方向燈聲音：' + SND_NAME[m]);
  if (m === 'tick') tone(1900, 0, 0.09); else if (m === 'bbb') { tone(2600, 0, 0.08); tone(2600, 0.13, 0.08); }
  else if (m === 'voice') say('腳踏車右轉');
  pubTailHb();
}
$('#sBtn').onclick = () => setSnd(SND[(SND.indexOf(T.snd) + 1) % SND.length]);
sndLabel();
$('#tExit').onclick = () => { location.href = location.pathname; };
// 跳出權限視窗等情況會退出全螢幕，點一下燈區就回到全螢幕
$('#tail .lamp').addEventListener('click', () => { if (!document.fullscreenElement) fullscreen(); });
$('#camBtn').onclick = () => { T.cam = !T.cam; $('#cam').hidden = !T.cam; $('#camBtn').classList.toggle('act', T.cam); };
$('#aiBtn').onclick = () => { T.ai ? stopAI() : startAI(); };

// ── AI 後方來車偵測：前鏡頭（和螢幕同一面，朝後）＋ COCO-SSD 物件辨識 ──
function loadScript(src) {
  return new Promise((ok, bad) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('載入失敗 ' + src));
    document.head.append(s);
  });
}
T.aiState = 'off';   // off／loading／on
async function startAI() {
  T.ai = true; T.aiState = 'loading'; pubTailHb();
  $('#aiBtn').classList.add('act'); $('#aiBtn').textContent = 'AI 載入中…';
  $('#camBtn').hidden = false; $('#camLbl').textContent = 'AI 載入中…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    if (!T.ai) { stream.getTracks().forEach(t => t.stop()); return; }   // 等權限時已被關掉
    const v = $('#video'); v.srcObject = stream; await v.play();
    await loadScript(TF_URL); await loadScript(SSD_URL);
    if (!T.model) T.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    if (!T.ai) return;   // 載入期間被關掉
    T.aiState = 'on'; pubTailHb();
    $('#aiBtn').textContent = 'AI 偵測中';
    loopAI();
  } catch (e) {
    const why = e.name === 'NotAllowedError' ? '車尾手機沒有相機權限' : '來車偵測載入失敗';
    toast('AI 無法啟動：' + why, 3500);
    if (T.link) T.link.pub('note', { msg: why, t: Date.now() });
    stopAI();
  }
}
function stopAI() {
  T.ai = false; T.carLvl = 0; T.aiState = 'off'; pubTailHb();
  $('#aiBtn').classList.remove('act'); $('#aiBtn').textContent = 'AI 來車偵測';
  const v = $('#video'); if (v.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; }
  $('#cam').hidden = true; $('#camBtn').hidden = true; T.cam = false;
}
const VEH = new Set(['car', 'truck', 'bus', 'motorcycle']);
const ZH = { car: '汽車', truck: '卡車', bus: '公車', motorcycle: '機車', bicycle: '腳踏車', person: '人' };
async function loopAI() {
  if (!T.ai) return;
  const v = $('#video');
  try { if (v.readyState >= 2) handlePreds(await T.model.detect(v, 8, 0.45), v.videoWidth, v.videoHeight); } catch (e) {}
  setTimeout(loopAI, 200);
}
// 判斷規則：車輛框占畫面比例 1.5 秒內變大 30% 以上＝正在靠近；占 22% 以上＝很近
function handlePreds(preds, W, H) {
  let best = 0, name = '';
  for (const p of preds) {
    if (!VEH.has(p.class)) continue;
    const a = (p.bbox[2] * p.bbox[3]) / (W * H);
    if (a > best) { best = a; name = p.class; }
  }
  const now = Date.now();
  T.hist.push({ t: now, a: best });
  T.hist = T.hist.filter(h => now - h.t < 1500);
  const old = T.hist[0];
  const growing = old && best > 0.05 && best > old.a * 1.3;
  T.carLvl = best > 0.22 ? 2 : (growing ? 1 : 0);
  if (T.carLvl && now - T.lastAlert > 4000) {
    T.lastAlert = now;
    if (T.link) T.link.pub('alert', { lvl: T.carLvl, t: now });
  }
  $('#camLbl').textContent = best ? `${ZH[name] || name} 占畫面 ${Math.round(best * 100)}%${T.carLvl === 2 ? '・很近' : T.carLvl ? '・靠近中' : ''}` : 'AI 偵測中・後方沒有車';
  if (T.cam) drawBoxes(preds, W, H);
}
function drawBoxes(preds, W, H) {
  const c = $('#boxes'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.clearRect(0, 0, W, H);
  g.lineWidth = 4; g.font = 'bold 22px sans-serif';
  for (const p of preds) {
    const [x, y, w, h] = p.bbox, mx = W - x - w;   // 畫面左右鏡射，框也跟著鏡射
    const veh = VEH.has(p.class);
    g.strokeStyle = veh ? '#ff2a1a' : '#3ddc84'; g.fillStyle = g.strokeStyle;
    g.strokeRect(mx, y, w, h);
    g.fillText(`${ZH[p.class] || p.class} ${Math.round(p.score * 100)}%`, mx + 4, Math.max(22, y - 6));
  }
}

// ── 啟動 ────────────────────────────────────────────────────────
if (/^\d{4}$/.test(params.get('code') || '')) {
  params.get('role') === 'tail' ? startTail(params.get('code')) : startCtrl(params.get('code'));
} else home();
