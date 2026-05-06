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
        console.log("🔥 Firebase Firestore connected successfully.");
    } catch (err) {
        console.error("❌ Firebase Init Error:", err.message);
    }
}

// ─── Fetching Helpers ────────────────────────────────────────────────────────
async function fetchFromStatPal(endpoint, params = {}) {
    const statpalKey = process.env.STATPAL_API_KEY || '98e5c7b5-5b16-412c-a270-c3196e4ef98f';
    try {
        const r = await axios.get(`https://statpal.io/api/v1/soccer/${endpoint}`, {
            params: { ...params, access_key: statpalKey },
            timeout: 15000 
        });
        return r.data;
    } catch (error) {
        console.error(`❌ StatPal Error on [${endpoint}]:`, error.message);
        return { livescore: { league: [] } };
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
        ['➕ Add New Prediction', '🔄 Sync Match Data'],
        ['📝 Edit/Delete Posts']
    ]).resize();

    bot.start((ctx) => {
        ctx.reply('⚽ *Magic Analysis Expert Panel*\nManage your professional daily predictions.', {
            parse_mode: 'Markdown',
            ...adminMenu
        });
    });

    // STEP 1: Select Category
    bot.hears('➕ Add New Prediction', (ctx) => {
        ctx.reply('Which match category are you predicting?', Markup.inlineKeyboard([
            [Markup.button.callback('🔴 Live Matches', 'cat_live')],
            [Markup.button.callback('🔵 Upcoming Matches', 'cat_upcoming')],
            [Markup.button.callback('✅ Past Results', 'cat_past')]
        ]));
    });

    // STEP 2: Load Matches based on Category
    bot.action(/cat_(.+)/, async (ctx) => {
        const category = ctx.match[1];
        ctx.answerCbQuery();
        ctx.reply(`⏳ Loading ${category} matches for selection...`);
        
        try {
            let data;
            if (category === 'upcoming') {
                const tomorrow = new Date(); 
                tomorrow.setDate(tomorrow.getDate() + 1);
                data = await fetchFromStatPal('fixtures', { date: tomorrow.toISOString().split('T')[0] });
            } else {
                data = await fetchFromStatPal('livescores');
            }

            const matches = [];
            const leagues = data.livescore?.league || (Array.isArray(data.data) ? [{match: data.data}] : []);
            
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

            if (matches.length === 0) return ctx.reply('❌ No matches found in this category.');

            // Limit to 10 for manual selection
            const buttons = matches.slice(0, 10).map(m => [
                Markup.button.callback(`${m.home.name} vs ${m.away.name}`, `select_${m.id}`)
            ]);
            ctx.reply('👉 Select a match to predict:', Markup.inlineKeyboard(buttons));
        } catch (e) { ctx.reply('❌ Error fetching: ' + e.message); }
    });

    // STEP 3: Handle Match Selection
    bot.action(/select_(.+)/, (ctx) => {
        const matchId = ctx.match[1];
        userSession[ctx.from.id] = { matchId, step: 'WAITING_FOR_TIP' };
        ctx.answerCbQuery();
        ctx.reply('🎯 Select your expert tip:', Markup.keyboard(PREDICTION_OPTIONS).resize());
    });

    // STEP 4: Save Tip to Firestore
    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        const session = userSession[userId];
        
        if (session && session.step === 'WAITING_FOR_TIP') {
            const tip = ctx.message.text;
            if (tip === '❌ Cancel') { 
                delete userSession[userId]; 
                return ctx.reply('Cancelled.', adminMenu); 
            }

            try {
                if (db) {
                    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'manual_predictions', 'current');
                    const existingSnap = await getDoc(docRef);
                    let currentTips = existingSnap.exists() ? existingSnap.data().tips || {} : {};
                    
                    // Add/Update the tip
                    currentTips[session.matchId] = { 
                        tip, 
                        timestamp: new Date().toISOString() 
                    };
                    
                    await setDoc(docRef, { tips: currentTips });
                    delete userSession[userId];
                    ctx.reply(`✅ Success! "${tip}" is now live on the website.`, adminMenu);
                }
            } catch (e) { ctx.reply('❌ Save Error: ' + e.message, adminMenu); }
        }
    });

    // Manual Sync Button
    bot.hears('🔄 Sync Match Data', async (ctx) => {
        ctx.reply('⏳ Syncing latest fixtures to database...');
        try {
            const data = await fetchFromStatPal('livescores');
            if (db) {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
                await setDoc(docRef, { 
                    ...data, 
                    syncTime: new Date().toISOString() 
                });
                ctx.reply('✅ Match data synced successfully.');
            }
        } catch (e) { ctx.reply('❌ Sync Error: ' + e.message); }
    });

    bot.launch().then(() => console.log('🤖 Bot Online'));
}

// ─── API for Website ─────────────────────────────────────────────────────────
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

        // Flatten all matches and inject the expert tips
        const flatMatches = [];
        const leagues = scoresData.livescore?.league || [];
        (Array.isArray(leagues) ? leagues : [leagues]).forEach(lg => {
            const ms = Array.isArray(lg.match) ? lg.match : [lg.match].filter(Boolean);
            ms.forEach(m => {
                // If this match has a tip in Firestore, add it to the object
                if (manualTips[m.id]) {
                    m.manual_prediction = manualTips[m.id].tip;
                }
                flatMatches.push({...m, leagueName: lg.name, country: lg.country});
            });
        });

        // Return simplified object for the updated frontend
        res.json({ matches: flatMatches });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('Magic Analysis API is Running'));
app.listen(port, () => console.log(`Server live on port ${port}`));
