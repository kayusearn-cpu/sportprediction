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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Telegram Bot Logic ──────────────────────────────────────────────────────
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;

if (botToken) {
    bot = new Telegraf(botToken);
    const userSession = {};

    const mainMenu = Markup.keyboard([
        ['🔴 Update Live Matches', '🔵 Update Upcoming'],
        ['✅ Update Past Results', '📝 Edit Existing']
    ]).resize();

    bot.start((ctx) => {
        ctx.reply('🤖 *Magic AI Prediction Engine*\n\nPaste match data or tap "Edit Existing". Using GPT-4o-mini with Poisson calculation and Neville-style analysis.', {
            parse_mode: 'Markdown',
            ...mainMenu
        });
    });

    bot.hears(['🔴 Update Live Matches', '🔵 Update Upcoming', '✅ Update Past Results'], (ctx) => {
        const text = ctx.message.text;
        let category = text.includes('Live') ? 'Live' : text.includes('Upcoming') ? 'Upcoming' : 'Past';
        userSession[ctx.from.id] = { category, step: 'AWAITING_TEXT' };
        ctx.reply(`📝 Updating *${category}*.\n\nPaste data (Teams, Scores, Predictions):`, { parse_mode: 'Markdown' });
    });

    bot.hears('📝 Edit Existing', async (ctx) => {
        if (!db) return ctx.reply('❌ DB error');
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
        if (!snap.exists() || !snap.data().matches?.length) return ctx.reply('No matches found.');
        const buttons = snap.data().matches.slice(0, 10).map(m => [
            Markup.button.callback(`${m.home.name} ${m.home.goals||0}-${m.away.goals||0} ${m.away.name}`, `edit_${m.id}`)
        ]);
        ctx.reply('Select to update:', Markup.inlineKeyboard(buttons));
    });

    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        const session = userSession[userId];
        if (!session) return;
        if (ctx.message.text === '🚀 Publish to Website' && session.pendingMatches) return publishMatches(ctx);
        if (ctx.message.text === '❌ Cancel') { delete userSession[userId]; return ctx.reply('Cancelled.', mainMenu); }

        if (session.step === 'AWAITING_TEXT') {
            ctx.reply(`⏳ AI Extracting (Teams, Scores, Predictions)...`);
            try {
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [{ role: "system", content: "Extract football data. Use JSON. Fields: homeTeam, awayTeam, league, homeScore, awayScore, prediction. Status: " + session.category }, { role: "user", content: ctx.message.text }],
                    response_format: { type: "json_object" }
                });
                const matches = JSON.parse(completion.choices[0].message.content).matches || [];
                userSession[userId].pendingMatches = matches;
                ctx.reply(`Found ${matches.length} matches. Click Publish.`, Markup.keyboard([['🚀 Publish to Website'], ['❌ Cancel']]).resize());
            } catch (e) { ctx.reply('AI Error: ' + e.message); }
        }
    });

    async function publishMatches(ctx) {
        const session = userSession[ctx.from.id];
        try {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            const snap = await getDoc(docRef);
            let data = snap.exists() ? snap.data() : { matches: [] };
            session.pendingMatches.forEach(m => {
                const matchObj = {
                    id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
                    home: { name: m.homeTeam, goals: m.homeScore },
                    away: { name: m.awayTeam, goals: m.awayScore },
                    leagueName: m.league,
                    status: session.category,
                    manual_prediction: m.prediction,
                    country: "Pro Tip"
                };
                data.matches.unshift(matchObj);
            });
            data.matches = data.matches.slice(0, 40);
            await setDoc(docRef, data);
            delete userSession[ctx.from.id];
            ctx.reply('✅ Success! Website updated.', mainMenu);
        } catch (e) { ctx.reply('Error saving.'); }
    }

    bot.launch();
}

// ─── Gary Neville Analysis & Poisson Predictions ────────────────────────────
app.get('/api/match-analysis', async (req, res) => {
    const { home, away, status, score } = req.query;
    try {
        const prompt = `You are Gary Neville, Sky Sports pundit. Analyze ${home} vs ${away}. 
        State: ${status}. Score: ${score}. 
        Style: Direct, tactical, specific. Mention shape, individual errors, or managerial decisions. 
        3 paragraphs: Pre-match/Verdict, Tactical Insight, Bottom Line. No filler. 350 tokens max.`;
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 350
        });
        res.json({ analysis: completion.choices[0].message.content });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/get-predictions', async (req, res) => {
    const { home, away } = req.query;
    try {
        const prompt = `Perform a Poisson distribution prediction for ${home} vs ${away}. 
        Assume Home Advantage +0.35, recent xG 1.8. 
        Return JSON ONLY: { "predictions": { "percent": { "home": "45%", "draw": "25%", "away": "30%" }, "goals": { "home": 2, "away": 1 }, "advice": "One sentence direct tip." } }`;
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        });
        res.json({ response: [JSON.parse(completion.choices[0].message.content)] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API Scores Format Fix ───────────────────────────────────────────────────
app.get('/api/scores', async (req, res) => {
    try {
        if (!db) return res.json({ matches: [] });
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
        const data = snap.exists() ? snap.data() : { matches: [] };
        // Ensure compatibility with frontend expecting flat array
        res.json({ matches: data.matches || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(port, () => console.log(`Magic Server live on ${port}`));
