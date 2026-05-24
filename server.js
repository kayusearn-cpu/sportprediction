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
        https.get({ hostname, path, headers: Object.assign({ 'User-Agent': 'Mozilla/5.0' }, headers || {}) }, res => {
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

// ── IMPROVED HTTP SCRAPER (with debug & correct patterns) ───────────────────
async function scrapeForebetHttp() {
    console.log('[HTTP] Fetching Forebet HTML...');
    const html = await httpsGet('www.forebet.com', '/en/football-tips-and-predictions-for-today/predictions-1x2');
    console.log(`[HTTP] Received ${html.length} bytes`);

    // Use the exact row class from your snippet: <div class='rcnt tr_0'> or tr_1
    const rowPattern = /<div class='rcnt tr_\d+'>([\s\S]*?)(?=<div class='rcnt tr_\d+'>|<\/div>\s*<\/div>\s*$)/gi;
    const rows = html.match(rowPattern) || [];
    console.log(`[HTTP] Found ${rows.length} potential match rows`);

    // Debug: log the first row (first 500 chars)
    if (rows.length > 0) {
        console.log('[HTTP] First row preview:', rows[0].substring(0, 500));
    }

    const matches = [];

    for (const row of rows) {
        // Home/away – your snippet uses <span class="homeTeam" ...>...<span itemprop="name">TEAM</span>
        const homeMatch = row.match(/<span class="homeTeam"[^>]*>[\s\S]*?<span itemprop="name">([^<]+)<\/span>/i);
        const awayMatch = row.match(/<span class="awayTeam"[^>]*>[\s\S]*?<span itemprop="name">([^<]+)<\/span>/i);
        if (!homeMatch || !awayMatch) {
            console.log('[HTTP] Skipping row - missing team names');
            continue;
        }
        const home = homeMatch[1].trim();
        const away = awayMatch[1].trim();

        // Date/time
        const dateMatch = row.match(/<time itemprop="startDate" datetime="([^"]+)"/i);
        const [date, time] = dateMatch ? dateMatch[1].split('T') : [new Date().toISOString().split('T')[0], ''];

        // Probabilities – inside <div class='fprc'>
        const fprcBlock = row.match(/<div class='fprc'>([\s\S]*?)<\/div>/i);
        let probs = [33, 33, 33];
        if (fprcBlock) {
            // The numbers are in <span> elements, but the class may be 'fpr' for the bold one
            const spans = fprcBlock[1].match(/<span[^>]*>(\d+)<\/span>/gi);
            if (spans && spans.length >= 3) {
                probs = spans.map(s => parseInt(s.match(/>(\d+)</)[1]));
            }
        }
        const [probHome, probDraw, probAway] = probs.length === 3 ? probs : [33, 33, 33];

        // Prediction: <span class="forepr"><span>1</span></span>
        const predMatch = row.match(/<span class="forepr">\s*<span>([12Xx])<\/span>/i);
        const prediction = predMatch ? predMatch[1].toUpperCase() : '';

        // Correct score: <div class="ex_sc tabonly">0 - 1</div> OR <div class="ex_sc">0 - 1</div>
        const scoreMatch = row.match(/<div class="ex_sc(?:\s+tabonly)?">\s*([\d\s\-–]+)\s*<\/div>/i);
        const score = scoreMatch ? scoreMatch[1].trim().replace(/\s+/g, '') : '';

        matches.push({
            home, away, date, time, prediction, score,
            probHome, probDraw, probAway,
        });
    }

    console.log(`[HTTP] Successfully extracted ${matches.length} matches`);
    return matches;
}

// ── BROWSERLESS FALLBACK (improved) ──────────────────────────────────────────
async function scrapeForebetBrowserless() {
    if (!BROWSERLESS_KEY) { console.warn('[Browserless] No token – skipped'); return []; }
    console.log('[Browserless] Launching headless browser...');
    const payload = {
        url: 'https://www.forebet.com/en/football-tips-and-predictions-for-today/predictions-1x2',
        elements: [{ selector: '.rcnt' }],   // all match containers
        gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
    };
    try {
        const result = await httpsPostJson('chrome.browserless.io', `/scrape?token=${BROWSERLESS_KEY}`, payload);
        const containers = result?.data?.[0]?.results || [];
        const matches = [];

        for (const c of containers) {
            // Use textContent from the container's sub-elements (Browserless returns a DOM-like object)
            const getText = (selector) => {
                const el = c.querySelector(selector);
                return el ? (el.textContent || el.innerText || '').trim() : '';
            };

            // Teams: .homeTeam span.itemprop="name" or just .homeTeam span
            let home = getText('.homeTeam span[itemprop="name"]');
            let away = getText('.awayTeam span[itemprop="name"]');
            if (!home || !away) {
                // fallback to just any span inside
                home = getText('.homeTeam span');
                away = getText('.awayTeam span');
            }
            if (!home || !away) continue;

            const prediction = getText('.forepr span');
            const score = getText('.ex_sc').replace(/\s/g, '');  // remove spaces

            // Probabilities: .fprc span – get all numbers
            const probSpans = c.querySelectorAll('.fprc span');
            const probs = [];
            for (const s of probSpans) {
                const t = (s.textContent || '').trim();
                if (/^\d+$/.test(t)) probs.push(parseInt(t));
            }
            const probHome = probs[0] || 33;
            const probDraw = probs[1] || 33;
            const probAway = probs[2] || 33;

            matches.push({
                home, away,
                date: new Date().toISOString().split('T')[0],
                time: '',
                prediction,
                score,
                probHome, probDraw, probAway,
            });
        }
        console.log(`[Browserless] Extracted ${matches.length} matches`);
        return matches;
    } catch (err) {
        console.error('[Browserless] Error:', err.message);
        return [];
    }
}

// ── FINAL FALLBACK: Try to find JSON in the page (if embedded) ─────────────
async function scrapeForebetJsonFallback() {
    console.log('[JSON fallback] Attempting to find embedded JSON...');
    const html = await httpsGet('www.forebet.com', '/en/football-tips-and-predictions-for-today/predictions-1x2');
    // Look for window.__INITIAL_STATE__ or a large JSON array
    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
    if (!jsonMatch) return [];
    try {
        const data = JSON.parse(jsonMatch[1]);
        const matchesList = data.matches || data.predictions || data.items || [];
        if (!Array.isArray(matchesList)) return [];
        return matchesList.map(m => ({
            home: m.homeTeam || m.home?.name || '',
            away: m.awayTeam || m.away?.name || '',
            date: m.date || new Date().toISOString().split('T')[0],
            time: m.time || '',
            prediction: m.prediction || '',
            score: m.correctScore || m.score || '',
            probHome: m.probHome || m.probabilities?.home || 33,
            probDraw: m.probDraw || m.probabilities?.draw || 33,
            probAway: m.probAway || m.probabilities?.away || 33,
        }));
    } catch (e) {
        console.error('[JSON fallback] Failed:', e.message);
        return [];
    }
}

// ── MAIN SCRAPE (HTTP → Browserless → JSON fallback) ────────────────────────
async function scrapeForebet() {
    let matches = await scrapeForebetHttp();
    if (!matches.length) {
        console.log('[Scraper] HTTP returned 0 matches, trying Browserless...');
        matches = await scrapeForebetBrowserless();
    }
    if (!matches.length) {
        console.log('[Scraper] Browserless returned 0 matches, trying JSON fallback...');
        matches = await scrapeForebetJsonFallback();
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

// ── Bot handlers (unchanged from earlier full code) ─────────────────────────
// (Insert your existing showPreview, showEditList, handleStateInput, handleCallbackQuery, etc. here)
// For brevity, I'm not repeating them – they are identical to the previous full server.js you have.
// Just copy the ones you already have.

// ── Polling loop (unchanged) ────────────────────────────────────────────────
let offset = 0;
async function pollTelegram() { /* your existing code */ }

// ── Frontend endpoints (unchanged) ──────────────────────────────────────────
app.get('/api/scores', (req, res) => { /* existing */ });
app.get('/api/get-predictions', (req, res) => { /* existing */ });

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚽ Magic Analysis Bot live on port ${PORT}`);
    pollTelegram();
    syncForebetToStore();
    setInterval(syncForebetToStore, 20 * 60 * 1000);
});
