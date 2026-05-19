// backend/server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');
const { OpenAI } = require('openai');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc } = require('firebase/firestore');

const app = express();
const port = process.env.PORT || 10000; 
const appId = "magic-betting-tips"; 

app.use(cors());
app.use(express.json());

// ─── Admin Security Configuration ────────────────────────────────────────────
const adminIdsStr = process.env.ADMIN_IDS || "";
const ADMIN_IDS = adminIdsStr.split(',').map(id => id.trim()).filter(id => id !== "");

const checkAdmin = (ctx) => {
    if (ADMIN_IDS.length === 0) return true;
    const userId = String(ctx.from.id);
    if (ADMIN_IDS.includes(userId)) return true;
    ctx.reply(`🚫 *Access Denied*\nYour ID (${userId}) is not authorized.`, { parse_mode: 'Markdown' });
    return false;
};

// ─── Firebase Initialization ─────────────────────────────────────────────────
const firebaseConfigStr = process.env.FIREBASE_CONFIG;
let db = null;
if (firebaseConfigStr) {
    try {
        const firebaseApp = initializeApp(JSON.parse(firebaseConfigStr.trim()));
        db = getFirestore(firebaseApp);
        console.log("🔥 Firebase connected.");
    } catch (err) { console.error("❌ Firebase Error:", err.message); }
}

// ─── OpenAI Initialization ───────────────────────────────────────────────────
let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
} else {
    console.warn("⚠️ OPENAI_API_KEY is missing! Server will run, but Vision features will be disabled.");
}

// ─── StatPal API Integration ─────────────────────────────────────────────────
const STATPAL_KEY = process.env.STATPAL_API_KEY || 'bcd42a3c-46ce-4dd2-aaae-320cf9d98f22';
const MAJOR_LEAGUES = [8, 301, 384, 82, 564, 2, 3, 4, 693, 400, 462, 556, 1, 30]; // Filter for top leagues

async function fetchFromStatPal(endpoint, params = {}) {
    try {
        const r = await axios.get(`https://statpal.io/api/v1/soccer/${endpoint}`, {
            params: { ...params, access_key: STATPAL_KEY },
            timeout: 15000 
        });
        return r.data;
    } catch (error) {
        console.error(`❌ StatPal Error [${endpoint}]:`, error.message);
        return null;
    }
}

// ─── Telegram Bot Logic ──────────────────────────────────────────────────────
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;

if (botToken) {
    bot = new Telegraf(botToken);
    const userSession = {};

    const mainMenu = Markup.keyboard([
        ['🔴 Live', '✅ Past Results', '🔵 Upcoming'],
        ['🔄 Sync API: Today', '🔄 Sync API: Tomorrow'],
        ['📸 Upload Screenshot', '🧹 Replace All with Upcoming'],
        ['🗑️ Clear All Matches']
    ]).resize();

    bot.command('myid', (ctx) => ctx.reply(`ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' }));

    bot.start((ctx) => {
        if (!checkAdmin(ctx)) return;
        ctx.reply('⚽ *Magic AI Dashboard*\n\nManage your site categories, sync real-time API data, or upload a screenshot.', {
            parse_mode: 'Markdown',
            ...mainMenu
        });
    });

    const showCategory = async (ctx, statusFilter) => {
        if (!checkAdmin(ctx)) return;
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
        const matches = (snap.exists() ? snap.data().matches : []).filter(m => m.status === statusFilter);
        if (matches.length === 0) return ctx.reply(`No ${statusFilter} matches.`);
        const buttons = matches.slice(0, 15).map(m => [Markup.button.callback(`${m.home.name} vs ${m.away.name}`, `sel_${m.id}`)]);
        ctx.reply(`Manage ${statusFilter}:`, Markup.inlineKeyboard(buttons));
    };

    bot.hears('🔴 Live', (ctx) => showCategory(ctx, 'Live'));
    bot.hears('✅ Past Results', (ctx) => showCategory(ctx, 'Past'));
    bot.hears('🔵 Upcoming', (ctx) => showCategory(ctx, 'Upcoming'));

    bot.action(/sel_(.+)/, async (ctx) => {
        const matchId = ctx.match[1];
        ctx.answerCbQuery();
        ctx.reply('Editor Settings:', Markup.inlineKeyboard([
            [Markup.button.callback('⚽ Edit Live Score', `edit_score_${matchId}`)],
            [Markup.button.callback('🎯 Edit Prediction', `edit_pred_${matchId}`)],
            [Markup.button.callback('🕒 Edit Minute', `edit_min_${matchId}`), Markup.button.callback('📅 Edit Date', `edit_dt_${matchId}`)],
            [Markup.button.callback('🗑️ Delete Match', `delete_${matchId}`)]
        ]));
    });

    bot.action(/edit_(score|pred|min|dt)_(.+)/, (ctx) => {
        userSession[ctx.from.id] = { matchId: ctx.match[2], editing: ctx.match[1] };
        ctx.answerCbQuery();
        const p = { score: "New Score (e.g. 1-1):", pred: "New Prediction (e.g. 1, X, 2):", min: "New Minute (e.g. 45, HT, FT):", dt: "New Date/Time:" };
        ctx.reply(p[ctx.match[1]]);
    });

    bot.on('text', async (ctx) => {
        const session = userSession[ctx.from.id];
        if (session && session.editing) {
            const val = ctx.message.text;
            try {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
                const snap = await getDoc(docRef);
                let data = snap.data();
                const idx = data.matches.findIndex(m => m.id === session.matchId);
                if (idx !== -1) {
                    if (session.editing === 'score') {
                        const s = val.split('-');
                        data.matches[idx].home.goals = s[0]?.trim();
                        data.matches[idx].away.goals = s[1]?.trim();
                    } else if (session.editing === 'pred') {
                        data.matches[idx].manual_prediction = val;
                    } else if (session.editing === 'min') {
                        data.matches[idx].playing_time = val;
                        if (val === 'FT') data.matches[idx].status = 'Past';
                        else if (!isNaN(parseInt(val)) || val === 'HT') data.matches[idx].status = 'Live';
                    } else if (session.editing === 'dt') {
                        data.matches[idx].date = val.split(' ')[0];
                        data.matches[idx].time = val.split(' ')[1] || "";
                    }
                    await setDoc(docRef, data);
                    ctx.reply('✅ Site Updated!');
                }
                delete userSession[ctx.from.id];
            } catch (e) { ctx.reply('Save error.'); }
            return;
        }
        if (session?.pendingMatches && ctx.message.text === '🚀 Confirm & Publish') return publishMatches(ctx, false);
        if (session?.pendingMatches && ctx.message.text === '🧹 Wipe & Replace All') return publishMatches(ctx, true);
    });

    // ─── StatPal API Fetching Logic ───
    bot.hears(/🔄 Sync API: (Today|Tomorrow)/, async (ctx) => {
        if (!checkAdmin(ctx)) return;
        const day = ctx.match[1];
        ctx.reply(`⏳ Fetching ${day}'s major matches from StatPal...`);
        
        const targetDate = new Date();
        if (day === 'Tomorrow') targetDate.setDate(targetDate.getDate() + 1);
        const dateStr = targetDate.toISOString().split('T')[0];

        try {
            const data = await fetchFromStatPal('fixtures', { date: dateStr });
            if (!data) return ctx.reply('❌ Failed to fetch from API. Check key limits.');
            
            const matchesToSave = [];
            const leagues = data.livescore?.league || (Array.isArray(data.data) ? [{match: data.data}] : []);
            
            leagues.forEach(l => {
                // Filter for major leagues only to avoid fake/obscure matches
                if (l.id && !MAJOR_LEAGUES.includes(Number(l.id))) return;

                const items = Array.isArray(l.match) ? l.match : [l.match].filter(Boolean);
                items.forEach(m => {
                    const statusText = m.status || '';
                    const isFin = ['FT', 'AET', 'PEN'].includes(statusText);
                    const isUpc = ['NS', 'TBD', 'POSTP'].includes(statusText) || /^\d{2}:\d{2}$/.test(statusText);
                    
                    // Smart Categorization: Sorts today's games into proper buckets
                    let computedStatus = "Upcoming";
                    if (isFin) computedStatus = "Past";
                    else if (!isUpc) computedStatus = "Live";

                    // Safely extract scores
                    let hGoal = null, aGoal = null;
                    if (m.score && m.score.includes('-')) {
                        hGoal = m.score.split('-')[0].trim();
                        aGoal = m.score.split('-')[1].trim();
                    } else if (m.home?.goals !== undefined) {
                        hGoal = m.home.goals;
                        aGoal = m.away.goals;
                    }

                    matchesToSave.push({
                        id: `api_${m.id || Date.now()}`,
                        date: dateStr,
                        time: m.time || (isUpc ? statusText : ""),
                        home: { name: m.home?.name || 'Home', goals: hGoal },
                        away: { name: m.away?.name || 'Away', goals: aGoal },
                        leagueName: l.name || "Major League",
                        status: computedStatus,
                        playing_time: computedStatus === "Live" ? statusText : (isFin ? "FT" : ""),
                        manual_prediction: "", 
                        country: "API Data"
                    });
                });
            });

            if (matchesToSave.length === 0) return ctx.reply(`❌ No major matches found for ${day}.`);

            // Merge with existing matches in the DB to preserve manual predictions
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            const snap = await getDoc(docRef);
            let currentData = snap.exists() ? snap.data() : { matches: [] };

            matchesToSave.forEach(newM => {
                const idx = currentData.matches.findIndex(em => em.home.name === newM.home.name && em.away.name === newM.away.name);
                if (idx !== -1) {
                    newM.manual_prediction = currentData.matches[idx].manual_prediction || "";
                    currentData.matches[idx] = newM; // Update existing
                } else {
                    currentData.matches.unshift(newM); // Add new
                }
            });
            
            await setDoc(docRef, { matches: currentData.matches.slice(0, 60) });
            ctx.reply(`✅ Successfully synced ${matchesToSave.length} matches for ${day}!\n\nMatches were automatically sorted into Live, Upcoming, and Past.`);
        } catch(e) {
            ctx.reply('❌ API Error: ' + e.message);
        }
    });

    bot.hears('🧹 Replace All with Upcoming', (ctx) => {
        if (!checkAdmin(ctx)) return;
        ctx.reply('📸 Please upload a screenshot. I will DELETE all existing matches and replace them with these as "Upcoming".');
        userSession[ctx.from.id] = { replaceAllMode: true };
    });

    // ── Vision Handling ──
    bot.on('photo', async (ctx) => {
        if (!checkAdmin(ctx)) return;
        if (!openai) return ctx.reply('❌ OpenAI API Key is missing on the server! Please add OPENAI_API_KEY to your Railway Variables.');
        
        const photo = ctx.message.photo[ctx.message.photo.length - 1]; 
        ctx.reply('⏳ Reading screenshot... Teams, Scores, Predictions, Dates, and Times are being extracted.');

        try {
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            const imageResponse = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
            const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: "Extract football JSON: matches[{home, away, prediction, pScore, liveScore, min, date, time, lg}]. Detect dates and times clearly." }, 
                { role: "user", content: [{ type: "text", text: "Scan:" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }],
                response_format: { type: "json_object" }
            });
            const matches = JSON.parse(completion.choices[0].message.content).matches || [];
            const isReplace = userSession[ctx.from.id]?.replaceAllMode || false;
            userSession[ctx.from.id] = { pendingMatches: matches, replaceAllMode: isReplace };

            let summary = `🔍 Detected ${matches.length} matches:\n\n`;
            matches.forEach((m, i) => summary += `${i+1}. *${m.home} vs ${m.away}*\n🎯 Tip: ${m.prediction || m.pred}\n\n`);

            const btns = isReplace ? [['🧹 Wipe & Replace All'], ['❌ Cancel']] : [['🚀 Confirm & Publish'], ['❌ Cancel']];
            ctx.reply(summary, { parse_mode: 'Markdown', ...Markup.keyboard(btns).resize() });
        } catch (e) { ctx.reply('Vision Scan Error.'); }
    });

    async function publishMatches(ctx, wipeFirst) {
        const session = userSession[ctx.from.id];
        try {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            let currentData = { matches: [] };
            if (!wipeFirst) {
                const snap = await getDoc(docRef);
                currentData = snap.exists() ? snap.data() : { matches: [] };
            }

            session.pendingMatches.forEach(m => {
                let status = wipeFirst ? "Upcoming" : (m.min === 'FT' ? "Past" : (m.min || m.liveScore ? "Live" : "Upcoming"));
                const matchObj = {
                    id: `v_${Date.now()}_${Math.random().toString(36).substr(2, 2)}`,
                    date: m.date || new Date().toLocaleDateString('en-GB'),
                    time: m.time || "",
                    home: { name: m.home, goals: wipeFirst ? null : (m.liveScore ? m.liveScore.split('-')[0].trim() : null) },
                    away: { name: m.away, goals: wipeFirst ? null : (m.liveScore ? m.liveScore.split('-')[1].trim() : null) },
                    leagueName: m.lg || "Pro League",
                    status: status,
                    playing_time: wipeFirst ? "" : (m.min || ""),
                    manual_prediction: `${m.prediction || m.pred} (${m.pScore || ''})`,
                    country: "Pro Tip"
                };
                currentData.matches.unshift(matchObj);
            });
            await setDoc(docRef, { matches: currentData.matches.slice(0, 50) });
            delete userSession[ctx.from.id];
            ctx.reply('✅ Success! Website updated.', mainMenu);
        } catch (e) { ctx.reply('Save Error.'); }
    }

    bot.hears('❌ Cancel', (ctx) => { delete userSession[ctx.from.id]; ctx.reply('Cancelled.', mainMenu); });
    bot.hears('🗑️ Clear All Matches', async (ctx) => { if (checkAdmin(ctx)) await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'), { matches: [] }); ctx.reply('Cleared.'); });

    const launchBot = (retries = 5) => {
        bot.launch().catch(err => { if (err.response?.error_code === 409 && retries > 0) setTimeout(() => launchBot(retries - 1), 10000); });
    };
    launchBot();
}

app.get('/api/get-predictions', async (req, res) => {
    const { fixture: fixtureId } = req.query;
    try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
        if (snap.exists()) {
            const match = (snap.data().matches || []).find(m => m.id === fixtureId);
            if (match && match.manual_prediction) {
                return res.json({ response: [{ predictions: { percent: { home: "—", draw: "—", away: "—" }, advice: match.manual_prediction, code: match.manual_prediction.charAt(0) } }] });
            }
        }
        res.json({ response: [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/scores', async (req, res) => {
    try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
        res.json(snap.exists() ? snap.data() : { matches: [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(port, () => console.log(`Vision Dashboard live on ${port}`));
