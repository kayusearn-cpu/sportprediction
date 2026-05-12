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
        ['🔴 Live Matches', '✅ Past Results', '🔵 Upcoming'],
        ['📸 Upload Screenshot', '🗑️ Clear All Matches']
    ]).resize();

    bot.command('myid', (ctx) => {
        ctx.reply(`Your ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
    });

    bot.start((ctx) => {
        if (!checkAdmin(ctx)) return;
        ctx.reply('⚽ *Magic Prediction Dashboard*\n\nManage your site categories or upload a screenshot to auto-sync matches. Predictions, Scores, Dates, and Times are fully supported.', {
            parse_mode: 'Markdown',
            ...mainMenu
        });
    });

    // ── Category Handlers ──
    const showCategory = async (ctx, statusFilter) => {
        if (!checkAdmin(ctx)) return;
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
        const matches = (snap.exists() ? snap.data().matches : []).filter(m => m.status === statusFilter);

        if (matches.length === 0) {
            return ctx.reply(`No ${statusFilter} matches found.`);
        }

        const buttons = matches.map(m => [
            Markup.button.callback(`${m.home.name} ${m.home.goals || 0}-${m.away.goals || 0} ${m.away.name}`, `sel_${m.id}`)
        ]);
        ctx.reply(`Manage *${statusFilter}* matches:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    };

    bot.hears('🔴 Live Matches', (ctx) => showCategory(ctx, 'Live'));
    bot.hears('✅ Past Results', (ctx) => showCategory(ctx, 'Past'));
    bot.hears('🔵 Upcoming', (ctx) => showCategory(ctx, 'Upcoming'));

    // ── Match Editing Flow ──
    bot.action(/sel_(.+)/, async (ctx) => {
        const matchId = ctx.match[1];
        ctx.answerCbQuery();
        
        ctx.reply('What would you like to edit for this match?', Markup.inlineKeyboard([
            [Markup.button.callback('✏️ Score', `edit_score_${matchId}`), Markup.button.callback('✏️ Prediction', `edit_pred_${matchId}`)],
            [Markup.button.callback('✏️ Date', `edit_date_${matchId}`), Markup.button.callback('✏️ Time', `edit_time_${matchId}`)],
            [Markup.button.callback('🕒 Match Minute', `edit_min_${matchId}`)],
            [Markup.button.callback('🗑️ Delete Match', `delete_${matchId}`)]
        ]));
    });

    bot.action(/edit_(score|pred|date|time|min)_(.+)/, (ctx) => {
        const field = ctx.match[1];
        const matchId = ctx.match[2];
        userSession[ctx.from.id] = { matchId, editing: field };
        ctx.answerCbQuery();
        
        let prompt = "Enter the new score (e.g. 2-1):";
        if (field === 'pred') prompt = "Enter the new prediction text (e.g. 1, X, 2):";
        if (field === 'date') prompt = "Enter the new date (e.g. 10/05/2026):";
        if (field === 'time') prompt = "Enter the new time (e.g. 19:00):";
        if (field === 'min') prompt = "Enter the match minute or status (e.g. 65, HT, FT):";
        
        ctx.reply(prompt);
    });

    // Handle Delete
    bot.action(/delete_(.+)/, async (ctx) => {
        const matchId = ctx.match[1];
        ctx.answerCbQuery();
        try {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            const snap = await getDoc(docRef);
            let data = snap.data();
            data.matches = data.matches.filter(m => m.id !== matchId);
            await setDoc(docRef, data);
            ctx.reply('🗑️ Match deleted successfully!', mainMenu);
        } catch (e) { ctx.reply('Error deleting match.'); }
    });

    // Handle Edit Inputs
    bot.on('text', async (ctx) => {
        const session = userSession[ctx.from.id];
        if (session && session.editing) {
            const newVal = ctx.message.text;
            try {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
                const snap = await getDoc(docRef);
                let data = snap.data();
                const idx = data.matches.findIndex(m => m.id === session.matchId);

                if (idx !== -1) {
                    if (session.editing === 'score') {
                        const scores = newVal.split('-');
                        data.matches[idx].home.goals = scores[0]?.trim();
                        data.matches[idx].away.goals = scores[1]?.trim();
                    } else if (session.editing === 'pred') {
                        data.matches[idx].manual_prediction = newVal;
                    } else if (session.editing === 'date') {
                        data.matches[idx].date = newVal;
                    } else if (session.editing === 'time') {
                        data.matches[idx].time = newVal;
                    } else if (session.editing === 'min') {
                        data.matches[idx].playing_time = newVal;
                        if (newVal === 'FT') data.matches[idx].status = 'Past';
                        else if (!isNaN(parseInt(newVal)) || newVal === 'HT') data.matches[idx].status = 'Live';
                    }
                    await setDoc(docRef, data);
                    ctx.reply('✅ Website updated successfully!', mainMenu);
                }
                delete userSession[ctx.from.id];
            } catch (e) { ctx.reply('Error saving edit.'); }
            return;
        }

        if (userSession[ctx.from.id]?.pendingMatches && ctx.message.text === '🚀 Confirm & Publish') {
            return publishMatches(ctx);
        }
    });

    // ── Vision Handling ──
    bot.on('photo', async (ctx) => {
        if (!checkAdmin(ctx)) return;
        const photo = ctx.message.photo[ctx.message.photo.length - 1]; 
        ctx.reply('⏳ Reading screenshot... Teams, Scores, Predictions, Dates, and Times are being extracted.');

        try {
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            const imageResponse = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
            const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');

            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{
                    role: "system",
                    content: "Extract football data from betting site screenshot. Return JSON object with 'matches' array. Fields: home, away, prediction, pScore (predicted score), live (current score), min (minute/status), date, time, lg (league)."
                }, {
                    role: "user",
                    content: [
                        { type: "text", text: "Scan this screenshot for all match details including date and time:" },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                    ]
                }],
                response_format: { type: "json_object" }
            });

            const parsed = JSON.parse(completion.choices[0].message.content);
            const matches = parsed.matches || [];
            userSession[ctx.from.id] = { pendingMatches: matches };

            let summary = `🔍 Found ${matches.length} Matches:\n\n`;
            matches.forEach((m, i) => {
                const dateInfo = m.date ? ` [${m.date} ${m.time || ''}]` : "";
                summary += `${i+1}. *${m.home} vs ${m.away}*${dateInfo}\n⚽ Score: ${m.live || 'v'}\n🎯 Tip: ${m.prediction || m.pred} (${m.pScore || ''})\n\n`;
            });

            ctx.reply(summary, {
                parse_mode: 'Markdown',
                ...Markup.keyboard([['🚀 Confirm & Publish'], ['❌ Cancel']]).resize()
            });
        } catch (e) { ctx.reply('Vision Scan Error.'); }
    });

    async function publishMatches(ctx) {
        const session = userSession[ctx.from.id];
        try {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            const snap = await getDoc(docRef);
            let currentData = snap.exists() ? snap.data() : { matches: [] };

            session.pendingMatches.forEach(m => {
                let status = "Upcoming";
                if (m.min === 'FT') status = "Past";
                else if (m.min || m.live) status = "Live";

                const matchObj = {
                    id: `v_${Date.now()}_${Math.random().toString(36).substr(2, 2)}`,
                    date: m.date || new Date().toLocaleDateString('en-GB'),
                    time: m.time || "",
                    home: { name: m.home, goals: m.live ? m.live.split('-')[0].trim() : null },
                    away: { name: m.away, goals: m.live ? m.live.split('-')[1].trim() : null },
                    leagueName: m.lg || "Pro League",
                    status: status,
                    playing_time: m.min || "",
                    manual_prediction: `${m.prediction || m.pred} (${m.pScore || ''})`,
                    country: "Expert Pick"
                };
                currentData.matches.unshift(matchObj);
            });

            currentData.matches = currentData.matches.slice(0, 50);
            await setDoc(docRef, currentData);
            delete userSession[ctx.from.id];
            ctx.reply('✅ Site updated with screenshot data!', mainMenu);
        } catch (e) { ctx.reply('Save Error.'); }
    }

    bot.hears('❌ Cancel', (ctx) => { delete userSession[ctx.from.id]; ctx.reply('Cancelled.', mainMenu); });

    bot.hears('🗑️ Clear All Matches', async (ctx) => {
        if (!checkAdmin(ctx)) return;
        if (db) {
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'), { matches: [] });
            ctx.reply('All matches cleared.');
        }
    });

    bot.launch();
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ─── API Endpoint: Fix "Undefined" Prediction ───
app.get('/api/get-predictions', async (req, res) => {
    const { fixture: fixtureId } = req.query;
    try {
        if (db) {
            const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
            if (snap.exists()) {
                const matches = snap.data().matches || [];
                const match = matches.find(m => m.id === fixtureId);
                
                // If match has a manual prediction, return it so details sheet isn't undefined
                if (match && match.manual_prediction) {
                    return res.json({
                        response: [{
                            predictions: {
                                percent: { home: "—", draw: "—", away: "—" },
                                advice: match.manual_prediction,
                                code: match.manual_prediction.charAt(0)
                            }
                        }]
                    });
                }
            }
        }
        res.json({ response: [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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

app.listen(port, () => console.log(`Vision Dash live on ${port}`));
