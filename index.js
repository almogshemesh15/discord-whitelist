const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
let whitelist = { creators: [], places: [] };
let pendingPlaces = [];

app.post('/api/verify', async (req, res) => {
    const { creatorId, placeId, licenseKey } = req.body;
    if (!creatorId || !placeId) return res.status(400).json({ allowed: false });

    if (licenseKey && !whitelist.places.some(p => p.id === Number(placeId))) {
        if (!pendingPlaces.some(p => p.id === Number(placeId))) {
            pendingPlaces.push({ id: Number(placeId), creatorId: Number(creatorId), key: licenseKey });
        }
    }

    if (whitelist.places.some(p => p.id === Number(placeId)) || whitelist.creators.some(c => c.id === Number(creatorId))) {
        return res.json({ allowed: true });
    }

    try {
        const groupsRes = await axios.get(`https://groups.roblox.com/v2/users/${creatorId}/groups/roles`);
        const ownedGroups = groupsRes.data.data.filter(g => g.role.rank === 255).map(g => g.group.id);
        if (whitelist.creators.some(c => ownedGroups.includes(c.id))) return res.json({ allowed: true });
    } catch (e) {}

    return res.json({ allowed: false });
});

app.get('/', (req, res) => {
    const createRows = (arr, type) => arr.map(item => `
        <tr>
            <td><strong>${item.name || 'Unknown'}</strong> (${item.id})${item.groups ? `<br><span class="group-tag">Groups: ${item.groups.join(', ')}</span>` : ''}</td>
            <td><a href="/delete/${type}/${item.id}" class="btn-delete">Remove</a></td>
        </tr>
    `).join('');

    const pendingRows = pendingPlaces.map(item => `
        <tr>
            <td>Place: <strong>${item.id}</strong><br><small style="color:#94a3b8">Creator: ${item.creatorId} | Key: ${item.key}</small></td>
            <td><a href="/approve/${item.id}" class="btn-approve">Approve</a></td>
        </tr>
    `).join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Whitelist Dashboard</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 30px; }
            .container { max-width: 1100px; margin: 0 auto; }
            h1 { font-size: 26px; color: #38bdf8; margin-bottom: 25px; border-bottom: 1px solid #1e293b; padding-bottom: 15px; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .card { background: #111827; padding: 20px; border-radius: 10px; border: 1px solid #1e293b; }
            h3 { margin: 0 0 15px 0; color: #e2e8f0; font-size: 16px; }
            input, select { width: 100%; padding: 10px; margin-bottom: 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; box-sizing: border-box; }
            button { width: 100%; background: #0284c7; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: bold; cursor: pointer; }
            button:hover { background: #0369a1; }
            table { width: 100%; border-collapse: collapse; margin-top: 5px; }
            th, td { padding: 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 14px; }
            th { background: #1f2937; color: #94a3b8; }
            .btn-delete { color: #f43f5e; text-decoration: none; font-weight: bold; }
            .btn-approve { color: #10b981; text-decoration: none; font-weight: bold; }
            .group-tag { font-size: 11px; color: #38bdf8; background: #0c4a6e; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🛡️ Whitelist Dashboard</h1>
            <div class="grid">
                <div class="card">
                    <h3>Add Target</h3>
                    <form action="/add" method="POST">
                        <select name="type">
                            <option value="creators">Creator (Username / ID / Group ID)</option>
                            <option value="places">Place ID</option>
                        </select>
                        <input type="text" name="input" placeholder="Enter name or ID" required>
                        <button type="submit">Grant Access</button>
                    </form>
                </div>
                <div class="card">
                    <h3>Pending Authorization Requests</h3>
                    <table>
                        <thead><tr><th>Request Info</th><th>Action</th></tr></thead>
                        <tbody>${pendingRows || '<tr><td colspan="2" style="color:#64748b; text-align:center;">No pending requests</td></tr>'}</tbody>
                    </table>
                </div>
                <div class="card">
                    <h3>Authorized Creators</h3>
                    <table>
                        <thead><tr><th>Identity</th><th>Action</th></tr></thead>
                        <tbody>${createRows(whitelist.creators, 'creators') || '<tr><td colspan="2" style="color:#64748b;">Empty</td></tr>'}</tbody>
                    </table>
                </div>
                <div class="card">
                    <h3>Authorized Places</h3>
                    <table>
                        <thead><tr><th>Place ID</th><th>Action</th></tr></thead>
                        <tbody>${createRows(whitelist.places, 'places') || '<tr><td colspan="2" style="color:#64748b;">Empty</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </body>
    </html>
    `);
});

app.post('/add', async (req, res) => {
    const { type, input } = req.body;
    let id = Number(input);
    let name = '';
    let groups = [];

    if (isNaN(id) && type === 'creators') {
        try {
            const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [input] });
            if (userRes.data.data.length > 0) {
                id = userRes.data.data[0].id;
                name = userRes.data.data[0].requestedUsername;
            }
        } catch (e) {}
    } else if (!isNaN(id) && type === 'creators') {
        try {
            const nameRes = await axios.get(`https://users.roblox.com/v1/users/${id}`);
            name = nameRes.data.name;
        } catch (e) {
            name = 'Roblox Group';
        }
    }

    if (type === 'creators' && id && name !== 'Roblox Group') {
        try {
            const groupsRes = await axios.get(`https://groups.roblox.com/v2/users/${id}/groups/roles`);
            groups = groupsRes.data.data.filter(g => g.role.rank === 255).map(g => g.group.name);
        } catch (e) {}
    }

    if (id && !whitelist[type].some(x => x.id === id)) {
        whitelist[type].push({ id, name: name || 'Place', groups: groups.length > 0 ? groups : null });
    }
    res.redirect('/');
});

app.get('/approve/:id', (req, res) => {
    const id = Number(req.params.id);
    const pending = pendingPlaces.find(p => p.id === id);
    if (pending) {
        if (!whitelist.places.some(p => p.id === id)) {
            whitelist.places.push({ id, name: 'Approved via Key' });
        }
        pendingPlaces = pendingPlaces.filter(p => p.id !== id);
    }
    res.redirect('/');
});

app.get('/delete/:type/:id', (req, res) => {
    const { type, id } = req.params;
    whitelist[type] = whitelist[type].filter(item => item.id !== Number(id));
    res.redirect('/');
});

app.listen(PORT, () => {});
