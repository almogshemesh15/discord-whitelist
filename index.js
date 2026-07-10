const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const whitelist = {
    creators: [
        0000,
    ],
    places: [
        0000,
    ]
};

app.post('/api/verify', (req, res) => {
    const { creatorId, placeId } = req.body;

    if (!creatorId || !placeId) {
        return res.status(400).json({ allowed: false, reason: "Missing parameters" });
    }

    const isCreatorAllowed = whitelist.creators.includes(Number(creatorId));
    const isPlaceAllowed = whitelist.places.includes(Number(placeId));

    if (isCreatorAllowed || isPlaceAllowed) {
        return res.json({ allowed: true });
    }

    return res.json({ allowed: false });
});

app.listen(PORT, () => {});
