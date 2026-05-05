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
    try {
        const r = await axios.get(`https://statpal.io/api/v1/soccer/${endpoint}`, {
            params: { ...params, access_key: statpalKey },
            timeout: 15000 
        });
        return r.data;
    } catch (error) {
        console.error(`❌ StatPal Error on [${endpoint}]:`, error.response?.data || error.message);
        throw new Error(`StatPal API failed: ${error.message}`);
    }
}

// ─── Telegram Bot Logic ──────────────────────────────────────────────────────
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken) {
    const bot = new Telegraf(botToken);
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

    // FIXED: Added check to ensure match data is an array before calling forEach
    bot.hears('➕ Add New Prediction', async (ctx) => {
        ctx.reply('⏳ Loading matches for selection...');
        try {
            const data = await fetchFromStatPal('livescores');
            const matches = [];
            
            const leagues = data.livescore?.league;
            if (Array.isArray(leagues)) {
                leagues.forEach(l => {
                    // Check if match property exists and is an array
                    if (l.match && Array.isArray(l.match)) {
                        l.match.forEach(m => {
                            matches.push({ id: m.id, home: m.home.name, away: m.away.name });
                        });
                    } else if (l.match && typeof l.match === 'object') {
                        // If it's a single match object instead of an array
                        const m = l.match;
                        matches.push({ id: m.id, home: m.home.name, away: m.away.name });
                    }
                });
            }

            if (matches.length === 0) return ctx.reply('❌ No matches found for today.');

            // Limit display to 10-15 buttons to avoid hitting Telegram limits
            const buttons = matches.slice(0, 10).map(m => [
                Markup.button.callback(`${m.home} vs ${m.away}`, `select_${m.id}`)
            ]);

            ctx.reply('👉 Select a match to provide a tip for:', Markup.inlineKeyboard(buttons));
        } catch (e) { 
            console.error("Bot selection error:", e);
            ctx.reply('❌ Error fetching matches: ' + e.message); 
        }
    });

    bot.action(/select_(.+)/, (ctx) => {
        const matchId = ctx.match[1];
        userSession[ctx.from.id] = { matchId, step: 'WAITING_FOR_TIP' };
        ctx.answerCbQuery();
        ctx.reply('📝 Great! Now type your prediction for this match:');
    });

    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        const session = userSession[userId];
        
        if (session && session.step === 'WAITING_FOR_TIP') {
            const tip = ctx.message.text;
            const matchId = session.matchId;

            ctx.reply(`⏳ Saving tip: "${tip}"...`);

            try {
                if (db) {
                    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'manual_predictions');
                    const existingSnap = await getDoc(docRef);
                    let currentTips = existingSnap.exists() ? existingSnap.data().tips || {} : {};
                    
                    currentTips[matchId] = {
                        tip: tip,
                        timestamp: new Date().toISOString(),
                        author: ctx.from.first_name || 'Admin'
                    };

                    await setDoc(docRef, { tips: currentTips }, { merge: true });
                    delete userSession[userId];
                    ctx.reply('✅ SUCCESS! Your prediction is now live.', adminMenu);
                }
            } catch (e) { 
                ctx.reply('❌ Error saving tip: ' + e.message); 
            }
        }
    });

    bot.hears('🔄 Sync Live Data', async (ctx) => {
        ctx.reply('⏳ Syncing data...');
        try {
            const data = await fetchFromStatPal('livescores');
            if (db) {
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores'), { 
                    ...data, 
                    syncTime: new Date().toISOString() 
                });
                ctx.reply('✅ Match data synced.');
            }
        } catch (e) { ctx.reply('❌ Error: ' + e.message); }
    });

    bot.launch().catch(err => console.error("Bot launch failed:", err));
}

app.get('/api/scores', async (req, res) => {
    try {
        let scores = { livescore: { league: [] } };
        let manualTips = {};
        if (db) {
            const scoreSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores'));
            if (scoreSnap.exists()) scores = scoreSnap.data();
            const tipSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'manual_predictions'));
            if (tipSnap.exists()) manualTips = tipSnap.data().tips || {};
        }

        scores.livescore?.league?.forEach(l => {
            if (Array.isArray(l.match)) {
                l.match.forEach(m => {
                    if (manualTips[m.id]) m.manual_prediction = manualTips[m.id].tip;
                });
            }
        });
        res.json(scores);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('Backend Online'));
app.listen(port, () => console.log(`Server on ${port}`));
