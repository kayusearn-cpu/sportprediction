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
        ['📸 Upload Screenshot', '📝 Edit Existing'],
        ['🗑️ Clear All Matches']
    ]).resize();

    bot.start((ctx) => {
        ctx.reply('🤖 *Magic Vision AI Engine Active*\n\nJust upload a screenshot from Forebet or any site. I will scan the prediction circles (Green zone) and live scores (Pink zone) and update your website automatically.', {
            parse_mode: 'Markdown',
            ...mainMenu
        });
    });

    // Handle Incoming Screenshots
    bot.on('photo', async (ctx) => {
        const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Highest resolution
        ctx.reply('⏳ AI is reading the screenshot... Please hold on.');

        try {
            // 1. Get file link from Telegram servers
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            
            // 2. Fetch image and convert to base64 for Vision API
            const imageResponse = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
            const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');

            // 3. Send to OpenAI Vision (gpt-4o-mini is cost-effective and powerful)
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: `You are a professional football data scraper. Analyze the screenshot.
                        Extract every match entry. Focus on:
                        - Teams: Home and Away names.
                        - Prediction: The big orange/yellow circle (1, X, or 2).
                        - Predicted Score: The small text underneath the prediction circle (e.g., '1-0').
                        - Live Score: The score in the red box on the right (e.g., '0-2').
                        - Status: The number in the small circle on the right (e.g., '62' is the minute, 'HT' is half-time, 'FT' is finished).
                        - Probabilities: The 1-X-2 percentage numbers.
                        
                        Respond ONLY with a JSON object containing a 'matches' array. 
                        JSON Format: { "matches": [ { "home": "", "away": "", "lg": "", "pred": "", "pScore": "", "live": "", "min": "", "hp": "", "dp": "", "ap": "" } ] }`
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Scan this screenshot for predictions and live scores:" },
                            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                        ]
                    }
                ],
                response_format: { type: "json_object" }
            });

            const parsed = JSON.parse(completion.choices[0].message.content);
            const matches = parsed.matches || [];

            if (matches.length === 0) return ctx.reply('❌ No matches found. Try a clearer screenshot.');

            userSession[ctx.from.id] = { pendingMatches: matches };

            let summary = `🔍 *Vision Detected ${matches.length} Matches:*\n\n`;
            matches.forEach((m, i) => {
                const liveInfo = m.live ? ` 🔴 ${m.live} (${m.min}')` : "";
                summary += `${i+1}. *${m.home} vs ${m.away}*${liveInfo}\n🎯 Tip: ${m.pred} (Score: ${m.pScore})\n\n`;
            });

            ctx.reply(summary, {
                parse_mode: 'Markdown',
                ...Markup.keyboard([['🚀 Confirm & Publish'], ['❌ Cancel']]).resize()
            });

        } catch (e) {
            console.error(e);
            ctx.reply('❌ Vision Scan Error: ' + e.message);
        }
    });

    bot.hears('🚀 Confirm & Publish', async (ctx) => {
        const session = userSession[ctx.from.id];
        if (!session?.pendingMatches) return ctx.reply('No data to publish.', mainMenu);

        try {
            if (!db) return ctx.reply('❌ DB connection failed.');

            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            const snap = await getDoc(docRef);
            let currentData = snap.exists() ? snap.data() : { matches: [] };

            session.pendingMatches.forEach(m => {
                // Determine category based on minute/score
                let status = "Upcoming";
                if (m.min === 'FT') status = "Past";
                else if (m.min || m.live) status = "Live";

                // Check for existing match to update
                const idx = currentData.matches.findIndex(em => 
                    em.home.name.toLowerCase() === m.home.toLowerCase() && 
                    em.away.name.toLowerCase() === m.away.toLowerCase()
                );

                const matchObj = {
                    id: idx !== -1 ? currentData.matches[idx].id : `v_${Date.now()}_${Math.random().toString(36).substr(2, 3)}`,
                    home: { name: m.home, goals: m.live ? m.live.split('-')[0].trim() : null },
                    away: { name: m.away, goals: m.live ? m.live.split('-')[1].trim() : null },
                    leagueName: m.lg || "Pro League",
                    status: status,
                    manual_prediction: `${m.pred} (${m.pScore})`,
                    country: "Premium Tip"
                };

                if (idx !== -1) currentData.matches[idx] = matchObj;
                else currentData.matches.unshift(matchObj);
            });

            // Keep top 50 matches
            currentData.matches = currentData.matches.slice(0, 50);
            
            await setDoc(docRef, currentData);
            delete userSession[ctx.from.id];
            ctx.reply('✅ SUCCESS! Your website is now live with the new data.', mainMenu);

        } catch (e) { ctx.reply('❌ Save Error: ' + e.message); }
    });

    bot.hears('❌ Cancel', (ctx) => {
        delete userSession[ctx.from.id];
        ctx.reply('Operation cancelled.', mainMenu);
    });

    bot.hears('🗑️ Clear All Matches', async (ctx) => {
        if (db) {
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'), { matches: [] });
            ctx.reply('Website cleared of all matches.');
        }
    });

    bot.launch().catch(err => console.error("Bot fail:", err));
}

// ─── API for Website ─────────────────────────────────────────────────────────
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

app.listen(port, () => console.log(`Vision Server on port ${port}`));
