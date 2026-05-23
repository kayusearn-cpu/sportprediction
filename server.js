bot.hears(/🔄 Sync API: (Today|Tomorrow)/, async (ctx) => {
    if (!checkAdmin(ctx)) return;
    if (!db) return ctx.reply('❌ Database not connected.');

    const day = ctx.match[1];
    ctx.reply(`⏳ Fetching ${day}'s matches from football‑data.org...`);

    const now = new Date();
    let dateFrom = new Date(now);
    let dateTo = new Date(now);

    if (day === 'Today') {
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

        // Filter for target day
        const targetDayStr = (day === 'Today' ? now : new Date(now.getTime() + 86400000)).toISOString().split('T')[0];
        const matchesForTargetDay = data.matches.filter(m => {
            const matchDate = m.utcDate ? new Date(m.utcDate).toISOString().split('T')[0] : null;
            return matchDate === targetDayStr;
        });

        let matchesToProcess = matchesForTargetDay;
        if (matchesToProcess.length === 0) {
            // Fallback: use all matches from the window
            if (data.matches.length === 0) {
                return ctx.reply(`❌ No matches found for ${day}. Try a different date or check your API key coverage.`);
            }
            matchesToProcess = data.matches;
            ctx.reply(`⚠️ No matches exactly for ${day} (UTC), using ${matchesToProcess.length} matches from the search window.`);
        }

        // Convert to internal format first (without predictions)
        let converted = matchesToProcess.map(m => convertMatch(m));

        // ── OpenAI auto‑prediction ────────────────────────────────
        if (openai && converted.length > 0) {
            ctx.reply('🧠 Generating predictions with AI...');
            try {
                // Prepare a compact text list of matches
                const matchList = converted.map((m, i) =>
                    `${i+1}. ${m.home.name} vs ${m.away.name} (${m.leagueName}, ${m.date} ${m.time})`
                ).join('\n');

                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",   // or "gpt-3.5-turbo"
                    messages: [
                        {
                            role: "system",
                            content: `You are a professional football betting analyst. Given a list of upcoming matches, provide a 1X2 prediction and percentage probabilities for each.

Return your answer as a JSON object with a key "predictions" that contains an array. Each element in the array must have:
- "match": the original match description (exactly as provided)
- "prediction": "1", "X", or "2"
- "probabilityHome": a number between 0 and 100
- "probabilityDraw": a number between 0 and 100
- "probabilityAway": a number between 0 and 100
The three probabilities must add up to 100.`
                        },
                        {
                            role: "user",
                            content: `Here are the matches:\n${matchList}\n\nPlease return your predictions in JSON.`
                        }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.7,
                    max_tokens: 1500
                });

                const result = JSON.parse(completion.choices[0].message.content);
                const predictions = result.predictions || [];

                // Map predictions back to matches (by index)
                predictions.forEach((pred, idx) => {
                    if (idx < converted.length) {
                        converted[idx].manual_prediction = pred.prediction || '';
                        converted[idx].probabilities = {
                            home: pred.probabilityHome || null,
                            draw: pred.probabilityDraw || null,
                            away: pred.probabilityAway || null
                        };
                    }
                });
            } catch (aiErr) {
                console.error('OpenAI prediction error:', aiErr.message);
                ctx.reply('⚠️ AI prediction failed, saving matches without predictions.');
            }
        }

        // Save all matches to Firebase
        await saveMatchesToFirebase(converted);
        ctx.reply(`✅ Synced ${converted.length} matches for ${day} (with predictions if AI was used).`);
        if (isAutoLiveOn) syncLiveScores();

    } catch(e) {
        ctx.reply(`❌ API Error: ${e.message}`);
    }
});
