// backend/server.js
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const port = process.env.PORT || 3000;
const SM   = 'https://api.sportmonks.com/v3/football';

app.use(cors());
app.use(express.json());

// ─── OpenAI singleton ─────────────────────────────────────────────────────────
let _openai = null;
function getOpenAI() {
    if (!_openai) {
        const { OpenAI } = require('openai');
        _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return _openai;
}

// ─── Scores cache ─────────────────────────────────────────────────────────────
let scoresCache     = null;
let scoresCacheTime = 0;
const SCORES_TTL    = 60 * 1000;

// ─── Prediction cache (TTL: 4 hours) ──────────────────────────────────────────
const predCache   = {};
const predCacheTs = {};
const PRED_TTL    = 4 * 60 * 60 * 1000;

// ─── News cache (TTL: 1 hour) ─────────────────────────────────────────────────
let newsCache     = null;
let newsCacheTime = 0;
const NEWS_TTL    = 60 * 60 * 1000;

// ─── Upcoming cache ───────────────────────────────────────────────────────────
let upcomingCache     = null;
let upcomingCacheTime = 0;
const UPCOMING_TTL    = 5 * 60 * 1000;

// ─── Sportmonks helpers ───────────────────────────────────────────────────────
function smStatus(state, kickoffTime) {
    if (!state) return kickoffTime || 'NS';
    const d = state.developer_name || '';
    if (d === 'NS')                                                        return kickoffTime || 'NS';
    if (['INPLAY_1ST_HALF','INPLAY_2ND_HALF','INPLAY_ET'].includes(d))    return state.short_name || 'LIVE';
    if (d === 'INPLAY_HT')                                                 return 'HT';
    if (['FT','FT_ONLY','AWARDED'].includes(d))                            return 'FT';
    if (d === 'AET')                                                       return 'AET';
    if (['PEN_BREAK','PENALTIES'].includes(d))                             return 'PEN';
    if (d === 'POSTP')  return 'Postp.';
    if (d === 'CANCL')  return 'Canc.';
    if (d === 'SUSP')   return 'Susp.';
    return state.short_name || kickoffTime || 'NS';
}

function smGoal(scores, teamId, desc) {
    return scores?.find(s => s.participant_id === teamId && s.description === desc)?.score?.goals ?? null;
}

function smFixturesToFlat(fixtures, defaultLeague = '') {
    const matches = [];
    fixtures.forEach(f => {
        if (f.placeholder) return;
        const home = f.participants?.find(p => p.meta?.location === 'home');
        const away = f.participants?.find(p => p.meta?.location === 'away');
        if (!home || !away) return;
        const time   = f.starting_at?.split(' ')[1]?.substring(0, 5) || '';
        const status = smStatus(f.state, time);
        const hC = smGoal(f.scores, home.id, 'CURRENT');
        const aC = smGoal(f.scores, away.id, 'CURRENT');
        const hH = smGoal(f.scores, home.id, 'HT');
        const aH = smGoal(f.scores, away.id, 'HT');
        const isFt = status === 'FT' || status === 'AET';
        matches.push({
            id:         String(f.id),
            static_id:  String(f.id),
            date:       f.starting_at?.split(' ')[0] || '',
            time,
            status,
            leagueName: f.league?.name  || defaultLeague,
            country:    f.league?.country?.name || '',
            home: { id: String(home.id), name: home.name, goals: hC !== null ? String(hC) : null, logo: home.image_path || null },
            away: { id: String(away.id), name: away.name, goals: aC !== null ? String(aC) : null, logo: away.image_path || null },
            ht:   hH !== null ? { score: `[${hH}-${aH}]` } : null,
            ft:   isFt && hC !== null ? { score: `[${hC}-${aC}]` } : null,
        });
    });
    return matches;
}

async function smFixturesByDate(date, key, include = 'participants;league.country;state;scores') {
    const all = [];
    let page = 1, hasMore = true;
    while (hasMore && page <= 4) {
        const r = await axios.get(`${SM}/fixtures/date/${date}`, {
            params: { include, api_token: key, per_page: 100, page },
            timeout: 12000,
        });
        all.push(...(r.data?.data || []));
        hasMore = r.data?.pagination?.has_more === true;
        page++;
    }
    return all;
}

function smParsePredictions(predictions) {
    if (!predictions?.length) return null;
    const ftP = predictions.find(p => p.type?.developer_name === 'FULLTIME_RESULT_PROBABILITY');
    if (!ftP?.predictions) return null;
    const { home = 33, away = 33, draw = 34 } = ftP.predictions;
    const h = Math.round(home), d = Math.round(draw), a = Math.round(away);
    const csP = predictions.find(p => p.type?.developer_name === 'CORRECT_SCORE_PROBABILITY');
    let gh = 1, ga = 0, bestScore = null;
    if (csP?.predictions?.scores) {
        let maxP = 0;
        Object.entries(csP.predictions.scores).forEach(([sc, prob]) => {
            if (typeof prob === 'number' && !sc.startsWith('Other') && prob > maxP) {
                maxP = prob; bestScore = sc;
            }
        });
        if (bestScore) [gh, ga] = bestScore.split('-').map(Number);
    }
    const code  = h >= a && h >= d ? '1' : a > h && a >= d ? '2' : 'X';
    const label = code === '1' ? 'Home Win' : code === '2' ? 'Away Win' : 'Draw';
    return { response: [{ predictions: {
        percent: { home: `${h}%`, draw: `${d}%`, away: `${a}%` },
        goals:   bestScore ? { home: gh, away: ga } : null,
        advice:  `${label} — ${h}% home / ${d}% draw / ${a}% away`,
    }}]};
}

// ─── API-Football helpers ─────────────────────────────────────────────────────
function mapApfStatus(short, elapsed, fixtureDate) {
    switch (short) {
        case '1H': case '2H': case 'ET': return elapsed ? String(elapsed) : short;
        case 'HT': case 'BT': case 'FT': case 'AET': return short;
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

function apfFixturesToFlat(fixtures) {
    const today = new Date().toISOString().split('T')[0];
    return fixtures.map(f => {
        const status = mapApfStatus(f.fixture.status.short, f.fixture.status.elapsed, f.fixture.date);
        const ht = f.score.halftime, ft = f.score.fulltime;
        return {
            id:         String(f.fixture.id),
            static_id:  String(f.fixture.id),
            date:       f.fixture.date ? f.fixture.date.split('T')[0] : today,
            time:       f.fixture.date ? (f.fixture.date.split('T')[1] || '').substring(0, 5) : '',
            status,
            leagueName: f.league.name,
            country:    f.league.country,
            home: { id: String(f.teams.home.id), name: f.teams.home.name, goals: f.goals.home != null ? String(f.goals.home) : null },
            away: { id: String(f.teams.away.id), name: f.teams.away.name, goals: f.goals.away != null ? String(f.goals.away) : null },
            ht: (ht && ht.home != null) ? { score: `[${ht.home}-${ht.away}]` } : null,
            ft: (ft && ft.home != null) ? { score: `[${ft.home}-${ft.away}]` } : null,
        };
    });
}

// ─── StatPal: status mapper ───────────────────────────────────────────────────
function mapStatpalStatus(status, matchStart) {
    if (status === undefined || status === null) return matchStart || 'NS';
    const s = String(status).trim();
    if (s === 'HT') return 'HT';
    if (s === 'FT' || s === 'Ended') return 'FT';
    if (s === 'AET' || s === 'FT_ET') return 'AET';
    if (s === 'PEN' || s === 'PENALTIES' || s === 'PEN_BREAK') return 'PEN';
    if (['POSTP','Postponed','postponed'].includes(s)) return 'Postp.';
    if (['CANC','Cancelled','cancelled'].includes(s)) return 'Canc.';
    if (['SUSP','Suspended','suspended'].includes(s)) return 'Susp.';
    if (/^\d+$/.test(s) && Number(s) > 0) return s;  // live minute e.g. "45"
    if (s === '0' || s === 'NS' || s === 'Not started' || s === '') return matchStart || 'NS';
    return matchStart || 'NS';
}

// ─── StatPal: flatten nested livescore → normalized flat matches ───────────────
function statpalToFlat(livescore) {
    if (!livescore?.league) return [];
    const leagues = Array.isArray(livescore.league) ? livescore.league : [livescore.league];
    const matches = [];
    const today = new Date().toISOString().split('T')[0];
    leagues.forEach(lg => {
        const items = Array.isArray(lg.match) ? lg.match : (lg.match ? [lg.match] : []);
        items.forEach(m => {
            const homeGoals = (m.home?.score != null && m.home.score !== '') ? String(m.home.score) : null;
            const awayGoals = (m.away?.score != null && m.away.score !== '') ? String(m.away.score) : null;
            const kickoff   = m.match_start || m.time || '';
            const status    = mapStatpalStatus(m.status, kickoff);
            const isFt      = status === 'FT' || status === 'AET';

            let htObj = null;
            if (m.ht_score && String(m.ht_score).includes('-')) {
                const [hh, ah] = String(m.ht_score).split('-');
                htObj = { score: `[${hh.trim()}-${ah.trim()}]` };
            }

            matches.push({
                id:         String(m.id || ''),
                static_id:  String(m.id || ''),
                date:       m.date || today,
                time:       kickoff,
                status,
                leagueName: lg.name || '',
                country:    typeof lg.country === 'string' ? lg.country : (lg.country?.name || ''),
                home: {
                    id:    String(m.home?.id || ''),
                    name:  m.home?.name || '',
                    goals: homeGoals,
                    logo:  m.home?.image_path || null,
                },
                away: {
                    id:    String(m.away?.id || ''),
                    name:  m.away?.name || '',
                    goals: awayGoals,
                    logo:  m.away?.image_path || null,
                },
                ht: htObj,
                ft: isFt && homeGoals !== null ? { score: `[${homeGoals}-${awayGoals}]` } : null,
            });
        });
    });
    return matches;
}

// ─── /api/scores ──────────────────────────────────────────────────────────────
//  Priority: StatPal → API-Football → Sportmonks → stale cache
app.get('/api/scores', async (req, res) => {
    if (scoresCache && (Date.now() - scoresCacheTime < SCORES_TTL)) return res.json(scoresCache);

    const smKey      = process.env.SPORTMONKS_KEY;
    const apfKey     = process.env.API_FOOTBALL_KEY;
    const statpalKey = process.env.STATPAL_API_KEY || '98e5c7b5-5b16-412c-a270-c3196e4ef98f';
    const today      = new Date().toISOString().split('T')[0];

    // 1: StatPal
    try {
        const r = await axios.get('https://statpal.io/api/v1/soccer/livescores', {
            params: { access_key: statpalKey }, timeout: 10000,
        });
        const matches = statpalToFlat(r.data?.livescore);
        if (matches.length > 0) {
            const result = { matches, source: 'statpal', updated: new Date().toISOString() };
            scoresCache = result; scoresCacheTime = Date.now();
            console.log(`StatPal: ${matches.length} matches loaded`);
            return res.json(result);
        }
        console.warn('StatPal: returned 0 matches');
    } catch (e) { console.error('StatPal failed:', e.message); }

    // 2: API-Football
    if (apfKey) {
        try {
            const r = await axios.get('https://v3.football.api-sports.io/fixtures', {
                params: { date: today }, headers: { 'x-apisports-key': apfKey }, timeout: 10000,
            });
            const body = r.data, fixtures = body.response || [];
            const hasErrors = body.errors && (Array.isArray(body.errors) ? body.errors.length > 0 : Object.keys(body.errors).length > 0);
            if (!hasErrors && fixtures.length > 0) {
                const matches = apfFixturesToFlat(fixtures);
                const result  = { matches, source: 'api-football', updated: new Date().toISOString() };
                scoresCache = result; scoresCacheTime = Date.now();
                console.log(`API-Football: ${matches.length} matches loaded`);
                return res.json(result);
            }
        } catch (e) { console.error('API-Football failed:', e.message); }
    }

    // 3: Sportmonks
    if (smKey) {
        try {
            const fixtures = await smFixturesByDate(today, smKey);
            const matches  = smFixturesToFlat(fixtures);
            if (matches.length > 0) {
                const result = { matches, source: 'sportmonks', updated: new Date().toISOString() };
                scoresCache = result; scoresCacheTime = Date.now();
                console.log(`Sportmonks: ${matches.length} matches loaded`);
                return res.json(result);
            }
            console.warn('Sportmonks: 0 fixtures for today');
        } catch (e) { console.error('Sportmonks failed:', e.message); }
    }

    if (scoresCache) { console.warn('Serving stale cache'); return res.json(scoresCache); }
    res.status(500).json({ error: 'All data sources failed', matches: [] });
});

// ─── /api/status ──────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
    const smKey  = process.env.SPORTMONKS_KEY;
    const apfKey = process.env.API_FOOTBALL_KEY;
    const result = {
        sportmonks_key_set:   !!smKey,
        api_football_key_set: !!apfKey,
        openai_key_set:       !!process.env.OPENAI_API_KEY,
        cache: null,
    };
    if (scoresCache) result.cache = {
        source:       scoresCache.source,
        match_count:  scoresCache.matches?.length,
        updated:      scoresCache.updated,
        age_seconds:  Math.round((Date.now() - scoresCacheTime) / 1000),
    };
    if (apfKey) {
        try {
            const c = await axios.get('https://v3.football.api-sports.io/status', { headers: { 'x-apisports-key': apfKey }, timeout: 8000 });
            result.api_football = c.data.response || c.data;
        } catch (e) { result.api_football = { error: e.message }; }
    }
    res.json(result);
});

// ─── /api/cache/clear ─────────────────────────────────────────────────────────
app.post('/api/cache/clear', (req, res) => {
    scoresCache = null;   scoresCacheTime = 0;
    upcomingCache = null; upcomingCacheTime = 0;
    newsCache = null;     newsCacheTime = 0;
    Object.keys(predCache).forEach(k => { delete predCache[k]; delete predCacheTs[k]; });
    console.log('All caches cleared');
    res.json({ cleared: true, timestamp: new Date().toISOString() });
});

// ─── Math fallback prediction ─────────────────────────────────────────────────
function generatePrediction(fixtureId) {
    const seed = String(fixtureId).split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 7);
    const r = n => { const x = Math.sin(seed * n + n * 13.7) * 99991; return x - Math.floor(x); };
    const hw = Math.round(40 + r(1) * 16), dw = Math.round(22 + r(2) * 8), aw = 100 - hw - dw;
    const hg = Math.min(4, Math.round(r(3) * 3.2)), ag = Math.min(3, Math.round(r(4) * 2.4));
    const best   = hw >= aw && hw >= dw ? 'home' : aw >= hw && aw >= dw ? 'away' : 'draw';
    const advice = best === 'home' ? 'Home Win Predicted' : best === 'away' ? 'Away Win Predicted' : 'Draw Predicted';
    return { response: [{ predictions: { percent: { home: `${hw}%`, draw: `${dw}%`, away: `${aw}%` }, goals: { home: hg, away: ag }, advice } }] };
}

// ─── /api/get-predictions ─────────────────────────────────────────────────────
//  Priority: Sportmonks → API-Football → OpenAI gpt-4o-mini → math fallback
app.get('/api/get-predictions', async (req, res) => {
    const { fixture: fixtureId, home, away, league, country, status, score } = req.query;
    const smKey     = process.env.SPORTMONKS_KEY;
    const apfKey    = process.env.API_FOOTBALL_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!fixtureId) return res.status(400).json({ error: 'fixture ID required' });

    const cached = predCache[fixtureId];
    if (cached && (Date.now() - predCacheTs[fixtureId] < PRED_TTL)) return res.json(cached);

    // 1. Sportmonks — only works with numeric Sportmonks IDs
    if (smKey && /^\d+$/.test(fixtureId)) {
        try {
            const r = await axios.get(`${SM}/fixtures/${fixtureId}`, {
                params: { include: 'predictions.type', api_token: smKey }, timeout: 8000,
            });
            const result = smParsePredictions(r.data?.data?.predictions);
            if (result) { predCache[fixtureId] = result; predCacheTs[fixtureId] = Date.now(); return res.json(result); }
        } catch (e) { console.warn('Sportmonks predictions failed:', e.message); }
    }

    // 2. API-Football — only works with numeric API-Football IDs
    if (apfKey && /^\d+$/.test(fixtureId)) {
        try {
            const r = await axios.get('https://v3.football.api-sports.io/predictions', {
                params: { fixture: fixtureId }, headers: { 'x-apisports-key': apfKey }, timeout: 8000,
            });
            if (r.data.response?.length > 0 && r.data.response[0]?.predictions) {
                predCache[fixtureId] = r.data; predCacheTs[fixtureId] = Date.now();
                return res.json(r.data);
            }
        } catch (e) { console.warn('API-Football predictions failed:', e.message); }
    }

    // 3. OpenAI gpt-4o-mini — always works as long as team names are provided
    if (openaiKey && home && away) {
        try {
            const openai = getOpenAI();
            const ctx = [
                league  ? `Competition: ${league}${country ? ' ('+country+')' : ''}` : null,
                status  ? `Match status: ${status}` : null,
                score   ? `Current score: ${score}` : null,
            ].filter(Boolean).join(' | ');

            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `You are an elite football prediction analyst. Use Poisson distribution methodology — like Forebet and WinDrawWin — factoring in:\n• Team attack/defense xG ratings and season averages\n• Home advantage (adds ~0.35 expected goals to home team)\n• Recent 5-match form, current injuries, squad depth\n• Head-to-head record (last 5 meetings)\n• League position, goal difference, and momentum\n\nYou MUST respond ONLY with raw JSON — no markdown fences, no extra text, nothing else:\n{"home":55,"draw":26,"away":19,"homeGoals":2,"awayGoals":1,"advice":"One sharp sentence (max 20 words) with specific insight about this fixture"}\n\nRules: home+draw+away must sum to exactly 100. All numbers must be integers.`,
                    },
                    {
                        role: 'user',
                        content: `Predict: ${home} vs ${away}${ctx ? '\n' + ctx : ''}`,
                    },
                ],
                max_tokens: 150,
                temperature: 0.25,
            });

            const raw  = completion.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
            const pred = JSON.parse(raw);
            const h    = Math.min(90, Math.max(5,  Math.round(Number(pred.home)  || 45)));
            const d    = Math.min(60, Math.max(5,  Math.round(Number
