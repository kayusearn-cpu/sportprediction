bot.on('text', async (ctx, next) => {  // ← ADD next
    const session = userSession[ctx.from.id];

    // 1) Manual editing flow
    if (session && session.editing) {
        const val = ctx.message.text;
        if (!db) return ctx.reply('❌ Database not connected.');

        try {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'livescores', 'current');
            const snap = await getDoc(docRef);
            let data = snap.data();
            const idx = data.matches.findIndex(m => m.id === session.matchId);
            if (idx !== -1) {
                if (session.editing === 'score') {
                    const s = val.split('-');
                    data.matches[idx].home.goals = s[0]?.trim();
                    data.matches[idx].away.goals = s[1]?.trim();
                } else if (session.editing === 'pred') {
                    data.matches[idx].manual_prediction = val;
                } else if (session.editing === 'min') {
                    data.matches[idx].playing_time = val;
                    if (val === 'FT') data.matches[idx].status = 'Past';
                    else if (!isNaN(parseInt(val)) || val === 'HT') data.matches[idx].status = 'Live';
                } else if (session.editing === 'dt') {
                    data.matches[idx].date = val.split(' ')[0];
                    data.matches[idx].time = val.split(' ')[1] || "";
                }
                
                const cleanData = JSON.parse(JSON.stringify(data));
                await setDoc(docRef, cleanData);
                ctx.reply('✅ Site Updated!');
            }
            delete userSession[ctx.from.id];
        } catch (e) { ctx.reply(`❌ Save error: ${e.message}`); }
        return; // stop here – we handled the session, no need to pass to other handlers
    }

    // 2) Confirmation / Wipe actions from screenshot flow
    if (session?.pendingMatches && ctx.message.text === '🚀 Confirm & Publish') {
        return publishMatches(ctx, false);
    }
    if (session?.pendingMatches && ctx.message.text === '🧹 Wipe & Replace All') {
        return publishMatches(ctx, true);
    }

    // 3) NOT a session action → pass control to other handlers (Sync API, Clear All, etc.)
    return next();
});
