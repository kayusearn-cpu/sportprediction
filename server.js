const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS so your frontend Netlify app can request data from this backend
app.use(cors());

// Create an endpoint that your frontend will call
app.get('/api/get-predictions', async (req, res) => {
    // We grab the fixture ID from the frontend request (e.g., /api/get-predictions?fixture=12345)
    const fixtureId = req.query.fixture;

    if (!fixtureId) {
        return res.status(400).json({ error: 'Please provide a fixture ID' });
    }

    try {
        // Your Render server makes the request to API-Football securely
        const response = await axios.get('https://v3.football.api-sports.io/predictions', {
            params: {
                fixture: fixtureId
            },
            headers: {
                // This pulls the API key you saved in the Render.com Environment Variables tab
                'x-apisports-key': process.env.API_FOOTBALL_KEY
            }
        });

        // Send the real prediction data back to your frontend website
        res.json(response.data);

    } catch (error) {
        console.error("Error fetching data:", error.message);
        res.status(500).json({ error: 'Failed to fetch predictions' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
