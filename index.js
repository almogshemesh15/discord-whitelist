const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

let whitelist = {
    creators: [12345678],
    places: [987654321]
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

app.get('/', (req, res) => {
    let creatorRows = whitelist.creators.map(id => `
        <tr>
            <td>${id}</td>
            <td><a href="/delete/creators/${id}" class="btn-delete">Remove</a></td>
        </tr>
    `).join('');

    let placeRows = whitelist.places.map(id => `
        <tr>
            <td>${id}</td>
            <td><a href="/delete/places/${id}" class="btn-delete">Remove</a></td>
        </tr>
    `).join('');

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Whitelist Dashboard</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f9; margin: 0; padding: 40px; color: #333; }
            .container { max-width: 900px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
            h1 { margin-top: 0; color: #1e293b; border-bottom: 2px solid #f1f5f9; padding-bottom: 15px; }
            .forms-container { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
            .form-box { background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; }
            h3 { margin-top: 0; color: #0f172a; }
            input[type="number"] { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
            button { width: 100%; background: #2563eb; color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 14px; transition: background 0.2s; }
            button:hover { background: #1d4ed8; }
            .tables-container { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; background: white; border-radius: 6px; overflow: hidden; border: 1px solid #e2e8f0; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
            th { background: #f1f5f9; color: #475569; font-weight: 600; }
            .btn-delete { color: #ef4444; text-decoration: none; font-weight: 600; font-size: 14px; }
            .btn-delete:hover { text-decoration: underline; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🛡️ Whitelist Management Dashboard</h1>
            
            <div class="forms-container">
                <div class="form-box">
                    <h3>Add Creator (User/Group)</h3>
                    <form action="/add/creators" method="POST">
                        <input type="number" name="id" placeholder="Enter Roblox Creator ID" required>
                        <button type="submit">Add Creator</button>
                    </form>
                </div>
                <div class="form-box">
                    <h3>Add Place ID</h3>
                    <form action="/add/places" method="POST">
                        <input type="number" name="id" placeholder="Enter Roblox Place ID" required>
                        <button type="submit">Add Place</button>
                    </form>
                </div>
            </div>

            <div class="tables-container">
                <div>
                    <h3>Whitelisted Creators</h3>
                    <table>
                        <thead><tr><th>Roblox ID</th><th>Action</th></tr></thead>
                        <tbody>${creatorRows || '<tr><td colspan="2" style="text-align:center;color:#94a3b8;">No creators whitelisted</td></tr>'}</tbody>
                    </table>
                </div>
                <div>
                    <h3>Whitelisted Places</h3>
                    <table>
                        <thead><tr><th>Place ID</th><th>Action</th></tr></thead>
                        <tbody>${placeRows || '<tr><td colspan="2" style="text-align:center;color:#94a3b8;">No places whitelisted</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

app.post('/add/:type', (req, res) => {
    const { type } = req.params;
    const id = Number(req.body.id);
    if (id && whitelist[type] && !whitelist[type].includes(id)) {
        whitelist[type].push(id);
    }
    res.redirect('/');
});

app.get('/delete/:type/:id', (req, res) => {
    const { type, id } = req.params;
    const targetId = Number(id);
    if (whitelist[type]) {
        whitelist[type] = whitelist[type].filter(item => item !== targetId);
    }
    res.redirect('/');
});

app.listen(PORT, () => {});
