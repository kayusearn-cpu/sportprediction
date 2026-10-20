
 // === INDEPENDENT LIVE-SCORES BACKUP ===
 // Uses the FOOTBALL_DATA_API_KEY configured in Railway.

 const LIVE_BACKUP_KEY = (
   process.env.FOOTBALL_DATA_API_KEY || ''
 ).trim();

 const LIVE_BACKUP_MS = Math.max(
   3,
   Number(process.env.FOOTBALL_DATA_LIVE_MIN) || 5
 ) * 60000;

 const liveBackupInfo = {
   enabled: Boolean(LIVE_BACKUP_KEY),
   lastCheck: null,
   lastSuccess: null,
   matches: 0,
   error: null
 };

 let liveBackupBusy = false;

 function liveBackupName(name) {
   return String(name || '')
     .toLowerCase()
     .normalize('NFKD')
     .replace(/[\u0300-\u036f]/g, '')
     .replace(/\b(fc|afc|cf|sc|football club)\b/g, '')
     .replace(/[^a-z0-9]/g, '');
 }

 async function refreshFootballDataLive() {
   if (!LIVE_BACKUP_KEY || liveBackupBusy) return;

   liveBackupBusy = true;
   liveBackupInfo.lastCheck = new Date().toISOString();

   try {
     const response = await httpRequest(
       'GET',
       'https://api.football-data.org/v4/matches?status=LIVE',
       {
         headers: {
           'X-Auth-Token': LIVE_BACKUP_KEY,
           Accept: 'application/json'
         },
         timeout: 20000
       }
     );

     if (response.status !== 200) {
       throw new Error(
         'football-data.org HTTP ' + response.status
       );
     }

     const result = JSON.parse(response.text);

     if (!Array.isArray(result.matches)) {
       throw new Error('Invalid live fixture response');
     }

     let count = 0;

     for (const match of result.matches) {
       if (!['IN_PLAY', 'PAUSED', 'LIVE'].includes(match.status)) {
         continue;
       }

       const home = match.homeTeam || {};
       const away = match.awayTeam || {};
       const time = new Date(match.utcDate || '');

       if (
         !home.name ||
         !away.name ||
         Number.isNaN(time.getTime())
       ) {
         continue;
       }

       const date = time.toISOString().slice(0, 10);
       const hhmm = time.toISOString().slice(11, 16);
       const raw = match.status === 'PAUSED' ? 'HT' : '1H';

       const score =
         (match.score || {}).fullTime ||
         (match.score || {}).halfTime ||
         {};

       const existingKey = Object.keys(store.matches).find(key => {
         const old = store.matches[key];

         return (
           old &&
           old.date === date &&
           old.home &&
           old.away &&
           liveBackupName(old.home.name) === liveBackupName(home.name) &&
           liveBackupName(old.away.name) === liveBackupName(away.name)
         );
       });

       const existing = existingKey && store.matches[existingKey];
       const key = existingKey || matchKey(home.name, away.name);

       const homeScore = Number.isInteger(score.home)
         ? score.home
         : (existing?.home?.score ?? null);

       const awayScore = Number.isInteger(score.away)
         ? score.away
         : (existing?.away?.score ?? null);

       store.matches[key] = {
         ...(existing || {}),
         id: key,

         date: existing?.date || date,
         time: existing?.time || hhmm,

         home: {
           ...(existing?.home || {}),
           name: existing?.home?.name || home.name,
           logo: existing?.home?.logo || home.crest || '',
           score: homeScore
         },

         away: {
           ...(existing?.away || {}),
           name: existing?.away?.name || away.name,
           logo: existing?.away?.logo || away.crest || '',
           score: awayScore
         },

         leagueName:
           existing?.leagueName ||
           (match.competition || {}).name ||
           '',

         leagueId: existing?.leagueId ?? null,

         status: 'LIVE',
         statusRaw: raw,

         statusLong:
           match.status === 'PAUSED'
             ? 'Half Time'
             : 'In Play',

         elapsed: Number.isInteger(match.minute)
           ? match.minute
           : (existing?.elapsed ?? null),

         elapsedAt: Date.now(),
         lastSeenAt: Date.now()
       };

       count++;
     }

     if (count) {
       saveCache();

       if (typeof _scoresCache !== 'undefined') {
         _scoresCache = {
           body: null,
           at: 0
         };
       }
     }

     liveBackupInfo.lastSuccess = new Date().toISOString();
     liveBackupInfo.error = null;
     liveBackupInfo.matches = count;

     console.log(
       '[live-backup] football-data.org: ' +
       count +
       ' in-play matches'
     );

   } catch (error) {
     liveBackupInfo.error = error.message;

     console.error(
       '[live-backup] ' + error.message
     );

   } finally {
     liveBackupBusy = false;
   }
 }

 app.get('/api/live-backup-health', (_req, res) => {
   res.set('Cache-Control', 'no-store');
   res.json(liveBackupInfo);
 });

 if (LIVE_BACKUP_KEY) {
   setTimeout(refreshFootballDataLive, 8000);

   setInterval(
     refreshFootballDataLive,
     LIVE_BACKUP_MS
   ).unref();

 } else {
   console.warn(
     '[live-backup] FOOTBALL_DATA_API_KEY is missing'
   );
 }

 // === END INDEPENDENT LIVE-SCORES BACKUP ===
