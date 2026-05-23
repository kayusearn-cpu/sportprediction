bot.hears(/🔄 Sync API: (Today|Tomorrow)/, async (ctx) => {
    if (!checkAdmin(ctx)) return;
    if (!db) return ctx.reply('❌ Database not connected.');

    const day = ctx.match[1];
    ctx.reply(`⏳ Fetching ${day}'s matches from football‑data.org...`);

    const now = new Date();
    let dateFrom = new Date(now);
    let dateTo = new Date(now);

    if (day === 'Today') {
        // Search from today UTC to tomorrow UTC (covers edge cases)
        dateTo.setDate(dateTo.getDate() + 1);
    } else {
        dateFrom.setDate(dateFrom.getDate() + 1);
        dateTo.setDate(dateTo.getDate() + 2);
    }

    const dateFromStr = dateFrom.toISOString().split('T')[0];
    const dateToStr = dateTo.toISOString().split('T')[0];

    try {
        let data = await fetchFromFootballData('matches', { dateFrom: dateFromStr, dateTo: dateToStr });
        if (!data) {
            ctx.reply('🔄 First attempt failed, retrying...');
            await new Promise(r => setTimeout(r, 2000));
            data = await fetchFromFootballData('matches', { dateFrom: dateFromStr, dateTo: dateToStr });
        }
        if (!data) return ctx.reply('❌ Failed to fetch from football‑data.org. Check key or rate limits.');

        // Filter matches that actually belong to the target day (using match's utcDate)
        const targetDayStr = (day === 'Today' ? now : new Date(now.getTime() + 86400000)).toISOString().split('T')[0];
        const matchesForTargetDay = data.matches.filter(m => {
            const matchDate = m.utcDate ? new Date(m.utcDate).toISOString().split('T')[0] : null;
            return matchDate === targetDayStr;
        });

        if (matchesForTargetDay.length === 0) {
            // Fallback: if no exact matches, still show all matches from the window
            if (data.matches.length > 0) {
                ctx.reply(`⚠️ No matches exactly for ${day} (UTC), but found ${data.matches.length} in the search window. Using all.`);
                return saveMatches(ctx, data.matches);
            }
            return ctx.reply(`❌ No matches found for ${day}. Try a different date or check your API key coverage.`);
        }

        return saveMatches(ctx, matchesForTargetDay);

    } catch(e) {
        ctx.reply(`❌ API Error: ${e.message}`);
    }
});

// Helper to save matches (reuse existing logic)
async function saveMatches(ctx, fdMatches) {
    const matchesToSave = fdMatches.map(m => convertMatch(m));
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
    const snap = await getDoc(docRef);
    let currentData = snap.exists() ? snap.data() : { matches: [] };

    matchesToSave.forEach(newM => {
        const idx = currentData.matches.findIndex(em => 
            em.home.name === newM.home.name && em.away.name === newM.away.name
        );
        if (idx !== -1) {
            newM.manual_prediction = currentData.matches[idx].manual_prediction || '';
            currentData.matches[idx] = newM;
        } else {
            currentData.matches.unshift(newM);
        }
    });
    
    const cleanData = JSON.parse(JSON.stringify({ matches: currentData.matches.slice(0, 60) }));
    await setDoc(docRef, cleanData);
    ctx.reply(`✅ Synced ${matchesToSave.length} matches for the requested day.`);
    if (isAutoLiveOn) syncLiveScores();
}
