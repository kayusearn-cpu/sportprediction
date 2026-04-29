const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

app.get('/api/get-predictions', async (req, res) => {
    const fixtureId = req.query.fixture;
    const apiKey = process.env.API_FOOTBALL_KEY;

    if (!fixtureId) {
        return res.status(400).json({ error: 'Please provide a fixture ID' });
    }

    if (!apiKey) {
        console.error("CRITICAL ERROR: API_FOOTBALL_KEY is not defined in Environment Variables.");
        return res.status(500).json({ error: 'Backend configuration error: API Key missing.' });
    }

    try {
        const response = await axios.get('https://v3.football.api-sports.io/predictions', {
            params: { fixture: fixtureId },
            headers: {
                'x-apisports-key': apiKey,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000 // 10 second timeout
        });

        res.json(response.data);

    } catch (error) {
        // This log will show up in your Render "Logs" tab
        console.error("API Fetch Error:", error.response ? error.response.data : error.message);
        
        const statusCode = error.response ? error.response.status : 500;
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        
        res.status(statusCode).json({ 
            error: 'Failed to fetch predictions', 
            details: errorMessage 
        });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
