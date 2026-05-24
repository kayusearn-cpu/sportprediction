'use strict';
const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PORT            = process.env.PORT               || 3000;
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN  || '';
const ADMIN_ID        = process.env.TELEGRAM_ADMIN_ID   || '';
const BROWSERLESS_KEY = process.env.BROWSERLESS_TOKEN   || '';
const OPENAI_KEY      = process.env.OPENAI_API_KEY      || '';

// ── In‑memory store ───────────────────────────────────────────────────────────
let store = { matches: {}, preds: {} };
const userState = {};

function matchKey(home, away) {
    return `${(home || '').trim().toLowerCase()}|${(away || '').trim().toLowerCase()}`;
}
function setState(chatId, step, data = {}) { userState[chatId] = { step, data }; }
function clearState(chatId)                { delete userState[chatId]; }
function getState(chatId)                  { return userState[chatId] || null; }

// ── Telegram helpers ─────────────────────────────────────────────────────────
function tgPost(method, data) {
    if (!TG_TOKEN) return;
    const body = JSON.stringify(data);
    https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${TG_TOKEN}/${method}`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }).on('error', () => {}).end(body);
}
const reply   = (chatId, text) => tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
const replyKb = (chatId, text, kb) => tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
const answerCb = (id) => tgPost('answerCallbackQuery', { callback_query_id: id });

const MAIN_KB = [
    [{ text: '🔴 Live', callback_data: 'btn_live' }, { text: '✅ Finished', callback_data: 'btn_finished' }],
    [{ text: '🔵 Upcoming', callback_data: 'btn_upcoming' }, { text: '👁 Preview', callback_data: 'btn_preview' }],
    [{ text: '🔄 Scrape Forebet', callback_data: 'btn_sync' }, { text: '✏️ Edit/Delete', callback_data: 'btn_edit' }],
];

function showMainMenu(chatId) {
    const count = Object.keys(store.matches).length;
    replyKb(chatId, `🎯 <b>Magic Analysis Bot</b>\n\n📦 ${count} match(es) stored.\n\nWhat would you like to do?`, MAIN_KB);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function httpsGet(hostname, path, headers) {
    return new Promise((resolve, reject) => {
        https.get({ hostname, path, headers: Object.assign({ 'User-Agent': 'MagicBot/1.0' }, headers || {}) }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve(raw));
        }).on('error', reject);
    });
}
function httpsPostJson(hostname, path, body, headers) {
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname, path, method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }, headers || {}),
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

// ── PURE HTTP SCRAPER (with detailed logs) ───────────────────────────────────
async function scrapeForebetHttp() {
    console.log('[HTTP] Fetching Forebet HTML...');
    const html = await httpsGet('www.forebet.com', '/en/football-tips-and-predictions-for-today/predictions-1x2');
    console.log(`[HTTP] Received ${html.length} bytes`);

    const rowPattern = /<div class='rcnt tr_\d+'>([\s\S]*?)(?=<div class='rcnt tr_\d+'>|$)/gi;
    const rows = html.match(rowPattern) || [];
    console.log(`[HTTP] Found ${rows.length} potential match rows`);

    const matches = [];
    for (const row of rows) {
        const homeMatch = row.match(/<span class="homeTeam"[^>]*>[\s\S]*?<span itemprop="name">([^<]+)<\/span>/i);
        const awayMatch = row.match(/<span class="awayTeam"[^>]*>[\s\S]*?<span itemprop="name">([^<]+)<\/span>/i);
        if (!homeMatch || !awayMatch) continue;
        const home = homeMatch[1].trim();
        const away = awayMatch[1].trim();

        const dateMatch = row.match(/<time itemprop="startDate" datetime="([^"]+)"/i);
        const [date, time] = dateMatch ? dateMatch[1].split('T') : ['', ''];

        const fprcBlock = row.match(/<div class='fprc'>([\s\S]*?)<\/div>/i);
        const probSpans = fprcBlock ? fprcBlock[1].match(/<span[^>]*>(\d+)<\/span>/gi) : [];
        const probs = probSpans ? probSpans.map(s => parseInt(s.match(/>(\d+)</)[1])) : [33,33,33];
        const [probHome, probDraw, probAway] = probs.length >= 3 ? probs : [33,33,33];

        const predMatch = row.match(/<span class="forepr">\s*<span>([12Xx])<\/span>/i);
        const prediction = predMatch ? predMatch[1].toUpperCase() : '';

        const scoreMatch = row.match(/<div class="ex_sc tabonly">\s*([\d\s\-–]+)\s*<\/div>/i);
        const score = scoreMatch ? scoreMatch[1].trim().replace(/\s+/g, '') : '';

        matches.push({ home, away, date: date || new Date().toISOString().split('T')[0], time, prediction, score, probHome, probDraw, probAway });
    }
    console.log(`[HTTP] Successfully extracted ${matches.length} matches`);
    return matches;
}

// ── BROWSERLESS FALLBACK ─────────────────────────────────────────────────────
async function scrapeForebetBrowserless() {
    if (!BROWSERLESS_KEY) { console.warn('[Browserless] No token – skipped'); return []; }
    console.log('[Browserless] Launching headless browser...');
    const payload = {
        url: 'https://www.forebet.com/en/football-tips-and-predictions-for-today/predictions-1x2',
        elements: [{ selector: '.rcnt' }],   // grab all match containers
        gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 }
    };
    try {
        const result = await httpsPostJson('chrome.browserless.io', `/scrape?token=${BROWSERLESS_KEY}`, payload);
        const containers = result?.data?.[0]?.results || [];
        const matches = [];
        for (const c of containers) {
            const home = c.querySelector('.homeTeam span')?.textContent?.trim() || '';
            const away = c.querySelector('.awayTeam span')?.textContent?.trim() || '';
            if (!home || !away) continue;
            const predEl = c.querySelector('.forepr span');
            const prediction = predEl ? predEl.textContent.trim() : '';
            const scoreEl = c.querySelector('.ex_sc');
            const score = scoreEl ? scoreEl.textContent.trim().replace(/\s/g, '') : '';
            const probEls = c.querySelectorAll('.fprc span');
            const probs = [...probEls].map(el => parseInt(el.textContent) || 0);
            matches.push({
                home, away,
                date: new Date().toISOString().split('T')[0],
                time: '',
                prediction,
                score,
                probHome: probs[0] || 33,
                probDraw: probs[1] || 33,
                probAway: probs[2] || 33,
            });
        }
        console.log(`[Browserless] Extracted ${matches.length} matches`);
        return matches;
    } catch (err) {
        console.error('[Browserless] Error:', err.message);
        return [];
    }
}

// ── MAIN SCRAPE FUNCTION (HTTP first, then Browserless) ─────────────────────
async function scrapeForebet() {
    let matches = await scrapeForebetHttp();
    if (!matches.length) {
        console.log('[Scraper] HTTP yielded 0 matches – falling back to Browserless');
        matches = await scrapeForebetBrowserless();
    }
    return matches;
}

// ── Update store ────────────────────────────────────────────────────────────
async function syncForebetToStore() {
    const matches = await scrapeForebet();
    if (!matches.length) {
        console.warn('[Sync] No matches obtained – store not updated');
        return;
    }
    for (const m of matches) {
        const k = matchKey(m.home, m.away);
        store.matches[k] = {
            id: k, home: { name: m.home, score: null }, away: { name: m.away, score: null },
            leagueName: '', country: '', time: m.time, status: 'NS',
            manual_prediction: `${m.prediction} (${m.score})`
        };
        store.preds[k] = {
            h: Math.round(m.probHome), d: Math.round(m.probDraw), a: Math.round(m.probAway),
            score: m.score,
            advice: m.prediction === '1' ? 'Home Win' : m.prediction === '2' ? 'Away Win' : 'Draw',
            confidence: Math.round(Math.max(m.probHome, m.probDraw, m.probAway) / 10) / 10,
            sources: ['forebet'], aiUsed: false
        };
    }
    console.log(`[Sync] Store updated with ${matches.length} matches`);
}

// ── Bot handlers (unchanged, just keep your existing ones) ──────────────────
// (Include all your previous handler functions here – they are identical to the last full code I sent, minus the scraper part)
// For brevity I'm omitting them – you already have them. Just copy from the previous full server.js.
// ── BUT ensure the btn_sync callback calls syncForebetToStore() and not the old sync function.

// ... [paste your existing handlers: showPreview, showEditList, handleStateInput, handleCallbackQuery, etc.] ...

// ── Polling loop (unchanged) ────────────────────────────────────────────────
let offset = 0;
async function pollTelegram() { /* your existing polling code */ }

// ── Frontend endpoints (unchanged) ──────────────────────────────────────────
app.get('/api/scores', (req, res) => { /* your existing code */ });
app.get('/api/get-predictions', (req, res) => { /* your existing code */ });

// ── Start server, polling, and periodic scraping ────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚽ Magic Analysis Bot live on port ${PORT}`);
    pollTelegram();
    syncForebetToStore();
    setInterval(syncForebetToStore, 20 * 60 * 1000);
});
