
'use strict';

// FOREBET-ONLY FOOTBALL BACKEND
// Replace the entire contents of server.js.
// Requires your existing express and cors packages.
// Preserves existing Railway match and community data.
// No football-data.org, API-Football or PitchPredictions.

const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_FILE = process.env.CACHE_FILE || '/data/sportprediction-cache.json';
const COMMUNITY_FILE = path.join(path.dirname(CACHE_FILE), 'community.json');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_ADMIN = process.env.TELEGRAM_ADMIN_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ADMIN_USER = (process.env.ADMIN_USER || '').toLowerCase();
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';
const BROWSERLESS_HOST = process.env.BROWSERLESS_HOST || 'chrome.browserless.io';
const LIVE_FRESH = 14 * 60000;

const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(x => x.trim()).filter(Boolean);

const store = { matches: {}, preds: {} };

const community = {
  users: {},
  comments: {},
  banned: {},
  settings: { filterEnabled: true },
  secret: ''
};

const health = {
  provider: 'Forebet website HTML',
  lastRun: null,
  lastOk: null,
  lastError: null,
  sources: {}
};

const busy = new Set();

const sources = [
  {
    name: 'forebet-live',
    page: 'live',
    url: 'https://www.forebet.com/en/live-football-tips',
    minutes: 5
  },
  {
    name: 'forebet-scores',
    page: 'scores',
    url: 'https://www.forebet.com/en/livescore',
    minutes: 5
  },
  {
    name: 'forebet-today',
    page: 'today',
    url: 'https://www.forebet.com/en/football-tips-and-predictions-for-today',
    minutes: 20
  },
  {
    name: 'forebet-tomorrow',
    page: 'tomorrow',
    url: 'https://www.forebet.com/en/football-tips-and-predictions-for-tomorrow',
    minutes: 180
  },
  {
    name: 'forebet-yesterday',
    page: 'yesterday',
    url: 'https://www.forebet.com/en/football-predictions-from-yesterday',
    minutes: 360
  }
];

const isoDate = n => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const keyFor = (h, a) =>
  `${h.trim().toLowerCase()}|${a.trim().toLowerCase()}`;

const plain = s => String(s || '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/\s+/g, ' ')
  .trim();

const pick = (body, re) => {
  const m = body.match(re);
  return m ? plain(m[1]) : '';
};

function load(file, target) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (target === store && v.matches && v.preds) {
      store.matches = v.matches;
      store.preds = v.preds;
    } else if (target === community && v.users) {
      Object.assign(community, v);
    }

    console.log('[cache] loaded', file);
  } catch (e) {
    console.log('[cache] starting without', file);
  }
}

function save(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(obj));
    fs.renameSync(temp, file);
  } catch (e) {
    console.error('[cache] save failed', file, e.message);
  }
}

function request(url, options = {}, hops = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    if (u.protocol !== 'https:') {
      return reject(Error('HTTPS required'));
    }

    const req = https.request(u, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 25000
    }, res => {
      if (
        hops &&
        [301, 302, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        res.resume();
        return resolve(request(
          new URL(res.headers.location, u).href,
          options,
          hops - 1
        ));
      }

      let out = '';
      res.setEncoding('utf8');

      res.on('data', c => {
        out += c;
        if (out.length > 4e6) {
          req.destroy(Error('Oversized response'));
        }
      });

      res.on('end', () => resolve({
        status: res.statusCode,
        text: out
      }));
    });

    req.on('timeout', () =>
      req.destroy(Error('Request timeout'))
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchHtml(src) {
  let firstError;

  try {
    const r = await request(src.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ForebetReader/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (
      r.status === 200 &&
      r.text.length > 500 &&
      !/just a moment|cf_chl_|challenge-platform/i.test(
        r.text.slice(0, 5000)
      )
    ) {
      return r.text;
    }

    firstError = Error(
      'Forebet HTTP ' + r.status + ' or access challenge'
    );
  } catch (e) {
    firstError = e;
  }

  if (
    !BROWSERLESS_TOKEN ||
    process.env.FOREBET_RENDER !== 'true'
  ) {
    throw firstError;
  }

  const payload = JSON.stringify({
    url: src.url,
    gotoOptions: {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }
  });

  const r = await request(
    `https://${BROWSERLESS_HOST}/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      body: payload
    }
  );

  if (
    r.status !== 200 ||
    r.text.length < 500 ||
    /just a moment|cf_chl_/i.test(r.text.slice(0, 5000))
  ) {
    throw Error(
      'Forebet browser rendering unavailable: HTTP ' + r.status
    );
  }

  return r.text;
}

function parsePage(html, kind) {
  const chunks = html.split(
    /<div\b[^>]*class=["'][^"']*\brcnt\b[^"']*["'][^>]*>/i
  ).slice(1);

  const data = [];
  const seen = new Set();

  const fallback = isoDate(
    kind === 'tomorrow' ? 1 :
    kind === 'yesterday' ? -1 : 0
  );

  for (const chunk of chunks) {
    const meta =
      pick(chunk, /itemprop=["']name["']\s+content=["']([^"']+)["']/i) ||
      pick(chunk, /content=["']([^"']+)["']\s+itemprop=["']name["']/i);

    const pair = meta.split(/\s+vs\.?\s+/i);

    const home =
      pick(chunk, /class=["'][^"']*\bhomeTeam\b[^"']*["'][^>]*>\s*(?:<span[^>]*>)?([^<]+)/i) ||
      (pair.length === 2 ? pair[0] : '');

    const away =
      pick(chunk, /class=["'][^"']*\bawayTeam\b[^"']*["'][^>]*>\s*(?:<span[^>]*>)?([^<]+)/i) ||
      (pair.length === 2 ? pair[1] : '');

    if (
      !home || !away ||
      home === away ||
      home.length > 100 ||
      away.length > 100
    ) continue;

    let date = fallback;
    let time = '';

    const dt = (
      pick(chunk, /class=["'][^"']*\bdate_bah\b[^"']*["'][^>]*>([\s\S]*?)<\//i) ||
      plain(chunk.slice(0, 1300))
    ).match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})\s+(\d{1,2}):(\d{2})/);

    const iso = pick(
      chunk,
      /<time[^>]*datetime=["']([^"']+)["']/i
    );

    if (dt) {
      date = `${dt[3]}-${dt[2].padStart(2, '0')}-${dt[1].padStart(2, '0')}`;
      time = `${dt[4].padStart(2, '0')}:${dt[5]}`;
    } else if (iso && !isNaN(Date.parse(iso))) {
      date = new Date(iso).toISOString().slice(0, 10);
      time = new Date(iso).toISOString().slice(11, 16);
    }

    const probArea = chunk.match(
      /class=["'][^"']*\bfprc\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );

    const nums = probArea ?
      [...probArea[1].matchAll(
        /<span[^>]*>\s*(\d{1,3})\s*<\/span>/gi
      )].map(m => Number(m[1])) : [];

    const probs =
      nums.length >= 3 &&
      nums.slice(0, 3).reduce((a, b) => a + b, 0) >= 90 &&
      nums.slice(0, 3).reduce((a, b) => a + b, 0) <= 110
        ? nums.slice(0, 3) : [];

    const p = pick(
      chunk,
      /class=["'][^"']*\bforepr\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    ).match(/(?:^|\s)(1|X|2)(?=\s|$)/i);

    const forecast = pick(
      chunk,
      /class=["'][^"']*\bex_sc\b[^"']*["'][^>]*>([^<]+)/i
    ).match(/(\d+)\s*[-:]\s*(\d+)/);

    const score = pick(
      chunk,
      /class=["'][^"']*\b(?:l_scr|lscr_td)\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    ).match(/(\d+)\s*[-:]\s*(\d+)/);

    const state = pick(
      chunk,
      /class=["'][^"']*\b(?:lmin_td|lmin)\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    ).toUpperCase();

    let raw = 'NS';
    let minute = null;

    if (/\b(FT|AET|PEN|FULL TIME)\b/.test(state)) {
      raw = 'FT';
    } else if (/\bHT\b/.test(state)) {
      raw = 'HT';
      minute = 45;
    } else if (/\b(1H|2H|ET|LIVE)\b/.test(state)) {
      raw = state.match(/\b(1H|2H|ET|LIVE)\b/)[1];
    } else {
      const m = state.match(/\b(\d{1,3})\s*['’]/);
      if (m) {
        minute = +m[1];
        raw = minute > 45 ? '2H' : '1H';
      }
    }

    const status =
      raw === 'FT' ? 'FT' :
      raw === 'NS' ? 'NS' : 'LIVE';

    const stag = chunk.match(
      /getstag\(this,\s*\d+,\s*'([^']*)',\s*'([^']*)'/
    );

    const id = `${date}|${keyFor(home, away)}`;
    if (seen.has(id)) continue;
    seen.add(id);

    data.push({
      homeTeam: home,
      awayTeam: away,
      date,
      time,
      league: stag ? plain(stag[2]) : '',
      country: stag ? plain(stag[1]) : '',
      status,
      statusRaw: raw,
      elapsed: minute,
      score: score ? `${score[1]}-${score[2]}` : '',
      prediction: p ? p[1].toUpperCase() : '',
      correctScore: forecast ?
        `${forecast[1]}-${forecast[2]}` : '',
      probHome: probs[0] ?? null,
      probDraw: probs[1] ?? null,
      probAway: probs[2] ?? null
    });
  }

  return data;
}

function update(rows) {
  let changed = 0;
  const now = Date.now();

  for (const x of rows) {
    const key = keyFor(x.homeTeam, x.awayTeam);
    const old = store.matches[key] || {};
    const prev = store.preds[key] || {};

    if (
      x.status === 'NS' &&
      old.date === x.date &&
      (
        old.status === 'FT' ||
        (
          old.status === 'LIVE' &&
          now - (old.elapsedAt || 0) < LIVE_FRESH
        )
      )
    ) continue;

    const found = x.score.match(/(\d+)\s*-\s*(\d+)/);
    const h = found ? +found[1] : null;
    const a = found ? +found[2] : null;

    const hs = h ??
      (old.date === x.date ? old.home?.score : null) ??
      null;

    const as = a ??
      (old.date === x.date ? old.away?.score : null) ??
      null;

    store.matches[key] = {
      ...old,
      id: key,
      date: x.date,
      time: x.time || old.time || '',
      home: {
        ...old.home,
        name: x.homeTeam,
        score: hs
      },
      away: {
        ...old.away,
        name: x.awayTeam,
        score: as
      },
      leagueName: x.league || old.leagueName || '',
      country: x.country || old.country || '',
      status: x.status,
      statusRaw: x.statusRaw,
      elapsed: x.elapsed,
      elapsedAt: x.status === 'LIVE' ? now : null,
      prediction: x.prediction || old.prediction || '',
      correctScore: x.correctScore || old.correctScore || '',
      lastSeenAt: now,
      dataSource: 'forebet'
    };

    store.preds[key] = {
      h: x.probHome ?? prev.h ?? 0,
      d: x.probDraw ?? prev.d ?? 0,
      a: x.probAway ?? prev.a ?? 0,
      score: x.correctScore || prev.score || '',
      confidence: Math.round(
        Math.max(
          x.probHome ?? 0,
          x.probDraw ?? 0,
          x.probAway ?? 0
        ) / 10
      ) / 10,
      sources: ['forebet'],
      aiUsed: false
    };

    changed++;
  }

  const cutoff = Date.now() - 60 * 86400000;

  for (const [key, m] of Object.entries(store.matches)) {
    if (
      m.date &&
      Date.parse(m.date + 'T23:59:00Z') < cutoff
    ) {
      delete store.matches[key];
      delete store.preds[key];
    }
  }

  return changed;
}

async function scrape(src, reason = 'scheduler') {
  if (busy.has(src.name)) return { skipped: true };

  busy.add(src.name);

  const st = health.sources[src.name] || {};
  health.sources[src.name] = st;
  st.lastRun = new Date().toISOString();
  health.lastRun = st.lastRun;

  try {
    const html = await fetchHtml(src);
    const rows = parsePage(html, src.page);

    if (rows.length === 0) {
      throw Error(
        'No recognizable match rows. Cache preserved.'
      );
    }

    const count = update(rows);

    save(CACHE_FILE, store);

    st.lastOk = health.lastOk = new Date().toISOString();
    st.count = rows.length;
    st.error = null;
    health.lastError = null;
    scoreCache = null;

    console.log(
      `[forebet ${src.page}] ${rows.length} rows, ${count} merged`
    );

    return {
      rows: rows.length,
      merged: count
    };
  } catch (e) {
    st.error = e.message;
    health.lastError = src.name + ': ' + e.message;

    console.error(
      `[forebet ${src.page}] ${e.message}`
    );

    return { error: e.message };
  } finally {
    busy.delete(src.name);
  }
}

async function scrapeAll() {
  const out = {};

  for (const src of sources) {
    out[src.name] = await scrape(src, 'manual');
  }

  return out;
}

function originOk(url) {
  if (!allowed.length) return true;

  try {
    const host = new URL(url).hostname;

    return allowed.some(x => {
      try {
        const h = new URL(x).hostname;
        return host === h || host.endsWith('.' + h);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

app.use(cors({ origin: true }));
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  next();
});

const guard = (req, res, next) => {
  const origin = req.headers.origin;

  if (
    !origin ||
    origin === 'null' ||
    originOk(origin) ||
    originOk(req.headers.referer || '')
  ) return next();

  return res.status(403).json({
    error: 'forbidden origin'
  });
};

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'prediction-scraper',
    matches: Object.keys(store.matches).length
  });
});

app.get('/api/forebet-health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(health);
});

let scoreCache = null;
const bootAt = new Date().toISOString();

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    ok: !!health.lastOk,
    matches: Object.keys(store.matches).length,
    lastRun: health.lastRun,
    lastOk: health.lastOk,
    lastError: health.lastError,
    bootAt,
    cadence: {
      live: 5,
      future: 180,
      past: 360
    },
    sources: sources.map(s => ({
      ...s,
      ...health.sources[s.name]
    }))
  });
});

app.get('/api/scores', guard, (_req, res) => {
  res.set('Cache-Control', 'public,max-age=30');
  res.type('json');

  if (
    scoreCache &&
    Date.now() - scoreCache.at < 30000
  ) {
    return res.send(scoreCache.body);
  }

  const lo = isoDate(-6);
  const hi = isoDate(11);
  const matches = [];

  for (const [key, m] of Object.entries(store.matches)) {
    if (
      m.status !== 'LIVE' &&
      (m.date < lo || m.date > hi)
    ) continue;

    const p = store.preds[key];

    matches.push({
      ...m,
      probabilities: p ? {
        home: p.h + '%',
        draw: p.d + '%',
        away: p.a + '%'
      } : null,
      tip: m.prediction
        ? m.prediction +
          (m.correctScore ? ' (' + m.correctScore + ')' : '')
        : ''
    });
  }

  const body = JSON.stringify({
    serverTime: new Date().toISOString(),
    updatedAt: health.lastOk,
    count: matches.length,
    matches
  });

  scoreCache = {
    body,
    at: Date.now()
  };

  res.send(body);
});

app.get('/scrape-now', async (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }

  res.json(await scrapeAll());
});

app.get('/scrape-now/:source', async (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const s = sources.find(
    x => x.name === req.params.source
  );

  if (!s) {
    return res.status(404).json({
      error: 'unknown source'
    });
  }

  res.json(await scrape(s, 'manual'));
});

// FOREBET STANDINGS

const leaguePaths = {
  39: 'england/premier-league',
  40: 'england/championship',
  140: 'spain/primera-division',
  135: 'italy/serie-a',
  78: 'germany/bundesliga',
  61: 'france/ligue1',
  94: 'portugal/liga-portugal',
  88: 'netherlands/eredivisie',
  203: 'turkey/super-lig',
  253: 'usa/mls'
};

const standingsCache = new Map();

const leagueFromName = name => {
  const x = String(name || '').toLowerCase();

  if (/premier league/.test(x)) return 39;
  if (/serie a/.test(x)) return 135;
  if (/bundesliga/.test(x)) return 78;
  if (/la ?liga|primera division/.test(x)) return 140;
  if (/ligue 1/.test(x)) return 61;
  if (/eredivisie/.test(x)) return 88;
  if (/super lig|süper lig/.test(x)) return 203;

  return null;
};

async function scrapeStandings(leagueId) {
  const key = String(leagueId);

  if (!leaguePaths[key]) return null;

  const found = standingsCache.get(key);

  if (
    found &&
    Date.now() - found.at < 180 * 60000
  ) {
    return found.data;
  }

  const src = {
    url: `https://www.forebet.com/en/football-tips-and-predictions-for-${leaguePaths[key]}`
  };

  let data = null;

  try {
    const html = await fetchHtml(src);

    const table = (
      html.match(
        /<table[^>]*id=["']standings["'][^>]*>([\s\S]*?)<\/table>/i
      ) || []
    )[1];

    if (table) {
      data = [];

      for (const m of table.matchAll(
        /<tr[^>]*>([\s\S]*?)<\/tr>/gi
      )) {
        const row = m[1];

        const name = pick(
          row,
          /<a[^>]*href=["'][^"']*\/en\/teams\/[^"']+["'][^>]*>([^<]+)<\/a>/i
        );

        const nums = [
          ...row.matchAll(
            /<td[^>]*align=["']center["'][^>]*>\s*(?:<b>)?\s*(-?\d+)/gi
          )
        ].map(x => +x[1]);

        if (name && nums.length >= 6) {
          data.push({
            rank: data.length + 1,
            teamName: name,
            points: nums[0],
            played: nums[1],
            win: nums[2],
            draw: nums[3],
            lose: nums[4],
            gd: nums[5]
          });
        }
      }

      if (!data.length) data = null;
    }
  } catch (e) {
    console.warn('[standings]', e.message);
  }

  standingsCache.set(key, {
    data,
    at: Date.now()
  });

  return data;
}

const teamEq = (a, b) =>
  String(a || '').trim().toLowerCase() ===
  String(b || '').trim().toLowerCase();

function histories(home, away, limit, exclude) {
  const recent = [];
  const h2h = [];

  for (const [key, m] of Object.entries(store.matches)) {
    if (
      key === exclude ||
      m.status !== 'FT' ||
      m.home?.score == null ||
      m.away?.score == null
    ) continue;

    const isHome =
      teamEq(m.home.name, home) ||
      teamEq(m.away.name, home);

    const isAway =
      teamEq(m.home.name, away) ||
      teamEq(m.away.name, away);

    if (!isHome && !isAway) continue;

    const kickoffMs = Date.parse(
      `${m.date}T${m.time || '00:00'}:00Z`
    ) || 0;

    const mk = team => {
      const homeSide = teamEq(team, m.home.name);
      const mine = homeSide ?
        m.home.score : m.away.score;
      const theirs = homeSide ?
        m.away.score : m.home.score;

      return {
        date: m.date,
        time: m.time,
        kickoffMs,
        opponent: homeSide ?
          m.away.name : m.home.name,
        isHome: homeSide,
        competition: m.leagueName || '',
        competitionLogo: m.leagueLogo || '',
        score: `${m.home.score}-${m.away.score}`,
        myScore: mine,
        theirScore: theirs,
        result: mine > theirs ? 'W' :
          mine < theirs ? 'L' : 'D'
      };
    };

    if (isHome) {
      recent.push({
        team: 'home',
        ...mk(home)
      });
    }

    if (isAway) {
      recent.push({
        team: 'away',
        ...mk(away)
      });
    }

    if (isHome && isAway) {
      const hr = teamEq(m.home.name, home) ?
        m.home.score : m.away.score;
      const ar = teamEq(m.home.name, home) ?
        m.away.score : m.home.score;

      h2h.push({
        date: m.date,
        time: m.time,
        kickoffMs,
        competition: m.leagueName || '',
        homeName: home,
        awayName: away,
        score: `${hr}-${ar}`,
        winner: hr > ar ? 'home' :
          hr < ar ? 'away' : 'draw',
        totalGoals: hr + ar
      });
    }
  }

  const sort = items =>
    items.sort((a, b) => b.kickoffMs - a.kickoffMs)
      .slice(0, limit);

  return {
    home: sort(recent.filter(x => x.team === 'home')),
    away: sort(recent.filter(x => x.team === 'away')),
    h2h: sort(h2h)
  };
}

app.get('/api/match/:id/details', guard, async (req, res) => {
  const id = req.params.id;

  if (id.length > 200 || /[<>]/.test(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const m = store.matches[id];

  if (!m) {
    return res.status(404).json({
      error: 'match not found'
    });
  }

  const lg = m.leagueId || leagueFromName(m.leagueName);
  let table = null;

  try {
    const rows = lg ? await scrapeStandings(lg) : null;

    if (rows) {
      table = [
        rows.map(r => ({
          rank: r.rank,
          teamName: r.teamName,
          teamId: null,
          teamLogo: '',
          group: '',
          played: r.played,
          win: r.win,
          draw: r.draw,
          lose: r.lose,
          gd: r.gd,
          gf: null,
          ga: null,
          points: r.points,
          form: '',
          description: '',
          isHomeTeam: teamEq(r.teamName, m.home.name),
          isAwayTeam: teamEq(r.teamName, m.away.name)
        }))
      ];
    }
  } catch (e) {
    console.warn('[details standings]', e.message);
  }

  const lim = Math.max(
    1,
    Math.min(20, Number(req.query.limit) || 10)
  );

  const hh = histories(
    m.home.name, m.away.name, lim, id
  );

  const wins = hh.h2h.filter(
    x => x.winner === 'home'
  ).length;

  const loses = hh.h2h.filter(
    x => x.winner === 'away'
  ).length;

  const total = hh.h2h.reduce(
    (n, x) => n + x.totalGoals, 0
  );

  const p = store.preds[id];

  res.json({
    id,
    match: m,
    home: {
      name: m.home.name,
      logo: m.home.logo,
      id: m.home.id,
      lastMatches: hh.home,
      form: null
    },
    away: {
      name: m.away.name,
      logo: m.away.logo,
      id: m.away.id,
      lastMatches: hh.away,
      form: null
    },
    h2h: {
      matches: hh.h2h,
      stats: {
        played: hh.h2h.length,
        homeWins: wins,
        awayWins: loses,
        draws: hh.h2h.length - wins - loses,
        totalGoals: total,
        avgGoals: hh.h2h.length ?
          Math.round(total / hh.h2h.length * 100) / 100 : 0
      }
    },
    predictions: {
      probabilities: p ? {
        home: p.h,
        draw: p.d,
        away: p.a
      } : null,
      btts: m.bttsPct == null ? null : {
        prediction: m.bttsPred,
        probability: m.bttsPct
      },
      ou25: m.ouPct == null ? null : {
        prediction: m.ouPred,
        probability: m.ouPct
      },
      doubleChance: m.dcPct == null ? null : {
        type: m.dcType,
        probability: m.dcPct
      },
      halfTime: m.htProbHome == null ? null : {
        home: m.htProbHome,
        draw: m.htProbDraw,
        away: m.htProbAway
      },
      avgGoals: m.avgGoals,
      recommendation: m.recommendation || ''
    },
    standings: table,
    commentCount: (community.comments[id] || []).length,
    historyDays: 60,
    cacheStats: {
      totalMatches: Object.keys(store.matches).length,
      totalFinished: Object.values(store.matches)
        .filter(x => x.status === 'FT').length
    },
    externalSource: null,
    note: hh.home.length + hh.away.length + hh.h2h.length ?
      '' : 'No local history available'
  });
});

// FOOTBALL NEWS

const news = { at: 0, items: [] };

const rss = [
  {
    label: 'BBC Sport',
    url: 'https://feeds.bbci.co.uk/sport/football/rss.xml'
  },
  {
    label: 'The Guardian',
    url: 'https://www.theguardian.com/football/rss'
  }
];

async function refreshNews() {
  const items = [];

  for (const s of rss) {
    try {
      const r = await request(
        s.url,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
        3
      );

      if (r.status !== 200) continue;

      for (const match of r.text.matchAll(
        /<item>([\s\S]*?)<\/item>/g
      )) {
        const body = match[1];

        const get = tag => plain((
          body.match(
            new RegExp(
              '<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>',
              'i'
            )
          ) || []
        )[1] || '');

        const title = get('title');

        if (title) {
          items.push({
            title,
            summary: get('description').slice(0, 220),
            link: get('link'),
            source: s.label,
            image: '',
            publishedAt: get('pubDate') || null
          });
        }
      }
    } catch (e) {
      console.error('[news]', e.message);
    }
  }

  if (items.length) {
    news.at = Date.now();
    news.items = items.slice(0, 12);
  }
}

app.get('/api/news', guard, (_req, res) => {
  res.json({
    items: news.items,
    updatedAt: news.at ?
      new Date(news.at).toISOString() : null
  });
});

// COMMUNITY AUTHENTICATION

const userRe = /^[a-zA-Z0-9_]{3,20}$/;

const blockedText =
  /(https?:\/\/|www\.|t\.me\/|wa\.me\/|@[a-z0-9_]{3,})/i;

const profanity =
  /\b(fuck|shit|bitch|scam|fraud)\b/i;

const hash = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');

const eq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));

  return x.length === y.length &&
    crypto.timingSafeEqual(x, y);
};

function tokenFor(name) {
  const payload = `${name}.${Date.now() + 30 * 86400000}`;

  const sig = crypto.createHmac(
    'sha256',
    community.secret
  ).update(payload).digest('hex').slice(0, 32);

  return Buffer.from(payload).toString('base64url') +
    '.' + sig;
}

function who(req) {
  try {
    const t =
      (req.headers.authorization || '').replace(/^Bearer /, '') ||
      (req.body || {}).token ||
      '';

    const parts = t.split('.');
    if (parts.length !== 2) return null;

    const payload = Buffer.from(
      parts[0],
      'base64url'
    ).toString();

    const sig = crypto.createHmac(
      'sha256',
      community.secret
    ).update(payload).digest('hex').slice(0, 32);

    if (!eq(sig, parts[1])) return null;

    const i = payload.lastIndexOf('.');
    const name = payload.slice(0, i);
    const expiry = +payload.slice(i + 1);

    return (
      expiry > Date.now() &&
      community.users[name] &&
      !community.banned[name]
    ) ? name : null;
  } catch {
    return null;
  }
}

const isAdmin = name =>
  !!name && !!ADMIN_USER && name === ADMIN_USER;

function commentOut(c, name) {
  return {
    ...c,
    mine: !!name && c.user.toLowerCase() === name,
    canModerate: isAdmin(name)
  };
}

app.post('/api/auth/signup', guard, (req, res) => {
  const name = String(req.body?.username || '').trim();
  const pw = String(req.body?.password || '');
  const key = name.toLowerCase();

  if (!userRe.test(name) || pw.length < 6) {
    return res.status(400).json({
      error: 'Username 3-20 characters; password at least 6.'
    });
  }

  if (community.users[key]) {
    return res.status(409).json({
      error: 'Username taken'
    });
  }

  const salt = crypto.randomBytes(16).toString('hex');

  community.users[key] = {
    username: name,
    salt,
    hash: hash(pw, salt),
    at: Date.now()
  };

  save(COMMUNITY_FILE, community);

  res.json({
    token: tokenFor(key),
    username: name,
    isAdmin: isAdmin(key)
  });
});

app.post('/api/auth/login', guard, (req, res) => {
  const name = String(
    req.body?.username || ''
  ).trim().toLowerCase();

  const u = community.users[name];

  if (
    !u ||
    !eq(
      u.hash,
      hash(String(req.body?.password || ''), u.salt)
    )
  ) {
    return res.status(401).json({
      error: 'Wrong username or password'
    });
  }

  if (community.banned[name]) {
    return res.status(403).json({
      error: 'Account banned'
    });
  }

  res.json({
    token: tokenFor(name),
    username: u.username,
    isAdmin: isAdmin(name)
  });
});

app.get('/api/auth/me', (req, res) => {
  const name = who(req);

  if (!name) {
    return res.status(401).json({
      error: 'not signed in'
    });
  }

  res.json({
    username: community.users[name].username,
    isAdmin: isAdmin(name),
    filterEnabled: !!community.settings.filterEnabled
  });
});

// COMMENTS

const lastPost = new Map();

app.get('/api/matches/:id/comments', guard, (req, res) => {
  const name = who(req);

  res.json({
    comments: (community.comments[req.params.id] || [])
      .filter(c =>
        !community.banned[c.user.toLowerCase()]
      )
      .slice(-200)
      .map(c => commentOut(c, name)),
    canComment: !!name,
    isAdmin: isAdmin(name),
    filterEnabled: !!community.settings.filterEnabled
  });
});

app.post('/api/matches/:id/comments', guard, (req, res) => {
  const name = who(req);
  const id = req.params.id;

  if (!name) {
    return res.status(401).json({
      error: 'Sign in first'
    });
  }

  if (!store.matches[id]) {
    return res.status(404).json({
      error: 'Match not found'
    });
  }

  const msg = String(req.body?.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  if (
    !msg ||
    blockedText.test(msg) ||
    (
      community.settings.filterEnabled &&
      profanity.test(msg)
    )
  ) {
    return res.status(400).json({
      error: 'Message rejected'
    });
  }

  if (Date.now() - (lastPost.get(name) || 0) < 4000) {
    return res.status(429).json({
      error: 'Wait before posting again'
    });
  }

  lastPost.set(name, Date.now());

  const c = {
    id: crypto.randomBytes(8).toString('hex'),
    user: community.users[name].username,
    text: msg,
    at: Date.now(),
    edited: false
  };

  (community.comments[id] ??= []).push(c);
  community.comments[id] =
    community.comments[id].slice(-500);

  save(COMMUNITY_FILE, community);

  res.json({
    comment: commentOut(c, name)
  });
});

app.patch('/api/matches/:id/comments/:cid', guard, (req, res) => {
  const name = who(req);

  if (!name) {
    return res.status(401).json({
      error: 'Sign in first'
    });
  }

  const c = (
    community.comments[req.params.id] || []
  ).find(x => x.id === req.params.cid);

  if (!c) {
    return res.status(404).json({
      error: 'Comment not found'
    });
  }

  if (c.user.toLowerCase() !== name) {
    return res.status(403).json({
      error: 'Forbidden'
    });
  }

  const msg = String(req.body?.text || '')
    .trim()
    .slice(0, 300);

  if (
    !msg ||
    blockedText.test(msg) ||
    (
      community.settings.filterEnabled &&
      profanity.test(msg)
    )
  ) {
    return res.status(400).json({
      error: 'Message rejected'
    });
  }

  c.text = msg;
  c.edited = true;

  save(COMMUNITY_FILE, community);

  res.json({
    comment: commentOut(c, name)
  });
});

app.delete('/api/matches/:id/comments/:cid', guard, (req, res) => {
  const name = who(req);
  const list = community.comments[req.params.id] || [];
  const idx = list.findIndex(
    c => c.id === req.params.cid
  );

  if (!name) {
    return res.status(401).json({
      error: 'Sign in first'
    });
  }

  if (idx < 0) {
    return res.status(404).json({
      error: 'Not found'
    });
  }

  if (
    list[idx].user.toLowerCase() !== name &&
    !isAdmin(name)
  ) {
    return res.status(403).json({
      error: 'Forbidden'
    });
  }

  list.splice(idx, 1);
  save(COMMUNITY_FILE, community);

  res.json({ ok: true });
});

// ADMIN MODERATION

app.post('/api/admin/ban', guard, (req, res) => {
  const name = who(req);
  const target = String(
    req.body?.username || ''
  ).toLowerCase();

  if (!isAdmin(name)) {
    return res.status(403).json({
      error: 'Admin only'
    });
  }

  if (!target || target === ADMIN_USER) {
    return res.status(400).json({
      error: 'Invalid target'
    });
  }

  community.banned[target] = true;
  save(COMMUNITY_FILE, community);

  res.json({
    ok: true,
    banned: target
  });
});

app.post('/api/admin/unban', guard, (req, res) => {
  if (!isAdmin(who(req))) {
    return res.status(403).json({
      error: 'Admin only'
    });
  }

  const target = String(
    req.body?.username || ''
  ).toLowerCase();

  delete community.banned[target];
  save(COMMUNITY_FILE, community);

  res.json({
    ok: true,
    unbanned: target
  });
});

app.post('/api/admin/filter', guard, (req, res) => {
  if (!isAdmin(who(req))) {
    return res.status(403).json({
      error: 'Admin only'
    });
  }

  community.settings.filterEnabled =
    !!req.body?.enabled;

  save(COMMUNITY_FILE, community);

  res.json({
    ok: true,
    filterEnabled: community.settings.filterEnabled
  });
});

// OPTIONAL TELEGRAM ADMIN CONTROL

let tgOffset = 0;

async function tgSend(chatId, text) {
  if (!TOKEN) return;

  const u = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  const body = JSON.stringify({
    chat_id: chatId,
    text
  });

  try {
    await request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body
    });
  } catch (e) {
    console.warn('[tg]', e.message);
  }
}

async function pollTg() {
  try {
    const r = await request(
      `https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=20&offset=${tgOffset}`
    );

    const j = JSON.parse(r.text);

    if (j.ok) {
      for (const u of j.result) {
        tgOffset = u.update_id + 1;

        const m = u.message;

        if (
          !m?.text ||
          (
            TG_ADMIN &&
            String(m.from?.id) !== String(TG_ADMIN)
          )
        ) continue;

        const command = m.text.trim().toLowerCase();

        if (command === '/status') {
          tgSend(
            m.chat.id,
            `Forebet: ${Object.keys(store.matches).length} matches; ${health.lastError || 'OK'}`
          );
        } else if (command === '/scrape') {
          tgSend(m.chat.id, 'Refreshing Forebet...');

          scrapeAll().then(() =>
            tgSend(m.chat.id, 'Scrape completed')
          );
        } else if (command === '/start') {
          tgSend(m.chat.id, 'Commands: /status /scrape');
        }
      }
    }
  } catch (e) {
    console.warn('[tg]', e.message);
  }

  setTimeout(pollTg, 1000);
}

// STARTUP

load(CACHE_FILE, store);
load(COMMUNITY_FILE, community);

if (!community.secret) {
  community.secret = crypto.randomBytes(32).toString('hex');
  save(COMMUNITY_FILE, community);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Forebet-only backend running on :${PORT}`);

  sources.forEach((src, i) => {
    setTimeout(() => {
      scrape(src, 'boot');

      setInterval(
        () => scrape(src),
        src.minutes * 60000
      ).unref();
    }, 2000 + i * 15000);
  });

  refreshNews();

  setInterval(
    refreshNews,
    180 * 60000
  ).unref();

  if (TOKEN && TG_ADMIN) {
    pollTg();
  }
});
