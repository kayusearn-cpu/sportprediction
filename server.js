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
        ctx.reply('🤖 *Magic AI Analysis Assistant*\n\nSelect a category to add new matches, or tap "Edit Existing" to update scores for matches already on the site.', {
            parse_mode: 'Markdown',
            ...mainMenu
        });
    });

    // Handle Category Selection
    bot.hears(['🔴 Update Live Matches', '🔵 Update Upcoming', '✅ Update Past Results'], (ctx) => {
        const text = ctx.message.text;
        let category = 'Live';
        if (text.includes('Upcoming')) category = 'Upcoming';
        if (text.includes('Past')) category = 'Past';

        userSession[ctx.from.id] = { category, step: 'AWAITING_TEXT' };
        ctx.reply(`📝 Updating *${category}* matches.\n\nPaste the match data (Teams, Scores, Predictions) here:`, { parse_mode: 'Markdown' });
    });

    // Handle Edit Existing
    bot.hears('📝 Edit Existing', async (ctx) => {
        if (!db) return ctx.reply('❌ Database not connected.');
        
        ctx.reply('⏳ Loading current matches...');
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
        if (!snap.exists() || !snap.data().matches?.length) {
            return ctx.reply('No matches found to edit.');
        }

        const matches = snap.data().matches;
        const buttons = matches.slice(0, 10).map(m => [
            Markup.button.callback(`${m.home.name} ${m.home.goals}-${m.away.goals} ${m.away.name}`, `edit_${m.id}`)
        ]);

        ctx.reply('Select a match to update its score or prediction:', Markup.inlineKeyboard(buttons));
    });

    bot.action(/edit_(.+)/, async (ctx) => {
        const matchId = ctx.match[1];
        userSession[ctx.from.id] = { editMatchId: matchId, step: 'AWAITING_EDIT_VALUE' };
        ctx.answerCbQuery();
        ctx.reply('Send the new Score and Prediction (e.g., "2-1, Home Win"):');
    });

    bot.on('text', async (ctx) => {
        const rawText = ctx.message.text;
        const userId = ctx.from.id;
        const session = userSession[userId];

        if (!session) return;

        // Handle Confirmation
        if (session.pendingMatches && rawText === '🚀 Publish to Website') {
            return publishMatches(ctx);
        }
        if (rawText === '❌ Cancel') {
            delete userSession[userId];
            return ctx.reply('Cancelled.', mainMenu);
        }

        // Handle Quick Edit
        if (session.step === 'AWAITING_EDIT_VALUE') {
            return performQuickEdit(ctx, rawText);
        }

        // Handle AI Extraction
        if (session.step === 'AWAITING_TEXT') {
            ctx.reply(`⏳ AI is extracting ${session.category} data (Teams, Scores, Predictions)...`);

            try {
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { 
                            role: "system", 
                            content: `Extract football data for ${session.category} matches. 
                            Format: JSON object with 'matches' array. 
                            Fields: homeTeam, awayTeam, league, homeScore, awayScore, prediction.
                            For 'Upcoming', scores must be null.` 
                        },
                        { role: "user", content: rawText }
                    ],
                    response_format: { type: "json_object" }
                });

                const result = JSON.parse(completion.choices[0].message.content);
                const matches = result.matches || [];
                if (!matches.length) return ctx.reply('❌ No matches found.');

                userSession[userId].pendingMatches = matches;
                let summary = `🔍 *AI Extracted (${session.category}):*\n\n`;
                matches.forEach((m, i) => {
                    const score = (m.homeScore !== null) ? `[${m.homeScore}-${m.awayScore}]` : "";
                    summary += `${i+1}. *${m.homeTeam} vs ${m.awayTeam}* ${score}\n🎯 Prediction: ${m.prediction}\n\n`;
                });

                ctx.reply(summary, {
                    parse_mode: 'Markdown',
                    ...Markup.keyboard([['🚀 Publish to Website'], ['❌ Cancel']]).resize()
                });
            } catch (e) { ctx.reply('❌ AI Error: ' + e.message); }
        }
    });

    async function performQuickEdit(ctx, text) {
        const session = userSession[ctx.from.id];
        try {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            const snap = await getDoc(docRef);
            if (!snap.exists()) return;

            let data = snap.data();
            const matchIdx = data.matches.findIndex(m => m.id === session.editMatchId);
            if (matchIdx === -1) return ctx.reply('Match no longer exists.');

            // Simple parse: "2-1, Home Win"
            const parts = text.split(',');
            const scores = parts[0].trim().split('-');
            
            data.matches[matchIdx].home.goals = scores[0];
            data.matches[matchIdx].away.goals = scores[1];
            if (parts[1]) data.matches[matchIdx].manual_prediction = parts[1].trim();

            await setDoc(docRef, data);
            delete userSession[ctx.from.id];
            ctx.reply('✅ Match updated successfully!', mainMenu);
        } catch (e) { ctx.reply('Error: ' + e.message); }
    }

    async function publishMatches(ctx) {
        const session = userSession[ctx.from.id];
        try {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            const snap = await getDoc(docRef);
            let currentData = snap.exists() ? snap.data() : { matches: [] };

            session.pendingMatches.forEach(m => {
                // Check if match already exists (Home vs Away) to update instead of add
                const existingIdx = currentData.matches.findIndex(em => 
                    em.home.name.toLowerCase() === m.homeTeam.toLowerCase() && 
                    em.away.name.toLowerCase() === m.awayTeam.toLowerCase()
                );

                const matchObj = {
                    id: existingIdx !== -1 ? currentData.matches[existingIdx].id : `ai_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
                    home: { name: m.homeTeam, goals: m.homeScore },
                    away: { name: m.awayTeam, goals: m.awayScore },
                    leagueName: m.league,
                    status: session.category,
                    manual_prediction: m.prediction
                };

                if (existingIdx !== -1) {
                    currentData.matches[existingIdx] = matchObj;
                } else {
                    currentData.matches.unshift(matchObj);
                }
            });

            currentData.matches = currentData.matches.slice(0, 40);
            await setDoc(docRef, currentData);
            delete userSession[ctx.from.id];
            ctx.reply(`✅ Success! Your ${session.category} updates are now live.`, mainMenu);
        } catch (e) { ctx.reply('❌ Save Error: ' + e.message); }
    }

    bot.launch();
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

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
