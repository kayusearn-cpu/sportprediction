const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');
const { OpenAI } = require('openai');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc } = require('firebase/firestore');
const { getAuth, signInAnonymously } = require('firebase/auth');

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
        const auth = getAuth(firebaseApp);
        
        signInAnonymously(auth)
            .then(() => console.log("🔥 Firebase Authenticated Successfully."))
            .catch(err => console.warn("⚠️ Firebase Auth skipped (rules may still work):", err.message));
            
        console.log("🔥 Firebase Database connected.");
    } catch (err) { console.error("❌ Firebase Config Error:", err.message); }
}

// ─── OpenAI Initialization ───────────────────────────────────────────────────
let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
} else {
    console.warn("⚠️ OPENAI_API_KEY is missing! Server will run, but Vision features will be disabled.");
}

// ─── Football‑Data.org API Integration ──────────────────────────────────────
const FD_API_KEY = process.env.FOOTBALL_DATA_API_KEY || '569ee80c4ec0495abe12a226d30394df';
const FD_BASE = 'https://api.football-data.org/v4';

async function fetchFromFootballData(endpoint, params = {}) {
    try {
        const r = await axios.get(`${FD_BASE}/${endpoint}`, {
            headers: { 'X-Auth-Token': FD_API_KEY },
            params,
            timeout: 30000
        });
        return r.data;
    } catch (error) {
        if (error.response) {
            console.error(`❌ Football‑Data Error [${endpoint}]: ${error.response.status} - ${error.response.statusText}`);
            if (error.response.status === 429) {
                console.warn('⚠️ Rate limit reached. Free tier allows 10 calls/min.');
            }
        } else {
            console.error(`❌ Football‑Data Error [${endpoint}]: ${error.message}`);
        }
        return null;
    }
}

function convertMatch(fdMatch, dateStr = null) {
    const statusMap = {
        'SCHEDULED': 'Upcoming',
        'LIVE': 'Live',
        'IN_PLAY': 'Live',
        'PAUSED': 'Live',
        'FINISHED': 'Past',
        'AWARDED': 'Past',
        'CANCELLED': 'Upcoming',
        'POSTPONED': 'Upcoming',
        'SUSPENDED': 'Live'
    };

    const utcDate = fdMatch.utcDate ? new Date(fdMatch.utcDate) : null;
    const date = dateStr || (utcDate ? utcDate.toISOString().split('T')[0] : '');
    const time = utcDate ? utcDate.toISOString().split('T')[1].substring(0,5) : '';

    const homeName = fdMatch.homeTeam?.name || 'Home';
    const awayName = fdMatch.awayTeam?.name || 'Away';
    const homeGoals = fdMatch.score?.fullTime?.home !== null ? fdMatch.score.fullTime.home : null;
    const awayGoals = fdMatch.score?.fullTime?.away !== null ? fdMatch.score.fullTime.away : null;

    let playingTime = '';
    if (fdMatch.status === 'IN_PLAY' || fdMatch.status === 'PAUSED') {
        playingTime = fdMatch.minute ? `${fdMatch.minute}'` : 'Live';
    } else if (fdMatch.status === 'FINISHED') {
        playingTime = 'FT';
    } else if (fdMatch.status === 'SCHEDULED' || fdMatch.status === 'POSTPONED') {
        playingTime = fdMatch.status.toLowerCase();
    }

    return {
        id: `fd_${fdMatch.id}`,
        date,
        time,
        home: { name: homeName, goals: homeGoals },
        away: { name: awayName, goals: awayGoals },
        leagueName: fdMatch.competition?.name || 'Unknown League',
        status: statusMap[fdMatch.status] || 'Upcoming',
        playing_time: playingTime,
        manual_prediction: '',
        country: 'API Data'
    };
}

// ─── Auto-Live Sync Logic ────────────────────────────────────────────────────
let autoLiveInterval = null;
let isAutoLiveOn = false;

async function syncLiveScores() {
    if (!db) return;
    try {
        const data = await fetchFromFootballData('matches', { status: 'LIVE' });
        if (!data || !data.matches) return;

        const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
        const snap = await getDoc(docRef);
        if (!snap.exists()) return;
        
        let currentData = snap.data();
        let updated = false;

        data.matches.forEach(fdMatch => {
            const idx = currentData.matches.findIndex(em => 
                em.id === `fd_${fdMatch.id}` || 
                (em.home.name.toLowerCase() === fdMatch.homeTeam?.name?.toLowerCase() &&
                 em.away.name.toLowerCase() === fdMatch.awayTeam?.name?.toLowerCase())
            );

            if (idx !== -1) {
                const homeGoals = fdMatch.score?.fullTime?.home !== null ? fdMatch.score.fullTime.home : null;
                const awayGoals = fdMatch.score?.fullTime?.away !== null ? fdMatch.score.fullTime.away : null;
                currentData.matches[idx].home.goals = homeGoals;
                currentData.matches[idx].away.goals = awayGoals;

                let status = 'Live';
                let playingTime = '';
                if (fdMatch.status === 'IN_PLAY' || fdMatch.status === 'PAUSED') {
                    playingTime = fdMatch.minute ? `${fdMatch.minute}'` : 'Live';
                } else if (fdMatch.status === 'FINISHED') {
                    status = 'Past';
                    playingTime = 'FT';
                }
                currentData.matches[idx].status = status;
                currentData.matches[idx].playing_time = playingTime;
                updated = true;
            }
        });

        if (updated) {
            const cleanData = JSON.parse(JSON.stringify(currentData));
            await setDoc(docRef, cleanData);
            console.log("⏱️ Auto-Live Sync updated live scores on the site.");
        }
    } catch(e) {
        console.error("Auto-Live Sync Error:", e.message);
    }
}

// ─── Telegram Bot Logic ──────────────────────────────────────────────────────
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;

if (botToken) {
    bot = new Telegraf(botToken);
    const userSession = {};

    // Helper to save matches to Firebase (used by Sync handler)
    async function saveMatchesToFirebase(matchesArray) {
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
        const snap = await getDoc(docRef);
        let currentData = snap.exists() ? snap.data() : { matches: [] };

        matchesArray.forEach(newM => {
            const idx = currentData.matches.findIndex(em => 
                em.home.name === newM.home.name && em.away.name === newM.away.name
            );
            if (idx !== -1) {
                newM.manual_prediction = currentData.matches[idx].manual_prediction || '';
                currentData.matches[idx] = newM;
            } else {
                currentData.matches.unshift(newM);
            }
        });
        
        const cleanData = JSON.parse(JSON.stringify({ matches: currentData.matches.slice(0, 60) }));
        await setDoc(docRef, cleanData);
    }

    const getMainMenu = () => Markup.keyboard([
        ['🔴 Live', '✅ Past Results', '🔵 Upcoming'],
        ['🔄 Sync API: Today', '🔄 Sync API: Tomorrow'],
        [`⏱️ Auto-Live Sync: ${isAutoLiveOn ? 'ON' : 'OFF'}`],
        ['📸 Upload Screenshot', '🧹 Replace All with Upcoming'],
        ['🗑️ Clear All Matches']
    ]).resize();

    bot.command('myid', (ctx) => ctx.reply(`ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' }));

    bot.start((ctx) => {
        if (!checkAdmin(ctx)) return;
        ctx.reply('⚽ *Magic AI Dashboard*\n\nNow using football‑data.org (free tier). Turn on **Auto-Live Sync** to refresh scores!', {
            parse_mode: 'Markdown',
            ...getMainMenu()
        });
    });

    bot.hears(/⏱️ Auto-Live Sync: (OFF|ON)/, (ctx) => {
        if (!checkAdmin(ctx)) return;
        isAutoLiveOn = !isAutoLiveOn;
        
        if (isAutoLiveOn) {
            ctx.reply("🚀 *Real-Time Live Sync Started!*\nI will check football‑data.org every 60 seconds.", { parse_mode: 'Markdown', ...getMainMenu() });
            syncLiveScores();
            autoLiveInterval = setInterval(syncLiveScores, 60000);
        } else {
            ctx.reply("🛑 *Real-Time Live Sync Stopped.*", { parse_mode: 'Markdown', ...getMainMenu() });
            if (autoLiveInterval) clearInterval(autoLiveInterval);
        }
    });

    const showCategory = async (ctx, statusFilter) => {
        if (!checkAdmin(ctx)) return;
        if (!db) return ctx.reply('❌ Database not connected.');
        
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

    // ✅ Sync API: Today / Tomorrow – improved with 2‑day window
    bot.hears(/🔄 Sync API: (Today|Tomorrow)/, async (ctx) => {
        if (!checkAdmin(ctx)) return;
        if (!db) return ctx.reply('❌ Database not connected.');

        const day = ctx.match[1];
        ctx.reply(`⏳ Fetching ${day}'s matches from football‑data.org...`);

        const now = new Date();
        let dateFrom = new Date(now);
        let dateTo = new Date(now);

        if (day === 'Today') {
            dateTo.setDate(dateTo.getDate() + 1);
        } else {
            dateFrom.setDate(dateFrom.getDate() + 1);
            dateTo.setDate(dateTo.getDate() + 2);
        }

        const dateFromStr = dateFrom.toISOString().split('T')[0];
        const dateToStr = dateTo.toISOString().split('T')[0];

        try {
            let data = await fetchFromFootballData('matches', { dateFrom: dateFromStr, dateTo: dateToStr });
            if (!data) {
                ctx.reply('🔄 First attempt failed, retrying...');
                await new Promise(r => setTimeout(r, 2000));
                data = await fetchFromFootballData('matches', { dateFrom: dateFromStr, dateTo: dateToStr });
            }
            if (!data) return ctx.reply('❌ Failed to fetch from football‑data.org. Check key or rate limits.');

            // Filter matches for the target day (based on match's utcDate)
            const targetDayStr = (day === 'Today' ? now : new Date(now.getTime() + 86400000)).toISOString().split('T')[0];
            const matchesForTargetDay = data.matches.filter(m => {
                const matchDate = m.utcDate ? new Date(m.utcDate).toISOString().split('T')[0] : null;
                return matchDate === targetDayStr;
            });

            if (matchesForTargetDay.length === 0) {
                // Fallback: if none match exactly, use all matches from the window
                if (data.matches.length > 0) {
                    ctx.reply(`⚠️ No matches exactly for ${day} (UTC), but found ${data.matches.length} in the search window. Using all.`);
                    const converted = data.matches.map(m => convertMatch(m));
                    await saveMatchesToFirebase(converted);
                    ctx.reply(`✅ Synced ${converted.length} matches.`);
                } else {
                    ctx.reply(`❌ No matches found for ${day}. Try a different date or check your API key coverage.`);
                }
            } else {
                const converted = matchesForTargetDay.map(m => convertMatch(m));
                await saveMatchesToFirebase(converted);
                ctx.reply(`✅ Successfully synced ${converted.length} matches for ${day}!`);
            }
            
            if (isAutoLiveOn) syncLiveScores();

        } catch(e) {
            ctx.reply(`❌ API Error: ${e.message}`);
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
        ctx.reply('⏳ Reading screenshot... Extracting Teams, Dates, Times, Predictions, Scores, and Probabilities!');

        try {
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            const imageResponse = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
            const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{
                    role: "system",
                    content: "You are an expert football data scraper. Extract EVERY match shown in the image exactly as it appears. Return a JSON object with a 'matches' array. For each match, extract: 'home' (Home team), 'away' (Away team), 'date' (e.g. 19/05/2026), 'time' (e.g. 19:30), 'prediction' (1, X, or 2), 'pScore' (Correct score prediction e.g. 1-3), 'liveScore' (Live or final score), 'min' (FT, HT, or minute), 'lg' (League initials), 'probHome' (Home win prob %), 'probDraw' (Draw prob %), and 'probAway' (Away win prob %). Do not miss the time and date!"
                },
                { role: "user", content: [{ type: "text", text: "Scan this screenshot and extract all match details:" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }],
                response_format: { type: "json_object" }
            });
            const matches = JSON.parse(completion.choices[0].message.content).matches || [];
            if (matches.length === 0) return ctx.reply("❌ No matches detected. Try a clearer image.");
            
            const isReplace = userSession[ctx.from.id]?.replaceAllMode || false;
            userSession[ctx.from.id] = { pendingMatches: matches, replaceAllMode: isReplace };

            let summary = `🔍 Detected ${matches.length} matches:\n\n`;
            matches.forEach((m, i) => {
                const dt = m.date ? `[${m.date} ${m.time || ''}]` : "";
                const probs = m.probHome ? `(Prob: ${m.probHome}% | ${m.probDraw}% | ${m.probAway}%)` : "";
                summary += `${i+1}. *${m.home} vs ${m.away}* ${dt}\n🎯 Tip: ${m.prediction || m.pred} | Score: ${m.pScore || ''} \n📊 ${probs}\n\n`;
            });

            const btns = isReplace ? [['🧹 Wipe & Replace All'], ['❌ Cancel']] : [['🚀 Confirm & Publish'], ['❌ Cancel']];
            ctx.reply(summary, { parse_mode: 'Markdown', ...Markup.keyboard(btns).resize() });
        } catch (e) { ctx.reply(`❌ Vision Scan Error: ${e.message}`); }
    });

    // ✅ Text handler – passes unknown messages to other handlers
    bot.on('text', async (ctx, next) => {
        const session = userSession[ctx.from.id];

        if (session && session.editing) {
            const val = ctx.message.text;
            if (!db) return ctx.reply('❌ Database not connected.');

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
                    
                    const cleanData = JSON.parse(JSON.stringify(data));
                    await setDoc(docRef, cleanData);
                    ctx.reply('✅ Site Updated!');
                }
                delete userSession[ctx.from.id];
            } catch (e) { ctx.reply(`❌ Save error: ${e.message}`); }
            return;
        }

        if (session?.pendingMatches && ctx.message.text === '🚀 Confirm & Publish') {
            return publishMatches(ctx, false);
        }
        if (session?.pendingMatches && ctx.message.text === '🧹 Wipe & Replace All') {
            return publishMatches(ctx, true);
        }

        return next();
    });

    async function publishMatches(ctx, wipeFirst) {
        const session = userSession[ctx.from.id];
        if (!session || !session.pendingMatches) return ctx.reply("❌ Session expired.");
        if (!db) return ctx.reply('❌ Database not connected.');

        try {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            let currentData = { matches: [] };
            if (!wipeFirst) {
                const snap = await getDoc(docRef);
                currentData = snap.exists() ? snap.data() : { matches: [] };
            }

            session.pendingMatches.forEach(m => {
                let status = wipeFirst ? "Upcoming" : (m.min === 'FT' ? "Past" : (m.min || m.liveScore ? "Live" : "Upcoming"));
                
                let hGoal = null;
                let aGoal = null;
                if (!wipeFirst && m.liveScore) {
                    const scoreStr = String(m.liveScore).replace(':', '-');
                    const parts = scoreStr.split('-');
                    hGoal = parts[0] ? parts[0].trim() : null;
                    aGoal = parts[1] ? parts[1].trim() : null;
                }

                const matchObj = {
                    id: `v_${Date.now()}_${Math.random().toString(36).substr(2, 2)}`,
                    date: m.date || new Date().toLocaleDateString('en-GB'),
                    time: m.time || "",
                    home: { name: m.home || 'Unknown', goals: hGoal },
                    away: { name: m.away || 'Unknown', goals: aGoal },
                    leagueName: m.lg || "Pro League",
                    status: status,
                    playing_time: wipeFirst ? "" : (m.min || ""),
                    manual_prediction: `${m.prediction || m.pred || ''} (${m.pScore || ''})`.trim(),
                    probabilities: {
                        home: m.probHome || null,
                        draw: m.probDraw || null,
                        away: m.probAway || null
                    },
                    country: "Pro Tip"
                };
                currentData.matches.unshift(matchObj);
            });
            
            const cleanData = JSON.parse(JSON.stringify({ matches: currentData.matches.slice(0, 60) }));
            await setDoc(docRef, cleanData);
            
            delete userSession[ctx.from.id];
            ctx.reply('✅ Success! Website updated.', getMainMenu());
        } catch (e) {
            console.error("Save Error Details:", e);
            ctx.reply(`❌ Save Error: ${e.message}`, getMainMenu());
        }
    }

    bot.hears('❌ Cancel', (ctx) => { delete userSession[ctx.from.id]; ctx.reply('Cancelled.', getMainMenu()); });
    
    bot.hears('🗑️ Clear All Matches', async (ctx) => {
        if (!checkAdmin(ctx)) return;
        if (!db) return ctx.reply('❌ Database not connected.');
        await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'), { matches: [] });
        ctx.reply('Cleared.', getMainMenu());
    });

    bot.launch()
        .then(() => console.log('✅ Bot is polling successfully'))
        .catch(err => console.error('🚨 Bot launch error:', err.message));
}

// ─── Express API endpoints ──────────────────────────────────────────────────
app.get('/api/get-predictions', async (req, res) => {
    const { fixture: fixtureId } = req.query;
    try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
        if (snap.exists()) {
            const match = (snap.data().matches || []).find(m => m.id === fixtureId);
            if (match && match.manual_prediction) {
                return res.json({
                    response: [{
                        predictions: {
                            percent: {
                                home: match.probabilities?.home ? match.probabilities.home + "%" : "—",
                                draw: match.probabilities?.draw ? match.probabilities.draw + "%" : "—",
                                away: match.probabilities?.away ? match.probabilities.away + "%" : "—"
                            },
                            advice: match.manual_prediction,
                            code: match.manual_prediction.charAt(0)
                        }
                    }]
                });
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

app.listen(port, '0.0.0.0', () => console.log(`Vision Dashboard live on ${port}`));
