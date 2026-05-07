// backend/server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc } = require('firebase/firestore');

const app = express();
const port = process.env.PORT || 10000; 
const appId = "magic-betting-tips"; 

app.use(cors());
app.use(express.json());

// ─── Firebase Initialization ─────────────────────────────────────────────────
const firebaseConfigStr = process.env.FIREBASE_CONFIG;
let db = null;
if (firebaseConfigStr) {
    try {
        const cleanedConfig = firebaseConfigStr.trim();
        const firebaseConfig = JSON.parse(cleanedConfig);
        const firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        console.log("🔥 Firebase connected.");
    } catch (err) {
        console.error("❌ Firebase Error:", err.message);
    }
}

// ─── Fetching Helper ────────────────────────────────────────────────────────
async function fetchFromStatPal(endpoint, params = {}) {
    const statpalKey = process.env.STATPAL_API_KEY || '98e5c7b5-5b16-412c-a270-c3196e4ef98f';
    try {
        const r = await axios.get(`https://statpal.io/api/v1/soccer/${endpoint}`, {
            params: { ...params, access_key: statpalKey },
            timeout: 15000 
        });
        return r.data;
    } catch (error) {
        console.error(`❌ API Error:`, error.message);
        return null;
    }
}

// ─── Telegram Bot Logic ──────────────────────────────────────────────────────
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken) {
    const bot = new Telegraf(botToken);
    const userSession = {};

    const PREDICTION_OPTIONS = [
        ['1 (Home Win)', 'X (Draw)', '2 (Away Win)'],
        ['1X (Home or Draw)', '12 (Home or Away)', 'X2 (Draw or Away)'],
        ['Over 1.5', 'Over 2.5', 'Over 3.5'],
        ['BTTS - Yes', 'BTTS - No'],
        ['❌ Cancel']
    ];

    const adminMenu = Markup.keyboard([
        ['➕ Add New Prediction', '🔄 Sync Match Data']
    ]).resize();

    bot.start((ctx) => ctx.reply('⚽ *Magic Admin*\nUse buttons below to manage tips.', { parse_mode: 'Markdown', ...adminMenu }));

    bot.hears('➕ Add New Prediction', (ctx) => {
        ctx.reply('Select category:', Markup.inlineKeyboard([
            [Markup.button.callback('🔴 Live', 'cat_live')],
            [Markup.button.callback('🔵 Upcoming', 'cat_upcoming')],
            [Markup.button.callback('✅ Past', 'cat_past')]
        ]));
    });

    bot.action(/cat_(.+)/, async (ctx) => {
        const category = ctx.match[1];
        ctx.answerCbQuery();
        ctx.reply(`⏳ Loading ${category}...`);
        
        const data = category === 'upcoming' 
            ? await fetchFromStatPal('fixtures', { date: new Date(Date.now() + 86400000).toISOString().split('T')[0] })
            : await fetchFromStatPal('livescores');

        if (!data || !data.livescore) return ctx.reply('❌ API Error or no matches.');

        const matches = [];
        const leagues = Array.isArray(data.livescore.league) ? data.livescore.league : [data.livescore.league];
        
        leagues.forEach(l => {
            const items = Array.isArray(l.match) ? l.match : [l.match].filter(Boolean);
            items.forEach(m => {
                const status = m.status || '';
                const isFin = ['FT', 'AET', 'PEN'].includes(status);
                const isUpc = ['NS', 'TBD'].includes(status) || /^\d{2}:\d{2}$/.test(status);

                if (category === 'live' && !isFin && !isUpc) matches.push(m);
                else if (category === 'past' && isFin) matches.push(m);
                else if (category === 'upcoming' && isUpc) matches.push(m);
            });
        });

        if (matches.length === 0) return ctx.reply('❌ None found.');

        const buttons = matches.slice(0, 10).map(m => [Markup.button.callback(`${m.home.name} vs ${m.away.name}`, `select_${m.id}`)]);
        ctx.reply('👉 Choose match:', Markup.inlineKeyboard(buttons));
    });

    bot.action(/select_(.+)/, (ctx) => {
        userSession[ctx.from.id] = { matchId: ctx.match[1], step: 'WAITING_FOR_TIP' };
        ctx.answerCbQuery();
        ctx.reply('🎯 Select tip:', Markup.keyboard(PREDICTION_OPTIONS).resize());
    });

    bot.on('text', async (ctx) => {
        const session = userSession[ctx.from.id];
        if (session?.step === 'WAITING_FOR_TIP') {
            if (ctx.message.text === '❌ Cancel') { delete userSession[ctx.from.id]; return ctx.reply('Cancelled.', adminMenu); }
            try {
                if (db) {
                    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'manual_predictions', 'current');
                    const snap = await getDoc(docRef);
                    let tips = snap.exists() ? snap.data().tips || {} : {};
                    tips[session.matchId] = { tip: ctx.message.text, time: new Date().toISOString() };
                    await setDoc(docRef, { tips });
                    delete userSession[ctx.from.id];
                    ctx.reply(`✅ Saved: ${ctx.message.text}`, adminMenu);
                }
            } catch (e) { ctx.reply('❌ Error: ' + e.message); }
        }
    });

    bot.hears('🔄 Sync Match Data', async (ctx) => {
        const data = await fetchFromStatPal('livescores');
        if (db && data) {
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'), data);
            ctx.reply('✅ Synced.');
        }
    });

    bot.launch();
}

// ─── API Endpoint (Fixed for Frontend) ───────────────────────────────────────
app.get('/api/scores', async (req, res) => {
    try {
        let scoresData = { livescore: { league: [] } };
        let manualTips = {};

        if (db) {
            const scoreSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
            if (scoreSnap.exists()) scoresData = scoreSnap.data();
            const tipSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'manual_predictions', 'current'));
            if (tipSnap.exists()) manualTips = tipSnap.data().tips || {};
        }

        // If Firestore is empty, fetch fresh for the first time
        if (scoresData.livescore.league.length === 0) {
            const fresh = await fetchFromStatPal('livescores');
            if (fresh) scoresData = fresh;
        }

        // Inject manual tips
        const leagues = Array.isArray(scoresData.livescore.league) ? scoresData.livescore.league : [scoresData.livescore.league].filter(Boolean);
        leagues.forEach(lg => {
            const ms = Array.isArray(lg.match) ? lg.match : [lg.match].filter(Boolean);
            ms.forEach(m => {
                if (manualTips[m.id]) m.manual_prediction = manualTips[m.id].tip;
            });
        });

        // Send data in BOTH formats
        res.json({
            ...scoresData,        // OLD FORMAT: livescore { league: [...] }
            matches: []           // placeholder for new format if needed later
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('API Running'));
app.listen(port, () => console.log(`Live on ${port}`));
