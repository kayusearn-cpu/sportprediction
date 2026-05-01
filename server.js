// backend/server.js
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const port = process.env.PORT || 3000;

app.use(cors());

// Simple in-memory cache — 1 upstream call per 60 s regardless of user count
let scoresCache     = null;
let scoresCacheTime = 0;
const SCORES_TTL    = 60 * 1000;

// Map API-Football status codes to what the frontend already understands
function mapStatus(short, elapsed, fixtureDate) {
    switch (short) {
        case '1H':
        case '2H':
        case 'ET':
            return elapsed ? String(elapsed) : short;
        case 'HT':
        case 'BT':
        case 'FT':
        case 'AET':
            return short;
        case 'PEN':
        case 'P':
            return 'PEN';
        case 'PST':  return 'Postp.';
        case 'CANC': return 'Canc.';
        case 'SUSP': return 'Susp.';
        case 'WO':
        case 'AWD':
        case 'ABD':
        case 'INT':
            return short;
        case 'NS':
        default:
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

// /api/scores — now uses API-Football so fixture IDs match /api/get-predictions
app.get('/api/scores', async (req, res) => {
    const apiKey = process.env.API_FOOTBALL_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'API_FOOTBALL_KEY environment variable is not set' });
    }

    if (scoresCache && (Date.now() - scoresCacheTime < SCORES_TTL)) {
        return res.json(scoresCache);
    }

    try {
        const today = new Date().toISOString().split('T')[0];

        const upstream = await axios.get('https://v3.football.api-sports.io/fixtures', {
            params:  { date: today },
            headers: { 'x-apisports-key': apiKey },
            timeout: 10000,
        });

        const fixtures = upstream.data.response || [];

        const leagueMap = {};
        fixtures.forEach(f => {
            const key = String(f.league.id);
            if (!leagueMap[key]) {
                leagueMap[key] = {
                    id:      key,
                    name:    f.league.name,
                    country: f.league.country,
                    match:   [],
                };
            }

            const status = mapStatus(
                f.fixture.status.short,
                f.fixture.status.elapsed,
                f.fixture.date,
            );

            const ht = f.score.halftime;
            const ft = f.score.fulltime;

            leagueMap[key].match.push({
                id:        String(f.fixture.id),
                static_id: String(f.fixture.id),
                date:      f.fixture.date ? f.fixture.date.split('T')[0] : today,
                time:      f.fixture.date ? (f.fixture.date.split('T')[1] || '').substring(0, 5) : '',
                status,
                home: {
                    id:    String(f.teams.home.id),
                    name:  f.teams.home.name,
                    goals: (f.goals.home !== null && f.goals.home !== undefined) ? String(f.goals.home) : null,
                },
                away: {
                    id:    String(f.teams.away.id),
                    name:  f.teams.away.name,
                    goals: (f.goals.away !== null && f.goals.away !== undefined) ? String(f.goals.away) : null,
                },
                ht: (ht && ht.home !== null && ht.home !== undefined) ? { score: `[${ht.home}-${ht.away}]` } : null,
                ft: (ft && ft.home !== null && ft.home !== undefined) ? { score: `[${ft.home}-${ft.away}]` } : null,
            });
        });

        const result = {
            livescore: {
                updated: new Date().toISOString(),
                sport:   'soccer',
                league:  Object.values(leagueMap),
            },
        };

        scoresCache     = result;
        scoresCacheTime = Date.now();
        res.json(result);

    } catch (error) {
        console.error('API-Football Scores Error:', error.response?.data || error.message);
        if (scoresCache) return res.json(scoresCache);
        res.status(500).json({ error: 'Failed to fetch live sports data' });
    }
});

// /api/get-predictions — unchanged, still uses API-Football
app.get('/api/get-predictions', async (req, res) => {
    const fixtureId = req.query.fixture;
    const apiKey    = process.env.API_FOOTBALL_KEY;

    if (!fixtureId) {
        return res.status(400).json({ error: 'Please provide a fixture ID' });
    }

    if (!apiKey) {
        console.error('CRITICAL: API_FOOTBALL_KEY is not set');
        return res.status(500).json({ error: 'Backend configuration error: API Key missing.' });
    }

    try {
        const response = await axios.get('https://v3.football.api-sports.io/predictions', {
            params:  { fixture: fixtureId },
            headers: { 'x-apisports-key': apiKey },
            timeout: 10000,
        });
        res.json(response.data);
    } catch (error) {
        console.error('API-Sports Predictions Error:', error.response?.data || error.message);
        const status  = error.response?.status  || 500;
        const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        res.status(status).json({ error: 'Failed to fetch predictions', details });
    }
});

app.listen(port, () => {
    console.log(`MagicBettingTips backend running on port ${port}`);
});
