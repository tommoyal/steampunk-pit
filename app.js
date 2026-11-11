'use strict';
/* =====================================================================
   1577 STEAMPUNK PIT APP
   Live stream + our matches + queue timer + checklist + batteries +
   debrief + rankings. TV mode for the pit, phone mode for members.
   Data: The Blue Alliance (schedule/results/rankings/webcasts),
         Nexus for FRC (live queue times), Statbotics (predictions).
   Shared team data: Firebase Firestore (optional) or this device only.
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }
};
const safeId = s => String(s).replace(/[\/.#\[\]$\s]/g, '_');

/* ---------------- settings (per device) ---------------- */
const DEFAULT_CHECKLIST = [
  'Battery installed & strapped down',
  'Bumpers on — correct color',
  'Radio powered & linked',
  'Latest code deployed',
  'All mechanisms tested in pit',
  'Swerve modules & bolts checked',
  'Spare battery + tools packed for queue'
];
const seasonYear = () => { const d = new Date(); return d.getMonth() >= 8 ? d.getFullYear() + 1 : d.getFullYear(); };
const S = Object.assign({
  team: 1577, year: seasonYear(), eventKey: '', tbaKey: '', nexusKey: '', firebase: '',
  queueLead: 20, alertLead: 5, chargeMin: 45, sound: true, notify: false,
  streamUrl: '', streamIdx: 0, streamCollapsed: false, demo: true, tv: false, member: '',
  checklist: DEFAULT_CHECKLIST, roster: [],
  ntfyOn: true, ntfySend: null, ntfyServer: 'https://ntfy.sh', ntfyTeam: '', ntfyQueue: '', ntfyMe: ''
}, LS.get('pit.settings', {}));
const saveSettings = () => LS.set('pit.settings', S);
const SHARE_KEYS = ['team', 'year', 'eventKey', 'tbaKey', 'nexusKey', 'firebase', 'queueLead', 'alertLead', 'chargeMin', 'streamUrl', 'demo', 'checklist', 'roster', 'ntfyOn', 'ntfyServer', 'ntfyTeam', 'ntfyQueue'];
const evKey = () => S.demo ? 'demo' : String(S.eventKey || '').trim().toLowerCase();

/* ---------------- formatting ---------------- */
const hm = ts => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
function fmtCD(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
}
function fmtEl(ms) { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`; }
const shortLabel = l => String(l || '').replace('Qualification ', 'Q').replace('Qual ', 'Q').replace('Playoff ', 'P').replace('Final ', 'F').replace('Practice ', 'PR');
const pct = p => `${Math.round(p * 100)}%`;

/* ---------------- event data (cached per device for offline) ---------------- */
const emptyData = () => ({ eventKey: evKey(), event: null, teams: {}, matches: [], rankings: null, nexus: null, sb: { matches: {}, teams: {} }, updated: {}, errors: {} });
let D = LS.get('pit.cache', null);
if (!D || D.eventKey !== evKey()) D = emptyData();
const saveCache = () => { if (!S.demo) LS.set('pit.cache', D); };

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers, cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText || ''}`.trim());
  return r.json();
}
const tba = p => getJSON('https://www.thebluealliance.com/api/v3' + p, { 'X-TBA-Auth-Key': S.tbaKey.trim() });
const sbApi = p => getJSON('https://api.statbotics.io/v3' + p);
const nexusApi = ev => getJSON('https://frc.nexus/api/v1/event/' + ev, { 'Nexus-Api-Key': S.nexusKey.trim() });

const LEVEL = { pm: 0, qm: 1, ef: 2, qf: 3, sf: 4, f: 5 };
function matchLabel(l, s, n) {
  if (l === 'qm') return 'Qual ' + n;
  if (l === 'sf') return 'Playoff ' + s + (n > 1 ? '-' + n : '');
  if (l === 'f') return 'Final ' + n;
  if (l === 'qf') return `QF ${s}-${n}`;
  if (l === 'ef') return `EF ${s}-${n}`;
  return `${l} ${n}`;
}
function normTBA(m) {
  const red = m.alliances.red.team_keys.map(k => +k.slice(3));
  const blue = m.alliances.blue.team_keys.map(k => +k.slice(3));
  const rs = m.alliances.red.score, bs = m.alliances.blue.score;
  return {
    key: m.key, level: m.comp_level, num: m.match_number, set: m.set_number,
    label: matchLabel(m.comp_level, m.set_number, m.match_number), red, blue, rs, bs,
    winner: m.winning_alliance, played: rs != null && bs != null && rs >= 0 && bs >= 0,
    sched: m.time ? m.time * 1000 : null, pred: m.predicted_time ? m.predicted_time * 1000 : null,
    actual: m.actual_time ? m.actual_time * 1000 : null,
    bd: m.score_breakdown ? { red: pickBreakdown(m.score_breakdown.red), blue: pickBreakdown(m.score_breakdown.blue) } : null,
    videos: (m.videos || []).filter(v => v.type === 'youtube').map(v => v.key),
    order: (LEVEL[m.comp_level] ?? 9) * 10000 + m.set_number * 100 + m.match_number
  };
}
function pickBreakdown(b) {
  if (!b) return null;
  const find = re => { const k = Object.keys(b).find(k => re.test(k) && typeof b[k] === 'number'); return k ? b[k] : null; };
  return { auto: find(/^autoPoints$/i), teleop: find(/^teleopPoints$/i), endgame: find(/^end ?game.*points$/i),
    fouls: find(/^foulPoints$/i), rp: find(/^rp$/i) };
}
function normRankings(r) {
  if (!r || !r.rankings) return null;
  const info = r.sort_order_info || [], extra = r.extra_stats_info || [];
  return {
    rsName: info[0]?.name || 'Ranking Score', rsPrec: info[0]?.precision ?? 2, extraName: extra[0]?.name || null,
    rows: r.rankings.map(x => ({
      rank: x.rank, team: +x.team_key.slice(3), w: x.record?.wins ?? 0, l: x.record?.losses ?? 0, t: x.record?.ties ?? 0,
      rs: x.sort_orders?.[0], played: x.matches_played, extra: x.extra_stats?.[0]
    }))
  };
}

async function refreshTBA() {
  if (!S.tbaKey.trim()) { D.errors.tba = 'Add your TBA read key in Settings to load the schedule.'; return; }
  if (!evKey()) { D.errors.tba = 'Pick your event in Settings.'; return; }
  try {
    const ev = evKey();
    const [event, matches, teams, rankings] = await Promise.all([
      tba(`/event/${ev}`), tba(`/event/${ev}/matches`), tba(`/event/${ev}/teams/simple`), tba(`/event/${ev}/rankings`).catch(() => null)
    ]);
    D.event = { key: event.key, name: event.short_name || event.name, fullName: event.name, start: event.start_date, end: event.end_date, webcasts: event.webcasts || [] };
    D.teams = Object.fromEntries((teams || []).map(t => [t.team_number, t.nickname]));
    D.matches = (matches || []).map(normTBA);
    D.rankings = normRankings(rankings);
    D.updated.tba = Date.now(); delete D.errors.tba;
  } catch (e) { D.errors.tba = `The Blue Alliance: ${e.message}`; }
}
async function refreshNexus() {
  if (!S.nexusKey.trim() || !evKey()) return;
  try {
    const n = await nexusApi(evKey());
    D.nexus = {
      asOf: n.dataAsOfTime, nowQueuing: n.nowQueuing,
      matches: (n.matches || []).map(x => ({
        label: x.label, status: x.status || null,
        red: (x.redTeams || []).map(Number).filter(Boolean), blue: (x.blueTeams || []).map(Number).filter(Boolean),
        t: x.times || {}
      })),
      announcements: n.announcements || []
    };
    D.updated.nexus = Date.now(); delete D.errors.nexus;
  } catch (e) { D.errors.nexus = `Nexus: ${e.message}`; }
}
async function refreshSB() {
  if (!evKey()) return;
  try {
    const [ms, ts] = await Promise.all([
      sbApi(`/matches?event=${evKey()}&limit=1000`), sbApi(`/team_events?event=${evKey()}&limit=200`)
    ]);
    D.sb.matches = Object.fromEntries((ms || []).map(m => [m.key, { redWin: m.pred?.red_win_prob ?? null, redScore: m.pred?.red_score ?? null, blueScore: m.pred?.blue_score ?? null }]));
    D.sb.teams = Object.fromEntries((ts || []).map(t => [Number(t.team), { epa: t.epa?.total_points?.mean ?? t.epa?.mean ?? null }]));
    D.updated.sb = Date.now(); delete D.errors.sb;
  } catch (e) { D.errors.sb = `Statbotics: ${e.message}`; }
}

/* ---------------- demo event (so the app can be tried any time) ---------------- */
function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const DEMO_TEAMS = [1577, 1690, 2231, 1574, 3339, 4590, 5654, 1937, 2630, 3075, 4338, 1942, 5990, 6738, 7039, 4744, 3083, 2212, 5951, 8175, 6230, 1943, 3211, 4661];
function demoData() {
  const t = Date.now();
  let base = LS.get('pit.demoBase', 0);
  if (!base || t - base > 6 * 3600e3 || base > t) { base = t - 50 * 60000; LS.set('pit.demoBase', base); }
  const r = rng(1577), others = DEMO_TEAMS.filter(x => x !== 1577), gap = 7 * 60000;
  const matches = [], sbm = {};
  for (let i = 1; i <= 54; i++) {
    const pool = others.map(n => [r(), n]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const six = pool.slice(0, 6);
    if (i % 6 === 3) six[i % 4 === 1 ? 1 : 4] = 1577;
    const red = six.slice(0, 3), blue = six.slice(3);
    const sched = base + (i - 1) * gap, start = sched + Math.min(i, 25) * 24000;
    const played = start + 3 * 60000 < t;
    const a = 55 + Math.floor(r() * 90), b = 55 + Math.floor(r() * 90), p = 0.12 + r() * 0.76;
    matches.push({
      key: `demo_qm${i}`, level: 'qm', num: i, set: 1, label: 'Qual ' + i, red, blue,
      rs: played ? a : -1, bs: played ? b : -1, winner: played ? (a > b ? 'red' : a < b ? 'blue' : '') : '',
      played, sched, pred: start, actual: played ? start : null, order: 10100 + i
    });
    sbm[`demo_qm${i}`] = { redWin: p, redScore: Math.round(70 + p * 50), blueScore: Math.round(70 + (1 - p) * 50) };
    if (played) { const split = (t, f) => ({ auto: Math.round(t * .25), teleop: Math.round(t * .55), endgame: t - Math.round(t * .25) - Math.round(t * .55) - f, fouls: f, rp: null });
      matches[matches.length - 1].bd = { red: split(a, i % 5 === 0 ? 6 : 0), blue: split(b, i % 7 === 0 ? 3 : 0) }; }
  }
  const st = Object.fromEntries(DEMO_TEAMS.map(n => [n, { w: 0, l: 0, t: 0, rp: 0, p: 0 }]));
  for (const m of matches) if (m.played) for (const [side, list] of [['red', m.red], ['blue', m.blue]]) {
    const us = side === 'red' ? m.rs : m.bs, them = side === 'red' ? m.bs : m.rs;
    for (const n of list) { const s = st[n]; s.p++; if (us > them) { s.w++; s.rp += 3; } else if (us < them) s.l++; else { s.t++; s.rp++; } if (us >= 110) s.rp++; }
  }
  const rows = DEMO_TEAMS.map(n => { const s = st[n]; return { team: n, w: s.w, l: s.l, t: s.t, rs: s.p ? s.rp / s.p : 0, played: s.p, extra: s.rp }; })
    .sort((x, y) => y.rs - x.rs || y.extra - x.extra).map((x, i) => ({ ...x, rank: i + 1 }));
  const nx = matches.map(m => {
    const d = m.pred - t; let status = null;
    if (!m.played) status = d < 0 ? 'On field' : d < 7 * 60000 ? 'On deck' : d < 18 * 60000 ? 'Now queuing' : d < 30 * 60000 ? 'Queuing soon' : null;
    return { label: m.label.replace('Qual', 'Qualification'), status, red: m.red, blue: m.blue, t: { estimatedQueueTime: m.pred - 20 * 60000, estimatedStartTime: m.pred } };
  });
  return {
    eventKey: 'demo', event: { key: 'demo', name: 'DEMO Steampunk Test Event', webcasts: [{ type: 'twitch', channel: 'firstinspires' }] },
    teams: { 1577: 'Steampunk' }, matches, rankings: { rsName: 'Ranking Score', rsPrec: 2, extraName: 'Total RP', rows },
    nexus: { matches: nx }, sb: { matches: sbm, teams: Object.fromEntries(DEMO_TEAMS.map(n => [n, { epa: Math.round(20 + rng(n)() * 50) }])) },
    updated: { tba: t, nexus: t, sb: t }, errors: {}
  };
}

/* ---------------- model: our matches, next match, timing ---------------- */
const teamsKey = (r, b) => { const a = [...r, ...b].filter(Boolean); return a.length === 6 ? a.slice().sort((x, y) => x - y).join(',') : ''; };
function sameLabel(m, label) {
  let x;
  if ((x = /qualification\s+(\d+)/i.exec(label))) return m.level === 'qm' && m.num === +x[1];
  if ((x = /(?:playoff|match)\s+(\d+)/i.exec(label))) return m.level === 'sf' && m.set === +x[1];
  if ((x = /final\s+(\d+)/i.exec(label))) return m.level === 'f' && m.num === +x[1];
  return false;
}
function buildModel() {
  const T = +S.team, now = Date.now();
  const all = D.matches.map(m => ({ ...m }));
  if (D.nexus) {
    const idx = new Map(); all.forEach(m => { const k = teamsKey(m.red, m.blue); if (k) idx.set(k, m); });
    D.nexus.matches.forEach((nm, i) => {
      const k = teamsKey(nm.red, nm.blue);
      let m = (k && idx.get(k)) || all.find(x => sameLabel(x, nm.label));
      if (!m && /practice/i.test(nm.label)) {
        const n = parseInt(String(nm.label).replace(/\D+/g, ''), 10) || i + 1;
        m = { key: 'pm' + n, level: 'pm', num: n, set: 1, label: 'Practice ' + n, red: nm.red, blue: nm.blue, played: false, order: n, nexusOnly: true };
        all.push(m);
      }
      if (m) m.nx = nm;
    });
  }
  for (const m of all) {
    const nt = (m.nx && m.nx.t) || {};
    m.start = nt.estimatedStartTime || nt.estimatedOnFieldTime || m.pred || m.sched || null;
    m.queue = nt.estimatedQueueTime || (m.start ? m.start - S.queueLead * 60000 : null);
    if (m.nexusOnly && m.start && m.start < now - 8 * 60000 && !/queu|deck|field/i.test(m.nx?.status || '')) m.played = true;
    m.color = m.red.includes(T) ? 'red' : m.blue.includes(T) ? 'blue' : null;
    if (!m.color) continue;
    const mine = m.color === 'red' ? m.red : m.blue;
    m.station = mine.indexOf(T) + 1;
    m.allies = mine; m.opps = m.color === 'red' ? m.blue : m.red;
    if (m.played && m.rs != null && m.rs >= 0) {
      m.us = m.color === 'red' ? m.rs : m.bs; m.them = m.color === 'red' ? m.bs : m.rs;
      m.result = (m.winner === 'red' || m.winner === 'blue') ? (m.winner === m.color ? 'W' : 'L') : (m.us > m.them ? 'W' : m.us < m.them ? 'L' : 'T');
    }
    const p = D.sb.matches[m.key]?.redWin;
    if (p != null) m.winProb = m.color === 'red' ? p : 1 - p;
  }
  all.sort((a, b) => a.order - b.order);
  const ours = all.filter(m => m.color);
  const next = ours.find(m => !m.played) || null;
  const last = [...ours].reverse().find(m => m.played) || null;
  const onField = all.find(m => !m.played && !m.nexusOnly && m.sched);
  const delay = onField && onField.start && onField.sched ? onField.start - onField.sched : null;
  const myRank = D.rankings?.rows.find(r => r.team === T) || null;
  const remainingQ = ours.filter(m => !m.played && m.level === 'qm');
  const expWins = remainingQ.length && remainingQ.every(m => m.winProb != null) ? remainingQ.reduce((s, m) => s + m.winProb, 0) : null;
  return { all, ours, next, last, delay, T, myRank, remainingQ, expWins };
}

/* ---------------- shared team data (Firestore or this device) ---------------- */
function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('could not load ' + src)); document.head.appendChild(s); }); }
function parseFirebase(txt) {
  const m = String(txt).match(/\{[\s\S]*\}/); if (!m) throw new Error('paste the firebaseConfig { … } block');
  const json = m[0].replace(/\/\/.*$/gm, '').replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/'/g, '"').replace(/,\s*}/g, '}');
  const cfg = JSON.parse(json); if (!cfg.projectId) throw new Error('config is missing projectId'); return cfg;
}
const Store = {
  mode: 'local', db: null, err: '', localSubs: {},
  async init() {
    if (!S.firebase.trim()) { this.mode = 'local'; return; }
    try {
      const cfg = parseFirebase(S.firebase);
      const v = '10.12.2';
      await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
      await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      this.db = firebase.firestore();
      try { await this.db.enablePersistence({ synchronizeTabs: true }); } catch { /* another tab or unsupported */ }
      this.mode = 'cloud';
    } catch (e) { this.mode = 'local'; this.err = e.message; toast('Team sync not connected: ' + e.message, 'bad'); }
  },
  ref(c) { return this.db.collection('teams').doc(String(S.team)).collection(c); },
  watch(c, cb) {
    if (this.mode === 'cloud') {
      return this.ref(c).onSnapshot(snap => { const o = {}; snap.forEach(d => { o[d.id] = d.data(); }); cb(o); },
        e => { this.err = e.message; renderTop(); });
    }
    const read = () => cb(LS.get('pit.store.' + c, {}));
    (this.localSubs[c] ||= []).push(read); read();
    return () => { this.localSubs[c] = (this.localSubs[c] || []).filter(f => f !== read); };
  },
  async put(c, id, data) {
    id = safeId(id);
    if (this.mode === 'cloud') return this.ref(c).doc(id).set(data, { merge: true });
    const o = LS.get('pit.store.' + c, {}); o[id] = { ...(o[id] || {}), ...data }; LS.set('pit.store.' + c, o);
    (this.localSubs[c] || []).forEach(f => f());
  },
  async del(c, id) {
    id = safeId(id);
    if (this.mode === 'cloud') return this.ref(c).doc(id).delete();
    const o = LS.get('pit.store.' + c, {}); delete o[id]; LS.set('pit.store.' + c, o);
    (this.localSubs[c] || []).forEach(f => f());
  }
};
window.addEventListener('storage', e => {
  if (e.key && e.key.startsWith('pit.store.')) (Store.localSubs[e.key.slice(10)] || []).forEach(f => f());
});
const SD = { batteries: {}, check: {}, debrief: {}, calls: {}, members: {} };
let unsubs = [];
function subscribeShared() {
  unsubs.forEach(u => { try { u && u(); } catch { } }); unsubs = [];
  const ev = evKey() || 'none';
  unsubs.push(Store.watch('batteries', o => { SD.batteries = o; renderAll(); }));
  unsubs.push(Store.watch('calls', o => { SD.calls = o; onCalls(); }));
  unsubs.push(Store.watch('members', o => { SD.members = o; }));
  unsubs.push(Store.watch('check_' + ev, o => { SD.check = o; renderAll(); }));
  unsubs.push(Store.watch('debrief_' + ev, o => { SD.debrief = o; renderAll(); }));
}
const colCheck = () => 'check_' + (evKey() || 'none');
const colDebrief = () => 'debrief_' + (evKey() || 'none');

/* ---------------- checklist + battery helpers ---------------- */
function checkProgress(m) {
  const doc = (m && SD.check[safeId(m.key)]) || {};
  const items = doc.items || {};
  const total = S.checklist.length;
  const n = S.checklist.filter((_, i) => items['c' + i]).length;
  return { n, total, done: total > 0 && n === total, battery: doc.battery || null, doc };
}
const BSTAT = { robot: 'In robot', ready: 'Ready', charging: 'Charging', resting: 'Resting', retired: 'Retired' };
const BORDER = { robot: 0, ready: 1, charging: 2, resting: 3, retired: 4 };
function battList() { return Object.entries(SD.batteries).map(([id, b]) => ({ id, ...b })).sort((a, b) => (BORDER[a.status] ?? 9) - (BORDER[b.status] ?? 9) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true })); }
function battWarn(b) {
  const w = [], now = Date.now(), last = (b.readings || []).slice(-1)[0];
  if (b.status === 'charging' && b.since && now - b.since < S.chargeMin * 60000) w.push(`Only ${fmtEl(now - b.since)} on charger (aim ${S.chargeMin}m)`);
  if (b.status === 'retired') w.push('Retired — do not use');
  if (last && last.v && last.v < 12.8) w.push(`Low voltage ${last.v} V`);
  if (last && last.ir && last.ir > 0.02) w.push(`High resistance ${last.ir} Ω`);
  return w;
}
function battLabel(b) {
  if (b.status === 'charging' && b.since && Date.now() - b.since >= S.chargeMin * 60000) return 'Charged ✓';
  return BSTAT[b.status] || b.status;
}

/* ---------------- stream ---------------- */
function twitchSrc(ch) { return `https://player.twitch.tv/?channel=${encodeURIComponent(ch)}&parent=${location.hostname || 'localhost'}&muted=true&autoplay=true`; }
function ytSrc(id) { return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&mute=1&playsinline=1`; }
function urlToEmbed(u) {
  try {
    const x = new URL(u.trim()), h = x.hostname.replace(/^www\.|^m\./, '');
    if (h === 'twitch.tv') { const ch = x.pathname.split('/').filter(Boolean)[0]; return ch ? twitchSrc(ch) : null; }
    if (h === 'youtu.be') return ytSrc(x.pathname.slice(1));
    if (h === 'youtube.com') {
      if (x.searchParams.get('v')) return ytSrc(x.searchParams.get('v'));
      const p = x.pathname.split('/').filter(Boolean);
      if ((p[0] === 'live' || p[0] === 'embed') && p[1]) return ytSrc(p[1]);
      return null;
    }
    return x.href;
  } catch { return null; }
}
function streamOptions() {
  const out = [];
  if (S.streamUrl.trim()) { const s = urlToEmbed(S.streamUrl); if (s) out.push({ label: 'Custom', src: s, link: S.streamUrl.trim() }); }
  (D.event?.webcasts || []).forEach((w, i) => {
    if (w.type === 'twitch') out.push({ label: `Twitch ${w.channel}`, src: twitchSrc(w.channel), link: `https://twitch.tv/${w.channel}` });
    else if (w.type === 'youtube') out.push({ label: `YouTube ${i + 1}`, src: ytSrc(w.channel), link: `https://youtube.com/watch?v=${w.channel}` });
    else if (w.type === 'direct_link' && w.channel) out.push({ label: `Link ${i + 1}`, src: null, link: w.channel });
  });
  return out;
}
let curSrc = null;
function renderStream() {
  const box = $('#streamBox'), wrap = $('#streamFrameWrap'), ctl = $('#streamCtl');
  const opts = streamOptions();
  const idx = Math.min(S.streamIdx || 0, Math.max(0, opts.length - 1));
  const sel = opts[idx];
  const src = sel?.src || null;
  if (src !== curSrc) {
    curSrc = src;
    if (src) wrap.innerHTML = `<iframe src="${esc(src)}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    else wrap.innerHTML = `<div class="stream-empty"><div>📺<br>${sel?.link ? `This webcast can't be embedded — <a href="${esc(sel.link)}" target="_blank" rel="noopener">open it</a>` : D.event ? 'No webcast posted for this event yet.<br>Paste a stream link in Settings.' : 'Waiting for event data…'}</div></div>`;
  }
  const isTV = document.body.classList.contains('tv');
  box.classList.toggle('collapsed', !!S.streamCollapsed && !isTV);
  ctl.innerHTML = `<span class="live">● LIVE</span>
    ${opts.length > 1 ? opts.map((o, i) => `<button data-act="stream-pick" data-i="${i}" class="${i === idx ? 'on' : ''}">${esc(o.label)}</button>`).join('') : ''}
    <span class="sp"></span>
    ${sel?.link ? `<a href="${esc(sel.link)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
    ${isTV ? '' : `<button data-act="stream-toggle">${S.streamCollapsed ? 'Show stream ▾' : 'Hide ▴'}</button>`}`;
}

/* ---------------- rendering helpers ---------------- */
function teamTag(n, T) { return `<span class="tt ${n === T ? 'us' : ''}"><b>${n || '?'}</b><small>${esc(D.teams[n] || '')}</small></span>`; }
function queueState(m) {
  const now = Date.now(), st = m.nx?.status || '';
  if (/now queuing|on deck|on field/i.test(st)) return `<div class="qstate hot">${esc(st.toUpperCase())}</div>`;
  if (m.queue && now >= m.queue) return `<div class="qstate hot">QUEUE NOW</div>`;
  if (m.queue) {
    const soon = m.queue - now < S.alertLead * 60000 || /soon/i.test(st);
    return `<div class="qstate ${soon ? 'soon' : ''}"><span class="ql">Queue in</span> <b data-cd="${m.queue}">${fmtCD(m.queue - now)}</b></div>`;
  }
  return `<div class="qstate"><span class="ql">Match time not posted yet</span></div>`;
}
function nextCard(M) {
  const m = M.next;
  if (!m) {
    const l = M.last;
    return `<div class="card next-card none"><div class="nc-kicker">Next match</div><div class="nc-label">${M.ours.length ? 'No more matches scheduled' : 'Schedule not posted yet'}</div>
      ${l ? `<div class="nc-times">Last: ${esc(l.label)} — <span class="res ${l.result}">${l.result} ${l.us}-${l.them}</span></div>` : '<div class="muted">It will appear here as soon as the event posts it.</div>'}</div>`;
  }
  const ck = checkProgress(m), bat = ck.battery && SD.batteries[ck.battery];
  const opp = m.color === 'red' ? 'blue' : 'red';
  return `<div class="card next-card ${m.color}">
    <div class="nc-head"><div><div class="nc-kicker">Next match</div><div class="nc-label">${esc(m.label)}</div></div>
      <span class="bumper ${m.color}">${m.color.toUpperCase()} ${m.station || ''}</span></div>
    ${queueState(m)}
    <div class="nc-times">Match ~${hm(m.start)} (in <span data-cd="${m.start}">${fmtCD(m.start - Date.now())}</span>)${m.queue ? ` · queue ~${hm(m.queue)}` : ''}
      ${m.nx ? ' <span class="src">NEXUS</span>' : m.pred ? ' <span class="src">TBA EST.</span>' : ''}</div>
    <div class="alrow ${m.color}"><span class="alt">With</span>${m.allies.map(n => teamTag(n, M.T)).join('')}</div>
    <div class="alrow ${opp}"><span class="alt">Against</span>${m.opps.map(n => teamTag(n, M.T)).join('')}</div>
    <div class="nc-foot">
      ${m.winProb != null ? `<span>Win chance <b>${pct(m.winProb)}</b></span>` : ''}
      <span class="${ck.done ? 'ok' : ''}">Checklist <b>${ck.done ? 'READY ✓' : `${ck.n}/${ck.total}`}</b></span>
      <span>Battery <b>${bat ? esc(bat.name) : '—'}</b></span>
    </div></div>`;
}
function matchRow(m, M) {
  const isNext = M.next && m.key === M.next.key;
  const st = m.nx?.status;
  let right;
  if (m.played && m.result) right = `<span class="res ${m.result}">${m.result} ${m.us}-${m.them}</span>`;
  else if (m.played) right = '<span class="muted">done</span>';
  else if (st && /queuing|deck|field/i.test(st)) right = `<span class="pill ${/now|deck|field/i.test(st) ? 'hot' : 'soon'}">${esc(st)}</span>`;
  else if (m.winProb != null) right = `<span class="muted">${pct(m.winProb)}</span>`;
  else right = '';
  const tag = n => `<b class="${n === M.T ? 'us' : ''}">${n}</b>`;
  const db = SD.debrief[safeId(m.key)];
  return `<div class="mrow ${m.color} ${m.played ? 'done' : ''} ${isNext ? 'is-next' : ''}" data-act="match" data-k="${esc(m.key)}" title="Match details">
    <div class="mlabel">${esc(shortLabel(m.label))}</div>
    <div class="mtime">${hm(m.start)}</div>
    <div class="mteams"><span class="w"><span class="lbl">w/</span>${m.allies.filter(n => n !== M.T).map(tag).join(' ')}</span>
      <span class="v"> <span class="lbl">vs</span>${m.opps.map(tag).join(' ')}</span></div>
    <div class="mres">${right}${db ? ' <span title="Debrief written">📝</span>' : ''}</div></div>`;
}
function notices(M) {
  const out = [];
  if (S.demo) out.push(`<div class="notice demo"><b>Demo mode</b> — a fake live event so you can try everything. Switch it off in <a href="#settings">Settings</a> when your event is set.</div>`);
  for (const [k, e] of Object.entries(D.errors || {})) if (k !== 'sb') out.push(`<div class="notice err">${esc(e)}</div>`);
  if (!navigator.onLine) out.push(`<div class="notice info">Offline — showing data saved at ${hm(D.updated?.tba)}. It will update when the connection is back.</div>`);
  if (M.delay != null && Math.abs(M.delay) >= 3 * 60000) out.push(`<div class="notice info">Field is running <b>${Math.round(Math.abs(M.delay) / 60000)} min ${M.delay > 0 ? 'behind' : 'ahead of'}</b> schedule.</div>`);
  return out.join('');
}
function rankWindow(M, R) {
  const rows = R.rows, i = rows.findIndex(r => r.team === M.T);
  if (i < 0) return '';
  let a = Math.max(0, i - 2), b = Math.min(rows.length, a + 5); a = Math.max(0, b - 5);
  return `<div class="rwin">${rows.slice(a, b).map(r => `<div class="rw ${r.team === M.T ? 'us' : 'blur'}">
    <span class="rr">#${r.rank}</span><span class="rt">${r.team}</span><span class="rn">${esc(D.teams[r.team] || '')}</span>
    <span class="rs">${Number(r.rs ?? 0).toFixed(R.rsPrec)}</span></div>`).join('')}</div>`;
}
function rankCardHTML(M, tv) {
  const r = M.myRank, R = D.rankings;
  if (!r) return `<h3>Ranking</h3><div class="muted">Rankings appear after the first quals.</div>`;
  const proj = M.expWins != null ? `${(r.w + M.expWins).toFixed(1)} wins projected (${M.remainingQ.length} quals left)` : '';
  if (tv) return `<div class="row" style="margin-bottom:6px"><h3 style="margin:0">Ranking</h3><span class="sp"></span><span class="tvsub">#${r.rank} of ${R.rows.length} · ${r.w}-${r.l}-${r.t}</span></div>${rankWindow(M, R)}`;
  return `<div class="bigstat"><div><b>#${r.rank}</b><span>of ${R.rows.length}</span></div><div><b>${r.w}-${r.l}-${r.t}</b><span>W-L-T</span></div>
    <div><b>${Number(r.rs ?? 0).toFixed(R.rsPrec)}</b><span>${esc(R.rsName)}</span></div>${r.extra != null && R.extraName ? `<div><b>${r.extra}</b><span>${esc(R.extraName)}</span></div>` : ''}</div>
    ${rankWindow(M, R)}
    ${proj ? `<div class="muted small" style="margin-top:8px">Statbotics: ${proj}</div>` : ''}`;
}

/* ---------------- views (phone / laptop) ---------------- */
function viewMatches(M) {
  return `${notices(M)}${nextCard(M)}
    <div class="row" style="margin:14px 0 8px"><h3 style="margin:0">Our matches</h3><span class="sp"></span><span class="muted small">${M.ours.filter(m => m.played).length}/${M.ours.length} played</span></div>
    <div class="mlist">${M.ours.map(m => matchRow(m, M)).join('') || '<div class="card muted">No matches for team ' + M.T + ' yet.</div>'}</div>
    <div class="muted small" style="margin-top:10px">Updated ${hm(D.updated?.tba)}${D.updated?.nexus ? ' · Nexus ' + hm(D.updated.nexus) : ''}</div>`;
}
let checkSel = null;
function viewChecklist(M) {
  const upcoming = M.ours.filter(m => !m.played).slice(0, 4);
  const m = upcoming.find(x => x.key === checkSel) || M.next;
  if (!m) return `${notices(M)}<div class="card"><h2>Pre-match checklist</h2><div class="muted">No upcoming match.</div></div>`;
  const ck = checkProgress(m), items = ck.doc.items || {};
  const batts = battList().filter(b => b.status !== 'retired');
  const cur = ck.battery && SD.batteries[ck.battery];
  const warn = cur ? battWarn(cur) : [];
  return `${notices(M)}
    <div class="seg" style="margin-bottom:10px">${upcoming.map(x => `<button data-act="chk-match" data-k="${esc(x.key)}" class="${x.key === m.key ? 'on' : ''}">${esc(shortLabel(x.label))} · ${hm(x.start)}</button>`).join('')}</div>
    <div class="card">
      <div class="row"><h2 style="margin:0">Checklist — ${esc(m.label)}</h2><span class="sp"></span><span class="muted small">queue ~${hm(m.queue)}</span></div>
      <div class="bigbumper ${m.color}" style="margin-top:10px">${m.color.toUpperCase()} BUMPERS · STATION ${m.station}</div>
      ${ck.done ? '<div class="ready">✓ ROBOT READY</div>' : ''}
      <div class="progress ${ck.done ? 'full' : ''}"><i style="width:${ck.total ? ck.n / ck.total * 100 : 0}%"></i></div>
      <label class="f">Battery for this match</label>
      <select data-act="chk-batt" data-k="${esc(m.key)}"><option value="">— pick a battery —</option>
        ${batts.map(b => `<option value="${esc(b.id)}" ${b.id === ck.battery ? 'selected' : ''}>${esc(b.name)} · ${esc(battLabel(b))}${b.status === 'charging' && b.since ? ' ' + fmtEl(Date.now() - b.since) : ''}</option>`).join('')}
      </select>
      ${warn.map(w => `<div class="bwarn">⚠ ${esc(w)}</div>`).join('')}
      ${batts.length ? '' : '<div class="muted small" style="margin-top:4px">Add your batteries in the <a href="#batteries">Batteries</a> tab.</div>'}
      <div style="margin-top:12px">${S.checklist.map((txt, i) => {
        const it = items['c' + i];
        return `<button class="chk ${it ? 'on' : ''}" data-act="chk-item" data-k="${esc(m.key)}" data-i="${i}"><span class="box">✓</span><span>${esc(txt)}</span>${it ? `<span class="who">${esc(it.by || '')} ${hm(it.t)}</span>` : ''}</button>`;
      }).join('')}</div>
      <div class="row"><span class="muted small">Ticks sync to the pit TV${Store.mode === 'cloud' ? '' : ' (when team sync is on)'}.</span><span class="sp"></span><button class="btn small" data-act="chk-reset" data-k="${esc(m.key)}">Reset</button></div>
    </div>`;
}
function viewBatteries() {
  const list = battList(), now = Date.now();
  const cnt = s => list.filter(b => b.status === s).length;
  const ev = evKey();
  return `<div class="row" style="margin-bottom:10px"><h2 style="margin:0">Batteries</h2><span class="sp"></span><button class="btn primary" data-act="batt-add">+ Add battery</button></div>
    <div class="muted small" style="margin-bottom:10px">${cnt('ready')} ready · ${cnt('charging')} charging · ${cnt('robot')} in robot · charge target ${S.chargeMin} min</div>
    <div class="bgrid">${list.map(b => {
      const last = (b.readings || []).slice(-1)[0];
      const usesEv = (b.uses || []).filter(u => u.ev === ev).length;
      return `<div class="batt ${b.status}">
        <div class="bh"><span class="bname">${esc(b.name)}</span><span class="st ${b.status}">${esc(battLabel(b))}</span>${b.since && b.status !== 'retired' ? `<span class="el" data-el="${b.since}">${fmtEl(now - b.since)}</span>` : ''}</div>
        <div class="bm">${last ? `Last: ${last.v ? last.v + ' V' : ''}${last.ir ? ' · ' + last.ir + ' Ω' : ''} (${hm(last.t)})` : 'No readings yet'} · ${usesEv} matches this event · ${(b.uses || []).length} total${b.notes ? '<br>' + esc(b.notes) : ''}</div>
        ${battWarn(b).filter(w => !/Retired/.test(w)).map(w => `<div class="bwarn">⚠ ${esc(w)}</div>`).join('')}
        <div class="bact">
          ${b.status !== 'charging' ? `<button class="btn small" data-act="batt-st" data-id="${esc(b.id)}" data-s="charging">🔌 Charger</button>` : ''}
          ${b.status !== 'ready' ? `<button class="btn small" data-act="batt-st" data-id="${esc(b.id)}" data-s="ready">✓ Ready</button>` : ''}
          ${b.status !== 'resting' && b.status !== 'retired' ? `<button class="btn small" data-act="batt-st" data-id="${esc(b.id)}" data-s="resting">Rest</button>` : ''}
          <button class="btn small" data-act="batt-read" data-id="${esc(b.id)}">Reading</button>
          <button class="btn small" data-act="batt-more" data-id="${esc(b.id)}">⋯</button>
        </div></div>`;
    }).join('') || '<div class="card muted">No batteries yet. Add them with their number (e.g. B01).</div>'}</div>`;
}
function viewDebrief(M) {
  const list = [...M.ours].sort((a, b) => (b.played - a.played) || (a.played ? b.order - a.order : a.order - b.order));
  return `<h2>Post-match debrief</h2><div class="muted small" style="margin-bottom:10px">Fill one in right after each match — what worked, what broke, driver notes.</div>
    <div class="mlist">${list.map(m => {
      const d = SD.debrief[safeId(m.key)];
      return `<div class="card" style="margin:0">
        <div class="row"><span class="mlabel">${esc(m.label)}</span>${m.result ? `<span class="res ${m.result}">${m.result} ${m.us}-${m.them}</span>` : `<span class="muted small">${m.played ? 'played' : 'upcoming ' + hm(m.start)}</span>`}
          <span class="sp"></span><button class="btn small ${d ? '' : 'primary'}" data-act="db-open" data-k="${esc(m.key)}">${d ? 'Edit' : 'Write'}</button></div>
        ${d ? `<div class="dbf" style="margin-top:8px">${d.rating ? `<b>${'★'.repeat(d.rating)}${'☆'.repeat(5 - d.rating)}</b> ` : ''}<span class="muted small">by ${esc(d.by || '?')} ${hm(d.t)}</span>
          ${d.broke ? `<div class="bad">Broke: ${esc(d.broke)}</div>` : ''}${d.worked ? `<div class="ok">Worked: ${esc(d.worked)}</div>` : ''}${d.driver ? `<div>Driver: ${esc(d.driver)}</div>` : ''}</div>` : ''}
      </div>`;
    }).join('') || '<div class="card muted">No matches yet.</div>'}</div>`;
}
function viewRankings(M) {
  const R = D.rankings;
  const partners = new Set(M.next ? M.next.allies : []), opps = new Set(M.next ? M.next.opps : []);
  return `${notices(M)}<div class="card"><h2>Team ${M.T}</h2>${rankCardHTML(M, false)}</div>
    ${R ? `<div class="card" style="padding:6px;overflow-x:auto"><table class="rank"><thead><tr><th>#</th><th>Team</th><th>W-L-T</th><th>${esc(R.rsName)}</th>${R.extraName ? `<th>${esc(R.extraName)}</th>` : ''}<th>EPA</th></tr></thead><tbody>
      ${R.rows.map(r => `<tr class="${r.team === M.T ? 'us' : partners.has(r.team) ? 'partner' : opps.has(r.team) ? 'opp' : ''}"><td class="n">${r.rank}</td>
        <td><b class="n">${r.team}</b> <span class="muted small">${esc(D.teams[r.team] || '')}</span></td><td>${r.w}-${r.l}-${r.t}</td><td>${Number(r.rs ?? 0).toFixed(R.rsPrec)}</td>
        ${R.extraName ? `<td>${r.extra ?? ''}</td>` : ''}<td>${D.sb.teams[r.team]?.epa != null ? Number(D.sb.teams[r.team].epa).toFixed(1) : '—'}</td></tr>`).join('')}
    </tbody></table><div class="muted small" style="padding:6px">Green edge = next-match partner, red edge = next-match opponent. EPA from Statbotics.</div></div>` : ''}`;
}
function viewSettings() {
  const f = (k, label, type = 'text', extra = '') => `<label class="f">${label}</label><input type="${type}" data-s="${k}" value="${esc(S[k])}" ${extra}>`;
  const cb = (k, label) => `<label class="row" style="margin:8px 0"><input type="checkbox" data-s="${k}" ${S[k] ? 'checked' : ''}> ${label}</label>`;
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  return `<h2>Settings</h2>
  <div class="card"><h3>This device</h3>
    ${f('member', 'Your name (shows on checklist ticks)', 'text', 'placeholder="e.g. Tom"')}
    ${cb('tv', '<b>Pit TV mode</b> — full-screen dashboard, keeps the screen awake')}
    ${cb('sound', 'Alert sounds')}
    <div class="row" style="margin-top:6px"><button class="btn small" data-act="test-alert">Test alert</button>
    <button class="btn small" data-act="notify-perm">Enable phone notifications</button><span class="muted small">Notifications: ${perm}</span></div>
    <div class="muted small" style="margin-top:6px">Alerts fire while the app is open (on a phone, keep it open or added to the home screen).</div></div>
  <div class="card"><h3>Event</h3>
    ${cb('demo', '<b>Demo mode</b> (fake live event for testing)')}
    <div class="row"><div style="flex:1">${f('team', 'Team number', 'number')}</div><div style="flex:1">${f('year', 'Season', 'number')}</div></div>
    ${f('eventKey', 'Event key (e.g. 2027isde1)', 'text', 'placeholder="2027isde1"')}
    <div class="row" style="margin-top:8px"><button class="btn small" data-act="find-events">Find our events</button><span id="evFind" class="muted small"></span></div>
    <div id="evList"></div></div>
  <div class="card"><h3>Data keys</h3>
    ${f('tbaKey', 'The Blue Alliance read key (required)', 'password')}
    <div class="muted small">thebluealliance.com → Account → Read API Keys → add one.</div>
    ${f('nexusKey', 'Nexus for FRC API key (optional, live queue times)', 'password')}
    <div class="muted small">frc.nexus → API. Without it, queue time = match time − “queue lead”.</div>
    <div class="muted small" style="margin-top:6px">Statbotics needs no key.</div>
    <div class="row" style="margin-top:8px"><button class="btn small" data-act="test-apis">Test connections</button></div><div id="apiTest" class="small"></div></div>
  <div class="card"><h3>Timing</h3>
    <div class="row"><div style="flex:1">${f('queueLead', 'Queue lead (min before match)', 'number')}</div><div style="flex:1">${f('alertLead', 'Warn me (min before queue)', 'number')}</div></div>
    ${f('chargeMin', 'Battery charge target (min)', 'number')}</div>
  <div class="card"><h3>Stream</h3>
    ${f('streamUrl', 'Custom stream link (optional — Twitch or YouTube)', 'text', 'placeholder="https://twitch.tv/…"')}
    <div class="muted small">Leave empty to use the event's official webcast from TBA.</div></div>
  <div class="card"><h3>Team sync</h3>
    <div class="muted small">Status: <b class="${Store.mode === 'cloud' ? 'ok' : 'warn'}">${Store.mode === 'cloud' ? 'Connected — checklist, batteries and debriefs are shared' : 'This device only'}</b>${Store.err ? ` · <span class="bad">${esc(Store.err)}</span>` : ''}</div>
    <label class="f">Firebase config (paste the firebaseConfig block)</label><textarea data-s="firebase" placeholder="const firebaseConfig = { apiKey: '…', projectId: '…', … };">${esc(S.firebase)}</textarea></div>
  <div class="card"><h3>Phone alerts (ntfy)</h3>
    <div class="muted small">Alerts that reach locked phones. Each member installs the free <b>ntfy</b> app (App Store / Google Play), taps <b>+</b>, and subscribes to the channels below (server: ntfy.sh).</div>
    ${cb('ntfyOn', 'Phone alerts on')}
    ${cb('ntfySend', '<b>This device sends queue alerts & results</b> — turn on for the pit TV only')}
    ${[['ntfyTeam', 'Team channel — “Everyone” calls (all members)'], ['ntfyQueue', 'Queue channel — queue alerts & results (drive team, pit crew)'], ['ntfyMe', 'My personal channel — calls just for me']].map(([k, l]) => `
      <label class="f">${l}</label><div class="row" style="flex-wrap:nowrap"><input type="text" data-s="${k}" value="${esc(S[k])}" readonly onclick="this.select()">
      <button class="btn small" data-act="ntfy-copy" data-k="${k}">Copy</button></div>`).join('')}
    <div class="row" style="margin-top:10px"><button class="btn small" data-act="ntfy-test">Send test to my phone</button>
      <button class="btn small" data-act="ntfy-new" title="Makes new team channels — everyone must re-subscribe">New team channels</button></div>
    <div class="muted small" style="margin-top:6px">Your personal channel is registered with the team under “Your name” (needs team sync). Calls to people without one go to the team channel.</div></div>
  <div class="card"><h3>Team members</h3><div class="muted small">One name per line — used by “Call to pit”. Each member should put the same name in “Your name” above.</div>
    <textarea data-s="roster" style="min-height:120px" placeholder="Tom\nNoa\nDaniel">${esc((S.roster || []).join('\n'))}</textarea></div>
  <div class="card"><h3>Checklist items</h3><div class="muted small">One per line.</div>
    <textarea data-s="checklist" style="min-height:170px">${esc(S.checklist.join('\n'))}</textarea></div>
  <div class="card"><h3>Set up other phones</h3><div class="muted small">Copies a link with this device's event, keys and sync settings. Send it to team members — opening it sets their app up.</div>
    <div class="row" style="margin-top:8px"><button class="btn small" data-act="copy-setup">Copy setup link</button></div><div id="setupOut"></div></div>
  <div style="position:sticky;bottom:80px;display:flex;gap:10px"><button class="btn primary" data-act="save-settings" style="flex:1;padding:12px">Save</button></div>`;
}

/* ---------------- match detail window ---------------- */
function matchDetail(key) {
  const m = (M.all || []).find(x => x.key === key); if (!m) return '<div class="muted">Match not found.</div>';
  const T = M.T, now = Date.now(), R = D.rankings, real = !S.demo && !m.nexusOnly;
  const rk = n => R?.rows.find(r => r.team === n);
  const epa = n => D.sb.teams[n]?.epa;
  const sbm = D.sb.matches[m.key] || {};
  const teamRow = (n, side) => { const r = rk(n); return `<tr class="${n === T ? 'us' : ''}"><td class="n"><b>${n}</b></td><td class="small">${esc(D.teams[n] || '')}</td>
    <td>${r ? '#' + r.rank : '—'}</td><td>${r ? `${r.w}-${r.l}-${r.t}` : '—'}</td><td>${epa(n) != null ? Number(epa(n)).toFixed(1) : '—'}</td></tr>`; };
  const sumEPA = list => { const v = list.map(epa); return v.every(x => x != null) ? v.reduce((a, b) => a + b, 0).toFixed(0) : null; };
  const allianceBox = side => {
    const list = side === 'red' ? m.red : m.blue, score = side === 'red' ? m.rs : m.bs, pred = side === 'red' ? sbm.redScore : sbm.blueScore;
    const won = m.played && ((m.winner === side) || (!m.winner && m.rs !== m.bs && (side === 'red' ? m.rs > m.bs : m.bs > m.rs)));
    return `<div class="mdal ${side}"><div class="row"><b class="mdside">${side.toUpperCase()}${m.color === side ? ' · US' : ''}</b><span class="sp"></span>
      ${m.played && score >= 0 ? `<span class="mdscore ${won ? 'won' : ''}">${score}</span>` : pred != null ? `<span class="muted small">pred. ${Math.round(pred)}</span>` : ''}</div>
      <table class="rank"><thead><tr><th>Team</th><th></th><th>Rank</th><th>W-L-T</th><th>EPA</th></tr></thead><tbody>${list.map(n => teamRow(n, side)).join('')}</tbody></table>
      ${sumEPA(list) ? `<div class="muted small">Alliance EPA ${sumEPA(list)}</div>` : ''}</div>`;
  };
  const bdRows = [['Auto', 'auto'], ['Teleop', 'teleop'], ['Endgame', 'endgame'], ['Fouls received', 'fouls'], ['Ranking points', 'rp']]
    .filter(([, k]) => m.bd && (m.bd.red?.[k] != null || m.bd.blue?.[k] != null));
  const ck = checkProgress(m), bat = ck.battery && SD.batteries[ck.battery], db = SD.debrief[safeId(m.key)];
  const st = m.nx?.status;
  return `<div class="row"><h2 style="margin:0">${esc(m.label)}</h2>
      ${m.color ? `<span class="bumper ${m.color}" style="font-size:15px">${m.color.toUpperCase()} ${m.station}</span>` : ''}
      ${m.result ? `<span class="res ${m.result}">${m.result === 'W' ? 'WIN' : m.result === 'L' ? 'LOSS' : 'TIE'}</span>` : st ? `<span class="pill ${/now|deck|field/i.test(st) ? 'hot' : 'soon'}">${esc(st)}</span>` : ''}
      <span class="sp"></span><button class="btn small" data-act="modal-close">✕</button></div>
    <div class="muted small" style="margin:6px 0 12px">${m.played ? `Played ${hm(m.actual || m.start)}` : `Starts ~${hm(m.start)} (in <span data-cd="${m.start}">${fmtCD((m.start || now) - now)}</span>)`}
      ${m.sched ? ` · scheduled ${hm(m.sched)}` : ''}${!m.played && m.queue ? ` · queue ~${hm(m.queue)}` : ''}${!m.played && m.nx?.t?.estimatedOnDeckTime ? ` · on deck ~${hm(m.nx.t.estimatedOnDeckTime)}` : ''}</div>
    ${m.played && m.rs >= 0 ? `<div class="mdbig"><span class="r">${m.rs}</span><span class="muted"> – </span><span class="b">${m.bs}</span></div>`
      : sbm.redWin != null ? `<div class="mdpred"><div class="bar"><i style="width:${sbm.redWin * 100}%"></i></div>
        <div class="row small"><span class="r">Red ${pct(sbm.redWin)}${sbm.redScore != null ? ' · ~' + Math.round(sbm.redScore) : ''}</span><span class="sp"></span>
        <span class="b">${sbm.blueScore != null ? '~' + Math.round(sbm.blueScore) + ' · ' : ''}Blue ${pct(1 - sbm.redWin)}</span></div><div class="muted small">Statbotics prediction</div></div>` : ''}
    <div class="mdgrid">${allianceBox('red')}${allianceBox('blue')}</div>
    ${bdRows.length ? `<h3 style="margin-top:12px">Score breakdown</h3><table class="rank"><thead><tr><th></th><th class="r">Red</th><th class="b">Blue</th></tr></thead><tbody>
      ${bdRows.map(([l, k]) => `<tr><td>${l}</td><td class="n">${m.bd.red?.[k] ?? '—'}</td><td class="n">${m.bd.blue?.[k] ?? '—'}</td></tr>`).join('')}</tbody></table>` : ''}
    ${m.color ? `<h3 style="margin-top:12px">Our prep</h3><div class="nc-foot" style="margin-top:0">
        <span class="${ck.done ? 'ok' : ''}">Checklist <b>${ck.done ? 'READY ✓' : `${ck.n}/${ck.total}`}</b></span><span>Battery <b>${bat ? esc(bat.name) : '—'}</b></span>
        ${m.winProb != null ? `<span>Our win chance <b>${pct(m.winProb)}</b></span>` : ''}</div>
      ${db ? `<div class="dbf" style="margin-top:8px">${db.rating ? `<b>${'★'.repeat(db.rating)}${'☆'.repeat(5 - db.rating)}</b> ` : ''}<span class="muted small">debrief by ${esc(db.by || '?')}</span>
        ${db.broke ? `<div class="bad">Broke: ${esc(db.broke)}</div>` : ''}${db.worked ? `<div class="ok">Worked: ${esc(db.worked)}</div>` : ''}${db.driver ? `<div>Driver: ${esc(db.driver)}</div>` : ''}</div>` : ''}` : ''}
    <div class="row" style="margin-top:14px">
      ${m.color && !m.played ? `<button class="btn small" data-act="md-check" data-k="${esc(m.key)}">✅ Checklist</button>` : ''}
      ${m.color ? `<button class="btn small" data-act="db-open" data-k="${esc(m.key)}">📝 ${db ? 'Edit' : 'Write'} debrief</button>` : ''}
      ${(m.videos || []).map((v, i) => `<a class="btn small" style="text-decoration:none" target="_blank" rel="noopener" href="https://www.youtube.com/watch?v=${esc(v)}">▶ Replay${m.videos.length > 1 ? ' ' + (i + 1) : ''}</a>`).join('')}
      ${real ? `<a class="btn small" style="text-decoration:none" target="_blank" rel="noopener" href="https://www.thebluealliance.com/match/${esc(m.key)}">TBA ↗</a>
      <a class="btn small" style="text-decoration:none" target="_blank" rel="noopener" href="https://www.statbotics.io/match/${esc(m.key)}">Statbotics ↗</a>` : ''}
    </div>`;
}

/* ---------------- TV dashboard ---------------- */
function renderTV(M) {
  const i = M.next ? M.ours.indexOf(M.next) : M.ours.length;
  const rows = M.ours.slice(Math.max(0, i - 2));
  $('#tvSide').innerHTML = `<div class="tvbtn" data-act="go" data-v="checklist" title="Open checklist">${nextCard(M)}</div><div class="card tvlist"><h3>Our matches</h3><div class="mlist">${rows.map(m => matchRow(m, M)).join('') || '<div class="muted">No matches yet.</div>'}</div></div>`;
  const ck = M.next ? checkProgress(M.next) : null;
  const bl = battList().filter(b => b.status !== 'retired');
  const now = Date.now(), l = M.last;
  const errs = Object.entries(D.errors || {}).filter(([k]) => k !== 'sb').map(([, e]) => e);
  $('#tvStrip').innerHTML = `
    <div class="card tvbtn" data-act="go" data-v="rankings" title="Open rankings">${rankCardHTML(M, true)}</div>
    <div class="card tvbtn" data-act="go" data-v="checklist" title="Open checklist"><h3>Robot ${M.next ? '· ' + esc(shortLabel(M.next.label)) : ''}</h3>
      ${ck ? (ck.done ? '<div class="tvbig ok">READY ✓</div>' : `<div class="tvbig ${ck.n ? 'warn' : ''}">${ck.n}/${ck.total}</div><div class="tvsub">checklist done</div>`) : '<div class="tvsub">No upcoming match</div>'}
      ${ck && ck.battery && SD.batteries[ck.battery] ? `<div class="tvsub">Battery ${esc(SD.batteries[ck.battery].name)}</div>` : ck ? '<div class="tvsub warn">No battery picked</div>' : ''}</div>
    <div class="card tvbtn" data-act="go" data-v="batteries" title="Open batteries"><h3>Batteries</h3><div class="bchips">${bl.map(b => `<span class="bchip ${b.status}" data-act="batt-read" data-id="${esc(b.id)}" title="Log a reading">${esc(b.name)}<small>${b.status === 'charging' ? fmtEl(now - (b.since || now)) : esc(battLabel(b))}</small></span>`).join('') || '<span class="tvsub">Add batteries on a phone</span>'}</div></div>
    <div class="card tvbtn" ${l ? `data-act="db-open" data-k="${esc(l.key)}" title="Write debrief"` : 'data-act="go" data-v="debrief"'}><h3>Last match</h3>${l ? `<div class="tvbig"><span class="res ${l.result}">${l.result || ''}</span> ${l.us ?? ''}–${l.them ?? ''}</div><div class="tvsub">${esc(l.label)}</div>` : '<div class="tvsub">None yet</div>'}
      ${M.delay != null && Math.abs(M.delay) >= 3 * 60000 ? `<div class="tvsub warn">Field ${Math.round(Math.abs(M.delay) / 60000)} min ${M.delay > 0 ? 'behind' : 'ahead'}</div>` : ''}
      ${errs.length ? `<div class="tvsub bad">${esc(errs[0])}</div>` : ''}${S.demo ? '<div class="tvsub warn">DEMO DATA</div>' : ''}</div>`;
}

/* ---------------- top bar / router ---------------- */
function renderTop() {
  const name = D.event?.name || (evKey() ? evKey() : 'No event selected');
  $('#evname').innerHTML = `${S.demo ? '<span class="demo">DEMO</span>' : ''}${esc(name)}`;
  const chip = $('#syncChip');
  chip.textContent = !navigator.onLine ? '● offline' : Store.mode === 'cloud' ? '● team sync' : '○ this device';
  chip.className = 'sync' + (!navigator.onLine ? ' off' : '');
  $('#soundChip').hidden = !(S.sound && (!actx || actx.state !== 'running'));
}
let current = 'matches', M = null;
const VIEWS = { matches: viewMatches, checklist: viewChecklist, batteries: viewBatteries, debrief: viewDebrief, rankings: viewRankings, settings: viewSettings };
function renderAll(force) {
  M = buildModel();
  renderTop(); renderStream();
  if (document.body.classList.contains('tv')) renderTV(M);
  else if (current !== 'settings' || force === 'nav') $('#view').innerHTML = (S.tv && current !== 'matches' ? '<a class="btn primary backtv" href="#matches">← Back to TV</a>' : '') + (VIEWS[current] || viewMatches)(M);
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === current));
}
function applyMode() {
  document.body.classList.toggle('tv', !!S.tv && current === 'matches');
  keepAwake(); requestAnimationFrame(setTopH);
}
function setTopH() { document.documentElement.style.setProperty('--topH', $('#topbar').offsetHeight + 'px'); }
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('setup=')) { applySetupCode(h.slice(6)); return; }
  current = VIEWS[h] ? h : 'matches';
  applyMode(); renderAll('nav'); window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
window.addEventListener('resize', setTopH);

/* ---------------- alerts: banner + sound + notifications ---------------- */
let actx = null;
function unlockAudio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } }
  if (actx.state === 'suspended') actx.resume().then(renderTop).catch(() => { });
  renderTop();
}
document.addEventListener('pointerdown', unlockAudio);
function beep(urgent) {
  if (!S.sound || !actx || actx.state !== 'running') return;
  const seq = urgent ? [880, 0, 880, 0, 1175, 0, 1175, 0, 1568] : [660, 0, 880];
  let t = actx.currentTime;
  for (const f of seq) {
    if (f) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.2);
    }
    t += 0.19;
  }
}
let alertTimer = null;
function alertUser(title, sub, urgent, tag, extra) {
  const bar = $('#alertBar');
  bar.className = urgent ? 'urgent' : '';
  bar.innerHTML = `<div><div class="at">${esc(title)}</div>${sub ? `<div class="as">${esc(sub)}</div>` : ''}</div>${extra || ''}<button data-act="alert-close">OK</button>`;
  bar.hidden = false;
  clearTimeout(alertTimer); alertTimer = setTimeout(() => { bar.hidden = true; }, urgent ? 120000 : 45000);
  beep(urgent);
  if (S.notify && 'Notification' in window && Notification.permission === 'granted') {
    const opts = { body: sub || '', tag: tag || title, icon: 'icon-192.png', renotify: true };
    (navigator.serviceWorker?.ready || Promise.reject()).then(r => r.showNotification(title, opts)).catch(() => { try { new Notification(title, opts); } catch { } });
  }
}
const alerted = new Set(LS.get('pit.alerted', []));
function once(id) { if (alerted.has(id)) return false; alerted.add(id); LS.set('pit.alerted', [...alerted].slice(-300)); return true; }
function checkAlerts() {
  const m = M?.next; if (!m) return;
  const now = Date.now(), lbl = m.label, ev = evKey();
  const side = `${m.color.toUpperCase()} bumpers · station ${m.station}`;
  if (m.queue) {
    const pre = m.queue - S.alertLead * 60000;
    if (now >= pre && now < m.queue && once(`${ev}:${m.key}:pre`)) {
      const t = `${lbl} — queue in ${Math.max(1, Math.round((m.queue - now) / 60000))} min`;
      alertUser(t, side + ' · run the checklist', false, m.key); pushQueue('⏱ ' + t, side + ' · run the checklist', 4, ['stopwatch']);
    }
    if (now >= m.queue && now < (m.start || m.queue) + 5 * 60000 && once(`${ev}:${m.key}:q`)) {
      alertUser(`QUEUE NOW — ${lbl}`, side, true, m.key); pushQueue(`🚨 QUEUE NOW — ${lbl}`, side, 5, ['rotating_light']);
    }
  }
  const st = m.nx?.status;
  if (st && /now queuing|on deck/i.test(st) && once(`${ev}:${m.key}:nx:${st}`)) {
    alertUser(`${st.toUpperCase()} — ${lbl}`, side, true, m.key); pushQueue(`🚨 ${st.toUpperCase()} — ${lbl}`, side + ' (Nexus)', 5, ['rotating_light']);
  }
}
let prevPlayed = null; const prevStart = {};
function detectChanges() {
  const played = new Set(M.ours.filter(m => m.played).map(m => m.key));
  if (prevPlayed) for (const m of M.ours) if (m.played && !prevPlayed.has(m.key) && m.result) {
    const rt = `${m.label}: ${m.result === 'W' ? 'WIN' : m.result === 'L' ? 'LOSS' : 'TIE'} ${m.us}–${m.them}`;
    alertUser(rt, 'Battery to the charger · write the debrief', false, 'result');
    if (!S.demo) pushQueue(rt, 'Battery to the charger · write the debrief', 3, [m.result === 'W' ? 'trophy' : 'robot']);
  }
  prevPlayed = played;
  const n = M.next;
  if (n && n.start) {
    const p = prevStart[n.key];
    if (p && Math.abs(n.start - p) >= 5 * 60000) toast(`${n.label} moved ${n.start > p ? 'later' : 'earlier'} — now ~${hm(n.start)}`);
    if (!p || Math.abs(n.start - p) >= 5 * 60000) prevStart[n.key] = n.start;
  }
}
function toast(msg, kind) {
  const el = document.createElement('div'); el.className = 'toast ' + (kind || ''); el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 6000);
}

/* ---------------- phone push alerts (ntfy) ---------------- */
const rnd = () => Math.random().toString(36).slice(2, 8);
const slug = x => String(x || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 12);
function ensureTopics() {
  let changed = false;
  if (!S.ntfyTeam) { S.ntfyTeam = `${S.team}pit-team-${rnd()}`; changed = true; }
  if (!S.ntfyQueue) { S.ntfyQueue = `${S.team}pit-queue-${rnd()}`; changed = true; }
  if (!S.ntfyMe) { S.ntfyMe = `${S.team}pit-${slug(S.member) || 'me'}-${rnd()}`; changed = true; }
  if (S.ntfySend == null) { S.ntfySend = !!S.tv; changed = true; }
  if (changed) saveSettings();
}
const appUrl = () => location.href.split('#')[0].split('?')[0];
async function pushPhone(topic, title, message, opts = {}) {
  if (!S.ntfyOn || !topic) return false;
  const body = { topic, title, message: message || ' ', priority: opts.priority || 3, tags: opts.tags || [], click: appUrl() + '#matches' };
  if (opts.actions) body.actions = opts.actions;
  try {
    const r = await fetch(String(S.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '') + '/', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) throw new Error(r.status);
    return true;
  } catch (e) { toast('Phone alert not sent (' + e.message + ')', 'bad'); return false; }
}
// queue alerts + results go out only from the sending device (the pit TV), so phones get one copy
const pushQueue = (title, msg, prio, tags) => { if (S.ntfySend) pushPhone(S.ntfyQueue, title, msg, { priority: prio, tags }); };
const SD_MEMBERS = () => SD.members || {};
function topicFor(name) {
  const m = Object.values(SD_MEMBERS()).find(x => norm(x.name) === norm(name));
  return m && m.topic;
}
function ackAction(callId, name) {
  try {
    const cfg = parseFirebase(S.firebase);
    const url = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/teams/${S.team}/calls/${callId}?updateMask.fieldPaths=ack${cfg.apiKey ? '&key=' + cfg.apiKey : ''}`;
    const body = JSON.stringify({ fields: { ack: { mapValue: { fields: { by: { stringValue: name }, t: { integerValue: String(Date.now()) } } } } } });
    return { action: 'http', label: '🏃 On my way', url, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body, clear: true };
  } catch { return null; }
}
async function pushCall(id, to, reason, by) {
  const everyone = to === '*';
  const personal = !everyone && topicFor(to);
  const topic = personal || S.ntfyTeam;
  const title = `📣 ${everyone ? 'EVERYONE' : to.toUpperCase()} — BACK TO THE PIT NOW`;
  const actions = [{ action: 'view', label: 'Open app', url: appUrl() + '#matches' }];
  if (!everyone && Store.mode === 'cloud') { const a = ackAction(id, to); if (a) actions.unshift(a); }
  return pushPhone(topic, title, `${reason ? reason + ' · ' : ''}called by ${by}`, { priority: 5, tags: ['rotating_light'], actions });
}
function registerMember() {
  if (!S.member || !S.ntfyMe) return;
  Store.put('members', slug(S.member) || 'me', { name: S.member, topic: S.ntfyMe, t: Date.now() }).catch(() => { });
}

/* ---------------- call to pit ---------------- */
const CALL_TTL = 20 * 60000;
let callAlertId = null;
const norm = x => String(x || '').trim().toLowerCase();
function activeCalls() {
  const now = Date.now();
  return Object.entries(SD.calls || {}).map(([id, c]) => ({ id, ...c })).filter(c => !c.done && now - (c.t || 0) < CALL_TTL).sort((a, b) => b.t - a.t);
}
function callIsForMe(c) { return c.to === '*' || (S.member && norm(c.to) === norm(S.member)); }
function onCalls() {
  const isTV = !!S.tv;
  if (callAlertId && (SD.calls[callAlertId]?.done || SD.calls[callAlertId]?.ack)) { $('#alertBar').hidden = true; callAlertId = null; }
  for (const c of activeCalls()) {
    if (c.ack || c.done) { if (callAlertId === c.id) { $('#alertBar').hidden = true; callAlertId = null; } }
    if (c.ack) { if ((isTV || norm(c.by) === norm(S.member)) && once(`call:${c.id}:ack`)) toast(`✓ ${c.ack.by || c.to} is on the way to the pit`, 'good'); continue; }
    if ((callIsForMe(c) || isTV) && once(`call:${c.id}`)) {
      const who = c.to === '*' ? 'EVERYONE' : c.to.toUpperCase();
      const mine = callIsForMe(c); callAlertId = c.id;
      alertUser(`📣 ${who} — BACK TO THE PIT NOW`, `${c.reason ? c.reason + ' · ' : ''}called by ${c.by || '?'} at ${hm(c.t)}`, true, 'call-' + c.id,
        mine ? `<button class="ackbtn" data-act="call-ack" data-id="${esc(c.id)}">🏃 On my way</button>` : '');
    }
  }
  renderCallFab(); renderTop();
}
function renderCallFab() {
  const n = activeCalls().filter(c => !c.ack).length;
  const fab = $('#callFab'); if (!fab) return;
  fab.querySelector('.cfn').textContent = n ? n : '';
  fab.classList.toggle('live', n > 0);
}
function callModal() {
  const names = (S.roster || []).filter(Boolean);
  const list = activeCalls();
  openModal(`<div class="row"><h2 style="margin:0">📣 Call to pit</h2><span class="sp"></span><button class="btn small" data-act="modal-close">✕</button></div>
    <div class="muted small" style="margin:4px 0 10px">Their phone (and the pit TV) will alarm until they tap “On my way”.${Store.mode === 'cloud' ? '' : ' <b class="warn">Team sync is off — calls only show on this device.</b>'}</div>
    <label class="f">Who?</label>
    <div class="seg" id="callWho"><button class="on" data-act="call-pick" data-n="*">Everyone</button>${names.map(n => `<button data-act="call-pick" data-n="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    <input type="text" id="callName" placeholder="…or type a name" style="margin-top:8px">
    <label class="f">Why? (optional)</label>
    <div class="seg">${['Repair needed', 'Queue now', 'Drive team', 'Judges here', 'Meeting'].map(r => `<button data-act="call-reason" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
    <input type="text" id="callReason" placeholder="Reason" style="margin-top:8px">
    <button class="btn primary" data-act="call-send" style="width:100%;margin-top:14px;padding:14px;font-size:18px">📣 CALL NOW</button>
    ${list.length ? `<h3 style="margin-top:16px">Active calls</h3>${list.map(c => `<div class="row callrow"><b>${esc(c.to === '*' ? 'Everyone' : c.to)}</b>
      <span class="muted small">${esc(c.reason || '')} · ${hm(c.t)} by ${esc(c.by || '?')}</span><span class="sp"></span>
      ${c.ack ? `<span class="ok small">✓ ${esc(c.ack.by)} on the way</span>` : '<span class="warn small">waiting…</span>'}
      <button class="btn small" data-act="call-clear" data-id="${esc(c.id)}">Clear</button></div>`).join('')}` : ''}
    ${names.length ? '' : '<div class="muted small" style="margin-top:10px">Tip: add team members in Settings → Team members.</div>'}`);
}

/* ---------------- screen wake lock (TV) ---------------- */
let wakeLock = null;
async function keepAwake() {
  if (!document.body.classList.contains('tv') || !('wakeLock' in navigator) || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch { }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); refresh(true); } });

/* ---------------- modals ---------------- */
function openModal(html, cls) { const m = $('#modal'); m.innerHTML = `<div class="mbox ${cls || ''}">${html}</div>`; m.hidden = false; const f = m.querySelector('input,textarea'); if (f) setTimeout(() => f.focus(), 50); }
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

/* ---------------- actions ---------------- */
const who = () => S.member || 'someone';
const A = {
  'go': el => { location.hash = el.dataset.v; },
  'ntfy-copy': async el => {
    const v = S[el.dataset.k] || $(`[data-s="${el.dataset.k}"]`).value;
    try { await navigator.clipboard.writeText(v); toast('Copied: ' + v, 'good'); } catch { toast(v); }
  },
  'ntfy-test': async () => {
    readSettingsForm(false); ensureTopics();
    const ok = await pushPhone(S.ntfyMe, '✅ 1577 Pit test', `Phone alerts work for ${S.member || 'this phone'}`, { priority: 4, tags: ['white_check_mark'] });
    if (ok) toast('Test sent to your personal channel — check the ntfy app', 'good');
  },
  'ntfy-new': el => {
    if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = 'Tap again — everyone must re-subscribe'; return; }
    S.ntfyTeam = ''; S.ntfyQueue = ''; ensureTopics(); renderAll('nav'); toast('New team channels made — send the setup link again');
  },
  'call-open': () => { unlockAudio(); callModal(); },
  'call-pick': el => { el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); $('#callName').value = ''; },
  'call-reason': el => { $('#callReason').value = el.dataset.r; },
  'call-send': async () => {
    const typed = $('#callName').value.trim(), picked = $('#callWho button.on')?.dataset.n || '*';
    const to = typed || picked;
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    once(`call:${id}`);
    const reason = $('#callReason').value.trim();
    await Store.put('calls', id, { to, reason, by: who(), t: Date.now(), ack: null, done: false });
    closeModal(); toast(`📣 Called ${to === '*' ? 'everyone' : to} to the pit`, 'good');
    const sent = await pushCall(id, to, reason, who());
    if (sent && to !== '*' && !topicFor(to)) toast(`${to} has no personal channel yet — sent to the team channel`);
  },
  'call-ack': async el => { await Store.put('calls', el.dataset.id, { ack: { by: who(), t: Date.now() } }); $('#alertBar').hidden = true; toast('Sent: on my way 🏃', 'good'); },
  'call-clear': async el => { await Store.put('calls', el.dataset.id, { done: true }); callModal(); },
  'match': el => { openModal(matchDetail(el.dataset.k), 'wide'); },
  'alert-close': () => { $('#alertBar').hidden = true; },
  'sound-unlock': () => { unlockAudio(); setTimeout(() => beep(false), 150); },
  'fullscreen': () => { const d = document; (d.fullscreenElement ? d.exitFullscreen() : d.documentElement.requestFullscreen()).catch(() => { }); },
  'stream-pick': el => { S.streamIdx = +el.dataset.i; saveSettings(); renderStream(); },
  'stream-toggle': () => { S.streamCollapsed = !S.streamCollapsed; saveSettings(); renderStream(); },
  'chk-match': el => { checkSel = el.dataset.k; renderAll(); },
  'chk-item': async el => {
    const m = M.all.find(x => x.key === el.dataset.k); if (!m) return;
    const items = { ...(checkProgress(m).doc.items || {}) }, k = 'c' + el.dataset.i;
    items[k] = items[k] ? false : { by: who(), t: Date.now() };
    await Store.put(colCheck(), m.key, { items, label: m.label });
    if (checkProgress({ key: m.key }).done) { toast(`${m.label}: robot ready ✓`, 'good'); }
  },
  'chk-reset': async el => { const m = M.all.find(x => x.key === el.dataset.k); if (m) await Store.put(colCheck(), m.key, { items: {}, battery: null }); },
  'batt-add': () => openModal(`<h2>Add battery</h2>
    <label class="f">Battery number / name</label><input type="text" id="bName" placeholder="B07">
    <label class="f">Notes (year, brand…)</label><input type="text" id="bNotes" placeholder="2026 MK ES17-12">
    <div class="row" style="margin-top:14px"><span class="sp"></span><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="batt-add-save">Add</button></div>`),
  'batt-add-save': async () => {
    const name = $('#bName').value.trim(); if (!name) return;
    await Store.put('batteries', name.toUpperCase(), { name, notes: $('#bNotes').value.trim(), status: 'ready', since: Date.now(), readings: [], uses: [] });
    closeModal();
  },
  'batt-st': async el => { await Store.put('batteries', el.dataset.id, { status: el.dataset.s, since: Date.now() }); },
  'batt-read': el => {
    const b = SD.batteries[el.dataset.id]; if (!b) return;
    openModal(`<h2>Reading — ${esc(b.name)}</h2><div class="muted small">From the Battery Beak / analyzer.</div>
      <div class="row"><div style="flex:1"><label class="f">Voltage (V)</label><input type="number" step="0.01" id="rV" placeholder="13.05"></div>
      <div style="flex:1"><label class="f">Internal resistance (Ω)</label><input type="number" step="0.001" id="rIR" placeholder="0.012"></div></div>
      <div class="row" style="margin-top:14px"><span class="sp"></span><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="batt-read-save" data-id="${esc(el.dataset.id)}">Save</button></div>`);
  },
  'batt-read-save': async el => {
    const b = SD.batteries[el.dataset.id]; const v = parseFloat($('#rV').value), ir = parseFloat($('#rIR').value);
    if (!b || (isNaN(v) && isNaN(ir))) return;
    const readings = [...(b.readings || []), { t: Date.now(), v: isNaN(v) ? null : v, ir: isNaN(ir) ? null : ir, by: who() }].slice(-30);
    await Store.put('batteries', el.dataset.id, { readings }); closeModal();
  },
  'batt-more': el => {
    const b = SD.batteries[el.dataset.id]; if (!b) return;
    const uses = (b.uses || []).slice(-8).reverse();
    openModal(`<h2>${esc(b.name)}</h2>
      <label class="f">Notes</label><input type="text" id="bNotes2" value="${esc(b.notes || '')}">
      <label class="f">Recent matches</label><div class="small">${uses.map(u => `${esc(u.label || u.m)} · ${hm(u.t)}`).join('<br>') || '<span class="muted">none</span>'}</div>
      <div class="row" style="margin-top:14px">
        <button class="btn small" data-act="batt-st" data-id="${esc(el.dataset.id)}" data-s="${b.status === 'retired' ? 'resting' : 'retired'}">${b.status === 'retired' ? 'Un-retire' : 'Retire'}</button>
        <button class="btn small danger" data-act="batt-del" data-id="${esc(el.dataset.id)}">Delete</button>
        <span class="sp"></span><button class="btn primary" data-act="batt-notes-save" data-id="${esc(el.dataset.id)}">Save</button></div>`);
  },
  'batt-notes-save': async el => { await Store.put('batteries', el.dataset.id, { notes: $('#bNotes2').value.trim() }); closeModal(); },
  'batt-del': async el => {
    if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = 'Tap again to delete'; return; }
    await Store.del('batteries', el.dataset.id); closeModal();
  },
  'db-open': el => {
    const m = M.all.find(x => x.key === el.dataset.k); if (!m) return;
    const d = SD.debrief[safeId(m.key)] || {};
    openModal(`<h2>Debrief — ${esc(m.label)}</h2>${m.result ? `<div><span class="res ${m.result}">${m.result} ${m.us}-${m.them}</span></div>` : ''}
      <label class="f">How did the robot do?</label><div class="seg" id="dbRate">${[1, 2, 3, 4, 5].map(n => `<button data-act="db-rate" data-n="${n}" class="${d.rating === n ? 'on' : ''}">${'★'.repeat(n)}</button>`).join('')}</div>
      <label class="f">What worked</label><textarea id="dbWorked">${esc(d.worked || '')}</textarea>
      <label class="f">What broke / needs fixing</label><textarea id="dbBroke">${esc(d.broke || '')}</textarea>
      <label class="f">Driver / strategy notes</label><textarea id="dbDriver">${esc(d.driver || '')}</textarea>
      <label class="f">Written by</label><input type="text" id="dbBy" value="${esc(d.by || S.member || '')}">
      <div class="row" style="margin-top:14px"><span class="sp"></span><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="db-save" data-k="${esc(m.key)}">Save</button></div>`);
  },
  'db-rate': el => { el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); },
  'db-save': async el => {
    const m = M.all.find(x => x.key === el.dataset.k); if (!m) return;
    const on = $('#dbRate button.on');
    await Store.put(colDebrief(), m.key, {
      label: m.label, rating: on ? +on.dataset.n : null, worked: $('#dbWorked').value.trim(), broke: $('#dbBroke').value.trim(),
      driver: $('#dbDriver').value.trim(), by: $('#dbBy').value.trim() || who(), t: Date.now()
    });
    closeModal(); toast('Debrief saved', 'good');
  },
  'modal-close': closeModal,
  'md-check': el => { checkSel = el.dataset.k; closeModal(); location.hash = 'checklist'; },
  'test-alert': () => { unlockAudio(); setTimeout(() => alertUser('QUEUE NOW — Qual 12', 'RED bumpers · station 2 (test)', true, 'test'), 150); },
  'notify-perm': async () => {
    if (!('Notification' in window)) { toast('This browser has no notifications. On iPhone: Share → Add to Home Screen first.', 'bad'); return; }
    const p = await Notification.requestPermission(); S.notify = p === 'granted'; saveSettings(); renderAll('nav');
  },
  'find-events': async () => {
    readSettingsForm(false);
    const out = $('#evFind'), list = $('#evList');
    if (!S.tbaKey.trim()) { out.textContent = 'Add the TBA key first.'; return; }
    out.textContent = 'Loading…';
    try {
      const evs = (await tba(`/team/frc${S.team}/events/${S.year}/simple`)).sort((a, b) => a.start_date.localeCompare(b.start_date));
      out.textContent = evs.length ? 'Tap your event:' : `No ${S.year} events for team ${S.team} on TBA yet.`;
      list.innerHTML = `<div class="seg" style="margin-top:8px">${evs.map(e => `<button data-act="pick-event" data-k="${esc(e.key)}">${esc(e.short_name || e.name)} · ${esc(e.start_date)}</button>`).join('')}</div>`;
    } catch (e) { out.textContent = 'TBA error: ' + e.message; }
  },
  'pick-event': el => { const i = $('[data-s="eventKey"]'); i.value = el.dataset.k; const d = $('[data-s="demo"]'); if (d) d.checked = false; toast('Event set — press Save'); },
  'test-apis': async () => {
    readSettingsForm(false);
    const out = $('#apiTest'); out.innerHTML = 'Testing…';
    const ev = String(S.eventKey || '').trim();
    const res = await Promise.all([
      tba('/status').then(() => '<span class="ok">✓ The Blue Alliance</span>', e => `<span class="bad">✗ The Blue Alliance (${esc(e.message)})</span>`),
      sbApi('/').then(() => '<span class="ok">✓ Statbotics</span>', e => `<span class="bad">✗ Statbotics (${esc(e.message)})</span>`),
      S.nexusKey.trim() ? (ev ? nexusApi(ev).then(() => '<span class="ok">✓ Nexus</span>', e => `<span class="bad">✗ Nexus (${esc(e.message)})</span>`) : Promise.resolve('<span class="warn">Nexus: set an event key to test</span>')) : Promise.resolve('<span class="muted">Nexus: no key (optional)</span>')
    ]);
    out.innerHTML = res.join('<br>');
  },
  'copy-setup': async () => {
    readSettingsForm(false);
    const pick = Object.fromEntries(SHARE_KEYS.map(k => [k, S[k]]));
    const code = btoa(unescape(encodeURIComponent(JSON.stringify(pick)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const link = location.href.split('#')[0] + '#setup=' + code;
    try { await navigator.clipboard.writeText(link); toast('Setup link copied — send it to the team', 'good'); }
    catch { $('#setupOut').innerHTML = `<label class="f">Copy this link</label><textarea readonly onclick="this.select()">${esc(link)}</textarea>`; }
  },
  'save-settings': () => readSettingsForm(true)
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = A[el.dataset.act]; if (!fn || el.tagName === 'SELECT') return;
  e.preventDefault(); fn(el, e);
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.act === 'chk-batt') {
    const m = M.all.find(x => x.key === el.dataset.k); if (!m) return;
    const id = el.value || null;
    await Store.put(colCheck(), m.key, { battery: id, label: m.label });
    if (id) {
      const b = SD.batteries[id] || {};
      const uses = (b.uses || []).filter(u => !(u.m === m.key && u.ev === evKey()));
      uses.push({ m: m.key, ev: evKey(), label: m.label, t: Date.now() });
      await Store.put('batteries', id, { status: 'robot', since: Date.now(), uses: uses.slice(-200) });
    }
  }
});

/* ---------------- settings form ---------------- */
function readSettingsForm(apply) {
  const before = JSON.stringify([evKey(), S.team, S.tbaKey, S.nexusKey]), fbBefore = S.firebase;
  document.querySelectorAll('[data-s]').forEach(el => {
    const k = el.dataset.s;
    if (el.type === 'checkbox') S[k] = el.checked;
    else if (el.type === 'number') S[k] = el.value === '' ? S[k] : +el.value;
    else if (k === 'checklist' || k === 'roster') S[k] = el.value.split('\n').map(x => x.trim()).filter(Boolean);
    else S[k] = el.value.trim();
  });
  S.eventKey = String(S.eventKey || '').toLowerCase();
  if (!apply) return;
  ensureTopics(); saveSettings(); registerMember();
  if (S.firebase !== fbBefore) { location.hash = 'matches'; location.reload(); return; }
  if (JSON.stringify([evKey(), S.team, S.tbaKey, S.nexusKey]) !== before) {
    D = emptyData(); curSrc = null; prevPlayed = null; subscribeShared(); refresh(true);
  }
  toast('Saved', 'good');
  location.hash = 'matches';
}
function applySetupCode(code) {
  try {
    const json = decodeURIComponent(escape(atob(code.replace(/-/g, '+').replace(/_/g, '/'))));
    const obj = JSON.parse(json);
    SHARE_KEYS.forEach(k => { if (k in obj) S[k] = obj[k]; });
    saveSettings(); LS.set('pit.cache', null);
    history.replaceState(null, '', location.pathname + '#settings');
    location.reload();
  } catch { toast('That setup link is broken', 'bad'); location.hash = 'matches'; }
}

/* ---------------- refresh loop + ticker ---------------- */
let busy = false, lastTBA = 0, lastSB = 0;
async function refresh(force) {
  if (busy) return; busy = true;
  try {
    if (S.demo) D = demoData();
    else {
      const t = Date.now(), jobs = [];
      if (force === true || t - lastTBA > 55000) { lastTBA = t; jobs.push(refreshTBA()); }
      jobs.push(refreshNexus());
      if (force === true || t - lastSB > 290000) { lastSB = t; jobs.push(refreshSB()); }
      await Promise.all(jobs); saveCache();
    }
  } finally { busy = false; }
  M = buildModel(); detectChanges(); renderAll(); checkAlerts();
}
let tickN = 0;
function tick() {
  const now = Date.now();
  const d = new Date(now);
  $('#clock').innerHTML = `<span class="cdate">${esc(d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }))}</span><span class="ctime">${pad(d.getHours())}:${pad(d.getMinutes())}<span class="csec">:${pad(d.getSeconds())}</span></span>`;
  document.querySelectorAll('[data-cd]').forEach(el => { el.textContent = fmtCD(+el.dataset.cd - now); });
  document.querySelectorAll('[data-el]').forEach(el => { el.textContent = fmtEl(now - +el.dataset.el); });
  if (++tickN % 15 === 0) renderAll(); // re-evaluate states (queue now, charged, etc.)
  checkAlerts();
}
window.addEventListener('online', () => refresh(true));
window.addEventListener('offline', renderTop);

/* ---------------- boot ---------------- */
(async function boot() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
  route();
  ensureTopics();
  await Store.init();
  subscribeShared();
  registerMember();
  await refresh(true);
  setInterval(refresh, 20000);
  setInterval(tick, 1000); tick();
})();
