const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DB_FILE = './database.json';

let data = {
    whitelist: { creators: [], places: [] },
    pendingPlaces: [],
    keys: ['abcdsed', 'vip-key', 'test-key']
};

if (fs.existsSync(DB_FILE)) {
    try {
        data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {}
}

function save() {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function checkExpiration() {
    const now = Date.now();
    let changed = false;
    ['creators', 'places'].forEach(type => {
        const initialLength = data.whitelist[type].length;
        data.whitelist[type] = data.whitelist[type].filter(item => !item.expiresAt || item.expiresAt > now);
        if (data.whitelist[type].length !== initialLength) changed = true;
    });
    if (changed) save();
}
setInterval(checkExpiration, 10000);

app.post('/api/verify', async (req, res) => {
    checkExpiration();
    const { creatorId, placeId, licenseKey } = req.body;
    if (!creatorId || !placeId) return res.status(400).json({ allowed: false });

    if (licenseKey && data.keys.includes(licenseKey) && !data.whitelist.places.some(p => p.id === Number(placeId))) {
        if (!data.pendingPlaces.some(p => p.id === Number(placeId))) {
            let placeName = 'Unknown Place';
            let creatorName = 'Unknown';
            try {
                const placeRes = await axios.get(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`);
                if (placeRes.data && placeRes.data[0]) {
                    placeName = placeRes.data[0].name;
                    creatorName = placeRes.data[0].builder;
                }
            } catch (e) {}
            data.pendingPlaces.push({ id: Number(placeId), creatorId: Number(creatorId), key: licenseKey, name: placeName, creatorName });
            save();
        }
    }

    if (data.whitelist.places.some(p => p.id === Number(placeId)) || data.whitelist.creators.some(c => c.id === Number(creatorId))) {
        return res.json({ allowed: true });
    }

    try {
        const groupsRes = await axios.get(`https://groups.roblox.com/v2/users/${creatorId}/groups/roles`);
        const ownedGroups = groupsRes.data.data.filter(g => g.role.rank === 255).map(g => g.group.id);
        if (data.whitelist.creators.some(c => ownedGroups.includes(c.id))) return res.json({ allowed: true });
    } catch (e) {}

    return res.json({ allowed: false });
});

app.get('/', (req, res) => {
    checkExpiration();
    
    const keyOptions = data.keys.map(k => `<option value="${k}">${k}</option>`).join('');
    const keyTags = data.keys.map(k => `
        <span class="key-tag-manage">${k} <a href="/delete-key/${k}" style="color:#f43f5e;margin-left:5px;text-decoration:none;">×</a></span>
    `).join('');

    const createRows = (arr, type) => arr.map(item => {
        let timeLeft = '';
        if (item.expiresAt) {
            const diff = item.expiresAt - Date.now();
            if (diff > 0) {
                const hours = Math.floor(diff / 3600000);
                const minutes = Math.floor((diff % 3600000) / 60000);
                timeLeft = `<br><span class="time-tag">⏱️ Expires in: ${hours}h ${minutes}m</span>`;
            }
        }
        return `
            <tr>
                <td>
                    <strong>${item.name || 'Unknown'}</strong> (${item.id})
                    ${item.assignedKey ? `<br><span class="key-badge">🔑 Key: ${item.assignedKey}</span>` : ''}
                    ${item.groups ? `<br><span class="group-tag">Groups: ${item.groups.join(', ')}</span>` : ''}
                    ${timeLeft}
                </td>
                <td><a href="/delete/${type}/${item.id}" class="btn-delete">Remove</a></td>
            </tr>
        `;
    }).join('');

    const pendingRows = data.pendingPlaces.map(item => `
        <tr>
            <td>
                🎮 Game: <strong>${item.name}</strong> (${item.id})<br>
                👤 Owner: <strong>${item.creatorName}</strong> (${item.creatorId})<br>
                <span class="key-badge">🔑 Used Key: ${item.key}</span>
            </td>
            <td><a href="/approve/${item.id}" class="btn-approve">Approve</a></td>
        </tr>
    `).join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Universal Whitelist System</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 30px; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 15px; margin-bottom: 25px; }
            h1 { font-size: 26px; color: #38bdf8; margin: 0; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .card { background: #111827; padding: 20px; border-radius: 10px; border: 1px solid #1e293b; position: relative; }
            .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
            h3 { margin: 0; color: #e2e8f0; font-size: 16px; }
            input, select { width: 100%; padding: 10px; margin-bottom: 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; box-sizing: border-box; }
            .inline-form { display: flex; gap: 10px; margin-bottom: 12px; }
            .inline-form input { margin-bottom: 0; }
            .inline-form button { width: auto; white-space: nowrap; }
            button { width: 100%; background: #0284c7; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: bold; cursor: pointer; }
            button:hover { background: #0369a1; }
            .btn-refresh { background: #1f2937; border: 1px solid #374151; color: #94a3b8; padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; text-decoration: none; }
            .btn-refresh:hover { background: #374151; color: white; }
            table { width: 100%; border-collapse: collapse; margin-top: 5px; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 14px; vertical-align: top; }
            th { background: #1f2937; color: #94a3b8; }
            .btn-delete { color: #f43f5e; text-decoration: none; font-weight: bold; }
            .btn-approve { color: #10b981; text-decoration: none; font-weight: bold; }
            .group-tag { font-size: 11px; color: #38bdf8; background: #0c4a6e; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; }
            .key-badge { font-size: 11px; color: #fbbf24; background: #78350f; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; }
            .time-tag { font-size: 11px; color: #a78bfa; background: #4c1d95; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; }
            .key-container { background: #1f2937; padding: 12px; border-radius: 6px; border: 1px solid #374151; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 8px; }
            .key-tag-manage { background: #111827; padding: 4px 10px; border-radius: 4px; font-size: 12px; border: 1px solid #475569; display: flex; align-items: center; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🛡️ Universal Whitelist Hub</h1>
                <a href="/" class="btn-refresh">🔄 Global Refresh</a>
            </div>
            <div class="grid">
                <div class="card">
                    <div class="card-header"><h3>🔑 System License Keys</h3></div>
                    <div class="key-container">${keyTags || '<span style="color:#64748b;font-size:13px;">No keys generated</span>'}</div>
                    <form action="/add-key" method="POST" class="inline-form">
                        <input type="text" name="key" placeholder="Generate new license key string" required>
                        <button type="submit">Create Key</button>
                    </form>
                </div>
                <div class="card">
                    <div class="card-header"><h3>📡 Pending Game Authorization Requests</h3><a href="/" class="btn-refresh">Refresh</a></div>
                    <table>
                        <thead><tr><th>Request Metadata</th><th>Action</th></tr></thead>
                        <tbody>${pendingRows || '<tr><td colspan="2" style="color:#64748b; text-align:center;">No pending requests incoming</td></tr>'}</tbody>
                    </table>
                </div>
                <div class="card" style="grid-column: span 2;">
                    <div class="card-header"><h3>➕ Direct Whitelist Access Grant</h3></div>
                    <form action="/add" method="POST" style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 12px; align-items: end;">
                        <div>
                            <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:5px;">Target Entity</label>
                            <select name="type" style="margin-bottom:0;">
                                <option value="creators">Creator (User/Group)</option>
                                <option value="places">Place ID</option>
                            </select>
                        </div>
                        <div>
                            <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:5px;">Input Name/ID</label>
                            <input type="text" name="input" placeholder="Name or numerical ID" style="margin-bottom:0;" required>
                        </div>
                        <div>
                            <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:5px;">Assign Key Tag (Optional)</label>
                            <select name="assignedKey" style="margin-bottom:0;">
                                <option value="">None</option>
                                ${keyOptions}
                            </select>
                        </div>
                        <div>
                            <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:5px;">Expiration (Optional)</label>
                            <input type="datetime-local" name="expiresAt" style="margin-bottom:0;">
                        </div>
                        <button type="submit" style="grid-column: span 4; margin-top:5px;">Authorize Entity</button>
                    </form>
                </div>
                <div class="card">
                    <div class="card-header"><h3>👥 Authorized Creators</h3><a href="/" class="btn-refresh">Refresh</a></div>
                    <table>
                        <thead><tr><th>Identity</th><th>Action</th></tr></thead>
                        <tbody>${createRows(data.whitelist.creators, 'creators') || '<tr><td colspan="2" style="color:#64748b;">Empty list</td></tr>'}</tbody>
                    </table>
                </div>
                <div class="card">
                    <div class="card-header"><h3>🏢 Authorized Places</h3><a href="/" class="btn-refresh">Refresh</a></div>
                    <table>
                        <thead><tr><th>Place Records</th><th>Action</th></tr></thead>
                        <tbody>${createRows(data.whitelist.places, 'places') || '<tr><td colspan="2" style="color:#64748b;">Empty list</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </body>
    </html>
    `);
});

app.post('/add', async (req, res) => {
    const { type, input, assignedKey, expiresAt } = req.body;
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

    if (id && !data.whitelist[type].some(x => x.id === id)) {
        const expiresTime = expiresAt ? new Date(expiresAt).getTime() : null;
        data.whitelist[type].push({ 
            id, 
            name: name || 'Place', 
            groups: groups.length > 0 ? groups : null,
            assignedKey: assignedKey || null,
            expiresAt: expiresTime
        });
        save();
    }
    res.redirect('/');
});

app.post('/add-key', (req, res) => {
    const key = req.body.key.trim();
    if (key && !data.keys.includes(key)) {
        data.keys.push(key);
        save();
    }
    res.redirect('/');
});

app.get('/delete-key/:key', (req, res) => {
    data.keys = data.keys.filter(k => k !== req.params.key);
    save();
    res.redirect('/');
});

app.get('/approve/:id', (req, res) => {
    const id = Number(req.params.id);
    const pending = data.pendingPlaces.find(p => p.id === id);
    if (pending) {
        if (!data.whitelist.places.some(p => p.id === id)) {
            data.whitelist.places.push({ id, name: pending.name || 'Approved Place', assignedKey: pending.key });
        }
        data.pendingPlaces = data.pendingPlaces.filter(p => p.id !== id);
        save();
    }
    res.redirect('/');
});

app.get('/delete/:type/:id', (req, res) => {
    const { type, id } = req.params;
    data.whitelist[type] = data.whitelist[type].filter(item => item.id !== Number(id));
    save();
    res.redirect('/');
});

app.listen(PORT, () => {});
