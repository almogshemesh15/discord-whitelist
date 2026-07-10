const express = require('express');
const axios = require('axios');
const db = require('./database');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

function parseLocalTime(inputString) {
    if (!inputString) return null;
    return new Date(inputString + ':00+03:00').getTime();
}

app.post('/api/verify', async (req, res) => {
    db.checkExpiration();
    const data = db.getData();
    const { creatorId, placeId, licenseKey } = req.body;
    if (!creatorId || !placeId) return res.status(400).json({ allowed: false });

    if (licenseKey) {
        const keyExists = data.keys.some(k => k.key === licenseKey);
        if (!keyExists) return res.json({ allowed: false });
    }

    const checkAccess = (item) => {
        if (!licenseKey) return true;
        if (item.assignedKey === licenseKey) return true;
        if (item.keys && Array.isArray(item.keys)) {
            return item.keys.some(k => k.key === licenseKey);
        }
        return false;
    };

    const isPlaceAllowed = data.whitelist.places.some(p => p.id === Number(placeId) && checkAccess(p));
    const isCreatorAllowed = data.whitelist.creators.some(c => c.id === Number(creatorId) && checkAccess(c));
    if (isPlaceAllowed || isCreatorAllowed) return res.json({ allowed: true });

    try {
        const groupsRes = await axios.get(`https://groups.roblox.com/v2/users/${creatorId}/groups/roles`);
        const ownedGroups = groupsRes.data.data.filter(g => g.role.rank === 255).map(g => g.group.id);
        if (data.whitelist.creators.some(c => ownedGroups.includes(c.id) && checkAccess(c))) return res.json({ allowed: true });
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
            db.save();
        }
    }

    return res.json({ allowed: false });
});

app.post('/api/obfuscate', (req, res) => {
    const { code, key } = req.body;
    const template = `local function verifyServer()
local payload = {
creatorId = game.CreatorId,
placeId = game.PlaceId,
licenseKey = "${key}"
}
local success, response = pcall(function()
return game:GetService("HttpService"):PostAsync(
"https://discord-whitelist-ow56.onrender.com/api/verify",
game:GetService("HttpService"):JSONEncode(payload),
Enum.HttpContentType.ApplicationJson
)
end)
if not success then
script:Destroy()
return false
end
local data = game:GetService("HttpService"):JSONDecode(response)
return data and data.allowed
end
if verifyServer() then
${code}
end`;
    const b64 = Buffer.from(template).toString('base64');
    const finalObfuscated = `loadstring(game:GetService("HttpService"):JSONDecode('{"data":"${b64}"}').data)()`;
    res.json({ obfuscated: finalObfuscated });
});

app.get('/', (req, res) => {
    db.checkExpiration();
    const data = db.getData();
    const keyOptions = data.keys.map(k => `<option value="${k.key}">${k.key}</option>`).join('');
    const keyTags = data.keys.map(k => {
        return `<span class="key-tag-manage" data-search="${k.key.toLowerCase()}">${k.key} <a href="/delete-key/${k.key}" style="color:#f43f5e;margin-left:5px;text-decoration:none;">×</a></span>`;
    }).join('');

    const createRows = (arr, type) => arr.map(item => {
        let timeLeft = '';
        let keysListHtml = '';
        let searchData = `${item.name || ''} ${item.id}`.toLowerCase();
        if (item.assignedKey) searchData += ` ${item.assignedKey}`;
        if (item.expiresAt) {
            const diff = item.expiresAt - Date.now();
            if (diff > 0) {
                const hours = Math.floor(diff / 3600000);
                const minutes = Math.floor((diff % 3600000) / 60000);
                const seconds = Math.floor((diff % 60000) / 1000);
                timeLeft = `<br><span class="time-tag target-timer" data-expire="${item.expiresAt}">⏱️ Expires in: ${hours}h ${minutes}m ${seconds}s (IL Time)</span>`;
            }
        }
        if (item.keys && Array.isArray(item.keys) && item.keys.length > 0) {
            keysListHtml = '<div style="margin-top:5px; display:flex; flex-direction:column; gap:3px;">';
            item.keys.forEach(k => {
                searchData += ` ${k.key}`;
                let kTime = '';
                if (k.expiresAt) {
                    const diff = k.expiresAt - Date.now();
                    if (diff > 0) {
                        const hours = Math.floor(diff / 3600000);
                        const minutes = Math.floor((diff % 3600000) / 60000);
                        const seconds = Math.floor((diff % 60000) / 1000);
                        kTime = ` <span class="target-timer" data-expire="${k.expiresAt}">(⏱️ ${hours}h ${minutes}m ${seconds}s)</span>`;
                    }
                }
                keysListHtml += `<span class="key-badge" style="width:fit-content;">🔑 Key: ${k.key}${kTime}</span>`;
            });
            keysListHtml += '</div>';
        }
        return `
            <tr data-search="${searchData}">
                <td>
                    <strong>${item.name || 'Unknown'}</strong> (${item.id})
                    ${item.assignedKey ? `<br><span class="key-badge">🔑 Key: ${item.assignedKey}</span>` : ''}
                    ${keysListHtml}
                    ${item.groups ? `<br><span class="group-tag">Groups: ${item.groups.join(', ')}</span>` : ''}
                    ${timeLeft}
                </td>
                <td><a href="/delete/${type}/${item.id}" class="btn-delete">Remove</a></td>
            </tr>`;
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
                <td>
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <form action="/approve/${item.id}" method="POST" style="display:flex; gap:5px; align-items:center; margin-bottom:0;">
                            <input type="datetime-local" name="expiresAt" style="padding:4px; margin-bottom:0; width:160px; font-size:12px; height:28px;">
                            <button type="submit" class="btn-approve" style="background:none; border:none; padding:0; width:auto; font-size:14px; cursor:pointer;">Approve</button>
                        </form>
                        <form action="/reject/${item.id}" method="POST" style="margin-bottom:0;">
                            <button type="submit" class="btn-delete" style="background:none; border:none; padding:0; width:auto; font-size:14px; cursor:pointer; text-align:left;">Decline</button>
                        </form>
                    </div>
                </td>
            </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Universal Whitelist System</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 30px; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 15px; margin-bottom: 25px; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .card { background: #111827; padding: 20px; border-radius: 10px; border: 1px solid #1e293b; }
            button { width: 100%; background: #0284c7; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: bold; cursor: pointer; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header"><h1>🛡️ Universal Whitelist Hub</h1></div>
            <div class="grid">
                <div class="card" style="grid-column: span 2;">
                    <h3>🔐 Script Obfuscator</h3>
                    <textarea id="luaCode" placeholder="Paste Lua..." style="width:100%; height:100px; background:#1f2937; color:#fff; border-radius:6px; padding:10px;"></textarea>
                    <select id="keySelect" style="width:100%; padding:10px; background:#1f2937; color:white; margin:10px 0;">${keyOptions}</select>
                    <button onclick="obfuscateScript()">Generate</button>
                    <textarea id="resultOutput" style="width:100%; height:100px; margin-top:10px; background:#000; color:#0f0;"></textarea>
                </div>
                </div>
        </div>
        <script>
            async function obfuscateScript() {
                const code = document.getElementById('luaCode').value;
                const key = document.getElementById('keySelect').value;
                const res = await fetch('/api/obfuscate', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ code, key })
                });
                const data = await res.json();
                document.getElementById('resultOutput').value = data.obfuscated;
            }
        </script>
    </body>
    </html>`);
});

app.get('/force-save', (req, res) => {
    db.save();
    res.redirect('/');
});

app.post('/add', async (req, res) => {
    const data = db.getData();
    const { type, input } = req.body;
    let assignedKeys = req.body.assignedKeys;
    let expiresAtKeys = req.body.expiresAtKeys;

    if (!Array.isArray(assignedKeys)) {
        assignedKeys = assignedKeys ? [assignedKeys] : [];
    }
    if (!Array.isArray(expiresAtKeys)) {
        expiresAtKeys = expiresAtKeys ? [expiresAtKeys] : [];
    }

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
        const itemKeys = [];
        let overallExpiresAt = null;

        for (let i = 0; i < assignedKeys.length; i++) {
            const kStr = assignedKeys[i];
            const expRaw = expiresAtKeys[i];
            if (kStr) {
                const kTime = expRaw ? parseLocalTime(expRaw) : null;
                itemKeys.push({ key: kStr, expiresAt: kTime });
            } else if (expRaw && i === 0) {
                overallExpiresAt = parseLocalTime(expRaw);
            }
        }

        const existingIndex = data.whitelist[type].findIndex(x => x.id === id);
        
        if (existingIndex !== -1) {
            const currentItem = data.whitelist[type][existingIndex];
            const updatedKeys = currentItem.keys && Array.isArray(currentItem.keys) ? [...currentItem.keys] : [];
            
            itemKeys.forEach(newK => {
                const kIdx = updatedKeys.findIndex(k => k.key === newK.key);
                if (kIdx !== -1) {
                    updatedKeys[kIdx].expiresAt = newK.expiresAt;
                } else {
                    updatedKeys.push(newK);
                }
            });

            data.whitelist[type][existingIndex] = {
                ...currentItem,
                name: name || currentItem.name,
                groups: groups.length > 0 ? groups : currentItem.groups,
                keys: updatedKeys,
                expiresAt: overallExpiresAt || currentItem.expiresAt
            };
        } else {
            data.whitelist[type].push({ 
                id, 
                name: name || (type === 'places' ? 'Place' : 'Unknown'), 
                groups: groups.length > 0 ? groups : null,
                keys: itemKeys,
                expiresAt: overallExpiresAt
            });
        }
        db.save();
    }
    res.redirect('/');
});

app.post('/add-key', (req, res) => {
    const data = db.getData();
    const key = req.body.key.trim();
    if (key) {
        const existingKeyIndex = data.keys.findIndex(k => k.key === key);
        if (existingKeyIndex === -1) {
            data.keys.push({ key });
            db.save();
        }
    }
    res.redirect('/');
});

app.get('/delete-key/:key', (req, res) => {
    const data = db.getData();
    data.keys = data.keys.filter(k => k.key !== req.params.key);
    db.save();
    res.redirect('/');
});

app.post('/approve/:id', (req, res) => {
    const data = db.getData();
    const id = Number(req.params.id);
    const expiresAtRaw = req.body.expiresAt;
    const pending = data.pendingPlaces.find(p => p.id === id);
    if (pending) {
        const expiresTime = expiresAtRaw ? parseLocalTime(expiresAtRaw) : null;
        const existingIndex = data.whitelist.places.findIndex(p => p.id === id);
        
        if (existingIndex !== -1) {
            const currentItem = data.whitelist.places[existingIndex];
            const updatedKeys = currentItem.keys && Array.isArray(currentItem.keys) ? [...currentItem.keys] : [];
            if (!updatedKeys.some(k => k.key === pending.key)) {
                updatedKeys.push({ key: pending.key, expiresAt: expiresTime });
            }
            data.whitelist.places[existingIndex] = {
                ...currentItem,
                keys: updatedKeys,
                expiresAt: expiresTime || currentItem.expiresAt
            };
        } else {
            data.whitelist.places.push({ 
                id, 
                name: pending.name || 'Approved Place', 
                keys: [{ key: pending.key, expiresAt: expiresTime }],
                expiresAt: expiresTime 
            });
        }
        data.pendingPlaces = data.pendingPlaces.filter(p => p.id !== id);
        db.save();
    }
    res.redirect('/');
});

app.post('/reject/:id', (req, res) => {
    const data = db.getData();
    const id = Number(req.params.id);
    data.pendingPlaces = data.pendingPlaces.filter(p => p.id !== id);
    db.save();
    res.redirect('/');
});

app.get('/delete/:type/:id', (req, res) => {
    const data = db.getData();
    const { type, id } = req.params;
    data.whitelist[type] = data.whitelist[type].filter(item => item.id !== Number(id));
    db.save();
    res.redirect('/');
});

app.listen(PORT, () => {});
