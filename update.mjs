// =====================================================================
//  Delta Force Streamer Ladder S2 — Discord 頻道排名更新
//  Delta Force Streamer Ladder S2 — Discord channel rank updater
//  OBS overlay 本體 / The OBS overlay itself: https://github.com/derder2000/deltaforce-ladder-overlay
//
//  每次執行：抓一次官方排名 → 編輯 Discord 頻道裡「同一則」訊息（不會洗版）
//  Each run fetches the official ladder once and edits ONE Discord message in place.
//
//  設定（環境變數）/ Settings (environment variables):
//    DISCORD_WEBHOOK_URL  必填，Discord 頻道的 Webhook 網址（機密！）/ required, keep secret
//    PLAYER               必填，要追蹤的實況主暱稱或玩家 ID / required, nickname or player ID
//    LANGUAGE             選填，預設 zh-TW（跟 overlay 一樣的 16 種語言）/ optional, default zh-TW
//    DISCORD_MESSAGE_ID   選填，要編輯的訊息 ID；第一次執行會自動建立並印出 / optional
//
//  需要 Node.js 18 以上，不需要安裝任何套件 / Requires Node.js 18+, no dependencies
// =====================================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = process.env;
const WEBHOOK = (ENV.DISCORD_WEBHOOK_URL || '').trim();
const PLAYER = (ENV.PLAYER || '').trim();
const LANG_PREF = (ENV.LANGUAGE || 'zh-TW').trim();
const IN_ACTIONS = ENV.GITHUB_ACTIONS === 'true';
// 在自己電腦上跑時，訊息 ID 記在這個檔案（已加進 .gitignore）/ local runs remember the message ID here
const ID_FILE = join(HERE, '.message-id');
// 翻譯直接讀 OBS overlay 專案裡的 overlay.html，兩邊永遠同一份 / translations come from the overlay repo
const OVERLAY_SOURCE = ENV.OVERLAY_SOURCE || 'https://raw.githubusercontent.com/derder2000/deltaforce-ladder-overlay/main/overlay.html';

// 官方排名介面（跟 overlay.html 相同）/ same endpoint as overlay.html
const API = ENV.LADDER_API_URL || 'https://sg-apps.vasdgame.com/ide/';
const BODY = new URLSearchParams({
  iChartId: '100017209', sIdeToken: 'IKJtRZ', instanceid: '4012871',
  method: 'streamer.rank', from_source: '2',
  param: JSON.stringify({ loginType: 0, streamerType: 0, seasonId: 'default' }),
}).toString();
const EVENT_URL = 'https://www.playdeltaforce.com/act/streamerladderS2/index.html';

// 注意：公開專案的 Actions 紀錄任何人都看得到，所以這裡只印「狀態」，不印暱稱、名次或分數
// Public repos have public Action logs: never print the nickname, rank or score.
const log = (...a) => console.log('[discord-rank]', ...a);

// fail = 需要你處理的問題（Webhook 失效、沒設定實況主…），GitHub 會寄信通知
// warn = 暫時性問題（官方伺服器沒回應），下次自動重試，不寄信、不算失敗
function fail(msg) { log('✗', msg); process.exitCode = 1; }
function warn(msg) { IN_ACTIONS ? console.log(`::warning::${msg}`) : log('⚠', msg); }

// ---------- 從 overlay 專案的 overlay.html 讀翻譯 / reuse overlay.html translations ----------
async function loadTranslations() {
  let src;
  if (/^https?:/.test(OVERLAY_SOURCE)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(OVERLAY_SOURCE, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      src = await res.text();
    } finally { clearTimeout(timer); }
  } else {
    src = readFileSync(OVERLAY_SOURCE, 'utf8');   // 也可以指定本機的 overlay.html 路徑 / or a local path
  }
  const grab = (name) => {
    const start = src.indexOf(`const ${name} = {`);
    if (start < 0) throw new Error(`overlay.html 裡找不到 ${name}`);
    const open = src.indexOf('{', start);
    let depth = 0, i = open, q = null;
    for (; i < src.length; i++) {             // 找到對應的右大括號（略過字串內容）
      const c = src[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    // 這是本專案自己的 overlay.html（純文字表格），只當資料讀取
    return new Function(`return (${src.slice(open, i + 1)});`)();
  };
  return { I18N: grab('I18N'), REGION_NAMES: grab('REGION_NAMES') };
}

function resolveLang(pref, I18N) {
  const t = String(pref).replace('_', '-').toLowerCase();
  if (t === 'zh-tw' || t === 'zh-hk' || t.startsWith('zh-hant')) return 'zh-TW';
  if (t.startsWith('zh')) return 'zh-CN';
  const base = t.split('-')[0];
  return I18N[base] ? base : 'en';
}

// ---------- 官方排名 / ladder ----------
async function fetchLadder() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(API, {
      method: 'POST', body: BODY, signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'deltaforce-ladder-overlay (discord updater)' },
    });
    if (!res.ok) throw new Error('排名伺服器回應 HTTP ' + res.status);
    const j = await res.json();
    const d = j?.jData?.data;
    if (j.iRet !== 0 || !d || d.code !== 0 || !Array.isArray(d.data?.list)) throw new Error('排名資料格式不對 / unexpected ladder response');
    return d.data;
  } finally { clearTimeout(timer); }
}

// ---------- Discord ----------
function webhookParts(url) {
  const m = url.match(/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/(\d+)\/([\w-]+)/);
  if (!m) throw new Error('DISCORD_WEBHOOK_URL 格式不對（應該是 https://discord.com/api/webhooks/... ）');
  const api = ENV.DISCORD_API_BASE || 'https://discord.com/api';   // DISCORD_API_BASE 只在測試時使用 / test-only override
  return { id: m[1], token: m[2], base: `${api}/webhooks/${m[1]}/${m[2]}` };
}
async function discord(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 429) {                    // 被限速就等一下再試一次
    const wait = Math.min(10, Number((await res.json().catch(() => ({}))).retry_after) || 2);
    await new Promise(r => setTimeout(r, wait * 1000));
    return discord(method, url, body);
  }
  return res;
}

// 上一次的名次記在標題連結的 #後面（畫面上看不到），不需要額外存檔
// The previous rank is stored after "#" in the title link (invisible), so no extra storage is needed.
function readState(msg) {
  const url = msg?.embeds?.[0]?.url || '';
  const m = url.match(/#r(\d+)(?:,(up|down)(\d+))?$/);
  return m ? { rank: Number(m[1]), dir: m[2] || '', diff: Number(m[3] || 0) } : null;
}

// ---------- 組出 Discord 訊息（內容和 overlay 相同）/ build the embed ----------
function buildEmbed({ list, total }, prev, T) {
  const { I18N, REGION_NAMES, LANG } = T;
  const t = (k, v = {}) => String(I18N[LANG]?.[k] ?? I18N.en[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');
  const loc = LANG === 'ar' ? 'ar-u-nu-latn' : LANG;
  const fmt = n => Number(n || 0).toLocaleString(loc);
  const fmtBig = n => { try { return new Intl.NumberFormat(loc, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n || 0)); } catch { return fmt(n); } };
  const esc = s => String(s ?? '').replace(/([\\*_`~|>#\[\]()])/g, '\\$1');
  const gap = d => (d === 0 ? '±0' : (d < 0 ? '-' : '+') + fmt(Math.abs(d)));
  const title = t('title');

  list = [...list].sort((a, b) => a.rank - b.rank);
  const p = PLAYER.toLowerCase();
  const me = list.find(x => String(x.gopenid) === PLAYER) || list.find(x => String(x.nickname).toLowerCase() === p);

  if (!me) {
    // overlay 的提示會說「請檢查 config.js」，Discord 這邊的設定不在 config.js，所以只留前半句
    const msg = t('notFound', { name: PLAYER }).replace(/\s*(?:[，。,:：—–]|\. )\s*[^，。,:：—–]*config\.js[\s\S]*$/, '');
    const keep = prev ? `#r${prev.rank}${prev.dir ? `,${prev.dir}${prev.diff}` : ''}` : '';   // 保留上次的名次記錄
    return { title, url: EVENT_URL + keep, color: 0xff5c5c, description: '❓ ' + msg, timestamp: new Date().toISOString() };
  }

  const i = list.indexOf(me), above = list[i - 1], below = list[i + 1];
  let change = prev && prev.rank !== me.rank
    ? { dir: me.rank < prev.rank ? 'up' : 'down', diff: Math.abs(prev.rank - me.rank) }
    : (prev ? { dir: prev.dir, diff: prev.diff } : { dir: '', diff: 0 });
  const arrow = change.dir ? (change.dir === 'up' ? ' ▲' : ' ▼') + change.diff : '';
  const medal = ['', '🥇 ', '🥈 ', '🥉 '][me.rank] || '';
  const colors = { 1: 0xf4cf67, 2: 0xd7dde2, 3: 0xe0995e };

  const region = String(me.region || '').trim().toUpperCase();
  let regionLine = '';
  if (region) {
    const rr = list.filter(x => String(x.region || '').trim().toUpperCase() === region).indexOf(me) + 1;
    regionLine = t('regionRank', { region: REGION_NAMES[LANG]?.[region] ?? REGION_NAMES.en[region] ?? region, r: rr });
  }

  // null = 這一行不顯示；'' = 段落之間的空行
  const lines = [
    `# ${medal}#${me.rank} / ${total || list.length}${arrow}`,
    regionLine ? `**${regionLine}**` : null,
    `${t('rating')}　**${fmt(me.eloScore)}**`,
    '',
    above ? `${t('above', { r: above.rank })}　${esc(above.nickname)}　**${gap(me.eloScore - above.eloScore)}**` : `**${t('first')}**`,
    below ? `${t('below', { r: below.rank })}　${esc(below.nickname)}　**${gap(me.eloScore - below.eloScore)}**` : null,
    '',
    `${t('kills')} **${fmt(me.killCnt)}**　${t('matches')} **${fmt(me.matchCnt)}**　${t('value')} **${fmtBig(me.carryOutValue)}**`,
  ].filter(l => l !== null);

  const state = `#r${me.rank}${change.dir ? `,${change.dir}${change.diff}` : ''}`;
  return {
    title,
    url: EVENT_URL + state,
    color: colors[me.rank] || 0x0ff796,       // 官方綠；前三名金 / 銀 / 銅
    author: { name: me.nickname, icon_url: me.avatar || undefined },
    thumbnail: me.avatar ? { url: me.avatar } : undefined,
    description: lines.join('\n').trim(),
    timestamp: new Date().toISOString(),       // Discord 會自動用每個人的時區顯示「最後更新時間」
  };
}

// ---------- 主流程 / main ----------
async function main() {
  if (!WEBHOOK) {
    // 別人 fork 這個專案、沒設定 Webhook 時，安靜跳過，不算失敗
    log('沒有設定 DISCORD_WEBHOOK_URL，跳過。/ DISCORD_WEBHOOK_URL not set, skipping.');
    return;
  }
  if (!PLAYER) return fail('沒有設定 PLAYER（要追蹤的實況主）。/ PLAYER is not set.');

  const hook = webhookParts(WEBHOOK);
  let I18N, REGION_NAMES;
  try { ({ I18N, REGION_NAMES } = await loadTranslations()); }
  catch (e) { return warn('讀不到 overlay 的翻譯檔，頻道訊息維持原樣，下次再試：' + (e.name === 'AbortError' ? '連線逾時' : e.message)); }
  const LANG = resolveLang(LANG_PREF, I18N);

  let messageId = (ENV.DISCORD_MESSAGE_ID || '').trim();
  if (!messageId && !IN_ACTIONS && existsSync(ID_FILE)) messageId = readFileSync(ID_FILE, 'utf8').trim();

  // 讀上一次的訊息，拿到上一次的名次（用來顯示 ▲▼）
  // 在 GitHub 上定時執行、但還沒設定訊息 ID 時不要發新訊息，不然每次執行都會多一則（洗版）
  if (!messageId && IN_ACTIONS && ENV.GITHUB_EVENT_NAME === 'schedule') {
    log('還沒設定 DISCORD_MESSAGE_ID，定時執行先跳過。請先到 Actions 手動執行一次（Run workflow）建立訊息。');
    log('DISCORD_MESSAGE_ID is not set yet; skipping scheduled run. Run the workflow manually once to create the message.');
    return;
  }

  let prev = null;
  if (messageId) {
    const r = await discord('GET', `${hook.base}/messages/${messageId}`);
    if (r.ok) prev = readState(await r.json());
    else if (r.status === 404) { log('找不到原本的訊息（可能被刪掉了），會重新建立一則。'); messageId = ''; }
    else return fail('讀取 Discord 訊息失敗，HTTP ' + r.status + '（Webhook 網址可能已失效）');
  }

  let ladder;
  try { ladder = await fetchLadder(); }
  catch (e) {
    // 官方伺服器沒回應：保留頻道裡原本的訊息，不覆蓋，下次再試
    return warn('抓不到官方排名，頻道訊息維持原樣，下次再試：' + (e.name === 'AbortError' ? '連線逾時' : e.message));
  }

  const payload = { content: '', embeds: [buildEmbed(ladder, prev, { I18N, REGION_NAMES, LANG })], allowed_mentions: { parse: [] } };

  if (messageId) {
    const r = await discord('PATCH', `${hook.base}/messages/${messageId}`, payload);
    if (!r.ok) return fail('更新 Discord 訊息失敗，HTTP ' + r.status);
    log('✓ 已更新頻道訊息 / message updated');
  } else {
    const r = await discord('POST', `${hook.base}?wait=true`, payload);
    if (!r.ok) return fail('發送 Discord 訊息失敗，HTTP ' + r.status);
    const msg = await r.json();
    if (!IN_ACTIONS) writeFileSync(ID_FILE, msg.id);
    log('✓ 已在頻道建立排名訊息 / message created');
    log(`  訊息 ID / message ID: ${msg.id}`);
    if (IN_ACTIONS) log('  ➜ 請到 GitHub 專案 Settings → Secrets and variables → Actions → Variables，新增 DISCORD_MESSAGE_ID =', msg.id);
  }
}

main().catch(e => fail(e.message));
