'use strict';

/*
 * Football prediction scraper.
 *
 * Pipeline (runs on boot, then every REFRESH_MINUTES):
 *   1. Browserless loads SEVERAL pages (today, yesterday, tomorrow + your primary).
 *   2. We parse the matches out of them and merge everything into one cache.
 *   3. Time-aware status inference puts each match into Live / Upcoming / Past correctly.
 *   4. Served to your website at /api/scores. 48 h retention on finished matches.
 *
 * All config comes from environment variables (no secrets in this file):
 *   PORT                 web port (Railway sets this automatically)
 *   REFRESH_MINUTES      how often to re-scrape (default 20)
 *   TARGET_URL           primary predictions page (default: Forebet's today page)
 *   FALLBACK_URL         pitchpredictions today page (default works fine)
 *   ONLY_WITH_ODDS       "true" (default) = only show upcoming matches that have real odds
 *                        (LIVE/FT matches always show). "false" = show everything.
 *   BROWSERLESS_TOKEN    required - your browserless.io API token
 *   BROWSERLESS_HOST     browserless host (default chrome.browserless.io)
 *   BROWSERLESS_PROXY    set "residential" to clear Cloudflare on the primary (Forebet)
 *   OPENAI_API_KEY       needed for Forebet (it has no JSON, so the AI parser reads it)
 *   OPENAI_MODEL         default gpt-4o-mini
 *   TELEGRAM_BOT_TOKEN   optional - enables /scrape and /status commands
 *   TELEGRAM_ADMIN_ID    optional - restricts the bot to you
 *   ADMIN_KEY            optional - protects the /scrape-now URL
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
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

// In-memory cache. Updated incrementally on every scrape (NOT wiped) so finished
// matches survive long enough to populate the Past section.
const store = { matches: {}, preds: {} };
const status = { lastRun: null, lastOk: null, lastError: null, lastCount: 0, running: false, source: null };

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

// Step 1: render a page in a cloud browser and return its HTML.
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

// Detect a Cloudflare "Just a moment" interstitial so we can skip extraction on it.
// Cap raised to 80 KB so we catch Forebet's ~32 KB challenge page (was being missed).
function isCloudflareChallenge(html) {
  return /just a moment|challenge-platform|cf-browser-verification|cf_chl_/i.test(html) && html.length < 80000;
}

// Strip scripts/styles/markup so the model sees real content, not 600KB of noise.
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

// Step 2a: pitchpredictions.com (Next.js) ships all matches as JSON in __NEXT_DATA__.
function maybeJson(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
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
function normStatus(r) {
  const s = String(r.status_short || '').toUpperCase();
  if (['NS', 'TBD', 'PST'].includes(s)) return 'NS';
  if (['FT', 'AET', 'PEN'].includes(s)) return 'FT';
  if (s) return 'LIVE';
  return r.goals_home != null ? 'LIVE' : 'NS';
}
// Source data often leaves matches stuck as "NS" forever. Infer real status from the
// kickoff time so the front-end can put each match into the right Live/Upcoming/Past bucket.
function effectiveStatus(date, time, sourceStatus) {
  if (sourceStatus === 'FT') return 'FT';                       // trust explicit FT from source
  if (!date || !time) return sourceStatus || 'NS';
  const t = Date.parse(`${date}T${time}:00Z`);
  if (isNaN(t)) return sourceStatus || 'NS';
  const minutesPast = (Date.now() - t) / 60000;
  if (minutesPast < 0) return 'NS';        // hasn't kicked off yet
  if (minutesPast < 150) return 'LIVE';    // ~90 min + halftime + extra time + buffer
  return 'FT';                              // probably finished
}
function bestCorrectScore(dcgRaw, pred) {
  const arr = maybeJson(dcgRaw) || [];
  let best = null;
  let any = null;
  for (const it of arr) {
    const mm = String(it.value || '').match(/(\d+)\s*:\s*(\d+)/);
    if (!mm) continue;
    const hs = +mm[1];
    const as = +mm[2];
    const odd = parseFloat(it.odd);
    if (!(odd > 0)) continue;
    const outcome = hs > as ? '1' : hs < as ? '2' : 'X';
    if (!any || odd < any.odd) any = { odd, s: `${hs}-${as}` };
    if (pred && outcome === pred && (!best || odd < best.odd)) best = { odd, s: `${hs}-${as}` };
  }
  return best || any ? (best || any).s : '';
}
function overUnderTip(gouRaw, line) {
  const arr = maybeJson(gouRaw) || [];
  const ln = line || '2.5';
  const ov = arr.find((x) => new RegExp('Over\\s*' + ln).test(x.value || ''));
  const un = arr.find((x) => new RegExp('Under\\s*' + ln).test(x.value || ''));
  const oo = ov ? parseFloat(ov.odd) : 0;
  const uo = un ? parseFloat(un.odd) : 0;
  if (oo > 0 && uo > 0) return oo <= uo ? `Over ${ln}` : `Under ${ln}`;
  return '';
}
function extractFromNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    return [];
  }
  const rows = data && data.props && data.props.pageProps && data.props.pageProps.initialData;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const time = String(r.date || '').split(' ')[1] || '';
    const oddsPct = impliedPct(r.bets_home, r.bets_draw, r.bets_away);
    const hasOdds = oddsPct[0] + oddsPct[1] + oddsPct[2] > 0;
    let [h, d, a] = oddsPct;
    if (!hasOdds) {
      h = parseInt(r.percent_pred_home, 10) || 0;
      d = parseInt(r.percent_pred_draw, 10) || 0;
      a = parseInt(r.percent_pred_away, 10) || 0;
    }
    const prediction = predFrom(h, d, a);
    const liveScore = r.goals_home != null && r.goals_away != null ? `${r.goals_home}-${r.goals_away}` : '';
    const ou = overUnderTip(r.goals_over_under, r.under_over);
    const winText = prediction === '1' ? 'Home Win' : prediction === '2' ? 'Away Win' : prediction === 'X' ? 'Draw' : '';
    return {
      date: r.unformatedDate || '',
      time,
      homeTeam: r.home_team_name || '',
      awayTeam: r.away_team_name || '',
      score: liveScore,
      status: normStatus(r),
      league: r.league_name || '',
      prediction,
      correctScore: bestCorrectScore(r.double_chance_goals, prediction),
      probHome: h,
      probDraw: d,
      probAway: a,
      advice: [winText, ou].filter(Boolean).join(' · '),
      hasOdds,
    };
  });
}

// Step 2: try the structured JSON first; fall back to AI text-extraction (Forebet path).
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

// Step 3: scrape multiple pages and merge them so all three sections populate.
async function runScrape(trigger = 'scheduler') {
  if (status.running) {
    console.log('[scrape] already running, skipping');
    return { skipped: true };
  }
  status.running = true;
  status.lastRun = new Date().toISOString();
  console.log(`[scrape] start (${trigger})`);
  try {
    // Scrape MULTIPLE pages and merge them all so every section populates straight away:
    //   primary    - your TARGET_URL (Forebet by default; usually Cloudflare-blocked for now)
    //   today      - pitchpredictions homepage (live + upcoming today)
    //   yesterday  - pitchpredictions /yesterday (finished matches → Past section)
    //   tomorrow   - pitchpredictions /tomorrow (more upcoming)
    const PP = 'https://www.pitchpredictions.com';
    const sources = [
      { name: 'primary',   url: TARGET_URL,                                useProxy: true  },
      { name: 'today',     url: FALLBACK_URL || PP,                         useProxy: false },
      { name: 'yesterday', url: PP + '/football-predictions-yesterday',     useProxy: false },
      { name: 'tomorrow',  url: PP + '/football-predictions-tomorrow',      useProxy: false },
    ].filter((s) => s.url);
    const seenUrls = new Set();
    let list = [];
    const usedSources = [];
    let why = '';
    for (const src of sources) {
      if (seenUrls.has(src.url)) continue; // skip if same URL configured twice
      seenUrls.add(src.url);
      try {
        const html = await fetchPageHTML(src.url, src.useProxy);
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

    // Merge new scrape into existing cache so finished matches persist across days
    // (the source rotates them off the homepage once a new day begins).
    const now = Date.now();
    const newMatches = { ...store.matches };
    const newPreds = { ...store.preds };
    for (const p of list) {
      if (!p.homeTeam || !p.awayTeam) continue;
      // Time-aware status: source data is unreliable, infer from kickoff time.
      p.status = effectiveStatus(p.date, p.time, p.status);
      // Only filter upcoming matches by odds — always show LIVE/FT (real or inferred).
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
        h,
        d,
        a,
        score: p.correctScore || '',
        advice: p.advice || (p.prediction === '1' ? 'Home Win' : p.prediction === '2' ? 'Away Win' : p.prediction === 'X' ? 'Draw' : ''),
        confidence: Math.round(Math.max(h, d, a) / 10) / 10,
        sources: ['scraped'],
        aiUsed: true,
      };
    }
    // Re-infer status for ALL cached matches so NS → LIVE → FT progresses over time
    // even for matches that already rolled off the source feed.
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

// ---- Optional Telegram control (only active if TELEGRAM_BOT_TOKEN is set) ----
function tgSend(chatId, text) {
  if (!TG_TOKEN) return;
  httpRequest('POST', `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    body: { chat_id: chatId, text, parse_mode: 'HTML' },
  }).catch(() => {});
}

function statusText() {
  return (
    `📊 <b>Status</b>\n` +
    `Matches cached: ${Object.keys(store.matches).length}\n` +
    `Source: ${status.source || 'none'}\n` +
    `Last run: ${status.lastRun || 'never'}\n` +
    `Last success: ${status.lastOk || 'never'}\n` +
    `Last error: ${status.lastError || 'none'}\n` +
    `Auto-refresh: every ${REFRESH_MINUTES} min`
  );
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
        if (cmd === '/start') tgSend(chatId, '⚽ <b>Prediction scraper</b>\n/scrape - run now\n/status - last run info');
        else if (cmd === '/scrape') {
          tgSend(chatId, '⏳ Scraping now...');
          runScrape('telegram').then((r) => tgSend(chatId, r.error ? `❌ ${r.error}` : `✅ ${r.count} matches`));
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

app.get('/api/health', (req, res) =>
  res.json({
    ok: !status.lastError,
    matches: Object.keys(store.matches).length,
    lastRun: status.lastRun,
    lastOk: status.lastOk,
    lastError: status.lastError,
    source: status.source,
    refreshMinutes: REFRESH_MINUTES,
    target: TARGET_URL,
    fallback: FALLBACK_URL,
  })
);

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

// Manual trigger. If ADMIN_KEY is set, call /scrape-now?key=YOUR_KEY
app.get('/scrape-now', async (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  res.json(await runScrape('http'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚽ Prediction scraper live on :${PORT}`);
  console.log(`   primary=${TARGET_URL}`);
  console.log(`   fallback=${FALLBACK_URL}  refresh=${REFRESH_MINUTES}min  browserless=${BROWSERLESS_HOST}`);
  setTimeout(() => runScrape('boot'), 3000);
  setInterval(() => runScrape('scheduler'), REFRESH_MINUTES * 60 * 1000);
  if (TG_TOKEN) pollTelegram();
});
