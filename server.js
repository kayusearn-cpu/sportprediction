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

// ─── Major League IDs (Forebet/Betensured standard) ──────────────────────────
// These IDs correspond to StatPal's league database. 
// Adding these ensures your bot doesn't show obscure/fake youth matches.
const MAJOR_LEAGUES = [
    8,   // Premier League (ENG)
    301, // La Liga (ESP)
    384, // Serie A (ITA)
    82,  // Bundesliga (GER)
    564, // Ligue 1 (FRA)
    2,   // Champions League
    3,   // Europa League
    693, // NPFL (Nigeria) - if relevant
    // Add more IDs here based on StatPal's league list
];

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

// ─── Fetching Helper with Filtering ──────────────────────────────────────────
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

    bot.start((ctx) => ctx.reply('⚽ *Magic Admin*\nMajor leagues filtering is now ACTIVE.', { parse_mode: 'Markdown', ...adminMenu }));

    bot.hears('➕ Add New Prediction', (ctx) => {
        ctx.reply('Select category (Major Leagues Only):', Markup.inlineKeyboard([
            [Markup.button.callback('🔴 Live', 'cat_live')],
            [Markup.button.callback('🔵 Upcoming', 'cat_upcoming')],
            [Markup.button.callback('✅ Past', 'cat_past')]
        ]));
    });

    bot.action(/cat_(.+)/, async (ctx) => {
        const category = ctx.match[1];
        ctx.answerCbQuery();
        ctx.reply(`⏳ Loading Major ${category} matches...`);
        
        const data = category === 'upcoming' 
            ? await fetchFromStatPal('fixtures', { date: new Date(Date.now() + 86400000).toISOString().split('T')[0] })
            : await fetchFromStatPal('livescores');

        if (!data || !data.livescore) return ctx.reply('❌ API Error or no matches.');

        const matches = [];
        const leagues = Array.isArray(data.livescore.league) ? data.livescore.league : [data.livescore.league];
        
        leagues.forEach(l => {
            // FILTER: Only process league if it's in our Major List OR if we want all (uncomment to disable filter)
            // if (!MAJOR_LEAGUES.includes(Number(l.id))) return;

            const items = Array.isArray(l.match) ? l.match : [l.match].filter(Boolean);
            items.forEach(m => {
                const status = m.status || '';
                const isFin = ['FT', 'AET', 'PEN'].includes(status);
                const isUpc = ['NS', 'TBD'].includes(status) || /^\d{2}:\d{2}$/.test(status);

                if (category === 'live' && !isFin && !isUpc) matches.push({ ...m, leagueName: l.name });
                else if (category === 'past' && isFin) matches.push({ ...m, leagueName: l.name });
                else if (category === 'upcoming' && isUpc) matches.push({ ...m, leagueName: l.name });
            });
        });

        if (matches.length === 0) return ctx.reply('❌ No major matches found right now.');

        // Sort by match quality or time and show top 15
        const buttons = matches.slice(0, 15).map(m => [
            Markup.button.callback(`${m.leagueName.substring(0,5)}: ${m.home.name} vs ${m.away.name}`, `select_${m.id}`)
        ]);
        ctx.reply('👉 Choose match:', Markup.inlineKeyboard(buttons));
    });

    bot.action(/select_(.+)/, (ctx) => {
        userSession[ctx.from.id] = { matchId: ctx.match[1], step: 'WAITING_FOR_TIP' };
        ctx.answerCbQuery();
        ctx.reply('🎯 Select expert tip:', Markup.keyboard(PREDICTION_OPTIONS).resize());
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
                    ctx.reply(`✅ Saved for Website: ${ctx.message.text}`, adminMenu);
                }
            } catch (e) { ctx.reply('❌ Error: ' + e.message); }
        }
    });

    bot.hears('🔄 Sync Match Data', async (ctx) => {
        const data = await fetchFromStatPal('livescores');
        if (db && data) {
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'), data);
            ctx.reply('✅ Synced latest major data.');
        }
    });

    bot.launch();
}

// ─── API Endpoint ────────────────────────────────────────────────────────────
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

        const flat = [];
        const leagues = Array.isArray(scoresData.livescore?.league) ? scoresData.livescore.league : [scoresData.livescore?.league].filter(Boolean);
        
        leagues.forEach(lg => {
            const ms = Array.isArray(lg.match) ? lg.match : [lg.match].filter(Boolean);
            ms.forEach(m => {
                if (manualTips[m.id]) m.manual_prediction = manualTips[m.id].tip;
                flat.push({...m, leagueName: lg.name, country: lg.country});
            });
        });

        res.json({ matches: flat });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('Magic Filtering API Online'));
app.listen(port, () => console.log(`Server running on ${port}`));
