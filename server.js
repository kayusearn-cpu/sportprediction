'use strict';
const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PORT        = process.env.PORT               || 3000;
const OPENAI_KEY  = process.env.OPENAI_API_KEY      || '';
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN  || '';
const ADMIN_ID    = process.env.TELEGRAM_ADMIN_ID   || '';
const APF_KEY     = process.env.API_FOOTBALL_KEY    || '';
const STATPAL_KEY = process.env.STATPAL_API_KEY     || '98e5c7b5-5b16-412c-a270-c3196e4ef98f';

// ── In-memory store ───────────────────────────────────────────────────────────
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
        { text: '🔄  Sync API: Today', callback_data: 'btn_sync'     },
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
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(new Error('httpsGet JSON parse error')); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function httpsPostJson(hostname, path, body, headers) {
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname, path, method: 'POST',
            headers: Object.assign({
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
            }, headers || {}),
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(new Error('httpsPostJson JSON parse error')); }
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

// ── Sync API: Today (with AI predictions matching screenshot format) ─────────
async function syncTodayMatches(chatId) {
    const today = new Date().toISOString().split('T')[0];
    let converted = [];

    reply(chatId, '⏳ Fetching today\'s matches from API...');

    // 1. API-Football — try first if key is set
    if (APF_KEY) {
        try {
            const data = await httpsGet(
                'v3.football.api-sports.io',
                `/fixtures?date=${today}`,
                { 'x-apisports-key': APF_KEY }
            );
            const fixtures = data.response || [];
            if (fixtures.length > 0) {
                converted = fixtures.map(f => ({
                    id:         String(f.fixture.id),
                    date:       today,
                    time:       f.fixture.date ? f.fixture.date.split('T')[1].substring(0, 5) : '',
                    leagueName: f.league.name  || 'Unknown',
                    country:    f.league.country || '',
                    home:       { name: f.teams.home.name, score: null },
                    away:       { name: f.teams.away.name, score: null },
                    status:     'NS',
                    manual_prediction: null,
                }));
                console.log(`Sync: API-Football returned ${converted.length} fixtures`);
            }
        } catch (e) { console.error('APF sync failed:', e.message); }
    }

    // 2. StatPal fallback
    if (!converted.length) {
        try {
            const data = await httpsGet(
                'statpal.io',
                `/api/v1/soccer/livescores?access_key=${STATPAL_KEY}`
            );
            const leagues = data && data.livescore && data.livescore.league;
            if (leagues) {
                const lgArr = Array.isArray(leagues) ? leagues : [leagues];
                lgArr.forEach(lg => {
                    const items = Array.isArray(lg.match) ? lg.match : (lg.match ? [lg.match] : []);
                    items.forEach(m => {
                        converted.push({
                            id:         String(m.id || matchKey(m.home && m.home.name, m.away && m.away.name)),
                            date:       today,
                            time:       m.match_start || m.time || '',
                            leagueName: lg.name || '',
                            country:    typeof lg.country === 'string' ? lg.country : ((lg.country && lg.country.name) || ''),
                            home:       { name: (m.home && m.home.name) || '', score: null },
                            away:       { name: (m.away && m.away.name) || '', score: null },
                            status:     'NS',
                            manual_prediction: null,
                        });
                    });
                });
                console.log(`Sync: StatPal returned ${converted.length} matches`);
            }
        } catch (e) { console.error('StatPal sync failed:', e.message); }
    }

    if (!converted.length) {
        reply(chatId, '⚠️ No matches found for today from any API source.');
        return;
    }

    reply(chatId, `📥 Found <b>${converted.length}</b> match(es).${OPENAI_KEY ? '\n🧠 Generating AI predictions...' : ''}`);

    // ── OpenAI auto‑prediction (with predicted scores) ────────────────────────
    if (OPENAI_KEY && converted.length > 0) {
        try {
            const matchList = converted.map((m, i) =>
                `${i + 1}. ${m.home.name} vs ${m.away.name} (${m.leagueName}, ${m.date} ${m.time})`
            ).join('\n');

            const aiResult = await httpsPostJson(
                'api.openai.com',
                '/v1/chat/completions',
                {
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: [
                                'You are a professional football betting analyst. For each upcoming match, provide:',
                                '- A 1X2 prediction: "1", "X", or "2"',
                                '- A predicted correct score (e.g., "2-1")',
                                '- Percentage probabilities for Home, Draw, and Away that add up to 100.',
                                '',
                                'Return a JSON object with a key "predictions" that is an array. Each element must have:',
                                '- "match": the original match description (exactly as provided)',
                                '- "prediction": "1", "X", or "2"',
                                '- "pScore": the predicted correct score (e.g., "2-1")',
                                '- "probabilityHome", "probabilityDraw", "probabilityAway": numbers 0-100, sum = 100',
                            ].join('\n'),
                        },
                        {
                            role: 'user',
                            content: `Here are the matches:\n${matchList}\n\nPlease return your predictions in JSON.`,
                        },
                    ],
                    response_format: { type: 'json_object' },
                    temperature: 0.7,
                    max_tokens: 1500,
                },
                { 'Authorization': `Bearer ${OPENAI_KEY}` }
            );

            const predictions = JSON.parse(aiResult.choices[0].message.content).predictions || [];
            predictions.forEach((pred, idx) => {
                if (idx < converted.length) {
                    const tip    = pred.prediction || '';
                    const pScore = pred.pScore     || '';
                    // 👇 EXACT SAME FORMAT AS SCREENSHOT UPLOAD
                    converted[idx].manual_prediction = `${tip} (${pScore})`.trim();

                    // Probabilities – ensure they sum to 100
                    const h = Math.round(Number(pred.probabilityHome) || 33);
                    const d = Math.round(Number(pred.probabilityDraw) || 33);
                    const a = 100 - h - d;

                    const k = matchKey(converted[idx].home.name, converted[idx].away.name);
                    store.preds[k] = {
                        h, d, a,
                        score:      pScore || null,
                        advice:     tip === '1' ? 'Home Win' : tip === '2' ? 'Away Win' : 'Draw',
                        confidence: Math.round(Math.max(h, d, a) / 10) / 10,
                        sources:    ['openai'],
                        aiUsed:     true,
                    };
                }
            });
        } catch (e) {
            console.error('OpenAI sync prediction error:', e.message);
            reply(chatId, '⚠️ AI prediction failed, saving matches without predictions.');
        }
    }

    // Save all matches into the in‑memory store (same format as manual upload)
    for (const m of converted) {
        const k = matchKey(m.home.name, m.away.name);
        store.matches[k] = {
            id:                m.id,
            home:              { name: m.home.name, score: null },
            away:              { name: m.away.name, score: null },
            leagueName:        m.leagueName,
            country:           m.country,
            time:              m.time,
            status:            'NS',
            manual_prediction: m.manual_prediction || null,
        };
    }

    const hasPreds = converted.filter(m => m.manual_prediction).length;
    reply(chatId, [
        `✅ Synced <b>${converted.length}</b> match(es) for today.`,
        hasPreds
            ? `🧠 <b>${hasPreds}</b> predictions generated (format: "1 (2-1)").`
            : 'No predictions generated (set OPENAI_API_KEY to enable).',
        '',
        'Use 👁 Preview to review.',
    ].join('\n'));
    showMainMenu(chatId);
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

    // ... (the rest of the input handlers remain unchanged, but I include them for completeness)
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
        syncTodayMatches(chatId);
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

// ── Frontend API endpoints (your Netlify site reads these) ───────────────────
app.get('/api/scores', (req, res) => {
    // Convert store to array of matches, attach predictions
    const matches = Object.entries(store.matches).map(([key, m]) => {
        const pred = store.preds[key];
        return {
            ...m,
            probabilities: pred ? {
                home: pred.h + '%',
                draw: pred.d + '%',
                away: pred.a + '%',
            } : null,
            // Also expose the exact manual_prediction string
        };
    });
    res.json({ matches });
});

app.get('/api/get-predictions', (req, res) => {
    const { fixture } = req.query;  // fixture = match key (e.g. "arsenal|chelsea")
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

// ── Start server and polling ─────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚽ Magic Analysis Bot live on port ${PORT}`);
    pollTelegram();
});
