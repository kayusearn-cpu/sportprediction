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

// ─── Prediction cache (TTL: 4 hours so predictions refresh each session) ──────
const predCache    = {};
const predCacheTs  = {};
const PRED_TTL     = 4 * 60 * 60 * 1000;

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

// ─── StatPal: flatten nested livescore → flat matches ─────────────────────────
function statpalToFlat(livescore) {
    if (!livescore?.league) return [];
    const leagues = Array.isArray(livescore.league) ? livescore.league : [livescore.league];
    const matches = [];
    leagues.forEach(lg => {
        const items = Array.isArray(lg.match) ? lg.match : (lg.match ? [lg.match] : []);
        items.forEach(m => matches.push({ ...m, leagueName: lg.name, country: lg.country }));
    });
    return matches;
}

// ─── /api/scores ──────────────────────────────────────────────────────────────
//  Returns: { matches: [...] }  — flat array, leagueName + country on every item
//  Priority: StatPal (broadest coverage) → API-Football → Sportmonks → stale cache
app.get('/api/scores', async (req, res) => {
    if (scoresCache && (Date.now() - scoresCacheTime < SCORES_TTL)) return res.json(scoresCache);

    const smKey      = process.env.SPORTMONKS_KEY;
    const apfKey     = process.env.API_FOOTBALL_KEY;
    const statpalKey = process.env.STATPAL_API_KEY || '98e5c7b5-5b16-412c-a270-c3196e4ef98f';
    const today      = new Date().toISOString().split('T')[0];

    // ── 1: StatPal (100+ leagues, broadest free coverage) ────────────────────
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

    // ── 2: API-Football ───────────────────────────────────────────────────────
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

    // ── 3: Sportmonks ────────────────────────────────────────────────────────
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

    // 1. Sportmonks
    if (smKey && /^\d+$/.test(fixtureId)) {
        try {
            const r = await axios.get(`${SM}/fixtures/${fixtureId}`, {
                params: { include: 'predictions.type', api_token: smKey }, timeout: 8000,
            });
            const result = smParsePredictions(r.data?.data?.predictions);
            if (result) { predCache[fixtureId] = result; predCacheTs[fixtureId] = Date.now(); return res.json(result); }
        } catch (e) { console.warn('Sportmonks predictions failed:', e.message); }
    }

    // 2. API-Football
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

    // 3. OpenAI gpt-4o-mini — intelligent Poisson-style prediction
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
                        content: `You are an elite football prediction analyst. Use Poisson distribution methodology — like Forebet and WinDrawWin — factoring in:
• Team attack/defense xG ratings and season averages
• Home advantage (adds ~0.35 expected goals to home team)
• Recent 5-match form, current injuries, squad depth
• Head-to-head record (last 5 meetings)
• League position, goal difference, and momentum

You MUST respond ONLY with raw JSON — no markdown fences, no extra text, nothing else:
{"home":55,"draw":26,"away":19,"homeGoals":2,"awayGoals":1,"advice":"One sharp sentence (max 20 words) with specific insight about this fixture"}

Rules: home+draw+away must sum to exactly 100. All numbers must be integers.`,
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
            const d    = Math.min(60, Math.max(5,  Math.round(Number(pred.draw)  || 27)));
            const a    = Math.max(5,  100 - h - d);
            const result = { response: [{ predictions: {
                percent: { home: `${h}%`, draw: `${d}%`, away: `${a}%` },
                goals:   {
                    home: Math.min(7, Math.max(0, Math.round(Number(pred.homeGoals) || 1))),
                    away: Math.min(7, Math.max(0, Math.round(Number(pred.awayGoals) || 1))),
                },
                advice: pred.advice || `${h > a ? 'Home Win' : a > h ? 'Away Win' : 'Draw'} — ${h}% / ${d}% / ${a}%`,
            }}]};
            predCache[fixtureId] = result; predCacheTs[fixtureId] = Date.now();
            return res.json(result);
        } catch (e) { console.warn('OpenAI prediction failed:', e.message); }
    }

    // 4. Math fallback
    const result = generatePrediction(fixtureId);
    predCache[fixtureId] = result; predCacheTs[fixtureId] = Date.now();
    return res.json(result);
});

// ─── Logo cache ───────────────────────────────────────────────────────────────
const logoCache = {};

app.get('/api/team-logo', async (req, res) => {
    const name = req.query.name;
    if (!name) return res.status(400).json({ logo: null });
    const key = name.toLowerCase().trim();
    if (logoCache[key] !== undefined) return res.json({ logo: logoCache[key] });
    try {
        const r = await axios.get('https://www.thesportsdb.com/api/v1/json/3/searchteams.php', {
            params: { t: name }, timeout: 5000,
        });
        const logo = r.data?.teams?.[0]?.strTeamBadge || null;
        logoCache[key] = logo; res.json({ logo });
    } catch (_) { logoCache[key] = null; res.json({ logo: null }); }
});

// ─── /api/match-analysis ──────────────────────────────────────────────────────
//  Returns a conversational, expert-level match analysis using gpt-4o-mini.
//  Reads like a knowledgeable friend explaining the game — tactical, specific, engaging.
app.get('/api/match-analysis', async (req, res) => {
    const { home, away, league, status, score, ht } = req.query;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || !home || !away) return res.json({ analysis: null });

    try {
        const openai = getOpenAI();
        const isLive    = status && !['NS','FT','AET','PEN','Postp.','Canc.','Susp.'].includes(status);
        const isFinished = ['FT','AET','PEN'].includes(status);
        const hasScore   = score && score !== 'Not started';

        const matchCtx = [
            `Match: ${home} vs ${away}`,
            league ? `Competition: ${league}` : null,
            hasScore ? `Score: ${score}` : null,
            ht && ht !== 'N/A' && ht !== '' ? `Half-time score: ${ht}` : null,
            status ? `Status: ${status}` : null,
        ].filter(Boolean).join('\n');

        const prompt = isFinished
            ? `You're a sharp football pundit giving your verdict on a match that just ended. Write 3–4 sentences in a direct, conversational tone — like you're texting a mate who missed the game. Cover what happened, who stood out, and one key moment or turning point.\n\n${matchCtx}`
            : isLive
            ? `You're a live football analyst giving real-time insight. Write 3–4 engaging sentences about how this match is unfolding, what the current score tells us about the game, and what to watch for in the remaining time. Keep it punchy and direct.\n\n${matchCtx}`
            : `You're a top football analyst giving a pre-match briefing. Write 3–4 sentences covering: which team has the tactical edge, a key player battle to watch, and your honest read on how this one plays out. Sound confident and specific — no generic filler.\n\n${matchCtx}`;

        const r = await openai.chat.completions.create({
            model:    'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a sharp, knowledgeable football analyst — think Gary Neville meets a data scientist. You know teams, tactics, form, and history. You speak directly and confidently, never vaguely. Your analysis is specific to the teams mentioned and reads like expert conversation, not a Wikipedia summary. Write in plain prose — no bullet points, no headings, no markdown.`,
                },
                { role: 'user', content: prompt },
            ],
            max_tokens:  350,
            temperature: 0.7,
        });

        res.json({ analysis: r.choices[0].message.content.trim() });
    } catch (e) {
        console.error('OpenAI match-analysis error:', e.message);
        res.json({ analysis: null });
    }
});

// ─── /api/upcoming ────────────────────────────────────────────────────────────
let upcomingCache = null, upcomingCacheTime = 0;
const UPCOMING_TTL = 5 * 60 * 1000;

app.get('/api/upcoming', async (req, res) => {
    if (upcomingCache && (Date.now() - upcomingCacheTime < UPCOMING_TTL)) return res.json(upcomingCache);

    const smKey    = process.env.SPORTMONKS_KEY;
    const fdKey    = process.env.FOOTBALL_DATA_KEY;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    // 1. Sportmonks tomorrow
    if (smKey) {
        try {
            const fixtures = await smFixturesByDate(tomorrow, smKey, 'participants;league.country;state');
            const matches  = smFixturesToFlat(fixtures);
            if (matches.length > 0) {
                upcomingCache = { matches }; upcomingCacheTime = Date.now();
                console.log(`Sportmonks upcoming: ${matches.length} matches`);
                return res.json(upcomingCache);
            }
        } catch (e) { console.error('Sportmonks upcoming failed:', e.message); }
    }

    // 2. football-data.org fallback
    if (fdKey) {
        try {
            const today = new Date().toISOString().split('T')[0];
            const r = await axios.get('https://api.football-data.org/v4/matches', {
                params: { dateFrom: today, dateTo: tomorrow },
                headers: { 'X-Auth-Token': fdKey }, timeout: 10000,
            });
            const statusMap = { IN_PLAY:'LIVE', PAUSED:'HT', FINISHED:'FT', POSTPONED:'Postp.', SUSPENDED:'Susp.', CANCELLED:'Canc.' };
            const matches = (r.data.matches || []).map(m => {
                const date = m.utcDate ? m.utcDate.split('T')[0] : today;
                const time = m.utcDate ? m.utcDate.split('T')[1].substring(0, 5) : '';
                return {
                    id: String(m.id), static_id: String(m.id), date, time,
                    status: statusMap[m.status] || time || 'NS',
                    leagueName: m.competition?.name || '', country: m.area?.name || '',
                    home: { id: String(m.homeTeam?.id || ''), name: m.homeTeam?.shortName || m.homeTeam?.name || '', goals: m.score?.fullTime?.home != null ? String(m.score.fullTime.home) : null },
                    away: { id: String(m.awayTeam?.id || ''), name: m.awayTeam?.shortName || m.awayTeam?.name || '', goals: m.score?.fullTime?.away != null ? String(m.score.fullTime.away) : null },
                    ht: null, ft: null,
                };
            });
            upcomingCache = { matches }; upcomingCacheTime = Date.now();
            console.log(`football-data.org upcoming: ${matches.length} matches`);
            return res.json(upcomingCache);
        } catch (e) { console.error('football-data.org failed:', e.message); }
    }

    return res.json(upcomingCache || { matches: [] });
});

app.listen(port, () => { console.log(`MagicBettingTips backend running on port ${port}`); });
