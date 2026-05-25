const { exec } = require('child_process');

// Promise wrapper for exec
function execCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
            if (err) reject(stderr || err);
            else resolve(stdout);
        });
    });
}

async function scrapeWithCrawl4AI(chatId) {
    if (!PROXY_HOST) throw new Error('Proxy settings missing');

    const proxyUrl = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
    const selector = MATCH_SELECTOR;   // e.g. ".match-row"

    reply(chatId, '🌐 Running Crawl4AI with proxy...');

    try {
        const cmd = `python3 scraper.py "${TARGET_URL}" "${selector}" "${proxyUrl}"`;
        const output = await execCommand(cmd);
        const data = JSON.parse(output);
        if (data.error) throw new Error(data.error);

        const elements = data.elements || [];
        if (!elements.length) {
            reply(chatId, '⚠️ No elements found. Check the selector.');
            return [];
        }
        reply(chatId, `📥 Found ${elements.length} match rows. Extracting with AI...`);
        return elements;  // array of plain text strings from each match row
    } catch (err) {
        console.error('Crawl4AI error:', err.message);
        throw err;
    }
}
