'use strict';

/*
 * Football prediction scraper.
 *
 * Pipeline (runs on boot, then every REFRESH_MINUTES):
 *   1. Browserless loads TARGET_URL in a real cloud browser (optionally via proxy).
 *   2. OpenAI reads the rendered HTML and returns structured predictions as JSON.
 *   3. Results are cached in memory and served to your website at /api/scores.
 *
 * All config comes from environment variables (no secrets in this file):
 *   PORT                 web port (Railway sets this automatically)
 *   REFRESH_MINUTES      how often to re-scrape (default 20)
 *   TARGET_URL           the predictions page to scrape
 *   BROWSERLESS_TOKEN    required - your browserless.io API token
 *   BROWSERLESS_HOST     browserless host (default chrome.browserless.io)
 *   BROWSERLESS_PROXY    optional - set to "residential" to use Browserless's proxy
 *   OPENAI_API_KEY       required - used to extract predictions from HTML
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
const TARGET_URL = process.env.TARGET_URL || 'https://www.pitchpredictions.com';

const BROWSERLESS_HOST = process.env.BROWSERLESS_HOST || 'chrome.browserless.io';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// In-memory cache. Rebuilt fresh on every successful scrape.
const store = { matches: {}, preds: {} };
const status = { lastRun: null, lastOk: null, lastError: null, lastCount: 0, running: false };

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

// Step 1: render the page in a cloud browser and return its HTML.
async function fetchPageHTML() {
  if (!BROWSERLESS_TOKEN) throw new Error('BROWSERLESS_TOKEN not set');
  // Browserless v2 takes the proxy as a QUERY PARAM, not in the POST body.
  // Optional: set env BROWSERLESS_PROXY=residential to route via Browserless's
  // built-in residential proxy (helps bypass Cloudflare). Leave it unset for no proxy.
  let url = `https://${BROWSERLESS_HOST}/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  const bproxy = process.env.BROWSERLESS_PROXY || '';
  if (bproxy) {
    url += `&proxy=${encodeURIComponent(bproxy)}&proxySticky=true`;
    if (process.env.PROXY_COUNTRY) url += `&proxyCountry=${encodeURIComponent(process.env.PROXY_COUNTRY)}`;
  }
  const payload = {
    url: TARGET_URL,
    gotoOptions: { waitUntil: 'networkidle2', timeout: 45000 },
  };
  const { status: code, text } = await httpRequest('POST', url, { body: payload });
  if (code !== 200) throw new Error(`Browserless HTTP ${code}: ${text.slice(0, 200)}`);
  if (!text || text.length < 200) throw new Error('Browserless returned empty/short HTML');
  return text;
}

// Step 2: turn raw HTML into structured predictions using OpenAI.
async function extractPredictions(html) {
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
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: html.slice(0, 80000) }, // keep token cost/latency bounded
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 3000,
  };
  const { status: code, text } = await httpRequest('POST', 'https://api.openai.com/v1/chat/completions', {
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body,
  });
  if (code !== 200) throw new Error(`OpenAI HTTP ${code}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const content = data.choices && data.choices[0] && data.choices[0].message.content;
  const parsed = JSON.parse(content || '{}');
  return Array.isArray(parsed) ? parsed : parsed.matches || parsed.predictions || [];
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

// Step 3: scrape, extract, and atomically swap the cache.
async function runScrape(trigger = 'scheduler') {
  if (status.running) {
    console.log('[scrape] already running, skipping');
    return { skipped: true };
  }
  status.running = true;
  status.lastRun = new Date().toISOString();
  console.log(`[scrape] start (${trigger}) -> ${TARGET_URL}`);
  try {
    const html = await fetchPageHTML();
    console.log(`[scrape] fetched ${html.length} bytes, extracting...`);
    const list = await extractPredictions(html);

    const matches = {};
    const preds = {};
    for (const p of list) {
      if (!p.homeTeam || !p.awayTeam) continue;
      const k = matchKey(p.homeTeam, p.awayTeam);
      const h = clampPct(p.probHome);
      const d = clampPct(p.probDraw);
      const a = clampPct(p.probAway);
      matches[k] = {
        id: k,
        date: p.date || '',
        time: p.time || '',
        home: { name: p.homeTeam, score: parseScore(p.score, 0) },
        away: { name: p.awayTeam, score: parseScore(p.score, 1) },
        leagueName: p.league || '',
        status: p.status || (p.score ? 'LIVE' : 'NS'),
        prediction: p.prediction || '',
        correctScore: p.correctScore || '',
        advice: p.advice || '',
      };
      preds[k] = {
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

    store.matches = matches;
    store.preds = preds;
    status.lastOk = new Date().toISOString();
    status.lastError = list.length ? null : 'No matches extracted';
    status.lastCount = Object.keys(matches).length;
    console.log(`[scrape] stored ${status.lastCount} matches`);
    if (TG_TOKEN && ADMIN_ID) tgSend(ADMIN_ID, `✅ Scrape ok: ${status.lastCount} matches updated.`);
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
    refreshMinutes: REFRESH_MINUTES,
    target: TARGET_URL,
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
  console.log(`   target=${TARGET_URL}  refresh=${REFRESH_MINUTES}min  browserless=${BROWSERLESS_HOST}`);
  setTimeout(() => runScrape('boot'), 3000);
  setInterval(() => runScrape('scheduler'), REFRESH_MINUTES * 60 * 1000);
  if (TG_TOKEN) pollTelegram();
});
