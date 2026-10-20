
 // ===== MAGICBETTINGTIPS LIVE-SCORE REPAIR =====
 // Paste ONCE at the very bottom of your existing scraper JS file.
 // Required Railway variable: API_FOOTBALL_KEY=your_api_football_key
 // Optional: API_FOOTBALL_LIVE_MIN=15



 const LIVE_SCORE_API_KEY = (process.env.API_FOOTBALL_KEY || '').trim();
 const LIVE_SCORE_INTERVAL_MIN = Math.max(15, Number(process.env.API_FOOTBALL_LIVE_MIN) || 15);
 const LIVE_SCORE_GRACE_MS = Math.max(35, LIVE_SCORE_INTERVAL_MIN * 2 + 5) * 60 * 1000;
 const KNOWN_IN_PLAY = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
 const KNOWN_FINISHED = new Set(['FT', 'AET', 'PEN']);
 const KNOWN_NOT_STARTED = new Set(['NS', 'TBD', 'PST', 'CANC', 'ABD']);

 // Prevent unstarted fixtures being incorrectly marked live.
 const previousHasLiveSignal = hasLiveSignal;
 hasLiveSignal = function (row) {
   if (KNOWN_NOT_STARTED.has(String(row && row.statusRaw || '').toUpperCase())) return false;
   return previousHasLiveSignal(row);
 };

 // Keep genuinely live reports active between provider updates.
 const previousEffectiveStatus = effectiveStatus;
 effectiveStatus = function (date, time, state, hasLive, observedAt, rawStatus) {
   const raw = String(rawStatus || '').toUpperCase();
   if (KNOWN_IN_PLAY.has(raw) && observedAt && Date.now() - observedAt < LIVE_SCORE_GRACE_MS) {
     return 'LIVE';
   }
   return previousEffectiveStatus(date, time, state, hasLive, observedAt, rawStatus);
 };

 // Older fixture feeds must not overwrite fresh live scores.
 const previousMergeIntoCache = mergeIntoCache;
 mergeIntoCache = function (incoming) {
   const recent = new Map();
   const currentTime = Date.now();

   for (const row of incoming || []) {
     if (!row.homeTeam || !row.awayTeam) continue;

     const key = matchKey(row.homeTeam, row.awayTeam);
     const old = store.matches[key];
     const raw = String(row.statusRaw || '').toUpperCase();
     const genuinelyFinished =
       KNOWN_FINISHED.has(raw) || (!raw && row.status === 'FT');

     if (
       old &&
       old.status === 'LIVE' &&
       old.elapsedAt &&
       currentTime - old.elapsedAt < LIVE_SCORE_GRACE_MS &&
       !KNOWN_IN_PLAY.has(raw) &&
       !genuinelyFinished
     ) {
       recent.set(key, {
         homeScore: old.home && old.home.score,
         awayScore: old.away && old.away.score,
         elapsed: old.elapsed,
         elapsedAt: old.elapsedAt,
         statusRaw: old.statusRaw,
         statusLong: old.statusLong
       });
     }
   }

   const count = previousMergeIntoCache(incoming);

   for (const [key, old] of recent) {
     const item = store.matches[key];
     if (!item) continue;

     item.status = 'LIVE';
     item.home.score = old.homeScore;
     item.away.score = old.awayScore;
     item.elapsed = old.elapsed;
     item.elapsedAt = old.elapsedAt;
     item.statusRaw = old.statusRaw;
     item.statusLong = old.statusLong;
   }

   return count;
 };

 let liveScorePolling = false;

 const liveScoreHealth = {
   enabled: !!LIVE_SCORE_API_KEY,
   lastRun: null,
   lastOk: null,
   lastError: null,
   lastCount: 0
 };

 async function pollIndependentLiveScores() {
   if (!LIVE_SCORE_API_KEY || liveScorePolling) return;

   liveScorePolling = true;
   liveScoreHealth.lastRun = new Date().toISOString();

   try {
     const result = await httpRequest(
       'GET',
       'https://v3.football.api-sports.io/fixtures?live=all',
       {
         headers: {
           'x-apisports-key': LIVE_SCORE_API_KEY,
           Accept: 'application/json'
         },
         timeout: 20000
       }
     );

     if (result.status !== 200) {
       throw new Error('API-Football HTTP ' + result.status);
     }

     const payload = JSON.parse(result.text);

     if (payload.errors && Object.keys(payload.errors).length) {
       throw new Error(
         'API-Football: ' + JSON.stringify(payload.errors).slice(0, 180)
       );
     }

     if (!Array.isArray(payload.response)) {
       throw new Error('Missing fixtures response');
     }

     const matches = [];

     for (const row of payload.response) {
       const fixture = row.fixture || {};
       const home = (row.teams || {}).home || {};
       const away = (row.teams || {}).away || {};
       const raw = String(
         (fixture.status || {}).short || ''
       ).toUpperCase();

       if (!KNOWN_IN_PLAY.has(raw) || !home.name || !away.name) {
         continue;
       }

       const kickedOff = new Date(fixture.date);

       if (Number.isNaN(kickedOff.getTime())) {
         continue;
       }

       const goals = row.goals || {};

       matches.push({
         date: kickedOff.toISOString().slice(0, 10),
         time: kickedOff.toISOString().slice(11, 16),

         homeTeam: home.name,
         awayTeam: away.name,

         homeLogo: home.logo || '',
         awayLogo: away.logo || '',

         league: (row.league || {}).name || '',
         country: (row.league || {}).country || '',
         leagueLogo: (row.league || {}).logo || '',
         countryFlag: (row.league || {}).flag || '',

         score:
           goals.home != null && goals.away != null
             ? `${goals.home}-${goals.away}`
             : '',

         status: 'LIVE',
         statusRaw: raw,
         statusLong: (fixture.status || {}).long || '',
         elapsed: (fixture.status || {}).elapsed ?? null,

         hasOdds: false
       });
     }

     if (matches.length) {
       mergeIntoCache(matches);

       // Keep official live status and elapsed time.
       const polledAt = Date.now();

       for (const row of matches) {
         const item = store.matches[
           matchKey(row.homeTeam, row.awayTeam)
         ];

         if (!item) continue;

         item.status = 'LIVE';
         item.statusRaw = row.statusRaw;
         item.statusLong = row.statusLong;
         item.elapsed = row.elapsed;
         item.elapsedAt = polledAt;
       }

       saveCache();

       // Invalidate the 30-second website response cache.
       _scoresCache = { body: null, at: 0 };
     }

     liveScoreHealth.lastOk = new Date().toISOString();
     liveScoreHealth.lastError = null;
     liveScoreHealth.lastCount = matches.length;

     console.log(
       `[live-backup] ${matches.length} in-play games from API-Football`
     );
   } catch (error) {
     liveScoreHealth.lastError = String(error.message || error);
     console.error(
       '[live-backup] failed:',
       liveScoreHealth.lastError
     );
   } finally {
     liveScorePolling = false;
   }
 }

 // Independent health endpoint.
 app.get('/api/live-health', (_req, res) => {
   res.set('Cache-Control', 'no-store');
   res.json(liveScoreHealth);
 });

 // Start backup live polling.
 if (LIVE_SCORE_API_KEY) {
   setTimeout(pollIndependentLiveScores, 8000);

   setInterval(
     pollIndependentLiveScores,
     LIVE_SCORE_INTERVAL_MIN * 60000
   ).unref();
 } else {
   console.warn(
     '[live-backup] Set API_FOOTBALL_KEY in Railway Variables to enable live games'
   );
 }

 // ===== END LIVE-SCORE REPAIR =====
