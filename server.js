// ── OpenAI auto‑prediction (with predicted scores) ────────────
if (openai && converted.length > 0) {
    ctx.reply('🧠 Generating predictions with AI...');
    try {
        const matchList = converted.map((m, i) =>
            `${i+1}. ${m.home.name} vs ${m.away.name} (${m.leagueName}, ${m.date} ${m.time})`
        ).join('\n');

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `You are a professional football betting analyst. For each upcoming match, provide:
- A 1X2 prediction: "1", "X", or "2"
- A predicted correct score (e.g., "2-1")
- Percentage probabilities for Home, Draw, and Away that add up to 100.

Return a JSON object with a key "predictions" that is an array. Each element must have:
- "match": the original match description (exactly as provided)
- "prediction": "1", "X", or "2"
- "pScore": the predicted correct score (e.g., "2-1")
- "probabilityHome", "probabilityDraw", "probabilityAway": numbers 0-100, sum = 100`
                },
                { role: "user", content: `Here are the matches:\n${matchList}\n\nPlease return your predictions in JSON.` }
            ],
            response_format: { type: "json_object" },
            temperature: 0.7,
            max_tokens: 1500
        });

        const result = JSON.parse(completion.choices[0].message.content);
        const predictions = result.predictions || [];

        predictions.forEach((pred, idx) => {
            if (idx < converted.length) {
                // Format exactly as the screenshot upload does: "prediction (pScore)"
                const tip = pred.prediction || '';
                const pScore = pred.pScore || '';
                converted[idx].manual_prediction = `${tip} (${pScore})`.trim();
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
