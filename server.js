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
    const req = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${TG_TOKEN}/${method}`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
}

const reply   = (chatId, text) =>
    tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
const replyKb = (chatId, text, keyboard) =>
    tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
const answerCb = (id) =>
    tgPost('answerCallbackQuery', { callback_query_id: id });

// ── Main menu keyboard ────────────────────────────────────────────────────────
const MAIN_KB = [
    [
        { text: '🔴  Live Matches',    callback_data: 'btn_live'     },
        { text: '✅  Finished',        callback_data: 'btn_finished' },
    ],
    [
        { text: '🔵  Upcoming',        callback_data: 'btn_upcoming' },
        { text: '👁  Preview',         callback_data: 'btn_preview'  },
    ],
    [
        { text: '🔄  Scrape Forebet',  callback_data: 'btn_sync'     },
        { text: '✏️  Edit / Delete',   callback_data: 'btn_edit'     },
    ],
];

function showMainMenu(chatId) {
    const count = Object.keys(store.matches).length;
    replyKb(chatId,
        `🎯 <b>Magic Analysis Bot</b>\n\n📦 ${count} match(es) stored.\n\nWhat would you like to do?`,
        MAIN_KB
    );
}

// ── HTTPS helpers for outbound API calls ─────────────────────────────────────
function httpsGet(hostname, path, headers) {
    return new Promise((resolve, reject) => {
        https.get({
            hostname,
            path,
            headers: Object.assign({ 'User-Agent': 'Mozilla/5.0' }, headers || {}),
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => resolve(raw));
        }).on('error', reject);
    });
}

function httpsPostJson(hostname, path, body, headers) {
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname,
            path,
            method: 'POST',
            headers: Object.assign({
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
            }, headers || {}),
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

// ── IMPROVED SCRAPERS ───────────────────────────────────────────────────────
async function scrapeForebetHttp() {
    console.log('[HTTP] Fetching Forebet HTML...');
    const html = await httpsGet('www.forebet.com', '/en/football-tips-and-predictions-for-today/predictions-1x2');
    console.log(`[HTTP] Received ${html.length} bytes`);

    const rowPattern = /<div class='rcnt tr_\d+'>([\s\S]*?)(?=<div class='rcnt tr_\d+'>|<\/div>\s*<\/div>\s*$)/gi;
    const rows = html.match(rowPattern) || [];
    console.log(`[HTTP] Found ${rows.length} potential match rows`);

    if (rows.length > 0) {
        console.log('[HTTP] First row preview:', rows[0].substring(0, 500));
    }

    const matches = [];
    for (const row of rows) {
        const homeMatch = row.match(/<span class="homeTeam"[^>]*>[\s\S]*?<span itemprop="name">([^<]+)<\/span>/i);
        const awayMatch = row.match(/<span class="awayTeam"[^>]*>[\s\S]*?<span itemprop="name">([^<]+)<\/span>/i);
        if (!homeMatch || !awayMatch) continue;

        const home = homeMatch[1].trim();
        const away = awayMatch[1].trim();

        const dateMatch = row.match(/<time itemprop="startDate" datetime="([^"]+)"/i);
        const [date, time] = dateMatch ? dateMatch[1].split('T') : [new Date().toISOString().split('T')[0], ''];

        const fprcBlock = row.match(/<div class='fprc'>([\s\S]*?)<\/div>/i);
        let probs = [33, 33, 33];
        if (fprcBlock) {
            const spans = fprcBlock[1].match(/<span[^>]*>(\d+)<\/span>/gi);
            if (spans && spans.length >= 3) {
                probs = spans.map(s => parseInt(s.match(/>(\d+)</)[1]));
            }
        }
        const [probHome, probDraw, probAway] = probs.length === 3 ? probs : [33, 33, 33];

        const predMatch = row.match(/<span class="forepr">\s*<span>([12Xx])<\/span>/i);
        const prediction = predMatch ? predMatch[1].toUpperCase() : '';

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

async function scrapeForebetBrowserless() {
    if (!BROWSERLESS_KEY) { console.warn('[Browserless] No token – skipped'); return []; }
    console.log('[Browserless] Launching headless browser...');
    const payload = {
        url: 'https://www.forebet.com/en/football-tips-and-predictions-for-today/predictions-1x2',
        elements: [{ selector: '.rcnt' }],
        gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
    };
    try {
        const result = await httpsPostJson('chrome.browserless.io', `/scrape?token=${BROWSERLESS_KEY}`, payload);
        const containers = result?.data?.[0]?.results || [];
        const matches = [];

        for (const c of containers) {
            const getText = (selector) => {
                const el = c.querySelector(selector);
                return el ? (el.textContent || el.innerText || '').trim() : '';
            };
            let home = getText('.homeTeam span[itemprop="name"]') || getText('.homeTeam span');
            let away = getText('.awayTeam span[itemprop="name"]') || getText('.awayTeam span');
            if (!home || !away) continue;

            const prediction = getText('.forepr span');
            const score = getText('.ex_sc').replace(/\s/g, '');

            const probSpans = c.querySelectorAll('.fprc span');
            const probs = [];
            for (const s of probSpans) {
                const t = (s.textContent || '').trim();
                if (/^\d+$/.test(t)) probs.push(parseInt(t));
            }
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

async function scrapeForebetJsonFallback() {
    console.log('[JSON fallback] Looking for embedded JSON...');
    const html = await httpsGet('www.forebet.com', '/en/football-tips-and-predictions-for-today/predictions-1x2');
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

async function scrapeForebet() {
    let matches = await scrapeForebetHttp();
    if (!matches.length) {
        console.log('[Scraper] HTTP returned 0, trying Browserless...');
        matches = await scrapeForebetBrowserless();
    }
    if (!matches.length) {
        console.log('[Scraper] Browserless returned 0, trying JSON fallback...');
        matches = await scrapeForebetJsonFallback();
    }
    return matches;
}

async function syncForebetToStore() {
    const matches = await scrapeForebet();
    if (!matches.length) {
        console.warn('[Sync] No matches obtained – store not updated');
        return;
    }
    for (const m of matches) {
        const k = matchKey(m.home, m.away);
        store.matches[k] = {
            id:                k,
            home:              { name: m.home, score: null },
            away:              { name: m.away, score: null },
            leagueName:        '',
            country:           '',
            time:              m.time,
            status:            'NS',
            manual_prediction: `${m.prediction} (${m.score})`,
        };
        store.preds[k] = {
            h:          Math.round(m.probHome),
            d:          Math.round(m.probDraw),
            a:          Math.round(m.probAway),
            score:      m.score,
            advice:     m.prediction === '1' ? 'Home Win' : m.prediction === '2' ? 'Away Win' : 'Draw',
            confidence: Math.round(Math.max(m.probHome, m.probDraw, m.probAway) / 10) / 10,
            sources:    ['forebet'],
            aiUsed:     false,
        };
    }
    console.log(`[Sync] Store updated with ${matches.length} matches`);
}

// ── Bot handlers ─────────────────────────────────────────────────────────────
function showPreview(chatId) {
    const keys = Object.keys(store.matches);
    if (!keys.length) {
        replyKb(chatId, '📋 No matches stored yet.', [[{ text: '⬅️ Back', callback_data: 'back_main' }]]);
        return;
    }
    const lines = keys.map((k, i) => {
        const m    = store.matches[k];
        const p    = store.preds[k];
        const sc   = m.home.score != null && m.away.score != null ? ` <b>${m.home.score}–${m.away.score}</b>` : '';
        const icon = m.status === 'FT' ? '✅' : m.status === 'NS' ? '🔵' : '🔴';
        const time = m.time ? ` @ ${m.time}` : '';
        const pred = p
            ? `   ↳ ${p.h}% / ${p.d}% / ${p.a}%${p.score ? ' · ' + p.score : ''}${p.advice ? '\n   ↳ ' + p.advice : ''}`
            : '   ↳ No prediction';
        const tip  = m.manual_prediction ? `\n   ↳ Tip: ${m.manual_prediction}` : '';
        return `${i + 1}. ${icon} <b>${m.home.name} vs ${m.away.name}</b>${sc}\n   ${m.leagueName}${m.country ? ' · ' + m.country : ''}${time}\n${pred}${tip}`;
    });
    replyKb(chatId,
        `<b>👁 Preview — ${keys.length} match(es)</b>\n\n${lines.join('\n\n')}`,
        [[{ text: '⬅️ Back to Menu', callback_data: 'back_main' }]]
    );
}

function showEditList(chatId) {
    const keys = Object.keys(store.matches);
    if (!keys.length) {
        replyKb(chatId, '📋 No matches to edit.', [[{ text: '⬅️ Back', callback_data: 'back_main' }]]);
        return;
    }
    const rows = keys.map((k, i) => {
        const m = store.matches[k];
        const icon = m.status === 'FT' ? '✅' : m.status === 'NS' ? '🔵' : '🔴';
        return [
            { text: `${icon} ${i + 1}. ${m.home.name} vs ${m.away.name}`, callback_data: `edit_sel_${k}` },
            { text: '🗑️', callback_data: `del_${k}` },
        ];
    });
    rows.push([{ text: '⬅️ Back to Menu', callback_data: 'back_main' }]);
    replyKb(chatId, '<b>✏️ Edit / Delete Matches</b>\n\nTap a match to edit, or 🗑️ to delete:', rows);
}

function handleStateInput(chatId, text, state) {
    const args = text.split('|').map(s => s.trim());

    if (state.step === 'live_input') {
        const [home, away, hg, ag, min] = args;
        if (!home || !away) { reply(chatId, '❌ Format: Home | Away | HomeGoals | AwayGoals | Minute'); return; }
        const k = matchKey(home, away);
        if (!store.matches[k]) { reply(chatId, `❌ Match not found: <b>${home} vs ${away}</b>\nAdd it first via 🔵 Upcoming.`); return; }
        store.matches[k].home.score = parseInt(hg) || 0;
        store.matches[k].away.score = parseInt(ag) || 0;
        store.matches[k].status     = min ? String(parseInt(min) || 'LIVE') : 'LIVE';
        clearState(chatId);
        reply(chatId, `🔴 Live updated: <b>${home} ${hg}–${ag} ${away}</b>${min ? ' (' + min + '\')' : ''}`);
        showMainMenu(chatId);
        return;
    }

    if (state.step === 'finished_input') {
        const [home, away, hg, ag] = args;
        if (!home || !away) { reply(chatId, '❌ Format: Home | Away | HomeGoals | AwayGoals'); return; }
        const k = matchKey(home, away);
        if (!store.matches[k]) { reply(chatId, `❌ Match not found: <b>${home} vs ${away}</b>`); return; }
        store.matches[k].home.score = parseInt(hg) || 0;
        store.matches[k].away.score = parseInt(ag) || 0;
        store.matches[k].status     = 'FT';
        clearState(chatId);
        reply(chatId, `✅ Full Time: <b>${home} ${hg}–${ag} ${away}</b>`);
        showMainMenu(chatId);
        return;
    }

    if (state.step === 'upcoming_input') {
        const [home, away, league, country, time, hp, dp, ap, score, advice, protip] = args;
        if (!home || !away) { reply(chatId, '❌ Minimum required: Home | Away'); return; }
        const k = matchKey(home, away);
        store.matches[k] = {
            id:                k,
            home:              { name: home, score: null },
            away:              { name: away, score: null },
            leagueName:        league  || 'Unknown League',
            country:           country || '',
            time:              time    || '',
            status:            'NS',
            manual_prediction: protip  || null,
        };
        const h = parseInt(hp) || 0, d = parseInt(dp) || 0, a = parseInt(ap) || 0;
        if (h || d || a) {
            const total = h + d + a || 100;
            store.preds[k] = {
                h:          Math.round(h * 100 / total),
                d:          Math.round(d * 100 / total),
                a:          Math.round(a * 100 / total),
                score:      score  || null,
                advice:     advice || null,
                confidence: Math.round(Math.max(h, d, a) * 10 / total) / 10,
                sources:    ['manual'],
                aiUsed:     false,
            };
        }
        clearState(chatId);
        const tot = h + d + a || 100;
        reply(chatId, [
            `✅ Added: <b>${home} vs ${away}</b>`,
            `${league || 'Unknown League'}${country ? ' · ' + country : ''}${time ? ' @ ' + time : ''}`,
            (h || d || a) ? `Prediction: ${Math.round(h*100/tot)}% / ${Math.round(d*100/tot)}% / ${Math.round(a*100/tot)}%${score ? ' · ' + score : ''}` : 'No prediction added.',
            protip ? `⭐ Pro Tip: ${protip}` : '',
        ].filter(Boolean).join('\n'));
        showMainMenu(chatId);
        return;
    }

    if (state.step === 'edit_input') {
        const { key } = state.data;
        const existing = store.matches[key];
        if (!existing) { reply(chatId, '❌ Match no longer exists.'); clearState(chatId); showMainMenu(chatId); return; }
        const [home, away, league, country, time, hp, dp, ap, score, advice, protip] = args;
        store.matches[key] = {
            ...existing,
            home:              { ...existing.home, name: home || existing.home.name },
            away:              { ...existing.away, name: away || existing.away.name },
            leagueName:        league  || existing.leagueName,
            country:           country || existing.country,
            time:              time    || existing.time,
            manual_prediction: protip  !== undefined ? (protip || null) : existing.manual_prediction,
        };
        const h = parseInt(hp) || 0, d = parseInt(dp) || 0, a = parseInt(ap) || 0;
        if (h || d || a) {
            const total = h + d + a || 100;
            store.preds[key] = {
                h:          Math.round(h * 100 / total),
                d:          Math.round(d * 100 / total),
                a:          Math.round(a * 100 / total),
                score:      score  || null,
                advice:     advice || null,
                confidence: Math.round(Math.max(h, d, a) * 10 / total) / 10,
                sources:    ['manual'],
                aiUsed:     false,
            };
        }
        clearState(chatId);
        reply(chatId, `✅ Updated: <b>${store.matches[key].home.name} vs ${store.matches[key].away.name}</b>`);
        showMainMenu(chatId);
        return;
    }
}

function handleCallbackQuery(cq) {
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const data   = cq.data || '';
    if (!chatId) return;
    answerCb(cq.id);

    if (ADMIN_ID && String(cq.from && cq.from.id) !== String(ADMIN_ID)) return;

    if (data === 'btn_live') {
        setState(chatId, 'live_input');
        replyKb(chatId, [
            '🔴 <b>Update Live Score</b>',
            '',
            'Type in this format:',
            '<code>Home | Away | HomeGoals | AwayGoals | Minute</code>',
            '',
            'Example: <code>Arsenal | Chelsea | 2 | 1 | 65</code>',
        ].join('\n'), [[{ text: '❌ Cancel', callback_data: 'back_main' }]]);
    }
    else if (data === 'btn_finished') {
        setState(chatId, 'finished_input');
        replyKb(chatId, [
            '✅ <b>Add Finished Match</b>',
            '',
            'Type in this format:',
            '<code>Home | Away | HomeGoals | AwayGoals</code>',
            '',
            'Example: <code>Arsenal | Chelsea | 2 | 1</code>',
        ].join('\n'), [[{ text: '❌ Cancel', callback_data: 'back_main' }]]);
    }
    else if (data === 'btn_upcoming') {
        setState(chatId, 'upcoming_input');
        replyKb(chatId, [
            '🔵 <b>Add Upcoming Match</b>',
            '',
            'Type in this format:',
            '<code>Home | Away | League | Country | Time | H% | D% | A% | Score | Advice | ProTip</code>',
            '',
            'Fields after Away are optional.',
            'Example: <code>Real Madrid | Barcelona | LaLiga | Spain | 20:00 | 40 | 30 | 30 | 2-1 | Home Win | 1 (2-1)</code>',
        ].join('\n'), [[{ text: '❌ Cancel', callback_data: 'back_main' }]]);
    }
    else if (data === 'btn_sync') {
        reply(chatId, '⏳ Scraping Forebet predictions...');
        syncForebetToStore().then(() => {
            reply(chatId, `✅ Forebet predictions scraped and stored. Use 👁 Preview.`);
            showMainMenu(chatId);
        }).catch(err => {
            reply(chatId, `❌ Scrape error: ${err.message}`);
        });
    }
    else if (data === 'btn_preview') {
        showPreview(chatId);
    }
    else if (data === 'btn_edit') {
        showEditList(chatId);
    }
    else if (data.startsWith('edit_sel_')) {
        const key = data.replace('edit_sel_', '');
        if (store.matches[key]) {
            setState(chatId, 'edit_input', { key });
            replyKb(chatId, [
                '✏️ <b>Edit Match</b>',
                '',
                'Type updated values (leave blank to keep current):',
                '<code>Home | Away | League | Country | Time | H% | D% | A% | Score | Advice | ProTip</code>',
            ].join('\n'), [[{ text: '❌ Cancel', callback_data: 'back_main' }]]);
        }
    }
    else if (data.startsWith('del_')) {
        const key = data.replace('del_', '');
        delete store.matches[key];
        delete store.preds[key];
        reply(chatId, '🗑️ Match deleted.');
        showMainMenu(chatId);
    }
    else if (data === 'back_main') {
        clearState(chatId);
        showMainMenu(chatId);
    }
}

// ── Polling loop ──────────────────────────────────────────────────────────────
let offset = 0;
async function pollTelegram() {
    if (!TG_TOKEN) return;
    try {
        const result = await httpsGet(
            'api.telegram.org',
            `/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=30`
        );
        const data = JSON.parse(result);
        if (data && data.ok) {
            for (const update of data.result) {
                offset = update.update_id + 1;
                if (update.message) {
                    const chatId = update.message.chat.id;
                    const text   = update.message.text || '';
                    if (text === '/start') {
                        showMainMenu(chatId);
                    } else {
                        const state = getState(chatId);
                        if (state) {
                            handleStateInput(chatId, text, state);
                        } else {
                            reply(chatId, 'Press a button from the menu below.');
                            showMainMenu(chatId);
                        }
                    }
                } else if (update.callback_query) {
                    handleCallbackQuery(update.callback_query);
                }
            }
        }
    } catch (e) {
        /* ignore */
    }
    pollTelegram();
}

// ── Frontend API endpoints ──────────────────────────────────────────────────
app.get('/api/scores', (req, res) => {
    const matches = Object.entries(store.matches).map(([key, m]) => {
        const pred = store.preds[key];
        return {
            ...m,
            probabilities: pred ? {
                home: pred.h + '%',
                draw: pred.d + '%',
                away: pred.a + '%',
            } : null,
        };
    });
    res.json({ matches });
});

app.get('/api/get-predictions', (req, res) => {
    const { fixture } = req.query;
    if (!fixture) return res.json({ response: [] });
    const pred = store.preds[fixture];
    const match = store.matches[fixture];
    if (!match || !pred) return res.json({ response: [] });
    res.json({
        response: [{
            predictions: {
                percent: {
                    home: pred.h + '%',
                    draw: pred.d + '%',
                    away: pred.a + '%',
                },
                advice: pred.advice,
                code:   pred.advice?.includes('Home') ? '1' : pred.advice?.includes('Away') ? '2' : 'X',
            }
        }]
    });
});

// ── Start server, polling, and periodic scraping ────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚽ Magic Analysis Bot live on port ${PORT}`);
    pollTelegram();
    syncForebetToStore();
    setInterval(syncForebetToStore, 20 * 60 * 1000);
});
