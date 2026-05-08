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
        ['✅ Update Past Results']
    ]).resize();

    bot.start((ctx) => {
        ctx.reply('🤖 *Magic AI Analysis Assistant*\n\nSelect a category below, then paste the match data (including scores if available). I will extract everything for the website.', {
            parse_mode: 'Markdown',
            ...mainMenu
        });
    });

    // Button Handlers
    bot.hears(['🔴 Update Live Matches', '🔵 Update Upcoming', '✅ Update Past Results'], (ctx) => {
        const text = ctx.message.text;
        let category = 'Live';
        if (text.includes('Upcoming')) category = 'Upcoming';
        if (text.includes('Past')) category = 'Past';

        userSession[ctx.from.id] = { category, step: 'AWAITING_TEXT' };
        ctx.reply(`📝 You are updating *${category}* matches.\n\nPaste the match data here:`, { parse_mode: 'Markdown' });
    });

    bot.on('text', async (ctx) => {
        const rawText = ctx.message.text;
        const userId = ctx.from.id;
        const session = userSession[userId];

        // Handle Confirmation
        if (session?.pendingMatches && rawText === '🚀 Publish to Website') {
            return publishMatches(ctx);
        }
        if (rawText === '❌ Cancel') {
            delete userSession[userId];
            return ctx.reply('Cancelled.', mainMenu);
        }

        // Handle AI Extraction
        if (session?.step === 'AWAITING_TEXT') {
            ctx.reply(`⏳ AI is extracting ${session.category} data (Teams, Scores, Tips)...`);

            try {
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { 
                            role: "system", 
                            content: `You are a football data extractor. The user is providing text for ${session.category} matches. 
                            Extract: homeTeam, awayTeam, league, homeScore (if provided), awayScore (if provided), and prediction.
                            Note: For 'Upcoming' matches, scores should be null.
                            Respond ONLY with a JSON object containing a 'matches' array.` 
                        },
                        { role: "user", content: rawText }
                    ],
                    response_format: { type: "json_object" }
                });

                const result = JSON.parse(completion.choices[0].message.content);
                const matches = result.matches || [];

                if (matches.length === 0) return ctx.reply('❌ No matches found. Try copying more clearly.');

                userSession[userId].pendingMatches = matches;

                let summary = `🔍 *AI Extracted (${session.category}):*\n\n`;
                matches.forEach((m, i) => {
                    const score = (m.homeScore !== undefined && m.homeScore !== null) ? `[${m.homeScore}-${m.awayScore}]` : "";
                    summary += `${i+1}. *${m.homeTeam} vs ${m.awayTeam}* ${score}\n🎯 Tip: ${m.prediction}\n\n`;
                });

                ctx.reply(summary, {
                    parse_mode: 'Markdown',
                    ...Markup.keyboard([['🚀 Publish to Website'], ['❌ Cancel']]).resize()
                });

            } catch (e) {
                ctx.reply('❌ AI Error: ' + e.message);
            }
        }
    });

    async function publishMatches(ctx) {
        const userId = ctx.from.id;
        const session = userSession[userId];
        const matches = session.pendingMatches;

        try {
            if (db) {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
                const snap = await getDoc(docRef);
                let currentData = snap.exists() ? snap.data() : { matches: [] };

                // Map AI data to website format
                const newMatches = matches.map(m => ({
                    id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
                    home: { name: m.homeTeam, goals: m.homeScore },
                    away: { name: m.awayTeam, goals: m.awayScore },
                    leagueName: m.league,
                    status: session.category,
                    manual_prediction: m.prediction
                }));

                // Combine and keep top 30
                currentData.matches = [...newMatches, ...currentData.matches].slice(0, 30);

                await setDoc(docRef, currentData);
                delete userSession[userId];
                ctx.reply(`✅ Success! Your ${session.category} updates are now live.`, mainMenu);
            }
        } catch (e) { ctx.reply('❌ Save Error: ' + e.message); }
    }

    bot.launch().then(() => console.log('🤖 Bot launched.')).catch(e => console.error("Bot launch error:", e));

    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ─── API Endpoint ────────────────────────────────────────────────────────────
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

app.listen(port, () => console.log(`Server live on ${port}`));
