// backend/server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Telegraf } = require('telegraf'); // Added Telegram Library

const app = express();
const port = process.env.PORT || 3000;
const SM = 'https://api.sportmonks.com/v3/football';

app.use(cors());
app.use(express.json());

// ─── Telegram Bot Initialization ─────────────────────────────────────────────
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot;

if (botToken) {
    bot = new Telegraf(botToken);

    // Handle /start command
    bot.start((ctx) => {
        ctx.reply('⚽ Welcome to MagicBettingTips Bot!\n\nI can provide you with live scores and betting predictions. Use /scores to see what is happening now!');
    });

    // Handle /scores command
    bot.command('scores', async (ctx) => {
        try {
            ctx.reply('🔄 Fetching latest scores...');
            const scores = await getScoresData();
            if (!scores || !scores.livescore || !scores.livescore.league) {
                return ctx.reply('❌ No live matches found at the moment.');
            }

            let message = "🏆 *Live Scores*\n\n";
            const leagues = scores.livescore.league.slice(0, 5); // Limit to top 5 for Telegram message length

            leagues.forEach(l => {
                message += `📍 *${l.name}*\n`;
                l.match.slice(0, 3).forEach(m => {
                    message += `${m.home.name} ${m.home.goals || 0} - ${m.away.goals || 0} ${m.away.name} (${m.status})\n`;
                });
                message += "\n";
            });

            ctx.replyWithMarkdown(message);
        } catch (error) {
            ctx.reply('❌ Error fetching scores.');
        }
    });

    // Launch bot
    bot.launch()
        .then(() => console.log('Telegram Bot started successfully'))
        .catch((err) => console.error('Telegram Bot failed to start:', err));

    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
    console.warn('TELEGRAM_BOT_TOKEN not found. Bot functionality is disabled.');
}

// ─── Scores cache ─────────────────────────────────────────────────────────────
let scoresCache = null;
let scoresCacheTime = 0;
const SCORES_TTL = 60 * 1000;

// ─── Helper function to fetch scores (used by both API and Bot) ───────────────
async function getScoresData() {
    if (scoresCache && (Date.now() - scoresCacheTime < SCORES_TTL)) return scoresCache;

    const smKey = process.env.SPORTMONKS_KEY;
    const apfKey = process.env.API_FOOTBALL_KEY;
    const statpalKey = process.env.STATPAL_API_KEY || '98e5c7b5-5b16-412c-a270-c3196e4ef98f';
    const today = new Date().toISOString().split('T')[0];

    // Attempt StatPal
    try {
        const r = await axios.get('https://statpal.io/api/v1/soccer/livescores', {
            params: { access_key: statpalKey }, timeout: 10000,
        });
        const result = r.data;
        if (result.livescore?.league?.length > 0) {
            result.livescore.source = 'statpal';
            scoresCache = result; scoresCacheTime = Date.now();
            return result;
        }
    } catch (e) { console.error('StatPal failed:', e.message); }

    // Fallback logic for other sources... (truncated for brevity, remains same as your original)
    return scoresCache; 
}

// ─── Existing API Endpoints ──────────────────────────────────────────────────
app.get('/api/scores', async (req, res) => {
    const data = await getScoresData();
    if (data) return res.json(data);
    res.status(500).json({ error: 'All data sources failed' });
});

// ... (Rest of your existing /api/get-predictions, /api/status endpoints etc.)

app.listen(port, () => { 
    console.log(`MagicBettingTips backend running on port ${port}`); 
});
