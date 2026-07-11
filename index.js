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

app.get('/', (req, res) => {
    db.checkExpiration();
    const data = db.getData();
    
    const keyOptions = data.keys.map(k => `<option value="${k.key}">${k.key}</option>`).join('');
    const keyTags = data.keys.map(k => {
        return `
            <span class="key-tag-manage" data-search="${k.key.toLowerCase()}">${k.key} <a href="/delete-key/${k.key}" style="color:#f43f5e;margin-left:5px;text-decoration:none;">×</a></span>
        `;
    }).join('');

    const createRows = (arr, type) => arr.map(item => {
        let timeLeft = '';
        let keysListHtml = '';
        let searchData = `${item.name || ''} ${item.id}`.toLowerCase();
        
        if (item.assignedKey) {
            searchData += ` ${item.assignedKey}`;
        }

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
            .header-actions { display: flex; gap: 10px; align-items: center; }
            h1 { font-size: 26px; color: #38bdf8; margin: 0; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .card { background: #111827; padding: 20px; border-radius: 10px; border: 1px solid #1e293b; position: relative; }
            .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; gap: 10px; }
            h3 { margin: 0; color: #e2e8f0; font-size: 16px; white-space: nowrap; }
            .search-input { width: 60%; padding: 6px 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; font-size: 13px; box-sizing: border-box; }
            input, select, textarea { width: 100%; padding: 10px; margin-bottom: 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; box-sizing: border-box; }
            .inline-form { display: flex; gap: 10px; margin-bottom: 12px; align-items: end; width: 100%; }
            .inline-form div { flex: 1; }
            .inline-form input { margin-bottom: 0; }
            .inline-form button { width: auto; white-space: nowrap; height: 38px; }
            button { width: 100%; background: #0284c7; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: bold; cursor: pointer; }
            button:hover { background: #0369a1; }
            .btn-refresh { background: #1f2937; border: 1px solid #374151; color: #94a3b8; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; box-sizing: border-box; font-weight: bold; }
            .btn-refresh:hover { background: #374151; color: white; }
            .btn-save-db { background: #10b981; border: 1px solid #059669; color: white; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; box-sizing: border-box; font-weight: bold; }
            .btn-save-db:hover { background: #059669; }
            .btn-obfuscate-page { background: #a855f7; border: 1px solid #9333ea; color: white; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; box-sizing: border-box; font-weight: bold; }
            .btn-obfuscate-page:hover { background: #9333ea; }
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
            .dynamic-key-row { display: flex; gap: 10px; margin-bottom: 8px; align-items: center; }
            .btn-add-row { background: #10b981; margin-bottom: 10px; padding: 6px; font-size: 13px; width: auto; display: inline-block; }
            .btn-add-row:hover { background: #059669; }
            .btn-remove-row { background: #f43f5e !important; color: white !important; width: 38px !important; height: 38px !important; display: flex !important; align-items: center !important; justify-content: center !important; border-radius: 6px !important; cursor: pointer !important; font-weight: bold !important; border: none !important; padding: 0 !important; font-size: 20px !important; line-height: 1 !important; flex-shrink: 0; }
            .btn-remove-row:hover { background: #e11d48 !important; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🛡️ Universal Whitelist Hub</h1>
                <div class="header-actions">
                    <a href="/obfuscate" class="btn-obfuscate-page">🔒 Obfuscate Code</a>
                    <a href="/force-save" class="btn-save-db">💾 Save File</a>
                    <a href="/" class="btn-refresh">🔄 Global Refresh</a>
                </div>
            </div>
            <div class="grid">
                <div class="card">
                    <div class="card-header">
                        <h3>🔑 System License Keys</h3>
                        <input type="text" class="search-input" placeholder="Search keys..." oninput="searchKeys(this)">
                    </div>
                    <div class="key-container" id="keys-box">${keyTags || '<span style="color:#64748b;font-size:13px;">No keys generated</span>'}</div>
                    <form action="/add-key" method="POST" class="inline-form" style="display: flex; flex-direction: column; gap: 8px; align-items: stretch;">
                        <input type="text" name="key" placeholder="Key string" required style="margin-bottom:0;">
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
                    <form action="/add" method="POST" style="display: flex; flex-direction: column; gap: 12px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
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
                        </div>
                        
                        <div style="border-top: 1px solid #1e293b; padding-top: 10px;">
                            <label style="font-size:14px;color:#e2e8f0;display:block;margin-bottom:8px;">Keys & Expirations Mapping</label>
                            <button type="button" class="btn-add-row" onclick="addKeyRow()">➕ Add Key & Date</button>
                            <div id="dynamic-keys-container">
                                <div class="dynamic-key-row">
                                    <select name="assignedKeys" style="margin-bottom:0; flex: 1; height: 38px;">
                                        <option value="">None</option>
                                        ${keyOptions}
                                    </select>
                                    <input type="datetime-local" name="expiresAtKeys" style="margin-bottom:0; flex: 1; height: 38px;">
                                    <button type="button" class="btn-remove-row" onclick="removeKeyRow(this)">×</button>
                                </div>
                            </div>
                        </div>

                        <button type="submit" style="margin-top:10px;">Authorize Entity</button>
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
            function updateTimers() {
                const now = Date.now();
                document.querySelectorAll('.target-timer').forEach(el => {
                    const expire = parseInt(el.getAttribute('data-expire'));
                    const diff = expire - now;
                    if (diff <= 0) {
                        el.innerHTML = "Expired";
                    } else {
                        const hours = Math.floor(diff / 3600000);
                        const minutes = Math.floor((diff % 3600000) / 60000);
                        const seconds = Math.floor((diff % 60000) / 1000);
                        if (el.tagName === 'SPAN' && !el.classList.contains('time-tag')) {
                            el.innerHTML = \`(⏱️ \${hours}h \${minutes}m \${seconds}s)\`;
                        } else {
                            el.innerHTML = \`⏱️ Expires in: \${hours}h \${minutes}m \${seconds}s (IL Time)\`;
                        }
                    }
                });
            }
            setInterval(updateTimers, 1000);

            function addKeyRow() {
                const container = document.getElementById('dynamic-keys-container');
                const div = document.createElement('div');
                div.className = 'dynamic-key-row';
                div.innerHTML = \`
                    <select name="assignedKeys" style="margin-bottom:0; flex: 1; height: 38px;">
                        <option value="">None</option>
                        ${keyOptions.replace(/"/g, '\\"')}
                    </select>
                    <input type="datetime-local" name="expiresAtKeys" style="margin-bottom:0; flex: 1; height: 38px;">
                    <button type="button" class="btn-remove-row" onclick="removeKeyRow(this)">×</button>
                \`;
                container.appendChild(div);
            }
            function removeKeyRow(button) {
                const row = button.parentElement;
                if (document.querySelectorAll('.dynamic-key-row').length > 1) {
                    row.remove();
                } else {
                    row.querySelector('select').value = '';
                    row.querySelector('input').value = '';
                }
            }
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

app.get('/obfuscate', (req, res) => {
    const data = db.getData();
    const keyOptions = data.keys.map(k => `<option value="${k.key}">${k.key}</option>`).join('');
    
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Obfuscate & Inject Whitelist</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 30px; }
            .container { max-width: 800px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 15px; margin-bottom: 25px; }
            h1 { font-size: 26px; color: #a855f7; margin: 0; }
            .card { background: #111827; padding: 20px; border-radius: 10px; border: 1px solid #1e293b; }
            select, textarea { width: 100%; padding: 10px; margin-bottom: 15px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; box-sizing: border-box; }
            textarea { font-family: monospace; height: 250px; resize: vertical; }
            button { width: 100%; background: #a855f7; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 15px; }
            button:hover { background: #9333ea; }
            .btn-back { background: #1f2937; border: 1px solid #374151; color: #94a3b8; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; box-sizing: border-box; font-weight: bold; }
            .btn-back:hover { background: #374151; color: white; }
            label { display: block; margin-bottom: 6px; font-size: 14px; color: #94a3b8; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🔒 Whitelist Code Injector</h1>
                <a href="/" class="btn-back">⬅️ Back to Hub</a>
            </div>
            <div class="card">
                <form action="/obfuscate" method="POST">
                    <label>Select License Key</label>
                    <select name="licenseKey" required>
                        ${keyOptions || '<option value="">No keys available - create one first</option>'}
                    </select>
                    
                    <label>Paste your Lua Source Code</label>
                    <textarea name="sourceCode" placeholder="-- Paste your script here" required></textarea>
                    
                    <button type="submit">Inject Whitelist Verification</button>
                </form>
            </div>
        </div>
    </body>
    </html>
    `);
});

app.post('/obfuscate', (req, res) => {
    const { licenseKey, sourceCode } = req.body;
    
    function luaObfuscateString(str) {
        return str.split('').map(char => '\\' + char.charCodeAt(0)).join('');
    }

    const encUrl = luaObfuscateString("https://discord-whitelist-ow56.onrender.com/api/verify");
    const encKey = luaObfuscateString(licenseKey);
    const encHttp = luaObfuscateString("HttpService");
    const encPost = luaObfuscateString("PostAsync");
    const encJsonE = luaObfuscateString("JSONEncode");
    const encJsonD = luaObfuscateString("JSONDecode");
    const encAppJson = luaObfuscateString("ApplicationJson");
    const encSource = luaObfuscateString(sourceCode);

    const obfuscatedTemplate = `local _O = {"${encUrl}", "${encKey}", "${encHttp}", "${encPost}", "${encJsonE}", "${encJsonD}", "${encAppJson}", "${encSource}"}
local function _D(idx)
    return (_O[idx]:gsub('\\\([0-9]+)', function(c) return string.char(tonumber(c)) end))
end
local function _V()
    local p = {creatorId = game.CreatorId, placeId = game.PlaceId, licenseKey = _D(2)}
    local s, r = pcall(function()
        return game:GetService(_D(3))[_D(4)](game:GetService(_D(3)), _D(1), game:GetService(_D(3))[_D(5)](game:GetService(_D(3)), p), Enum.HttpContentType.ApplicationJson)
    end)
    if not s then 
        script:Destroy() 
        return false 
    end
    local d = game:GetService(_D(3))[_D(6)](game:GetService(_D(3)), r)
    return d and d.allowed
end
if _V() then
    task.spawn(function()
        local src = _D(8)
        assert(loadstring(src))()
    end)
else
    script:Destroy()
end`;

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Output Protected Code</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 30px; }
            .container { max-width: 800px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 15px; margin-bottom: 25px; }
            h1 { font-size: 26px; color: #10b981; margin: 0; }
            .card { background: #111827; padding: 20px; border-radius: 10px; border: 1px solid #1e293b; }
            textarea { width: 100%; padding: 10px; margin-bottom: 15px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: #10b981; box-sizing: border-box; font-family: monospace; height: 350px; }
            button { width: 100%; background: #10b981; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 15px; }
            button:hover { background: #059669; }
            .btn-back { background: #1f2937; border: 1px solid #374151; color: #94a3b8; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; box-sizing: border-box; font-weight: bold; }
            .btn-back:hover { background: #374151; color: white; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>✅ Code Protected Successfully</h1>
                <a href="/obfuscate" class="btn-back">⬅️ Back</a>
            </div>
            <div class="card">
                <textarea id="output-code" readonly>${obfuscatedTemplate}</textarea>
                <button onclick="copyToClipboard()">📋 Copy Code</button>
            </div>
        </div>
        <script>
            function copyToClipboard() {
                const copyText = document.getElementById("output-code");
                copyText.select();
                copyText.setSelectionRange(0, 99999);
                navigator.clipboard.writeText(copyText.value);
            }
        </script>
    </body>
    </html>
    `);
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

app.listen(PORT, () => {});
