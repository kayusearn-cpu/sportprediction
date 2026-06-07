'use strict';

/*
 * Football prediction scraper — smart tiered scheduler edition.
 *
 * Why this is different from the old version:
 *   The old code scraped ALL sources every REFRESH_MINUTES. Forebet (the "primary"
 *   source) is Cloudflare-blocked and burned a Browserless token every cycle for ZERO
 *   matches. That's why you kept running out of tokens.
 *
 *   This version gives each source its own cadence based on how often its data really
 *   changes, and DISABLES the failing primary by default.
 *
 *     TODAY      → every LIVE_REFRESH_MIN min  (default 10) — live scores need refresh
 *     TOMORROW   → every FUTURE_REFRESH_MIN min (default 60) — odds shift slowly
 *     YESTERDAY  → every PAST_REFRESH_MIN min   (default 360 = 6h) — mostly finished
 *     PRIMARY    → only if ENABLE_PRIMARY=true; same cadence as PAST
 *
 *   Net effect: roughly 1/3 the Browserless usage, same data coverage, with /api/health
 *   showing each source's status separately so you can see what's working.
 *
 * Pipeline per source:
 *   1. Try plain HTTPS first (free, fast). Pitchpredictions is server-rendered so the
 *      __NEXT_DATA__ JSON arrives without needing a real browser.
 *   2. Only if Cloudflare blocks us → fall back to Browserless.
 *   3. Parse __NEXT_DATA__ for matches (no AI cost).
 *   4. OpenAI fallback is only used when a source has no JSON at all (e.g. Forebet).
 *   5. Merge into the cache; persist to /tmp/sportprediction-cache.json.
 *
 * Env vars (all optional — defaults are sensible):
 *   PORT                     web port (Railway sets this)
 *   LIVE_REFRESH_MIN         today's cadence in minutes (default 10)
 *   FUTURE_REFRESH_MIN       tomorrow's cadence in minutes (default 60)
 *   PAST_REFRESH_MIN         yesterday's & primary's cadence (default 360)
 *   REFRESH_MINUTES          LEGACY — falls back into LIVE_REFRESH_MIN if set
 *   ONLY_WITH_ODDS           "true" (default) = filter NS matches without odds
 *   ENABLE_PRIMARY           "true" = also scrape TARGET_URL (Forebet). Default: false.
 *   TARGET_URL               primary URL (only used if ENABLE_PRIMARY=true)
 *   FALLBACK_URL             pitchpredictions today URL (default: homepage)
 *   BROWSERLESS_TOKEN        required for Cloudflare fallback / primary
 *   BROWSERLESS_HOST         default chrome.browserless.io
 *   BROWSERLESS_PROXY        "residential" — only used for primary
 *   OPENAI_API_KEY           only needed if primary has no JSON
 *   OPENAI_MODEL             default gpt-4o-mini
 *   TELEGRAM_BOT_TOKEN       optional — enables /scrape and /status commands
 *   TELEGRAM_ADMIN_ID        restricts the bot to you
 *   ADMIN_KEY                protects the /scrape-now URL
 *   CACHE_FILE               cache file path (default /tmp/sportprediction-cache.json)
 *   HISTORY_DAYS             how long to keep finished matches for H2H (default 60)
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// Tiered cadence. REFRESH_MINUTES kept as a legacy fallback for LIVE_REFRESH_MIN.
const LEGACY_REFRESH = parseInt(process.env.REFRESH_MINUTES || '10', 10);
const LIVE_REFRESH_MIN = parseInt(process.env.LIVE_REFRESH_MIN || String(LEGACY_REFRESH), 10);
const FUTURE_REFRESH_MIN = parseInt(process.env.FUTURE_REFRESH_MIN || '60', 10);
const PAST_REFRESH_MIN = parseInt(process.env.PAST_REFRESH_MIN || '360', 10);

const TARGET_URL = process.env.TARGET_URL || 'https://www.forebet.com/en/football-tips-and-predictions-for-today';
const FALLBACK_URL = process.env.FALLBACK_URL || 'https://www.pitchpredictions.com';
const ONLY_WITH_ODDS = (process.env.ONLY_WITH_ODDS || 'true').toLowerCase() !== 'false';
const ENABLE_PRIMARY = (process.env.ENABLE_PRIMARY || 'false').toLowerCase() === 'true';

const BROWSERLESS_HOST = process.env.BROWSERLESS_HOST || 'chrome.browserless.io';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const CACHE_FILE = process.env.CACHE_FILE || '/tmp/sportprediction-cache.json';

// In-memory cache (merged across sources). Single source of truth.
const store = { matches: {}, preds: {} };

// Global status (last successful scrape across ANY source).
const status = {
  lastRun: null,
  lastOk: null,
  lastError: null,
  lastCount: 0,
  bootAt: new Date().toISOString(),
};

// Per-source status. Populated lazily as sources run.
//   sourceState.today = { lastRun, lastOk, lastError, lastCount }
const sourceState = {};

// Only one scrape per source at a time, but different sources can run concurrently.
const runningSources = new Set();

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.matches && data.preds) {
      store.matches = data.matches;
      store.preds = data.preds;
      status.lastCount = Object.keys(store.matches).length;
      console.log(`[cache] loaded ${status.lastCount} matches from ${CACHE_FILE}`);
    }
  } catch (e) {
    /* no cache yet, or invalid — start fresh */
  }
}
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(store));
  } catch (e) {
    console.error('[cache] save failed:', e.message);
  }
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

// Render a page in a cloud browser. Costs 1 Browserless unit per call.
async function fetchPageHTML(targetUrl, useProxy) {
  if (!BROWSERLESS_TOKEN) throw new Error('BROWSERLESS_TOKEN not set');
  let url = `https://${BROWSERLESS_HOST}/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  const bproxy = process.env.BROWSERLESS_PROXY || '';
  if (useProxy && bproxy) {
    url += `&proxy=${encodeURIComponent(bproxy)}&proxySticky=true`;
    if (process.env.PROXY_COUNTRY) url += `&proxyCountry=${encodeURIComponent(process.env.PROXY_COUNTRY)}`;
  }
  const payload = {
    url: targetUrl,
    gotoOptions: { waitUntil: 'networkidle2', timeout: 45000 },
  };
  const { status: code, text } = await httpRequest('POST', url, { body: payload });
  if (code !== 200) throw new Error(`Browserless HTTP ${code}: ${text.slice(0, 200)}`);
  if (!text || text.length < 200) throw new Error('Browserless returned empty/short HTML');
  return text;
}

// Detect a Cloudflare "Just a moment" interstitial.
function isCloudflareChallenge(html) {
  return /just a moment|challenge-platform|cf-browser-verification|cf_chl_/i.test(html) && html.length < 80000;
}

// Plain HTTPS fetch — FREE, fast. Use first for any non-JS site (e.g. pitchpredictions).
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

// Strip scripts/styles/markup so the AI sees real content, not 600KB of noise.
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

// ---- Pitchpredictions __NEXT_DATA__ extraction helpers ----
function maybeJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}
function impliedPct(homeOdd, drawOdd, awayOdd) {
  const inv = [homeOdd, drawOdd, awayOdd].map((o) => {
    const n = parseFloat(o);
    return n > 0 ? 1 / n : 0;
  });
  const sum = inv.reduce((a, b) => a + b, 0);
  if (sum <= 0) return [0, 0, 0];
  return inv.map((x) => Math.round((x / sum) * 100));
}
function predFrom(h, d, a) {
  const max = Math.max(h, d, a);
  if (max <= 0) return '';
  return max === h ? '1' : max === a ? '2' : 'X';
}
// Infer real status from kickoff time so the front-end can bucket matches correctly.
function effectiveStatus(date, time, srcStatus) {
  if (srcStatus === 'FT') return 'FT';
  if (!date || !time) return srcStatus || 'NS';
  const t = Date.parse(`${date}T${time}:00Z`);
  if (isNaN(t)) return srcStatus || 'NS';
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
    let s;
    if (['NS', 'TBD', 'PST'].includes(srcS)) s = 'NS';
    else if (['FT', 'AET', 'PEN'].includes(srcS)) s = 'FT';
    else if (srcS) s = 'LIVE';
    else s = liveHome != null ? 'LIVE' : 'NS';

    const ouPred = r.predictions && r.predictions.over_under_2_5 && r.predictions.over_under_2_5.prediction;
    const ouProb = r.predictions && r.predictions.over_under_2_5 && r.predictions.over_under_2_5.probability;
    const ou = ouPred === 'Ov2.5' ? 'Over 2.5' : ouPred === 'Un2.5' ? 'Under 2.5' : '';
    const winText = prediction === '1' ? 'Home Win' : prediction === '2' ? 'Away Win' : prediction === 'X' ? 'Draw' : '';

    const btts = r.predictions && r.predictions.both_teams_to_score;
    const dc = r.predictions && r.predictions.double_chance;
    const htProbs = r.predictions && r.predictions.half_time;

    return {
      date,
      time,
      homeTeam: (r.home_team && r.home_team.name) || '',
      awayTeam: (r.away_team && r.away_team.name) || '',
      homeTeamId: (r.home_team && r.home_team.id != null) ? r.home_team.id : null,
      awayTeamId: (r.away_team && r.away_team.id != null) ? r.away_team.id : null,
      homeLogo: (r.home_team && r.home_team.logo) || '',
      awayLogo: (r.away_team && r.away_team.logo) || '',
      score: liveScore,
      status: s,
      league: (r.league && r.league.name) || '',
      leagueLogo: (r.league && (r.league.logo || r.league.downloaded_league_logo)) || '',
      prediction,
      correctScore: '',
      probHome: h,
      probDraw: d,
      probAway: a,
      advice: [winText, ou].filter(Boolean).join(' · '),
      hasOdds,
      fixtureId: r.fixture_id || null,
      statusRaw: srcS,
      statusLong: (r.match && r.match.status_long) || '',
      elapsed: (r.match && r.match.elapsed != null) ? r.match.elapsed : null,
      htScoreHome: r.score && r.score.half_time && r.score.half_time.home,
      htScoreAway: r.score && r.score.half_time && r.score.half_time.away,
      recommendation: (r.predictions && r.predictions.recommendation) || '',
      avgGoals: (r.predictions && r.predictions.avg_goals) || null,
      bttsPct: btts ? btts.probability : null,
      bttsPred: btts ? btts.prediction : '',
      ouPct: ouProb || null,
      ouPred: ouPred || '',
      dcType: dc ? dc.type : '',
      dcPct: dc ? dc.probability : null,
      htProbHome: htProbs ? htProbs.home : null,
      htProbDraw: htProbs ? htProbs.draw : null,
      htProbAway: htProbs ? htProbs.away : null,
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
  console.log('[extract] no __NEXT_DATA__ matches; falling back to OpenAI');
  return extractWithOpenAI(html);
}

async function extractWithOpenAI(html) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  const sys = `You extract football (soccer) match predictions from raw HTML.
Return ONLY a JSON object of the form { "matches": [ ... ] }.
Each match object must have these keys (use empty string "" when unknown):
- "date"          match date as YYYY-MM-DD
- "time"          kickoff time as HH:MM (24h)
- "homeTeam"      home team name
- "awayTeam"      away team name
- "score"         current or final score like "1-2"; "" if not started
- "status"        one of "NS" (not started), "LIVE", "FT" (finished)
- "league"        competition name; "" if unknown
- "prediction"    one of "1" (home win), "X" (draw), "2" (away win)
- "correctScore"  predicted scoreline like "2-1"; "" if none
- "probHome"      integer 0-100
- "probDraw"      integer 0-100
- "probAway"      integer 0-100
- "advice"        short tip text e.g. "Home Win" or "Over 2.5"
Only include real matches found in the HTML. Never invent data.`;
  let userText = htmlToText(html);
  if (userText.length < 500) userText = html;
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userText.slice(0, 100000) },
    ],
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

// ---- Sources & scheduling ----
function getSources() {
  const PP = 'https://www.pitchpredictions.com';
  const list = [
    { name: 'today',     url: FALLBACK_URL || PP,                            useBrowser: false, intervalMin: LIVE_REFRESH_MIN,   tier: 'live'   },
    { name: 'tomorrow',  url: PP + '/football-predictions-tomorrow',         useBrowser: false, intervalMin: FUTURE_REFRESH_MIN, tier: 'future' },
    { name: 'yesterday', url: PP + '/football-predictions-yesterday',        useBrowser: false, intervalMin: PAST_REFRESH_MIN,   tier: 'past'   },
  ];
  if (ENABLE_PRIMARY && TARGET_URL) {
    list.push({ name: 'primary', url: TARGET_URL, useBrowser: true, useProxy: true, intervalMin: PAST_REFRESH_MIN, tier: 'primary' });
  }
  return list;
}

function mergeIntoCache(list) {
  const now = Date.now();
  const newMatches = { ...store.matches };
  const newPreds = { ...store.preds };
  let merged = 0;
  for (const p of list) {
    if (!p.homeTeam || !p.awayTeam) continue;
    p.status = effectiveStatus(p.date, p.time, p.status);
    if (ONLY_WITH_ODDS && !p.hasOdds && p.status === 'NS') continue;
    const k = matchKey(p.homeTeam, p.awayTeam);
    const h = clampPct(p.probHome);
    const d = clampPct(p.probDraw);
    const a = clampPct(p.probAway);
    const prev = store.matches[k] || {};
    newMatches[k] = {
      id: k,
      date: p.date || '',
      time: p.time || '',
      home: {
        name: p.homeTeam,
        score: parseScore(p.score, 0),
        logo: p.homeLogo || '',
        id: p.homeTeamId != null ? p.homeTeamId : (prev.home && prev.home.id) || null,
      },
      away: {
        name: p.awayTeam,
        score: parseScore(p.score, 1),
        logo: p.awayLogo || '',
        id: p.awayTeamId != null ? p.awayTeamId : (prev.away && prev.away.id) || null,
      },
      leagueName: p.league || '',
      leagueLogo: p.leagueLogo || '',
      status: p.status,
      prediction: p.prediction || '',
      correctScore: p.correctScore || '',
      advice: p.advice || '',
      fixtureId: p.fixtureId != null ? p.fixtureId : prev.fixtureId || null,
      statusRaw: p.statusRaw || prev.statusRaw || '',
      statusLong: p.statusLong || prev.statusLong || '',
      elapsed: p.elapsed != null ? p.elapsed : prev.elapsed,
      elapsedAt: p.elapsed != null ? Date.now() : prev.elapsedAt || null,
      htScore: (p.htScoreHome != null && p.htScoreAway != null) ? `${p.htScoreHome}-${p.htScoreAway}` : prev.htScore || '',
      recommendation: p.recommendation || prev.recommendation || '',
      avgGoals: p.avgGoals != null ? p.avgGoals : prev.avgGoals,
      bttsPct: p.bttsPct != null ? p.bttsPct : prev.bttsPct,
      bttsPred: p.bttsPred || prev.bttsPred || '',
      ouPct: p.ouPct != null ? p.ouPct : prev.ouPct,
      ouPred: p.ouPred || prev.ouPred || '',
      dcType: p.dcType || prev.dcType || '',
      dcPct: p.dcPct != null ? p.dcPct : prev.dcPct,
      htProbHome: p.htProbHome != null ? p.htProbHome : prev.htProbHome,
      htProbDraw: p.htProbDraw != null ? p.htProbDraw : prev.htProbDraw,
      htProbAway: p.htProbAway != null ? p.htProbAway : prev.htProbAway,
      lastSeenAt: Date.now(),
    };
    newPreds[k] = {
      h, d, a,
      score: p.correctScore || '',
      advice: p.advice || (p.prediction === '1' ? 'Home Win' : p.prediction === '2' ? 'Away Win' : p.prediction === 'X' ? 'Draw' : ''),
      confidence: Math.round(Math.max(h, d, a) / 10) / 10,
      sources: ['scraped'],
      aiUsed: true,
    };
    merged++;
  }
  for (const k of Object.keys(newMatches)) {
    newMatches[k].status = effectiveStatus(newMatches[k].date, newMatches[k].time, newMatches[k].status);
  }
  // Eviction: finished matches kept HISTORY_DAYS (for H2H); stale NS dropped after 48h.
  const HISTORY_DAYS = parseInt(process.env.HISTORY_DAYS || '60', 10);
  const evictFinishedBefore = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const evictStaleBefore = now - 48 * 60 * 60 * 1000;
  for (const k of Object.keys(newMatches)) {
    const m = newMatches[k];
    if (m.date && m.time) {
      const t = Date.parse(`${m.date}T${m.time}:00Z`);
      if (isNaN(t)) continue;
      const isFinished = m.status === 'FT';
      const cutoff = isFinished ? evictFinishedBefore : evictStaleBefore;
      if (t < cutoff) {
        delete newMatches[k];
        delete newPreds[k];
      }
    }
  }
  store.matches = newMatches;
  store.preds = newPreds;
  return merged;
}

async function scrapeOne(src, trigger = 'scheduler') {
  if (runningSources.has(src.name)) {
    console.log(`[scrape ${src.name}] already running, skipping`);
    return { skipped: true };
  }
  runningSources.add(src.name);
  const st = (sourceState[src.name] = sourceState[src.name] || {});
  st.lastRun = new Date().toISOString();
  console.log(`[scrape ${src.name}] start (${trigger}) -> ${src.url}`);
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
          console.log(`[scrape ${src.name}] plain HTTPS blocked, retrying via Browserless`);
          html = await fetchPageHTML(src.url, false);
        } else {
          throw e;
        }
      }
    }
    if (isCloudflareChallenge(html)) {
      throw new Error('blocked by Cloudflare (even via Browserless)');
    }
    const list = await extractPredictions(html);
    console.log(`[scrape ${src.name}] ${html.length} bytes → ${list.length} matches`);
    if (!list.length) {
      st.lastError = '0 matches extracted';
      return { count: 0 };
    }
    const merged = mergeIntoCache(list);
    st.lastOk = new Date().toISOString();
    st.lastError = null;
    st.lastCount = merged;
    status.lastOk = st.lastOk;
    status.lastRun = st.lastOk;
    status.lastError = null;
    status.lastCount = Object.keys(store.matches).length;
    saveCache();
    console.log(`[scrape ${src.name}] merged ${merged}; total cache ${status.lastCount}`);
    return { count: merged };
  } catch (err) {
    st.lastError = err.message;
    status.lastError = `${src.name}: ${err.message}`;
    status.lastRun = new Date().toISOString();
    console.error(`[scrape ${src.name}] error:`, err.message);
    if (TG_TOKEN && ADMIN_ID && (src.tier === 'live' || src.tier === 'future')) {
      tgSend(ADMIN_ID, `❌ Scrape (${src.name}) failed: ${err.message}`);
    }
    return { error: err.message };
  } finally {
    runningSources.delete(src.name);
  }
}

async function runFullScrape(trigger = 'manual') {
  const sources = getSources();
  const results = {};
  for (const src of sources) {
    results[src.name] = await scrapeOne(src, trigger);
  }
  if (TG_TOKEN && ADMIN_ID) tgSend(ADMIN_ID, `✅ Full scrape done: ${status.lastCount} total matches.`);
  return { count: status.lastCount, sources: results };
}

function startTieredScheduler() {
  const sources = getSources();
  console.log(`[scheduler] ${sources.length} source(s) scheduled:`);
  sources.forEach((src, i) => {
    console.log(`   ${src.name.padEnd(10)} every ${String(src.intervalMin).padStart(4)} min  (${src.useBrowser ? 'browser' : 'direct '})  tier=${src.tier}`);
    setTimeout(() => scrapeOne(src, 'boot'), 3000 + i * 4000);
    setInterval(() => scrapeOne(src, 'scheduler'), src.intervalMin * 60 * 1000);
  });
}

// ---- Telegram bot control ----
function tgSend(chatId, text) {
  if (!TG_TOKEN) return;
  httpRequest('POST', `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    body: { chat_id: chatId, text, parse_mode: 'HTML' },
  }).catch(() => {});
}

function statusText() {
  const lines = [
    `📊 <b>Status</b>`,
    `Matches cached: ${Object.keys(store.matches).length}`,
    `Last run: ${status.lastRun || 'never'}`,
    `Last success: ${status.lastOk || 'never'}`,
    `Last error: ${status.lastError || 'none'}`,
    ``,
    `<b>Cadence</b>`,
    `Live: every ${LIVE_REFRESH_MIN} min`,
    `Future: every ${FUTURE_REFRESH_MIN} min`,
    `Past: every ${PAST_REFRESH_MIN} min`,
    `Primary: ${ENABLE_PRIMARY ? 'enabled' : 'disabled'}`,
    ``,
    `<b>Sources</b>`,
  ];
  for (const src of getSources()) {
    const s = sourceState[src.name] || {};
    const ok = s.lastOk ? '✅' : (s.lastError ? '❌' : '⏳');
    lines.push(`${ok} ${src.name}: ${s.lastCount || 0} matches, last ${s.lastOk || s.lastRun || 'never'}`);
  }
  return lines.join('\n');
}

let tgOffset = 0;
async function pollTelegram() {
  if (!TG_TOKEN) return;
  try {
    const { text } = await httpRequest(
      'GET',
      `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=30&offset=${tgOffset}`,
      { timeout: 40000 }
    );
    const data = JSON.parse(text);
    if (data.ok) {
      for (const up of data.result) {
        tgOffset = up.update_id + 1;
        const msg = up.message;
        if (!msg || !msg.text) continue;
        if (ADMIN_ID && String(msg.from && msg.from.id) !== String(ADMIN_ID)) continue;
        const chatId = msg.chat.id;
        const cmd = msg.text.trim().toLowerCase();
        if (cmd === '/start') tgSend(chatId, '⚽ <b>Prediction scraper</b>\n/scrape - run all sources now\n/status - last run info');
        else if (cmd === '/scrape') {
          tgSend(chatId, '⏳ Scraping all sources...');
          runFullScrape('telegram').then((r) => tgSend(chatId, `✅ ${r.count} matches total`));
        } else if (cmd === '/status') tgSend(chatId, statusText());
        else tgSend(chatId, 'Commands: /scrape, /status');
      }
    }
  } catch (e) {
    /* transient network error; keep polling */
  }
  setTimeout(pollTelegram, 1000);
}

// ---- Web API consumed by your website ----
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) =>
  res.json({ ok: true, service: 'prediction-scraper', matches: Object.keys(store.matches).length })
);

app.get('/api/health', (req, res) => {
  const sources = getSources().map((s) => ({
    name: s.name,
    tier: s.tier,
    intervalMin: s.intervalMin,
    useBrowser: s.useBrowser,
    ...sourceState[s.name],
  }));
  res.json({
    ok: !status.lastError,
    matches: Object.keys(store.matches).length,
    lastRun: status.lastRun,
    lastOk: status.lastOk,
    lastError: status.lastError,
    bootAt: status.bootAt,
    refreshMinutes: LIVE_REFRESH_MIN,
    cadence: {
      live: LIVE_REFRESH_MIN,
      future: FUTURE_REFRESH_MIN,
      past: PAST_REFRESH_MIN,
    },
    primaryEnabled: ENABLE_PRIMARY,
    target: TARGET_URL,
    fallback: FALLBACK_URL,
    sources,
  });
});

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
  res.json(await runFullScrape('http'));
});

app.get('/scrape-now/:source', async (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  const src = getSources().find((s) => s.name === req.params.source);
  if (!src) return res.status(404).json({ error: `unknown source "${req.params.source}"` });
  res.json(await scrapeOne(src, 'http'));
});

// ---- Match detail endpoint: Last Matches + H2H + Form ----
// Builds the details organically from our OWN cache (no extra scraping required).
// Cache grows over HISTORY_DAYS so this becomes more useful every day.
function teamMatches(teamName, teamId, limit = 10, excludeKey = null) {
  if (!teamName && teamId == null) return [];
  const norm = (teamName || '').trim().toLowerCase();
  const out = [];
  for (const k of Object.keys(store.matches)) {
    if (k === excludeKey) continue;
    const m = store.matches[k];
    // Prefer ID match (robust); fall back to name match for older cached records that lack an ID.
    const mhId = m.home && m.home.id != null ? m.home.id : null;
    const maId = m.away && m.away.id != null ? m.away.id : null;
    const isHome = (teamId != null && mhId != null) ? mhId === teamId
                                                    : norm && (m.home && m.home.name || '').trim().toLowerCase() === norm;
    const isAway = (teamId != null && maId != null) ? maId === teamId
                                                    : norm && (m.away && m.away.name || '').trim().toLowerCase() === norm;
    if (!isHome && !isAway) continue;
    if (m.status !== 'FT') continue;
    const hs = m.home && m.home.score, as = m.away && m.away.score;
    if (hs == null || as == null) continue;
    const opponent = isHome ? (m.away.name || '') : (m.home.name || '');
    const myScore = isHome ? hs : as;
    const theirScore = isHome ? as : hs;
    const result = myScore > theirScore ? 'W' : (myScore < theirScore ? 'L' : 'D');
    out.push({
      date: m.date,
      time: m.time,
      kickoffMs: Date.parse(`${m.date}T${m.time || '00:00'}:00Z`) || 0,
      opponent,
      isHome,
      competition: m.leagueName || '',
      competitionLogo: m.leagueLogo || '',
      score: `${hs}-${as}`,
      myScore,
      theirScore,
      result,
    });
  }
  out.sort((a, b) => b.kickoffMs - a.kickoffMs);
  return out.slice(0, limit);
}

function h2hMatches(homeName, awayName, homeId, awayId, limit = 10, excludeKey = null) {
  if ((!homeName || !awayName) && (homeId == null || awayId == null)) return [];
  const h = (homeName || '').trim().toLowerCase();
  const a = (awayName || '').trim().toLowerCase();
  const out = [];
  for (const k of Object.keys(store.matches)) {
    if (k === excludeKey) continue;
    const m = store.matches[k];
    const hn = (m.home && m.home.name || '').trim().toLowerCase();
    const an = (m.away && m.away.name || '').trim().toLowerCase();
    const mhId = m.home && m.home.id != null ? m.home.id : null;
    const maId = m.away && m.away.id != null ? m.away.id : null;
    let sameMatchup;
    if (homeId != null && awayId != null && mhId != null && maId != null) {
      sameMatchup = (mhId === homeId && maId === awayId) || (mhId === awayId && maId === homeId);
    } else {
      sameMatchup = (hn === h && an === a) || (hn === a && an === h);
    }
    if (!sameMatchup) continue;
    if (m.status !== 'FT') continue;
    const hs = m.home && m.home.score, as = m.away && m.away.score;
    if (hs == null || as == null) continue;
    const homeTeamWasHome = (homeId != null && mhId != null) ? mhId === homeId : hn === h;
    const requestedHomeScore = homeTeamWasHome ? hs : as;
    const requestedAwayScore = homeTeamWasHome ? as : hs;
    const winner =
      requestedHomeScore > requestedAwayScore ? 'home' :
      requestedHomeScore < requestedAwayScore ? 'away' : 'draw';
    out.push({
      date: m.date,
      time: m.time,
      kickoffMs: Date.parse(`${m.date}T${m.time || '00:00'}:00Z`) || 0,
      competition: m.leagueName || '',
      score: `${requestedHomeScore}-${requestedAwayScore}`,
      homeName: homeTeamWasHome ? m.home.name : m.away.name,
      awayName: homeTeamWasHome ? m.away.name : m.home.name,
      winner,
      totalGoals: requestedHomeScore + requestedAwayScore,
    });
  }
  out.sort((a, b) => b.kickoffMs - a.kickoffMs);
  return out.slice(0, limit);
}

function h2hStats(matches) {
  let homeWins = 0, awayWins = 0, draws = 0, totalGoals = 0;
  for (const m of matches) {
    if (m.winner === 'home') homeWins++;
    else if (m.winner === 'away') awayWins++;
    else draws++;
    totalGoals += m.totalGoals || 0;
  }
  return {
    played: matches.length,
    homeWins,
    awayWins,
    draws,
    totalGoals,
    avgGoals: matches.length ? Math.round((totalGoals / matches.length) * 100) / 100 : 0,
  };
}

function parseFormStats(text) {
  if (!text) return { home: null, away: null };
  const home = {};
  const away = {};
  const homeMatch = text.match(/home side[^0-9]*(\d+)\s*goals\s*scored[^0-9]*(\d+)\s*conceded[^0-9]*(\d+)\s*matches/i);
  if (homeMatch) {
    home.scored = +homeMatch[1];
    home.conceded = +homeMatch[2];
    home.matches = +homeMatch[3];
    home.avgScored = Math.round((home.scored / home.matches) * 100) / 100;
    home.avgConceded = Math.round((home.conceded / home.matches) * 100) / 100;
  }
  const awayMatch = text.match(/away side[^0-9]*(\d+)\s*goals[^0-9]*conceded\s*(\d+)[^0-9]*(\d+)\s*matches/i);
  if (awayMatch) {
    away.scored = +awayMatch[1];
    away.conceded = +awayMatch[2];
    away.matches = +awayMatch[3];
    away.avgScored = Math.round((away.scored / away.matches) * 100) / 100;
    away.avgConceded = Math.round((away.conceded / away.matches) * 100) / 100;
  }
  return { home: Object.keys(home).length ? home : null, away: Object.keys(away).length ? away : null };
}

app.get('/api/match/:id/details', (req, res) => {
  const id = decodeURIComponent(req.params.id || '');
  const m = store.matches[id];
  if (!m) return res.status(404).json({ error: 'match not found', id });
  const limit = Math.max(1, Math.min(20, parseInt(req.query.limit || '10', 10)));
  const homeName = m.home && m.home.name;
  const awayName = m.away && m.away.name;
  const homeId = m.home && m.home.id != null ? m.home.id : null;
  const awayId = m.away && m.away.id != null ? m.away.id : null;
  const homeLast = teamMatches(homeName, homeId, limit, id);
  const awayLast = teamMatches(awayName, awayId, limit, id);
  const h2hList = h2hMatches(homeName, awayName, homeId, awayId, limit, id);
  const stats = h2hStats(h2hList);
  const form = parseFormStats(m.recommendation || '');

  // Cache diagnostic — helps you see how many FT matches are stored across the whole feed.
  let totalFinished = 0;
  for (const k of Object.keys(store.matches)) {
    if (store.matches[k].status === 'FT' && store.matches[k].home && store.matches[k].home.score != null) totalFinished++;
  }

  res.json({
    id,
    match: m,
    home: { name: homeName, logo: m.home && m.home.logo, id: homeId, lastMatches: homeLast, form: form.home },
    away: { name: awayName, logo: m.away && m.away.logo, id: awayId, lastMatches: awayLast, form: form.away },
    h2h: { matches: h2hList, stats },
    predictions: {
      probabilities: store.preds[id] ? { home: store.preds[id].h, draw: store.preds[id].d, away: store.preds[id].a } : null,
      btts: m.bttsPct != null ? { prediction: m.bttsPred, probability: m.bttsPct } : null,
      ou25: m.ouPct != null ? { prediction: m.ouPred, probability: m.ouPct } : null,
      doubleChance: m.dcPct != null ? { type: m.dcType, probability: m.dcPct } : null,
      halfTime: m.htProbHome != null ? { home: m.htProbHome, draw: m.htProbDraw, away: m.htProbAway } : null,
      avgGoals: m.avgGoals,
      recommendation: m.recommendation || '',
    },
    historyDays: parseInt(process.env.HISTORY_DAYS || '60', 10),
    cacheStats: { totalMatches: Object.keys(store.matches).length, totalFinished },
    note:
      homeLast.length === 0 && awayLast.length === 0 && h2hList.length === 0
        ? `No history yet for these teams. Cache holds ${totalFinished} finished match${totalFinished === 1 ? '' : 'es'}; H2H/form for small-league teams may stay sparse — the feature is most useful for top-flight clubs that play frequently.`
        : null,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚽ Prediction scraper live on :${PORT}`);
  console.log(`   cadence: live=${LIVE_REFRESH_MIN}min  future=${FUTURE_REFRESH_MIN}min  past=${PAST_REFRESH_MIN}min`);
  console.log(`   primary: ${ENABLE_PRIMARY ? 'ENABLED (' + TARGET_URL + ')' : 'disabled'}`);
  console.log(`   fallback=${FALLBACK_URL}  browserless=${BROWSERLESS_HOST}`);
  loadCache();
  startTieredScheduler();
  if (TG_TOKEN) pollTelegram();
});
