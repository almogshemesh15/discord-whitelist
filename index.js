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
    keys: []
};

if (fs.existsSync(DB_FILE)) {
    try {
        const fileContent = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(fileContent);
        if (parsed.whitelist) data.whitelist = parsed.whitelist;
        if (parsed.pendingPlaces) data.pendingPlaces = parsed.pendingPlaces;
        if (parsed.keys) {
            data.keys = parsed.keys.map(k => typeof k === 'string' ? { key: k, expiresAt: null } : k);
        }
    } catch (e) {}
} else {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function save() {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function checkExpiration() {
    const now = Date.now();
    let changed = false;

    const initialKeysLength = data.keys.length;
    data.keys = data.keys.filter(k => !k.expiresAt || k.expiresAt > now);
    if (data.keys.length !== initialKeysLength) changed = true;

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

    const isPlaceAllowed = data.whitelist.places.some(p => p.id === Number(placeId));
    const isCreatorAllowed = data.whitelist.creators.some(c => c.id === Number(creatorId));
    if (isPlaceAllowed || isCreatorAllowed) return res.json({ allowed: true });

    try {
        const groupsRes = await axios.get(`https://groups.roblox.com/v2/users/${creatorId}/groups/roles`);
        const ownedGroups = groupsRes.data.data.filter(g => g.role.rank === 255).map(g => g.group.id);
        if (data.whitelist.creators.some(c => ownedGroups.includes(c.id))) return res.json({ allowed: true });
    } catch (e) {}

    const validKey = data.keys.find(k => k.key === licenseKey);
    if (licenseKey && validKey) {
        if (!data.pendingPlaces.some(p => p.id === Number(placeId))) {
            let placeName = 'Unknown Place';
            let creatorName = 'Unknown';
            try {
                const placeRes = await axios.get(`https://games.roblox.com/v1/games/v2/places/${placeId}/details`);
                if (placeRes.data && placeRes.data.name) {
                    placeName = placeRes.data.name;
                    const builderId = placeRes.data.builderId;
                    if (builderId) {
                        const userRes = await axios.get(`https://users.roblox.com/v1/users/${builderId}`);
                        if (userRes.data && userRes.data.name) {
                            creatorName = userRes.data.name;
                        }
                    }
                }
            } catch (e) {}
            data.pendingPlaces.push({ id: Number(placeId), creatorId: Number(creatorId), key: licenseKey, name: placeName, creatorName });
            save();
        }
    }

    return res.json({ allowed: false });
});

app.get('/', (req, res) => {
    checkExpiration();
    
    const keyOptions = data.keys.map(k => `<option value="${k.key}">${k.key}</option>`).join('');
    const keyTags = data.keys.map(k => {
        let keyTimeInfo = '';
        if (k.expiresAt) {
            const diff = k.expiresAt - Date.now();
            if (diff > 0) {
                const hours = Math.floor(diff / 3600000);
                const minutes = Math.floor((diff % 3600000) / 60000);
                keyTimeInfo = ` (${hours}h ${minutes}m left)`;
            }
        }
        return `
            <span class="key-tag-manage" data-search="${k.key.toLowerCase()}">${k.key}${keyTimeInfo} <a href="/delete-key/${k.key}" style="color:#f43f5e;margin-left:5px;text-decoration:none;">×</a></span>
        `;
    }).join('');

    const createRows = (arr, type) => arr.map(item => {
        let timeLeft = '';
        let searchData = `${item.name || ''} ${item.id} ${item.assignedKey || ''}`.toLowerCase();
        if (item.expiresAt) {
            const diff = item.expiresAt - Date.now();
            if (diff > 0) {
                const hours = Math.floor(diff / 3600000);
                const minutes = Math.floor((diff % 3600000) / 60000);
                timeLeft = `<br><span class="time-tag">⏱️ Expires in: ${hours}h ${minutes}m (IL Time)</span>`;
            }
        }
        return `
            <tr data-search="${searchData}">
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

    const pendingRows = data.pendingPlaces.map(item => {
        let searchData = `${item.name} ${item.id} ${item.creatorName} ${item.creatorId} ${item.key}`.toLowerCase();
        return `
            <tr data-search="${searchData}">
                <td>
                    🎮 Game: <strong>${item.name}</strong> (${item.id})<br>
                    👤 Owner: <strong>${item.creatorName}</strong> (${item.creatorId})<br>
                    <span class="key-badge">🔑 Used Key: ${item.key}</span>
                </td>
                <td><a href="/approve/${item.id}" class="btn-approve">Approve</a></td>
            </tr>
        `;
    }).join('');

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
            .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; gap: 10px; }
            h3 { margin: 0; color: #e2e8f0; font-size: 16px; white-space: nowrap; }
            .search-input { width: 60%; padding: 6px 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; font-size: 13px; box-sizing: border-box; }
            input, select { width: 100%; padding: 10px; margin-bottom: 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; box-sizing: border-box; }
            .inline-form { display: flex; gap: 10px; margin-bottom: 12px; align-items: end; width: 100%; }
            .inline-form div { flex: 1; }
            .inline-form input { margin-bottom: 0; }
            .inline-form button { width: auto; white-space: nowrap; height: 38px; }
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
            .key-container { background: #1f2937; padding: 12px; border-radius: 6px; border: 1px solid #374151; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 8px; max-height: 120px; overflow-y: auto; }
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
                    <div class="card-header">
                        <h3>🔑 System License Keys</h3>
                        <input type="text" class="search-input" placeholder="Search keys..." oninput="searchKeys(this)">
                    </div>
                    <div class="key-container" id="keys-box">${keyTags || '<span style="color:#64748b;font-size:13px;">No keys generated</span>'}</div>
                    <form action="/add-key" method="POST" class="inline-form">
                        <div>
                            <input type="text" name="key" placeholder="Key string" required>
                        </div>
                        <div>
                            <input type="datetime-local" name="keyExpiresAt">
                        </div>
                        <button type="submit">Create Key</button>
                    </form>
                </div>
                <div class="card">
                    <div class="card-header">
                        <h3>📡 Pending Game Requests</h3>
                        <input type="text" class="search-input" placeholder="Search requests..." oninput="searchTable(this, 'pending-table')">
                    </div>
                    <table>
                        <thead><tr><th>Request Metadata</th><th>Action</th></tr></thead>
                        <tbody id="pending-table">${pendingRows || '<tr><td colspan="2" style="color:#64748b; text-align:center;">No pending requests incoming</td></tr>'}</tbody>
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
                            <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:5px;">Expiration (Israel Time)</label>
                            <input type="datetime-local" name="expiresAt" style="margin-bottom:0;">
                        </div>
                        <button type="submit" style="grid-column: span 4; margin-top:5px;">Authorize Entity</button>
                    </form>
                </div>
                <div class="card">
                    <div class="card-header">
                        <h3>👥 Authorized Creators</h3>
                        <input type="text" class="search-input" placeholder="Search creators..." oninput="searchTable(this, 'creators-table')">
                    </div>
                    <table>
                        <thead><tr><th>Identity</th><th>Action</th></tr></thead>
                        <tbody id="creators-table">${createRows(data.whitelist.creators, 'creators') || '<tr><td colspan="2" style="color:#64748b;">Empty list</td></tr>'}</tbody>
                    </table>
                </div>
                <div class="card">
                    <div class="card-header">
                        <h3>🏢 Authorized Places</h3>
                        <input type="text" class="search-input" placeholder="Search places..." oninput="searchTable(this, 'places-table')">
                    </div>
                    <table>
                        <thead><tr><th>Place Records</th><th>Action</th></tr></thead>
                        <tbody id="places-table">${createRows(data.whitelist.places, 'places') || '<tr><td colspan="2" style="color:#64748b;">Empty list</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        </div>
        <script>
            function searchTable(input, tableId) {
                let filter = input.value.toLowerCase();
                let rows = document.getElementById(tableId).getElementsByTagName('tr');
                for (let i = 0; i < rows.length; i++) {
                    let searchAttr = rows[i].getAttribute('data-search');
                    if (searchAttr) {
                        if (searchAttr.includes(filter)) {
                            rows[i].style.display = "";
                        } else {
                            rows[i].style.display = "none";
                        }
                    }
                }
            }
            function searchKeys(input) {
                let filter = input.value.toLowerCase();
                let tags = document.getElementById('keys-box').getElementsByClassName('key-tag-manage');
                for (let i = 0; i < tags.length; i++) {
                    let searchAttr = tags[i].getAttribute('data-search');
                    if (searchAttr) {
                        if (searchAttr.includes(filter)) {
                            tags[i].style.display = "flex";
                        } else {
                            tags[i].style.display = "none";
                        }
                    }
                }
            }
        </script>
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

    if (id) {
        let expiresTime = null;
        if (expiresAt) {
            expiresTime = new Date(expiresAt).getTime();
        }

        const existingIndex = data.whitelist[type].findIndex(x => x.id === id);
        if (existingIndex !== -1) {
            data.whitelist[type][existingIndex].assignedKey = assignedKey || null;
            data.whitelist[type][existingIndex].expiresAt = expiresTime;
        } else {
            data.whitelist[type].push({ 
                id, 
                name: name || (type === 'places' ? 'Place' : 'Unknown'), 
                groups: groups.length > 0 ? groups : null,
                assignedKey: assignedKey || null,
                expiresAt: expiresTime
            });
        }
        save();
    }
    res.redirect('/');
});

app.post('/add-key', (req, res) => {
    const key = req.body.key.trim();
    const { keyExpiresAt } = req.body;
    if (key) {
        let expiresTime = null;
        if (keyExpiresAt) {
            expiresTime = new Date(keyExpiresAt).getTime();
        }

        const existingKeyIndex = data.keys.findIndex(k => k.key === key);
        if (existingKeyIndex !== -1) {
            data.keys[existingKeyIndex].expiresAt = expiresTime;
        } else {
            data.keys.push({ key, expiresAt: expiresTime });
        }
        save();
    }
    res.redirect('/');
});

app.get('/delete-key/:key', (req, res) => {
    data.keys = data.keys.filter(k => k.key !== req.params.key);
    save();
    res.redirect('/');
});

app.get('/approve/:id', (req, res) => {
    const id = Number(req.params.id);
    const pending = data.pendingPlaces.find(p => p.id === id);
    if (pending) {
        const existingIndex = data.whitelist.places.findIndex(p => p.id === id);
        if (existingIndex !== -1) {
            data.whitelist.places[existingIndex].assignedKey = pending.key;
            data.whitelist.places[existingIndex].expiresAt = null;
        } else {
            data.whitelist.places.push({ id, name: pending.name || 'Approved Place', assignedKey: pending.key, expiresAt: null });
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
