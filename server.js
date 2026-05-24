'use strict';
const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PORT        = process.env.PORT               || 3000;
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN  || '';
const ADMIN_ID    = process.env.TELEGRAM_ADMIN_ID   || '';
const OPENAI_KEY  = process.env.OPENAI_API_KEY      || '';   // optional, if you still want screenshots

// ── In‑memory store ───────────────────────────────────────────────────────────
let store = { matches: {}, preds: {} };

// ── Conversation state per user ───────────────────────────────────────────────
const userState = {};

function matchKey(home, away) {
    return `${(home || '').trim().toLowerCase()}|${(away || '').trim().toLowerCase()}`;
}

function setState(chatId, step, data = {}) { userState[chatId] = { step, data }; }
function clearState(chatId)                { delete userState[chatId]; }
function getState(chatId)                  { return userState[chatId] || null; }

// ── Telegram API helpers ──────────────────────────────────────────────────────
function tgPost(method, data) {
    if (!TG_TOKEN) return;
    const body = JSON.stringify(data);
    const req  = https.request({
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

// ── HTTPS helpers for outbound API calls ──────────────────────────────────────
function httpsGet(hostname, path, headers) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname, path, method: 'GET',
            headers: Object.assign({ 'User-Agent': 'MagicBot/1.0' }, headers || {}),
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try { resolve(raw); }   // return raw HTML, not JSON
                catch (e) { reject(new Error('httpsGet failed')); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ── PURE HTTP FOREBET SCRAPER (no browser, no CSS) ─────────────────────────
async function scrapeForebetViaHttp() {
    try {
        const html = await httpsGet(
            'www.forebet.com',
            '/en/football-tips-and-predictions-for-today/predictions-1x2'
        );

        // Split into individual match rows
        const rowPattern = /<div class='rcnt tr_\d+'>([\s\S]*?)(?=<div class='rcnt tr_\d+'>|$)/gi;
        const rows = html.match(rowPattern) || [];

        const matches = [];

        for (const row of rows) {
            // 1. Home & away teams
            const homeMatch = row.match(/<span class="homeTeam"[^>]*>[\s\S]*?<span itemprop="name">([^<]+)<\/span>/i);
            const awayMatch = row.match(/<span class="awayTeam"[^>]*>[\s\S]*?<span itemprop="name">([^<]+)<\/span>/i);
            if (!homeMatch || !awayMatch) continue;

            const home = homeMatch[1].trim();
            const away = awayMatch[1].trim();

            // 2. Date & time
            const dateMatch = row.match(/<time itemprop="startDate" datetime="([^"]+)"/i);
            const dateTime = dateMatch ? dateMatch[1] : '';
            const [date, time] = dateTime ? dateTime.split('T') : ['', ''];

            // 3. Probabilities (inside <div class='fprc'>)
            const fprcBlock = row.match(/<div class='fprc'>([\s\S]*?)<\/div>/i);
            const probSpans = fprcBlock ? fprcBlock[1].match(/<span[^>]*>(\d+)<\/span>/gi) : [];
            const probs = probSpans
                ? probSpans.map(s => parseInt(s.match(/>(\d+)</)[1]))
                : [33, 33, 33];
            const [probHome, probDraw, probAway] = probs.length >= 3 ? probs : [33, 33, 33];

            // 4. Prediction (1 / X / 2)
            const predMatch = row.match(/<span class="forepr">\s*<span>([12Xx])<\/span>/i);
            const prediction = predMatch ? predMatch[1].toUpperCase() : '';

            // 5. Correct score
            const scoreMatch = row.match(/<div class="ex_sc tabonly">\s*([\d\s\-–]+)\s*<\/div>/i);
            const scoreRaw = scoreMatch ? scoreMatch[1].trim() : '';
            const score = scoreRaw.replace(/\s+/g, '');  // "0 - 1" → "0-1"

            matches.push({
                home,
                away,
                date: date || new Date().toISOString().split('T')[0],
                time: time || '',
                prediction,
                score,
                probHome: probHome || 33,
                probDraw: probDraw || 33,
                probAway: probAway || 33,
            });
        }

        console.log(`✅ HTTP scrape: ${matches.length} matches`);
        return matches;
    } catch (err) {
        console.error('HTTP scrape failed:', err.message);
        return [];
    }
}

// ── Update store with scraped data ─────────────────────────────────────────
async function syncForebetToStore() {
    const matches = await scrapeForebetViaHttp();
    if (!matches.length) return;

    const today = new Date().toISOString().split('T')[0];

    for (const m of matches) {
        const k = matchKey(m.home, m.away);
        store.matches[k] = {
            id:                k,
            home:              { name: m.home, score: null },
            away:              { name: m.away, score: null },
            leagueName:        '',          // not scraped (optional)
            country:           '',
            time:              m.time,
            status:            'NS',
            manual_prediction: `${m.prediction} (${m.score})`,   // "1 (2-1)"
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

    console.log(`📊 Store updated with ${matches.length} Forebet matches`);
}

// ── Preview ───────────────────────────────────────────────────────────────────
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

// ── Edit list ─────────────────────────────────────────────────────────────────
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

// ── Process state input (text typed after pressing a button) ──────────────────
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

// ── Handle button presses ─────────────────────────────────────────────────────
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
        const result = await new Promise((resolve, reject) => {
            https.get({
                hostname: 'api.telegram.org',
                path: `/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=30`,
                headers: { 'User-Agent': 'MagicBot/1.0' },
            }, res => {
                let raw = '';
                res.on('data', c => { raw += c; });
                res.on('end', () => {
                    try { resolve(JSON.parse(raw)); }
                    catch (e) { reject(e); }
                });
            }).on('error', reject);
        });

        if (result && result.ok) {
            for (const update of result.result) {
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
    } catch (e) { /* ignore network errors */ }
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

    // Scrape immediately, then every 20 minutes
    syncForebetToStore();
    setInterval(syncForebetToStore, 20 * 60 * 1000);
});
