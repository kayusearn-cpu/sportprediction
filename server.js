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
        const cleanedConfig = firebaseConfigStr.trim();
        const firebaseConfig = JSON.parse(cleanedConfig);
        const firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        console.log("🔥 Firebase connected.");
    } catch (err) {
        console.error("❌ Firebase Error:", err.message);
    }
}

// ─── API Fetchers ────────────────────────────────────────────────────────────

// 1. StatPal
async function fetchStatPal() {
    const key = process.env.STATPAL_API_KEY || '98e5c7b5-5b16-412c-a270-c3196e4ef98f';
    try {
        const r = await axios.get(`https://statpal.io/api/v1/soccer/livescores`, { params: { access_key: key }, timeout: 10000 });
        const matches = [];
        const leagues = Array.isArray(r.data?.livescore?.league) ? r.data.livescore.league : [r.data?.livescore?.league].filter(Boolean);
        leagues.forEach(l => {
            const ms = Array.isArray(l.match) ? l.match : [l.match].filter(Boolean);
            ms.forEach(m => matches.push({ id: m.id, home: m.home.name, away: m.away.name, league: l.name }));
        });
        return matches;
    } catch (e) { return []; }
}

// 2. API-Football
async function fetchApiFootball() {
    const key = process.env.API_FOOTBALL_KEY;
    if (!key) return [];
    try {
        const r = await axios.get('https://v3.football.api-sports.io/fixtures', {
            params: { live: 'all' },
            headers: { 'x-apisports-key': key },
            timeout: 10000
        });
        return (r.data?.response || []).map(f => ({
            id: String(f.fixture.id),
            home: f.teams.home.name,
            away: f.teams.away.name,
            league: f.league.name
        }));
    } catch (e) { return []; }
}

// 3. Sportmonks
async function fetchSportmonks() {
    const key = process.env.SPORTMONKS_KEY;
    if (!key) return [];
    try {
        const r = await axios.get('https://api.sportmonks.com/v3/football/livescores/inplay', {
            params: { api_token: key, include: 'participants;league' },
            timeout: 10000
        });
        return (r.data?.data || []).map(f => {
            const home = f.participants?.find(p => p.meta?.location === 'home')?.name || 'Home';
            const away = f.participants?.find(p => p.meta?.location === 'away')?.name || 'Away';
            return { id: String(f.id), home, away, league: f.league?.name || 'Unknown' };
        });
    } catch (e) { return []; }
}

// 4. Football-Data.org
async function fetchFootballData() {
    const key = process.env.FOOTBALL_DATA_KEY;
    if (!key) return [];
    try {
        const r = await axios.get('https://api.football-data.org/v4/matches', {
            headers: { 'X-Auth-Token': key },
            timeout: 10000
        });
        return (r.data?.matches || []).filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED').map(m => ({
            id: String(m.id),
            home: m.homeTeam.name,
            away: m.awayTeam.name,
            league: m.competition.name
        }));
    } catch (e) { return []; }
}

// ─── Telegram Bot Logic ──────────────────────────────────────────────────────
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken) {
    const bot = new Telegraf(botToken);
    const userSession = {};

    const PREDICTION_OPTIONS = [
        ['1 (Home Win)', 'X (Draw)', '2 (Away Win)'],
        ['1X (Home or Draw)', '12 (Home or Away)', 'X2 (Draw or Away)'],
        ['Over 1.5', 'Over 2.5', 'Over 3.5'],
        ['BTTS - Yes', 'BTTS - No'],
        ['❌ Cancel']
    ];

    const adminMenu = Markup.keyboard([
        ['➕ Add New Prediction', '🔄 Sync Global Data']
    ]).resize();

    bot.start((ctx) => ctx.reply('⚽ *Magic Analysis Multi-Engine*\nSelect an API to see its live matches.', { parse_mode: 'Markdown', ...adminMenu }));

    bot.hears('➕ Add New Prediction', (ctx) => {
        ctx.reply('Which data source would you like to use for Live matches?', Markup.inlineKeyboard([
            [Markup.button.callback('🏆 Sportmonks', 'src_sm')],
            [Markup.button.callback('⚽ API-Football', 'src_af')],
            [Markup.button.callback('📊 Football-Data', 'src_fd')],
            [Markup.button.callback('🎯 StatPal (Default)', 'src_sp')]
        ]));
    });

    bot.action(/src_(.+)/, async (ctx) => {
        const source = ctx.match[1];
        ctx.answerCbQuery();
        ctx.reply(`⏳ Requesting data from ${source.toUpperCase()}...`);

        let matches = [];
        if (source === 'sm') matches = await fetchSportmonks();
        else if (source === 'af') matches = await fetchApiFootball();
        else if (source === 'fd') matches = await fetchFootballData();
        else matches = await fetchStatPal();

        if (matches.length === 0) return ctx.reply('❌ No live matches found in this source.');

        // Show top 12 matches to avoid UI clutter
        const buttons = matches.slice(0, 12).map(m => [
            Markup.button.callback(`${m.league.substring(0,6)}: ${m.home} vs ${m.away}`, `sel_${m.id}`)
        ]);
        ctx.reply(`👉 Select match from ${source.toUpperCase()}:`, Markup.inlineKeyboard(buttons));
    });

    bot.action(/sel_(.+)/, (ctx) => {
        userSession[ctx.from.id] = { matchId: ctx.match[1], step: 'WAITING_FOR_TIP' };
        ctx.answerCbQuery();
        ctx.reply('🎯 Set your professional tip:', Markup.keyboard(PREDICTION_OPTIONS).resize());
    });

    bot.on('text', async (ctx) => {
        const session = userSession[ctx.from.id];
        if (session?.step === 'WAITING_FOR_TIP') {
            if (ctx.message.text === '❌ Cancel') { delete userSession[ctx.from.id]; return ctx.reply('Cancelled.', adminMenu); }
            try {
                if (db) {
                    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'manual_predictions', 'current');
                    const snap = await getDoc(docRef);
                    let tips = snap.exists() ? snap.data().tips || {} : {};
                    tips[session.matchId] = { tip: ctx.message.text, time: new Date().toISOString() };
                    await setDoc(docRef, { tips });
                    delete userSession[ctx.from.id];
                    ctx.reply(`✅ TIP LIVE: ${ctx.message.text}`, adminMenu);
                }
            } catch (e) { ctx.reply('❌ Error: ' + e.message); }
        }
    });

    bot.launch();
}

// ─── Web API ─────────────────────────────────────────────────────────────────
app.get('/api/scores', async (req, res) => {
    try {
        let scoresData = { livescore: { league: [] } };
        let manualTips = {};
        if (db) {
            const scoreSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current'));
            if (scoreSnap.exists()) scoresData = scoreSnap.data();
            const tipSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'manual_predictions', 'current'));
            if (tipSnap.exists()) manualTips = tipSnap.data().tips || {};
        }
        const flat = [];
        const leagues = Array.isArray(scoresData.livescore?.league) ? scoresData.livescore.league : [scoresData.livescore?.league].filter(Boolean);
        leagues.forEach(lg => {
            const ms = Array.isArray(lg.match) ? lg.match : [lg.match].filter(Boolean);
            ms.forEach(m => {
                if (manualTips[m.id]) m.manual_prediction = manualTips[m.id].tip;
                flat.push({...m, leagueName: lg.name, country: lg.country});
            });
        });
        res.json({ matches: flat });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('Multi-Engine Backend Online.'));
app.listen(port, () => console.log(`Server live on ${port}`));
