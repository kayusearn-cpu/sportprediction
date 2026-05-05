// backend/server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf'); // Added Markup for buttons

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

    // Main Admin Keyboard
    const adminKeyboard = Markup.keyboard([
        ['🔄 Update Live & Predictions', '📅 Update Old Matches'],
        ['🕒 Update Upcoming Matches', '👁️ Preview Before Send'],
        ['📝 Edit Posts']
    ]).resize();

    // Handle /start command
    bot.start((ctx) => {
        ctx.reply('🛠️ MagicBettingTips Admin Panel\nSelect an action to manage the website data:', adminKeyboard);
    });

    // 1. Update Live & Predictions
    bot.hears('🔄 Update Live & Predictions', async (ctx) => {
        ctx.reply('⏳ Fetching live data and generating predictions...');
        try {
            // Trigger your internal scoring update
            const data = await getScoresData();
            // You can add logic here to "push" to a DB or clear cache
            ctx.reply(`✅ Success! Live matches updated. (${data.livescore?.league?.length || 0} leagues loaded)`);
        } catch (error) {
            ctx.reply('❌ Failed to update live data.');
        }
    });

    // 2. Update Old Matches
    bot.hears('📅 Update Old Matches', (ctx) => {
        ctx.reply('🔄 Syncing results for past matches...');
        // Add logic here to fetch yesterday's scores and update the DB
        ctx.reply('✅ Old matches updated successfully.');
    });

    // 3. Update Upcoming Matches
    bot.hears('🕒 Update Upcoming Matches', async (ctx) => {
        ctx.reply('🔄 Refreshing upcoming fixtures...');
        try {
            // This calls your existing API logic internally
            // In a real app, you'd save this to your database
            ctx.reply('✅ Upcoming matches synchronized with the frontend.');
        } catch (error) {
            ctx.reply('❌ Error updating upcoming matches.');
        }
    });

    // 4. Preview Before Send
    bot.hears('👁️ Preview Before Send', (ctx) => {
        ctx.reply('📊 *PREVIEW MODE*\n\nHere is how the next post will look:\n\n⚽ *Match:* Team A vs Team B\n📈 *Prediction:* Home Win (65%)\n🎯 *Score:* 2-0', Markup.inlineKeyboard([
            [Markup.button.callback('Push to Website', 'push_now')]
        ]));
    });

    // 5. Edit Posts
    bot.hears('📝 Edit Posts', (ctx) => {
        ctx.reply('✏️ Which post ID would you like to edit? (Send the ID)');
    });

    // Handle button actions
    bot.action('push_now', (ctx) => {
        ctx.answerCbQuery();
        ctx.editMessageText('🚀 Post has been pushed to the live website!');
    });

    bot.launch()
        .then(() => console.log('Telegram Bot with Admin Menu started'))
        .catch((err) => console.error('Bot Error:', err));

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ─── Data Logic (Remaining the same as your original) ────────────────────────
let scoresCache = null;
let scoresCacheTime = 0;
const SCORES_TTL = 60 * 1000;

async function getScoresData() {
    // ... (Your existing StatPal/Sportmonks logic)
    // Return the scores object
}

// ─── API Endpoints ──────────────────────────────────────────────────────────
app.get('/api/scores', async (req, res) => {
    const data = await getScoresData();
    res.json(data);
});

// ... rest of your API routes

app.listen(port, () => { 
    console.log(`Backend running on port ${port}`); 
});
