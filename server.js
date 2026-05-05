// backend/server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc, updateDoc } = require('firebase/firestore');

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
        const firebaseConfig = JSON.parse(firebaseConfigStr);
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
    const r = await axios.get(`https://statpal.io/api/v1/soccer/${endpoint}`, {
        params: { ...params, access_key: statpalKey },
        timeout: 12000
    });
    return r.data;
}

// ─── Telegram Bot Logic ──────────────────────────────────────────────────────
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken) {
    const bot = new Telegraf(botToken);

    // Temp state to track what the user is currently predicting
    const userSession = {};

    const adminMenu = Markup.keyboard([
        ['➕ Add New Prediction', '🔄 Sync Live Data'],
        ['📅 Update Old Matches', '🕒 Update Upcoming'],
        ['📝 Edit/Delete Posts']
    ]).resize();

    bot.start((ctx) => {
        ctx.reply('⚽ *MagicBettingTips Manual Admin*\nUse this bot to manually input your professional predictions.', {
            parse_mode: 'Markdown',
            ...adminMenu
        });
    });

    // STEP 1: Start Manual Prediction
    bot.hears('➕ Add New Prediction', async (ctx) => {
        ctx.reply('⏳ Loading today\'s matches for selection...');
        try {
            const data = await fetchFromStatPal('livescores');
            const matches = [];
            
            // Flatten matches from leagues
            data.livescore?.league?.forEach(l => {
                l.match?.forEach(m => {
                    matches.push({ id: m.id, home: m.home.name, away: m.away.name });
                });
            });

            if (matches.length === 0) return ctx.reply('❌ No matches found for today.');

            // Create buttons for the first 10 matches (Telegram limit)
            const buttons = matches.slice(0, 10).map(m => [
                Markup.button.callback(`${m.home} vs ${m.away}`, `select_${m.id}`)
            ]);

            ctx.reply('👉 Select a match to provide a tip for:', Markup.inlineKeyboard(buttons));
        } catch (e) { ctx.reply('❌ Error fetching matches: ' + e.message); }
    });

    // STEP 2: Handle Match Selection
    bot.action(/select_(.+)/, (ctx) => {
        const matchId = ctx.match[1];
        userSession[ctx.from.id] = { matchId, step: 'WAITING_FOR_TIP' };
        ctx.answerCbQuery();
        ctx.reply('📝 Great! Now type your prediction for this match (e.g., "Home Win @ 1.80" or "Over 2.5 Goals"):');
    });

    // STEP 3: Handle the typed Prediction text
    bot.on('text', async (ctx) => {
        const session = userSession[ctx.from.id];
        
        if (session && session.step === 'WAITING_FOR_TIP') {
            const tip = ctx.message.text;
            const matchId = session.matchId;

            ctx.reply(`⏳ Saving tip: "${tip}" to website...`);

            try {
                if (db) {
                    // Save this specific manual tip to a "manual_tips" collection
                    // The website will look here first
                    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'manual_predictions');
                    const existingSnap = await getDoc(docRef);
                    let currentTips = existingSnap.exists() ? existingSnap.data().tips || {} : {};
                    
                    currentTips[matchId] = {
                        tip: tip,
                        timestamp: new Date().toISOString(),
                        author: ctx.from.first_name
                    };

                    await setDoc(docRef, { tips: currentTips });
                    
                    delete userSession[ctx.from.id]; // Clear session
                    ctx.reply('✅ SUCCESS! Your prediction is now live on the website.', adminMenu);
                } else {
                    ctx.reply('❌ Firebase not connected.');
                }
            } catch (e) { ctx.reply('❌ Error saving tip: ' + e.message); }
        }
    });

    // Basic Sync for data that doesn't need manual tips
    bot.hears('🔄 Sync Live Data', async (ctx) => {
        ctx.reply('⏳ Syncing match data background...');
        try {
            const data = await fetchFromStatPal('livescores');
            if (db) {
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores'), { ...data, syncTime: new Date().toISOString() });
                ctx.reply('✅ Match data synced.');
            }
        } catch (e) { ctx.reply('❌ Error: ' + e.message); }
    });

    bot.launch();
}

// ─── Web API Endpoints ───────────────────────────────────────────────────────

app.get('/api/scores', async (req, res) => {
    try {
        let scores = { livescore: { league: [] } };
        let manualTips = {};

        if (db) {
            // 1. Get raw scores
            const scoreSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores'));
            if (scoreSnap.exists()) scores = scoreSnap.data();

            // 2. Get manual tips
            const tipSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'manual_predictions'));
            if (tipSnap.exists()) manualTips = tipSnap.data().tips || {};
        }

        // 3. Merge manual tips into the scores object for the frontend
        scores.livescore?.league?.forEach(l => {
            l.match?.forEach(m => {
                if (manualTips[m.id]) {
                    m.manual_prediction = manualTips[m.id].tip; // Add your custom tip here
                }
            });
        });

        res.json(scores);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(port, () => console.log(`Backend running on port ${port}`));
