'use strict';

/*
 * Football prediction scraper.
 *
 * Pipeline (runs on boot, then every REFRESH_MINUTES):
 *   1. Scrape today/yesterday/tomorrow from pitchpredictions — plain HTTPS first, then
 *      automatic Browserless fallback if Cloudflare blocks us.
 *   2. Optionally try a primary source (Forebet) via Browserless if BROWSERLESS_TOKEN is set.
 *   3. Merge results into an in-memory cache (also persisted to disk).
 *   4. Re-infer each match's status from kickoff time so Live/Upcoming/Past all populate.
 *   5. Serve everything to your website at /api/scores (now includes home/away logo URLs).
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

const CACHE_FILE = process.env.CACHE_FILE || '/tmp/sportprediction-cache.json';

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

function isCloudflareChallenge(html) {
  return /just a moment|challenge-platform|cf-browser-verification|cf_chl_/i.test(html) && html.length < 80000;
}

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

function predFrom(h, d, a) {
  const max = Math.max(h, d, a);
  if (max <= 0) return '';
  return max === h ? '1' : max === a ? '2' : 'X';
}

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

function extractFromNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return []; }
  const rows = data && data.props && data.props.pageProps && data.props.pageProps.initialData;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const dt = r.match && r.match.datetime ? new Date(r.match.datetime) : null;
    const date = (r.match && r.match.unformatted_date) || (dt && !isNaN(dt) ? dt.toISOString().substring(0, 10) : '');
    const time = dt && !isNaN(dt) ? dt.toISOString().substring(11, 16) : '';

    const p1x2 = (r.predictions && r.predictions['1x2']) || {};
    const h = parseInt(p1x2.home, 10) || 0;
    const d = parseInt(p1x2.draw, 10) || 0;
    const a = parseInt(p1x2.away, 10) || 0;
    const hasOdds = parseFloat(r.odds && r.odds.home) > 0;
    const prediction = predFrom(h, d, a);

    const liveHome = r.score && r.score.home;
    const liveAway = r.score && r.score.away;
    const liveScore = liveHome != null && liveAway != null ? `${liveHome}-${liveAway}` : '';

    const srcS = String((r.match && r.match.status) || '').toUpperCase();
    let status;
    if (['NS', 'TBD', 'PST'].includes(srcS)) status = 'NS';
    else if (['FT', 'AET', 'PEN'].includes(srcS)) status = 'FT';
    else if (srcS) status = 'LIVE';
    else status = liveHome != null ? 'LIVE' : 'NS';

    const ouPred = r.predictions && r.predictions.over_under_2_5 && r.predictions.over_under_2_5.prediction;
    const ou = ouPred === 'Ov2.5' ? 'Over 2.5' : ouPred === 'Un2.5' ? 'Under 2.5' : '';
    const winText = prediction === '1' ? 'Home Win' : prediction === '2' ? 'Away Win' : prediction === 'X' ? 'Draw' : '';

    return {
      date,
      time,
      homeTeam: (r.home_team && r.home_team.name) || '',
      awayTeam: (r.away_team && r.away_team.name) || '',
      homeLogo: (r.home_team && r.home_team.logo) || '',
      awayLogo: (r.away_team && r.away_team.logo) || '',
      score: liveScore,
      status,
      league: (r.league && r.league.name) || '',
      leagueLogo: (r.league && (r.league.logo || r.league.downloaded_league_logo)) || '',
      prediction,
      correctScore: '',
      probHome: h,
      probDraw: d,
      probAway: a,
      advice: [winText, ou].filter(Boolean).join(' · '),
      hasOdds,
    };
  });
}

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

async function runScrape(trigger = 'scheduler') {
  if (status.running) { console.log('[scrape] already running, skipping'); return { skipped: true }; }
  status.running = true;
  status.lastRun = new Date().toISOString();
  console.log(`[scrape] start (${trigger})`);
  try {
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
        let html;
        if (src.useBrowser) {
          html = await fetchPageHTML(src.url, src.useProxy);
        } else {
          try {
            html = await fetchPageDirect(src.url);
            if (isCloudflareChallenge(html)) throw new Error('Cloudflare challenge in body');
          } catch (e) {
            const blocked = /cloudflare|just a moment|HTTP 403/i.test(e.message);
            if (blocked && BROWSERLESS_TOKEN) {
              console.log(`[scrape] ${src.name}: plain HTTPS blocked, retrying via Browserless`);
              html = await fetchPageHTML(src.url, false);
            } else {
              throw e;
            }
          }
        }
        if (isCloudflareChallenge(html)) {
          why = `${src.name}: blocked by Cloudflare (even via Browserless)`;
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
        home: { name: p.homeTeam, score: parseScore(p.score, 0), logo: p.homeLogo || '' },
        away: { name: p.awayTeam, score: parseScore(p.score, 1), logo: p.awayLogo || '' },
        leagueName: p.league || '',
        leagueLogo: p.leagueLogo || '',
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
    for (const k of Object.keys(newMatches)) {
      newMatches[k].status = effectiveStatus(newMatches[k].date, newMatches[k].time, newMatches[k].status);
    }
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
