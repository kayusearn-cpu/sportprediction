'use strict';

/*
 * Football prediction scraper.
 *
 * Pipeline (runs on boot, then every REFRESH_MINUTES):
 *   1. Scrape today/yesterday/tomorrow from pitchpredictions via plain HTTPS (no Browserless),
 *      plus an optional primary source (Forebet) via Browserless if its token+proxy work.
 *   2. Merge results into an in-memory cache (also persisted to disk).
 *   3. Re-infer each match's status from kickoff time so Live/Upcoming/Past all populate.
 *   4. Serve everything to your website at /api/scores.
 *
 * Env variables:
 *   PORT                 web port (Railway sets this automatically)
 *   REFRESH_MINUTES      how often to re-scrape (default 20)
 *   TARGET_URL           optional primary page (e.g. Forebet) - tried first via Browserless
 *   FALLBACK_URL         pitchpredictions URL (default https://www.pitchpredictions.com)
 *   ONLY_WITH_ODDS       "true" (default) = hide amateur upcoming matches w/o real odds
 *   CACHE_FILE           where to persist the cache (default /tmp/sportprediction-cache.json)
 *   BROWSERLESS_TOKEN    only needed for TARGET_URL (Forebet) — pp doesn't use it
 *   BROWSERLESS_HOST     default chrome.browserless.io
 *   BROWSERLESS_PROXY    set "residential" to clear Cloudflare on the primary
 *   OPENAI_API_KEY       only needed for TARGET_URL (Forebet has no JSON)
 *   OPENAI_MODEL         default gpt-4o-mini
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_ID / ADMIN_KEY   optional bot/manual controls
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const REFRESH_MINUTES = parseInt(process.env.REFRESH_MINUTES || '20', 10);
const TARGET_URL = process.env.TARGET_URL || 'https://www.forebet.com/en/football-tips-and-predictions-for-today';
const FALLBACK_URL = process.env.FALLBACK_URL || 'https://www.pitchpredictions.com';
const ONLY_WITH_ODDS = (process.env.ONLY_WITH_ODDS || 'true').toLowerCase() !== 'false';

const BROWSERLESS_HOST = process.env.BROWSERLESS_HOST || 'chrome.browserless.io';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Cache file — survives process restarts. /tmp gets wiped on a NEW Railway deploy but kept
// across in-place restarts. For full deploy-persistence add a Railway Volume and set
// CACHE_FILE=/data/cache.json (or wherever you mount it).
const CACHE_FILE = process.env.CACHE_FILE || '/tmp/sportprediction-cache.json';

// In-memory cache. Updated incrementally (NOT wiped) so finished matches survive long
// enough to populate the Past section.
const store = { matches: {}, preds: {} };
const status = { lastRun: null, lastOk: null, lastError: null, lastCount: 0, running: false, source: null };

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.matches && data.preds) {
      store.matches = data.matches;
      store.preds = data.preds;
      console.log(`[cache] loaded ${Object.keys(store.matches).length} matches from ${CACHE_FILE}`);
    }
  } catch (e) { /* no cache yet, or invalid — start fresh */ }
}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(store)); }
  catch (e) { console.error('[cache] save failed:', e.message); }
}

function matchKey(home, away) {
  return `${(home || '').trim().toLowerCase()}|${(away || '').trim().toLowerCase()}`;
}

// Minimal promise wrapper around https. Returns { status, text }.
function httpRequest(method, urlString, { headers = {}, body = null, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = Object.assign({}, headers);
    if (payload != null) {
      h['Content-Length'] = Buffer.byteLength(payload);
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    }
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers: h },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, text: raw }));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('Request timed out')));
    if (payload != null) req.write(payload);
    req.end();
  });
}

// Step 1: render a page in a cloud browser. Only used for sites that need JS (e.g. Forebet).
async function fetchPageHTML(targetUrl, useProxy) {
  if (!BROWSERLESS_TOKEN) throw new Error('BROWSERLESS_TOKEN not set');
  let url = `https://${BROWSERLESS_HOST}/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  const bproxy = process.env.BROWSERLESS_PROXY || '';
  if (useProxy && bproxy) {
    url += `&proxy=${encodeURIComponent(bproxy)}&proxySticky=true`;
    if (process.env.PROXY_COUNTRY) url += `&proxyCountry=${encodeURIComponent(process.env.PROXY_COUNTRY)}`;
  }
  const payload = { url: targetUrl, gotoOptions: { waitUntil: 'networkidle2', timeout: 45000 } };
  const { status: code, text } = await httpRequest('POST', url, { body: payload });
  if (code !== 200) throw new Error(`Browserless HTTP ${code}: ${text.slice(0, 200)}`);
  if (!text || text.length < 200) throw new Error('Browserless returned empty/short HTML');
  return text;
}

// Detect a Cloudflare "Just a moment" interstitial so we can skip extraction on it.
function isCloudflareChallenge(html) {
  return /just a moment|challenge-platform|cf-browser-verification|cf_chl_/i.test(html) && html.length < 80000;
}

// Plain HTTPS fetch with a browser User-Agent. Used for sites that don't need JS rendering
// (like pitchpredictions, which server-renders all match data into __NEXT_DATA__). Free
// and ~10x faster than going through Browserless.
async function fetchPageDirect(targetUrl) {
  const { status: code, text } = await httpRequest('GET', targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (code !== 200) throw new Error(`Direct HTTP ${code}: ${text.slice(0, 200)}`);
  if (!text || text.length < 200) throw new Error('Direct fetch returned empty/short HTML');
  return text;
}

// Strip scripts/styles/markup so the OpenAI parser sees real content, not 600KB of noise.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(div|p|li|tr|table|section|article|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// 1X2 pick from probabilities.
function predFrom(h, d, a) {
  const max = Math.max(h, d, a);
  if (max <= 0) return '';
  return max === h ? '1' : max === a ? '2' : 'X';
}

// Time-based status inference — source data is unreliable, so we infer NS/LIVE/FT
// from the kickoff time instead of trusting whatever the source says.
function effectiveStatus(date, time, sourceStatus) {
  if (sourceStatus === 'FT') return 'FT';
  if (!date || !time) return sourceStatus || 'NS';
  const t = Date.parse(`${date}T${time}:00Z`);
  if (isNaN(t)) return sourceStatus || 'NS';
  const minutesPast = (Date.now() - t) / 60000;
  if (minutesPast < 0) return 'NS';
  if (minutesPast < 150) return 'LIVE';
  return 'FT';
}

// Extract matches from pitchpredictions' Next.js __NEXT_DATA__ JSON (server-rendered).
function extractFromNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return []; }
  const rows = data && data.props && data.props.pageProps && data.props.pageProps.initialData;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    // Date/time from match.datetime (ISO with timezone) or fall back to match.unformatted_date.
    const dt = r.match && r.match.datetime ? new Date(r.match.datetime) : null;
    const date = (r.match && r.match.unformatted_date) || (dt && !isNaN(dt) ? dt.toISOString().substring(0, 10) : '');
    const time = dt && !isNaN(dt) ? dt.toISOString().substring(11, 16) : '';

    // 1X2 model probabilities (already 0-100).
    const p1x2 = (r.predictions && r.predictions['1x2']) || {};
    const h = parseInt(p1x2.home, 10) || 0;
    const d = parseInt(p1x2.draw, 10) || 0;
    const a = parseInt(p1x2.away, 10) || 0;
    const hasOdds = parseFloat(r.odds && r.odds.home) > 0;
    const prediction = predFrom(h, d, a);

    // Live/final score (null until kickoff).
    const liveHome = r.score && r.score.home;
    const liveAway = r.score && r.score.away;
    const liveScore = liveHome != null && liveAway != null ? `${liveHome}-${liveAway}` : '';

    // Normalize source status into NS/LIVE/FT.
    const srcS = String((r.match && r.match.status) || '').toUpperCase();
    let status;
    if (['NS', 'TBD', 'PST'].includes(srcS)) status = 'NS';
    else if (['FT', 'AET', 'PEN'].includes(srcS)) status = 'FT';
    else if (srcS) status = 'LIVE';
    else status = liveHome != null ? 'LIVE' : 'NS';

    // Over/Under 2.5 tip from the model.
    const ouPred = r.predictions && r.predictions.over_under_2_5 && r.predictions.over_under_2_5.prediction;
    const ou = ouPred === 'Ov2.5' ? 'Over 2.5' : ouPred === 'Un2.5' ? 'Under 2.5' : '';
    const winText = prediction === '1' ? 'Home Win' : prediction === '2' ? 'Away Win' : prediction === 'X' ? 'Draw' : '';

    return {
      date,
      time,
      homeTeam: (r.home_team && r.home_team.name) || '',
      awayTeam: (r.away_team && r.away_team.name) || '',
      score: liveScore,
      status,
      league: (r.league && r.league.name) || '',
      prediction,
      correctScore: '', // new pp schema doesn't expose correct-score odds
      probHome: h,
      probDraw: d,
      probAway: a,
      advice: [winText, ou].filter(Boolean).join(' · '),
      hasOdds,
    };
  });
}

// Try the structured JSON first; fall back to AI text-extraction (used for Forebet).
async function extractPredictions(html) {
  const fromJson = extractFromNextData(html);
  if (fromJson.length) {
    console.log(`[extract] __NEXT_DATA__ -> ${fromJson.length} matches`);
    return fromJson;
  }
  if (!OPENAI_KEY) return [];
  console.log('[extract] no __NEXT_DATA__ matches; using OpenAI parser');
  return extractWithOpenAI(html);
}

// AI parser used for sites without a JSON feed (e.g. Forebet).
async function extractWithOpenAI(html) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  const sys = `You extract football (soccer) match predictions from raw HTML.
Return ONLY a JSON object of the form { "matches": [ ... ] }.
Each match object must have these keys (use empty string "" when unknown):
- "date"          match date as YYYY-MM-DD
- "time"          kickoff time as HH:MM (24h)
- "homeTeam" / "awayTeam"
- "score"         current or final score like "1-2"; "" if not started
- "status"        one of "NS", "LIVE", "FT"
- "league"
- "prediction"    one of "1", "X", "2"
- "correctScore"  e.g. "2-1"; "" if none
- "probHome" / "probDraw" / "probAway"  integers 0-100
- "advice"        short tip text
Only include real matches found in the HTML. Never invent data.`;
  let userText = htmlToText(html);
  if (userText.length < 500) userText = html;
  const body = {
    model: OPENAI_MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: userText.slice(0, 100000) }],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 4000,
  };
  const { status: code, text } = await httpRequest('POST', 'https://api.openai.com/v1/chat/completions', {
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body,
  });
  if (code !== 200) throw new Error(`OpenAI HTTP ${code}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const content = data.choices && data.choices[0] && data.choices[0].message.content;
  const parsed = JSON.parse(content || '{}');
  const arr = Array.isArray(parsed) ? parsed : parsed.matches || parsed.predictions || [];
  return arr.map((x) => ({ ...x, hasOdds: true }));
}

function clampPct(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}
function parseScore(score, idx) {
  if (!score || typeof score !== 'string') return null;
  const m = score.match(/(\d+)\s*[-:]\s*(\d+)/);
  return m ? parseInt(m[idx + 1], 10) : null;
}

// Scrape multiple pages, merge into cache, re-infer status by time, evict old, persist.
async function runScrape(trigger = 'scheduler') {
  if (status.running) { console.log('[scrape] already running, skipping'); return { skipped: true }; }
  status.running = true;
  status.lastRun = new Date().toISOString();
  console.log(`[scrape] start (${trigger})`);
  try {
    // useBrowser=true uses Browserless (needed for JS/Cloudflare sites like Forebet).
    // useBrowser=false uses plain HTTPS — pitchpredictions is server-rendered, no browser needed.
    const PP = 'https://www.pitchpredictions.com';
    const sources = [
      { name: 'primary',   url: TARGET_URL,                                useBrowser: true,  useProxy: true  },
      { name: 'today',     url: FALLBACK_URL || PP,                         useBrowser: false },
      { name: 'yesterday', url: PP + '/football-predictions-yesterday',     useBrowser: false },
      { name: 'tomorrow',  url: PP + '/football-predictions-tomorrow',      useBrowser: false },
    ].filter((s) => s.url);
    const seenUrls = new Set();
    let list = [];
    const usedSources = [];
    let why = '';
    for (const src of sources) {
      if (seenUrls.has(src.url)) continue;
      seenUrls.add(src.url);
      try {
        const html = src.useBrowser
          ? await fetchPageHTML(src.url, src.useProxy)
          : await fetchPageDirect(src.url);
        if (isCloudflareChallenge(html)) {
          why = `${src.name}: blocked by Cloudflare`;
          console.log(`[scrape] ${why}`);
          continue;
        }
        const got = await extractPredictions(html);
        console.log(`[scrape] ${src.name}: ${html.length} bytes → ${got.length} matches`);
        if (got.length) {
          list = list.concat(got);
          usedSources.push(`${src.name}(${got.length})`);
        } else {
          why = `${src.name}: 0 matches`;
        }
      } catch (e) {
        why = `${src.name}: ${e.message}`;
        console.log(`[scrape] ${why}`);
      }
    }
    status.source = usedSources.join(' + ') || null;
    if (!list.length) throw new Error(why || 'no matches from any source');

    // Merge new scrape into existing cache so finished matches persist across days.
    const now = Date.now();
    const newMatches = { ...store.matches };
    const newPreds = { ...store.preds };
    for (const p of list) {
      if (!p.homeTeam || !p.awayTeam) continue;
      p.status = effectiveStatus(p.date, p.time, p.status);
      if (ONLY_WITH_ODDS && !p.hasOdds && p.status === 'NS') continue;
      const k = matchKey(p.homeTeam, p.awayTeam);
      const h = clampPct(p.probHome);
      const d = clampPct(p.probDraw);
      const a = clampPct(p.probAway);
      newMatches[k] = {
        id: k,
        date: p.date || '',
        time: p.time || '',
        home: { name: p.homeTeam, score: parseScore(p.score, 0) },
        away: { name: p.awayTeam, score: parseScore(p.score, 1) },
        leagueName: p.league || '',
        status: p.status,
        prediction: p.prediction || '',
        correctScore: p.correctScore || '',
        advice: p.advice || '',
      };
      newPreds[k] = {
        h, d, a,
        score: p.correctScore || '',
        advice: p.advice || (p.prediction === '1' ? 'Home Win' : p.prediction === '2' ? 'Away Win' : p.prediction === 'X' ? 'Draw' : ''),
        confidence: Math.round(Math.max(h, d, a) / 10) / 10,
        sources: ['scraped'],
        aiUsed: true,
      };
    }
    // Re-infer status for ALL cached matches (so NS → LIVE → FT progresses over time).
    for (const k of Object.keys(newMatches)) {
      newMatches[k].status = effectiveStatus(newMatches[k].date, newMatches[k].time, newMatches[k].status);
    }
    // Evict matches whose kickoff was more than 48 h ago.
    const evictBefore = now - 48 * 60 * 60 * 1000;
    for (const k of Object.keys(newMatches)) {
      const m = newMatches[k];
      if (m.date && m.time) {
        const t = Date.parse(`${m.date}T${m.time}:00Z`);
        if (!isNaN(t) && t < evictBefore) {
          delete newMatches[k];
          delete newPreds[k];
        }
      }
    }

    store.matches = newMatches;
    store.preds = newPreds;
    saveCache();
    status.lastOk = new Date().toISOString();
    status.lastError = null;
    status.lastCount = Object.keys(store.matches).length;
    console.log(`[scrape] stored ${status.lastCount} matches (sources: ${status.source || 'none'})`);
    if (TG_TOKEN && ADMIN_ID) tgSend(ADMIN_ID, `✅ Scrape ok: ${status.lastCount} matches (${status.source}).`);
    return { count: status.lastCount };
  } catch (err) {
    status.lastError = err.message;
    console.error('[scrape] error:', err.message);
    if (TG_TOKEN && ADMIN_ID) tgSend(ADMIN_ID, `❌ Scrape failed: ${err.message}`);
    return { error: err.message };
  } finally {
    status.running = false;
  }
}

// ---- Optional Telegram control ----
function tgSend(chatId, text) {
  if (!TG_TOKEN) return;
  httpRequest('POST', `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    body: { chat_id: chatId, text, parse_mode: 'HTML' },
  }).catch(() => {});
}
function statusText() {
  return `📊 <b>Status</b>\nMatches cached: ${Object.keys(store.matches).length}\nSource: ${status.source || 'none'}\nLast run: ${status.lastRun || 'never'}\nLast success: ${status.lastOk || 'never'}\nLast error: ${status.lastError || 'none'}\nAuto-refresh: every ${REFRESH_MINUTES} min`;
}
let tgOffset = 0;
async function pollTelegram() {
  if (!TG_TOKEN) return;
  try {
    const { text } = await httpRequest('GET', `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=30&offset=${tgOffset}`, { timeout: 40000 });
    const data = JSON.parse(text);
    if (data.ok) {
      for (const up of data.result) {
        tgOffset = up.update_id + 1;
        const msg = up.message;
        if (!msg || !msg.text) continue;
        if (ADMIN_ID && String(msg.from && msg.from.id) !== String(ADMIN_ID)) continue;
        const chatId = msg.chat.id;
        const cmd = msg.text.trim().toLowerCase();
        if (cmd === '/start') tgSend(chatId, '⚽ <b>Prediction scraper</b>\n/scrape - run now\n/status - last run info');
        else if (cmd === '/scrape') { tgSend(chatId, '⏳ Scraping now...'); runScrape('telegram').then((r) => tgSend(chatId, r.error ? `❌ ${r.error}` : `✅ ${r.count} matches`)); }
        else if (cmd === '/status') tgSend(chatId, statusText());
        else tgSend(chatId, 'Commands: /scrape, /status');
      }
    }
  } catch (e) { /* keep polling */ }
  setTimeout(pollTelegram, 1000);
}

// ---- Web API consumed by your website ----
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ ok: true, service: 'prediction-scraper', matches: Object.keys(store.matches).length }));

app.get('/api/health', (req, res) => res.json({
  ok: !status.lastError,
  matches: Object.keys(store.matches).length,
  lastRun: status.lastRun,
  lastOk: status.lastOk,
  lastError: status.lastError,
  source: status.source,
  refreshMinutes: REFRESH_MINUTES,
  target: TARGET_URL,
  fallback: FALLBACK_URL,
}));

app.get('/api/scores', (req, res) => {
  const matches = Object.entries(store.matches).map(([key, m]) => {
    const p = store.preds[key];
    return {
      ...m,
      probabilities: p ? { home: p.h + '%', draw: p.d + '%', away: p.a + '%' } : null,
      tip: m.prediction ? `${m.prediction}${m.correctScore ? ' (' + m.correctScore + ')' : ''}` : '',
    };
  });
  res.json({ updatedAt: status.lastOk, count: matches.length, matches });
});

app.get('/scrape-now', async (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  res.json(await runScrape('http'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚽ Prediction scraper live on :${PORT}`);
  console.log(`   primary=${TARGET_URL}`);
  console.log(`   fallback=${FALLBACK_URL}  refresh=${REFRESH_MINUTES}min`);
  loadCache();
  setTimeout(() => runScrape('boot'), 3000);
  setInterval(() => runScrape('scheduler'), REFRESH_MINUTES * 60 * 1000);
  if (TG_TOKEN) pollTelegram();
});
