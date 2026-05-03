// backend/server.js
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const port = process.env.PORT || 3000;

app.use(cors());

let scoresCache     = null;
let scoresCacheTime = 0;
const SCORES_TTL    = 60 * 1000;

function mapStatus(short, elapsed, fixtureDate) {
    switch (short) {
        case '1H': case '2H': case 'ET':
            return elapsed ? String(elapsed) : short;
        case 'HT': case 'BT': case 'FT': case 'AET':
            return short;
        case 'PEN': case 'P':  return 'PEN';
        case 'PST':  return 'Postp.';
        case 'CANC': return 'Canc.';
        case 'SUSP': return 'Susp.';
        case 'WO': case 'AWD': case 'ABD': case 'INT': return short;
        case 'NS': default:
            if (fixtureDate) {
                try {
                    const d  = new Date(fixtureDate);
                    const hh = String(d.getUTCHours()).padStart(2, '0');
                    const mm = String(d.getUTCMinutes()).padStart(2, '0');
                    return `${hh}:${mm}`;
                } catch (_) {}
            }
            return 'NS';
    }
}

function buildFromAPIFootball(fixtures) {
    const leagueMap = {};
    const today = new Date().toISOString().split('T')[0];
    fixtures.forEach(f => {
        const key = String(f.league.id);
        if (!leagueMap[key]) {
            leagueMap[key] = { id: key, name: f.league.name, country: f.league.country, match: [] };
        }
        const status = mapStatus(f.fixture.status.short, f.fixture.status.elapsed, f.fixture.date);
        const ht = f.score.halftime;
        const ft = f.score.fulltime;
        leagueMap[key].match.push({
            id: String(f.fixture.id), static_id: String(f.fixture.id),
            date: f.fixture.date ? f.fixture.date.split('T')[0] : today,
            time: f.fixture.date ? (f.fixture.date.split('T')[1] || '').substring(0, 5) : '',
            status,
            home: { id: String(f.teams.home.id), name: f.teams.home.name, goals: f.goals.home != null ? String(f.goals.home) : null },
            away: { id: String(f.teams.away.id), name: f.teams.away.name, goals: f.goals.away != null ? String(f.goals.away) : null },
            ht: (ht && ht.home != null) ? { score: `[${ht.home}-${ht.away}]` } : null,
            ft: (ft && ft.home != null) ? { score: `[${ft.home}-${ft.away}]` } : null,
        });
    });
    return { livescore: { updated: new Date().toISOString(), sport: 'soccer', source: 'api-football', league: Object.values(leagueMap) } };
}

app.get('/api/scores', async (req, res) => {
    if (scoresCache && (Date.now() - scoresCacheTime < SCORES_TTL)) return res.json(scoresCache);
    const apfKey     = process.env.API_FOOTBALL_KEY;
    const statpalKey = process.env.STATPAL_API_KEY || '98e5c7b5-5b16-412c-a270-c3196e4ef98f';
    const today      = new Date().toISOString().split('T')[0];
    if (apfKey) {
        try {
            const upstream = await axios.get('https://v3.football.api-sports.io/fixtures', { params: { date: today }, headers: { 'x-apisports-key': apfKey }, timeout: 10000 });
            const body = upstream.data, fixtures = body.response || [];
            const hasErrors = body.errors && (Array.isArray(body.errors) ? body.errors.length > 0 : Object.keys(body.errors).length > 0);
            if (hasErrors) console.warn('API-Football errors:', JSON.stringify(body.errors));
            else if (fixtures.length > 0) {
                const result = buildFromAPIFootball(fixtures);
                scoresCache = result; scoresCacheTime = Date.now();
                console.log(`API-Football: ${fixtures.length} fixtures loaded`);
                return res.json(result);
            } else console.warn('API-Football returned 0 fixtures — falling back to StatPal');
        } catch (err) { console.error('API-Football request failed:', err.message); }
    } else console.warn('API_FOOTBALL_KEY not set — using StatPal only');
    try {
        const upstream = await axios.get('https://statpal.io/api/v1/soccer/livescores', { params: { access_key: statpalKey }, timeout: 10000 });
        const result = upstream.data;
        if (result.livescore) result.livescore.source = 'statpal';
        scoresCache = result; scoresCacheTime = Date.now();
        console.log('StatPal fallback: data loaded');
        return res.json(result);
    } catch (err) { console.error('StatPal fallback failed:', err.message); }
    if (scoresCache) { console.warn('Serving stale cache'); return res.json(scoresCache); }
    res.status(500).json({ error: 'Failed to fetch live sports data from all sources' });
});

app.get('/api/status', async (req, res) => {
    const apfKey = process.env.API_FOOTBALL_KEY;
    const result = { api_football_key_set: !!apfKey, api_football: null, cache: null };
    if (scoresCache) result.cache = { source: scoresCache.livescore?.source, league_count: scoresCache.livescore?.league?.length, updated: scoresCache.livescore?.updated, age_seconds: Math.round((Date.now() - scoresCacheTime) / 1000) };
    if (apfKey) {
        try { const check = await axios.get('https://v3.football.api-sports.io/status', { headers: { 'x-apisports-key': apfKey }, timeout: 8000 }); result.api_football = check.data.response || check.data; }
        catch (e) { result.api_football = { error: e.message }; }
    }
    res.json(result);
});

const predCache = {};

function generatePrediction(fixtureId) {
    const seed = String(fixtureId).split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 7);
    const r = n => { const x = Math.sin(seed * n + n * 13.7) * 99991; return x - Math.floor(x); };
    const homeWin = Math.round(40 + r(1) * 16), draw = Math.round(22 + r(2) * 8), awayWin = 100 - homeWin - draw;
    const hg = Math.min(4, Math.round(r(3) * 3.2)), ag = Math.min(3, Math.round(r(4) * 2.4));
    const best = homeWin >= awayWin && homeWin >= draw ? 'home' : awayWin >= homeWin && awayWin >= draw ? 'away' : 'draw';
    const advice = best === 'home' ? 'Home Win Predicted' : best === 'away' ? 'Away Win Predicted' : 'Draw Predicted';
    return { response: [{ predictions: { percent: { home: `${homeWin}%`, draw: `${draw}%`, away: `${awayWin}%` }, goals: { home: hg, away: ag }, advice } }] };
}

app.get('/api/get-predictions', async (req, res) => {
    const { fixture: fixtureId, home, away, league, country, status, score } = req.query;
    const apiKey = process.env.API_FOOTBALL_KEY, openaiKey = process.env.OPENAI_API_KEY;
    if (!fixtureId) return res.status(400).json({ error: 'fixture ID required' });
    if (predCache[fixtureId]) return res.json(predCache[fixtureId]);
    if (apiKey && /^\d+$/.test(fixtureId)) {
        try {
            const r = await axios.get('https://v3.football.api-sports.io/predictions', { params: { fixture: fixtureId }, headers: { 'x-apisports-key': apiKey }, timeout: 8000 });
            if (r.data.response?.length > 0 && r.data.response[0]?.predictions) { predCache[fixtureId] = r.data; return res.json(r.data); }
        } catch (e) { console.warn('API-Football predictions failed:', e.message); }
    }
    if (openaiKey && home && away) {
        try {
            const { OpenAI } = require('openai');
            const openai = new OpenAI({ apiKey: openaiKey });
            const context = [league ? `Competition: ${league}${country ? ' (' + country + ')' : ''}` : '', status ? `Match status: ${status}` : '', score ? `Current score: ${score}` : ''].filter(Boolean).join(' | ');
            const completion = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'system', content: `You are a professional football prediction analyst using Poisson distribution methodology like Forebet/WinDrawWin/PredictZ. Use real team attack/defense strength, home advantage (+0.35 xG), recent form, and H2H history. Respond ONLY with raw JSON: {"home":53,"draw":24,"away":23,"homeGoals":2,"awayGoals":0,"advice":"One sentence mentioning teams and key factor"}` }, { role: 'user', content: `Predict: ${home} vs ${away}${context ? '\n' + context : ''}\nhome+draw+away must equal 100.` }],
                max_tokens: 120, temperature: 0.2,
            });
            const pred = JSON.parse(completion.choices[0].message.content.trim().replace(/```json[\s\S]*?```|```/g, '').trim());
            const h = Math.min(90, Math.max(5, Math.round(Number(pred.home) || 45)));
            const d = Math.min(60, Math.max(5, Math.round(Number(pred.draw) || 27)));
            const a = Math.max(5, 100 - h - d);
            const result = { response: [{ predictions: { percent: { home: `${h}%`, draw: `${d}%`, away: `${a}%` }, goals: { home: Math.min(7, Math.max(0, Math.round(Number(pred.homeGoals) || 1))), away: Math.min(7, Math.max(0, Math.round(Number(pred.awayGoals) || 1))) }, advice: pred.advice || '' } }] };
            predCache[fixtureId] = result; return res.json(result);
        } catch (e) { console.warn('OpenAI prediction failed:', e.message); }
    }
    const result = generatePrediction(fixtureId);
    predCache[fixtureId] = result; return res.json(result);
});

const logoCache = {};
app.get('/api/team-logo', async (req, res) => {
    const name = req.query.name;
    if (!name) return res.status(400).json({ logo: null });
    const key = name.toLowerCase().trim();
    if (logoCache[key] !== undefined) return res.json({ logo: logoCache[key] });
    try {
        const r = await axios.get('https://www.thesportsdb.com/api/v1/json/3/searchteams.php', { params: { t: name }, timeout: 5000 });
        const logo = r.data?.teams?.[0]?.strTeamBadge || null;
        logoCache[key] = logo; res.json({ logo });
    } catch (_) { logoCache[key] = null; res.json({ logo: null }); }
});

app.get('/api/match-analysis', async (req, res) => {
    const { home, away, league, status, score, ht } = req.query;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.json({ analysis: null });
    try {
        const { OpenAI } = require('openai');
        const openai = new OpenAI({ apiKey });
        const r = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: `Brief 2-3 sentence football match analysis: ${home} vs ${away}, ${league}, Score: ${score}, Status: ${status}, HT: ${ht || 'N/A'}. Be concise and insightful.` }], max_tokens: 120 });
        res.json({ analysis: r.choices[0].message.content });
    } catch (e) { console.error('OpenAI error:', e.message); res.json({ analysis: null }); }
});

let upcomingCache = null, upcomingCacheTime = 0;
const UPCOMING_TTL = 5 * 60 * 1000;

app.get('/api/upcoming', async (req, res) => {
    if (upcomingCache && (Date.now() - upcomingCacheTime < UPCOMING_TTL)) return res.json(upcomingCache);
    const key = process.env.FOOTBALL_DATA_KEY;
    if (!key) return res.json({ matches: [] });
    const today    = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    try {
        const r = await axios.get('https://api.football-data.org/v4/matches', { params: { dateFrom: today, dateTo: tomorrow }, headers: { 'X-Auth-Token': key }, timeout: 10000 });
        const rem = parseInt(r.headers['x-requests-available-minute'] || '99', 10);
        if (rem < 3) console.warn(`football-data.org rate limit low: ${rem} remaining`);
        const matches = (r.data.matches || []).map(m => {
            const date = m.utcDate ? m.utcDate.split('T')[0] : today;
            const time = m.utcDate ? m.utcDate.split('T')[1].substring(0, 5) : '';
            const statusMap = { IN_PLAY: 'LIVE', PAUSED: 'HT', FINISHED: 'FT', POSTPONED: 'Postp.', SUSPENDED: 'Susp.', CANCELLED: 'Canc.' };
            const status = statusMap[m.status] || time || 'NS';
            return {
                id: String(m.id), static_id: String(m.id), date, time, status,
                leagueName: m.competition?.name || '', country: m.area?.name || '',
                home: { id: String(m.homeTeam?.id || ''), name: m.homeTeam?.shortName || m.homeTeam?.name || '', goals: m.score?.fullTime?.home != null ? String(m.score.fullTime.home) : null },
                away: { id: String(m.awayTeam?.id || ''), name: m.awayTeam?.shortName || m.awayTeam?.name || '', goals: m.score?.fullTime?.away != null ? String(m.score.fullTime.away) : null },
                ht: m.score?.halfTime?.home != null ? { score: `[${m.score.halfTime.home}-${m.score.halfTime.away}]` } : null,
                ft: m.score?.fullTime?.home != null  ? { score: `[${m.score.fullTime.home}-${m.score.fullTime.away}]` }  : null,
            };
        });
        upcomingCache = { matches }; upcomingCacheTime = Date.now();
        console.log(`football-data.org: ${matches.length} matches loaded`);
        return res.json(upcomingCache);
    } catch (e) {
        console.error('football-data.org failed:', e.message);
        return res.json(upcomingCache || { matches: [] });
    }
});

app.listen(port, () => { console.log(`MagicBettingTips backend running on port ${port}`); });
