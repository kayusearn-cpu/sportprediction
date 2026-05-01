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
        case 'PEN': case 'P':
            return 'PEN';
        case 'PST':  return 'Postp.';
        case 'CANC': return 'Canc.';
        case 'SUSP': return 'Susp.';
        case 'WO': case 'AWD': case 'ABD': case 'INT':
            return short;
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
            home: { id: String(f.teams.home.id), name: f.teams.home.name, goals: (f.goals.home !== null && f.goals.home !== undefined) ? String(f.goals.home) : null },
            away: { id: String(f.teams.away.id), name: f.teams.away.name, goals: (f.goals.away !== null && f.goals.away !== undefined) ? String(f.goals.away) : null },
            ht: (ht && ht.home !== null && ht.home !== undefined) ? { score: `[${ht.home}-${ht.away}]` } : null,
            ft: (ft && ft.home !== null && ft.home !== undefined) ? { score: `[${ft.home}-${ft.away}]` } : null,
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
            const upstream = await axios.get('https://v3.football.api-sports.io/fixtures', {
                params: { date: today }, headers: { 'x-apisports-key': apfKey }, timeout: 10000,
            });
            const body = upstream.data;
            const fixtures = body.response || [];
            const hasErrors = body.errors && (Array.isArray(body.errors) ? body.errors.length > 0 : Object.keys(body.errors).length > 0);
            if (hasErrors) {
                console.warn('API-Football errors:', JSON.stringify(body.errors));
            } else if (fixtures.length > 0) {
                const result = buildFromAPIFootball(fixtures);
                scoresCache = result; scoresCacheTime = Date.now();
                return res.json(result);
            } else {
                console.warn('API-Football 0 fixtures — falling back to StatPal');
            }
        } catch (err) { console.error('API-Football failed:', err.message); }
    }

    try {
        const upstream = await axios.get('https://statpal.io/api/v1/soccer/livescores', {
            params: { access_key: statpalKey }, timeout: 10000,
        });
        const result = upstream.data;
        if (result.livescore) result.livescore.source = 'statpal';
        scoresCache = result; scoresCacheTime = Date.now();
        return res.json(result);
    } catch (err) { console.error('StatPal failed:', err.message); }

    if (scoresCache) return res.json(scoresCache);
    res.status(500).json({ error: 'Failed to fetch live sports data from all sources' });
});

app.get('/api/status', async (req, res) => {
    const apfKey = process.env.API_FOOTBALL_KEY;
    const result = { api_football_key_set: !!apfKey, cache: null, api_football: null };
    if (scoresCache) result.cache = { source: scoresCache.livescore?.source, league_count: scoresCache.livescore?.league?.length, updated: scoresCache.livescore?.updated, age_seconds: Math.round((Date.now() - scoresCacheTime) / 1000) };
    if (apfKey) {
        try {
            const check = await axios.get('https://v3.football.api-sports.io/status', { headers: { 'x-apisports-key': apfKey }, timeout: 8000 });
            result.api_football = check.data.response || check.data;
        } catch (e) { result.api_football = { error: e.message }; }
    }
    res.json(result);
});

app.get('/api/get-predictions', async (req, res) => {
    const fixtureId = req.query.fixture;
    const apiKey    = process.env.API_FOOTBALL_KEY;
    if (!fixtureId) return res.status(400).json({ error: 'Please provide a fixture ID' });
    if (!apiKey) return res.status(500).json({ error: 'Backend configuration error: API Key missing.' });
    try {
        const response = await axios.get('https://v3.football.api-sports.io/predictions', {
            params: { fixture: fixtureId }, headers: { 'x-apisports-key': apiKey }, timeout: 10000,
        });
        res.json(response.data);
    } catch (error) {
        const status  = error.response?.status  || 500;
        const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        res.status(status).json({ error: 'Failed to fetch predictions', details });
    }
});

app.listen(port, () => console.log(`MagicBettingTips backend running on port ${port}`));
