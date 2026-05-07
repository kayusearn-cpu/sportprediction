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
if (botToken) {
    const bot = new Telegraf(botToken);
    const userSession = {};

    bot.start((ctx) => {
        ctx.reply('🤖 *Magic AI Prediction Assistant*\n\nJust copy and paste match data from Forebet, Betensured, or any site. I will extract the matches and predictions for your website automatically.', { parse_mode: 'Markdown' });
    });

    // Handle any text pasted into the bot
    bot.on('text', async (ctx) => {
        const rawText = ctx.message.text;

        // If user is confirming a previous extraction
        if (userSession[ctx.from.id]?.pendingMatches && rawText === '✅ Confirm & Publish All') {
            return publishMatches(ctx);
        }
        if (rawText === '❌ Cancel') {
            delete userSession[ctx.from.id];
            return ctx.reply('Cancelled. Send me new text anytime.');
        }

        ctx.reply('⏳ AI is analyzing your text and extracting matches...');

        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini", // Fast and cheap for text parsing
                messages: [
                    { 
                        role: "system", 
                        content: "You are a football data extractor. The user will paste text from betting sites. Extract all matches. For each match, provide: homeTeam, awayTeam, league, prediction (e.g. 'Home Win', 'Over 2.5'), and status ('Upcoming' or 'Live'). Respond ONLY with a JSON array of objects." 
                    },
                    { role: "user", content: rawText }
                ],
                response_format: { type: "json_object" }
            });

            const result = JSON.parse(completion.choices[0].message.content);
            const matches = result.matches || Object.values(result)[0]; // Handle different JSON structures

            if (!Array.isArray(matches) || matches.length === 0) {
                return ctx.reply('❌ AI couldn\'t find any matches in that text. Try copying more clearly.');
            }

            userSession[ctx.from.id] = { pendingMatches: matches };

            let summary = "🔍 *AI Found these matches:*\n\n";
            matches.forEach((m, i) => {
                summary += `${i+1}. *${m.homeTeam} vs ${m.awayTeam}*\n🏆 ${m.league}\n🎯 Tip: ${m.prediction}\n\n`;
            });

            ctx.reply(summary, {
                parse_mode: 'Markdown',
                ...Markup.keyboard([['✅ Confirm & Publish All'], ['❌ Cancel']]).resize()
            });

        } catch (e) {
            ctx.reply('❌ Error processing with OpenAI: ' + e.message);
        }
    });

    async function publishMatches(ctx) {
        const matches = userSession[ctx.from.id].pendingMatches;
        try {
            if (db) {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
                const existingSnap = await getDoc(docRef);
                let currentData = existingSnap.exists() ? existingSnap.data() : { matches: [] };

                // Format matches for the website (convert AI format to site format)
                const newFormattedMatches = matches.map(m => ({
                    id: `manual_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                    home: { name: m.homeTeam, goals: null },
                    away: { name: m.awayTeam, goals: null },
                    leagueName: m.league,
                    country: "Pro Pick",
                    status: m.status || "Upcoming",
                    manual_prediction: m.prediction
                }));

                // Add to existing list (limit to 30 total matches to keep it clean)
                currentData.matches = [...newFormattedMatches, ...currentData.matches].slice(0, 30);

                await setDoc(docRef, currentData);
                delete userSession[ctx.from.id];
                ctx.reply('🚀 SUCCESS! These matches are now live on your website.', Markup.removeKeyboard());
            }
        } catch (e) { ctx.reply('❌ Save Error: ' + e.message); }
    }

    bot.launch();
}

// ─── Web API ─────────────────────────────────────────────────────────────────
app.get('/api/scores', async (req, res) => {
    try {
        let data = { matches: [] };
        if (db) {
            const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
            if (snap.exists()) data = snap.data();
        }
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('AI Content Engine is Active.'));
app.listen(port, () => console.log(`Server live on ${port}`));
