const express = require('express');
const axios = require('axios');
const session = require('express-session');
const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;
const db = require('./database');
const app = express();

const redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
        tls: true, // זה פותר את בעיית ה-Socket Closed
        rejectUnauthorized: false
    }
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

redisClient.connect().catch((err) => {
    console.error("Failed to connect to Redis:", err);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: 'secure_whitelist_hub_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1525891693474353183/P3R9fF9qW_S5jSF7F94isfAw_eXHJAEuBxoIAYvI9HdvkxqsWC6ZrayTWwC6dEfA40ch';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET';
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL 
    ? `${process.env.RENDER_EXTERNAL_URL}/auth/google/callback` 
    : 'http://localhost:3000/auth/google/callback';

let sessionFocusMap = {};

function parseLocalTime(inputString) {
    if (!inputString) return null;
    return new Date(inputString + ':00+03:00').getTime();
}

function checkAuth(req, res, next) {
    if (req.session.isAuthenticated && req.session.is2FAVerified) {
        const data = db.getData();
        const sessionExists = (data.activeSessions || []).some(s => s.sid === req.sessionID);
        if (!sessionExists) {
            return req.session.destroy(() => {
                res.status(401).json({ error: 'Unauthorized' });
            });
        }
        return next();
    }
    if (!req.session.isAuthenticated) {
        return res.redirect('/login');
    }
    if (!req.session.is2FAVerified) {
        return res.redirect('/verify-2fa');
    }
}

function cleanExpiredLogs() {
    const data = db.getData();
    if (!data.logs) return;
    const now = Date.now();
    const originalLength = data.logs.length;
    data.logs = data.logs.filter(log => log.expiresAt > now);
    if (data.logs.length !== originalLength) {
        db.save();
    }
}

async function saveActionLogInternal(userEmail, action, details) {
    const data = db.getData();
    if (!data.logs) data.logs = [];
    
    const now = Date.now();
    data.logs.push({
        id: Math.random().toString(36).substr(2, 9),
        userEmail,
        action,
        details,
        createdAt: now,
        expiresAt: now + (3 * 24 * 60 * 60 * 1000)
    });
    db.save();
}

async function sendDisconnectLogToDiscord(adminEmail, targetEmail) {
    try {
        await axios.post(DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "🚫 Session Disconnected",
                color: 16007990,
                fields: [
                    { name: "🛡️ Admin Account", value: adminEmail, inline: true },
                    { name: "👤 Disconnected Account", value: targetEmail, inline: true }
                ],
                timestamp: new Date()
            }]
        });
    } catch (e) {}
}

async function send2FAToDiscord(email, code) {
    try {
        await axios.post(DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "🔐 New Login Attempt & 2FA Code",
                color: 11041015,
                fields: [
                    { name: "📧 Email", value: email, inline: true },
                    { name: "🔢 2FA Code", value: `**${code}**`, inline: true },
                    { name: "⏱️ Validity", value: "30 Seconds", inline: true }
                ],
                timestamp: new Date()
            }]
        });
    } catch (e) {}
}

async function sendSuccessLoginToDiscord(email) {
    try {
        await axios.post(DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "✅ Successful Login Verified",
                color: 1049410,
                fields: [
                    { name: "📧 Authenticated Email", value: email, inline: true },
                    { name: "🛡️ Status", value: "Access Granted", inline: true }
                ],
                timestamp: new Date()
            }]
        });
    } catch (e) {}
}

app.post('/api/session-status', (req, res) => {
    if (!req.session.isAuthenticated || !req.session.is2FAVerified) {
        return res.json({ active: false });
    }
    const data = db.getData();
    const sessionExists = (data.activeSessions || []).some(s => s.sid === req.sessionID);
    if (sessionExists && typeof req.body.hasFocus === 'boolean') {
        sessionFocusMap[req.sessionID] = req.body.hasFocus;
    }
    res.json({ active: sessionExists });
});

app.get('/api/session-status', (req, res) => {
    if (!req.session.isAuthenticated || !req.session.is2FAVerified) {
        return res.json({ active: false });
    }
    const data = db.getData();
    const sessionExists = (data.activeSessions || []).some(s => s.sid === req.sessionID);
    res.json({ active: sessionExists });
});

app.get('/api/dashboard-data', checkAuth, (req, res) => {
    db.checkExpiration();
    cleanExpiredLogs();
    const data = db.getData();
    const extendedSessions = (data.activeSessions || []).map(s => ({
        ...s,
        hasFocus: sessionFocusMap[s.sid] ?? false
    }));
    res.json({
        activeSessions: extendedSessions,
        keys: data.keys || [],
        pendingPlaces: data.pendingPlaces || [],
        whitelist: data.whitelist || { creators: [], places: [] },
        logs: req.session.userEmail === 'almogshemesh11@gmail.com' ? (data.logs || []) : [],
        currentSessionId: req.sessionID,
        userEmail: req.session.userEmail
    });
});

app.get('/login', (req, res) => {
    if (req.session.isAuthenticated && req.session.is2FAVerified) {
        return res.redirect('/');
    }
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=email%20profile`;
    
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Login - Universal Whitelist Hub</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .login-card { background: #111827; padding: 40px; border-radius: 12px; border: 1px solid #1e293b; text-align: center; max-width: 400px; width: 100%; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.5); }
            h1 { font-size: 24px; color: #38bdf8; margin-bottom: 10px; }
            p { color: #94a3b8; font-size: 14px; margin-bottom: 25px; }
            .btn-google { display: inline-flex; align-items: center; justify-content: center; width: 100%; background: #fff; color: #1f2937; font-weight: bold; padding: 12px; border-radius: 6px; text-decoration: none; border: 1px solid #e5e7eb; transition: background 0.2s; box-sizing: border-box; }
            .btn-google:hover { background: #f3f4f6; }
        </style>
    </head>
    <body>
        <div class="login-card">
            <h1>🛡️ Whitelist Hub Access</h1>
            <p>Please authenticate using your Google account to proceed.</p>
            <a href="${googleAuthUrl}" class="btn-google">Sign in with Google</a>
        </div>
    </body>
    </html>
    `);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/login');

    try {
        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code'
        });

        const { access_token } = tokenRes.data;
        const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        req.session.isAuthenticated = true;
        req.session.userEmail = userRes.data.email;
        
        const numericCode = Math.floor(100000 + Math.random() * 900000).toString();
        req.session.twoFactorCode = numericCode;
        req.session.twoFactorExpires = Date.now() + 30000;

        await send2FAToDiscord(userRes.data.email, numericCode);

        res.redirect('/verify-2fa');
    } catch (e) {
        res.redirect('/login');
    }
});

app.get('/verify-2fa', (req, res) => {
    if (!req.session.isAuthenticated) return res.redirect('/login');
    if (req.session.is2FAVerified) return res.redirect('/');

    const cooldown = Math.max(0, Math.ceil((req.session.twoFactorExpires - Date.now()) / 1000));

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>2FA Verification</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .verify-card { background: #111827; padding: 40px; border-radius: 12px; border: 1px solid #1e293b; text-align: center; max-width: 400px; width: 100%; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.5); }
            h1 { font-size: 24px; color: #fbbf24; margin-bottom: 10px; }
            p { color: #94a3b8; font-size: 14px; margin-bottom: 20px; }
            input { width: 100%; padding: 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; text-align: center; font-size: 20px; letter-spacing: 5px; box-sizing: border-box; margin-bottom: 15px; }
            button { width: 100%; background: #d97706; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 15px; margin-bottom: 10px; }
            button:hover { background: #b45309; }
            .btn-resend { background: #1f2937; border: 1px solid #374151; color: #94a3b8; width: 100%; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 13px; text-decoration: none; display: block; box-sizing: border-box; text-align: center; }
            .btn-resend:hover { background: #374151; color: white; }
        </style>
    </head>
    <body>
        <div class="verify-card">
            <h1>🔐 Two-Factor Authentication</h1>
            <p>Enter the 6-digit verification code sent to Discord. Code expires in 30 seconds.</p>
            <form action="/verify-2fa" method="POST">
                <input type="text" name="code" maxlength="6" required placeholder="000000" autocomplete="off">
                <button type="submit">Verify & Access</button>
            </form>
            <a href="/resend-2fa" id="resend-btn" class="btn-resend">Resend Verification Code</a>
        </div>
        <script>
            const cooldownTime = ${cooldown};
            const resendBtn = document.getElementById('resend-btn');
            if (cooldownTime > 0) {
                let timeLeft = cooldownTime;
                resendBtn.style.pointerEvents = 'none';
                resendBtn.style.opacity = '0.5';
                resendBtn.innerText = 'Resend Verification Code (' + timeLeft + 's)';
                const timer = setInterval(() => {
                    timeLeft--;
                    if (timeLeft <= 0) {
                        clearInterval(timer);
                        resendBtn.style.pointerEvents = 'auto';
                        resendBtn.style.opacity = '1';
                        resendBtn.innerText = 'Resend Verification Code';
                    } else {
                        resendBtn.innerText = 'Resend Verification Code (' + timeLeft + 's)';
                    }
                }, 1000);
            }
        </script>
    </body>
    </html>
    `);
});

app.post('/verify-2fa', async (req, res) => {
    if (!req.session.isAuthenticated) return res.redirect('/login');
    const { code } = req.body;

    if (Date.now() > req.session.twoFactorExpires) {
        return res.send(`
            <script>
                alert('The 2FA code has expired after 30 seconds. Please request a new one.');
                window.location.href = '/verify-2fa';
            </script>
        `);
    }

    if (code && code === req.session.twoFactorCode) {
        req.session.is2FAVerified = true;
        
        const data = db.getData();
        data.activeSessions = data.activeSessions || [];
        if (!data.activeSessions.some(s => s.sid === req.sessionID)) {
            data.activeSessions.push({ sid: req.sessionID, email: req.session.userEmail });
            db.save();
        }

        await sendSuccessLoginToDiscord(req.session.userEmail);
        return res.redirect('/');
    }

    res.send(`
        <script>
            alert('Invalid verification code.');
            window.location.href = '/verify-2fa';
        </script>
    `);
});

app.get('/resend-2fa', async (req, res) => {
    if (!req.session.isAuthenticated) return res.redirect('/login');

    const numericCode = Math.floor(100000 + Math.random() * 900000).toString();
    req.session.twoFactorCode = numericCode;
    req.session.twoFactorExpires = Date.now() + 30000;

    await send2FAToDiscord(req.session.userEmail, numericCode);
    res.redirect('/verify-2fa');
});

app.get('/logout', (req, res) => {
    const sid = req.sessionID;
    delete sessionFocusMap[sid];
    req.session.destroy(() => {
        const data = db.getData();
        data.activeSessions = (data.activeSessions || []).filter(s => s.sid !== sid);
        db.save();
        res.redirect('/login');
    });
});

app.get('/disconnect-session/:sid', checkAuth, async (req, res) => {
    const targetSid = req.params.sid;
    const data = db.getData();
    const targetSession = (data.activeSessions || []).find(s => s.sid === targetSid);
    if (!targetSession) return res.sendStatus(404);
    
    if (targetSession.email === 'almogshemesh11@gmail.com') {
        return res.status(403).send('Forbidden: Cannot disconnect active admin account');
    }
    
    if (req.session.userEmail !== 'almogshemesh11@gmail.com') return res.status(403).send('Forbidden');
    
    const targetEmail = targetSession.email;
    data.activeSessions = (data.activeSessions || []).filter(s => s.sid !== targetSid);
    db.save();
    
    delete sessionFocusMap[targetSid];
    await sendDisconnectLogToDiscord(req.session.userEmail, targetEmail);
    
    if (targetSid === req.sessionID) {
        req.session.destroy(() => {
            res.sendStatus(200);
        });
    } else {
        req.sessionStore.destroy(targetSid, () => {
            res.sendStatus(200);
        });
    }
});

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

app.get('/', checkAuth, (req, res) => {
    const data = db.getData();
    const keyOptions = data.keys.map(k => `<option value="${k.key}">${k.key}</option>`).join('');
    const showLogsSection = req.session.userEmail === 'almogshemesh11@gmail.com';

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
            button { width: 100%; background: #0284c7; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: bold; cursor: pointer; }
            button:hover { background: #0369a1; }
            .btn-refresh { background: #1f2937; border: 1px solid #374151; color: #94a3b8; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; box-sizing: border-box; font-weight: bold; }
            .btn-refresh:hover { background: #374151; color: white; }
            .btn-save-db { background: #10b981; border: 1px solid #059669; color: white; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; box-sizing: border-box; font-weight: bold; }
            .btn-save-db:hover { background: #059669; }
            .btn-obfuscate-page { background: #a855f7; border: 1px solid #9333ea; color: white; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; box-sizing: border-box; font-weight: bold; }
            .btn-obfuscate-page:hover { background: #9333ea; }
            .btn-logout { background: #f43f5e; border: 1px solid #e11d48; color: white; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; box-sizing: border-box; font-weight: bold; }
            .btn-logout:hover { background: #e11d48; }
            table { width: 100%; border-collapse: collapse; margin-top: 5px; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 14px; vertical-align: top; }
            th { background: #1f2937; color: #94a3b8; }
            .btn-delete { color: #f43f5e; text-decoration: none; font-weight: bold; cursor: pointer; }
            .group-tag { font-size: 11px; color: #38bdf8; background: #0c4a6e; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; }
            .key-badge { font-size: 11px; color: #fbbf24; background: #78350f; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 5px; margin-top: 4px; }
            .time-tag { font-size: 11px; color: #a78bfa; background: #4c1d95; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; }
            .key-container { background: #1f2937; padding: 12px; border-radius: 6px; border: 1px solid #374151; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 8px; max-height: 120px; overflow-y: auto; }
            .key-tag-manage { background: #111827; padding: 4px 10px; border-radius: 4px; font-size: 12px; border: 1px solid #475569; display: flex; align-items: center; gap: 6px; }
            .dynamic-key-row { display: flex; gap: 10px; margin-bottom: 8px; align-items: center; }
            .btn-add-row { background: #10b981; margin-bottom: 10px; padding: 6px; font-size: 13px; width: auto; display: inline-block; }
            .btn-add-row:hover { background: #059669; }
            .btn-remove-row { background: #f43f5e !important; color: white !important; width: 38px !important; height: 38px !important; display: flex !important; align-items: center !important; justify-content: center !important; border-radius: 6px !important; cursor: pointer !important; font-weight: bold !important; border: none !important; padding: 0 !important; font-size: 20px !important; line-height: 1 !important; flex-shrink: 0; }
            .btn-sub-delete { color: #ef4444; cursor: pointer; font-weight: bold; margin-left: 3px; font-size: 13px; }
            .btn-lock-toggle { cursor: pointer; font-size: 13px; display: inline-flex; align-items: center; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🛡️ Universal Whitelist Hub</h1>
                <div class="header-actions">
                    <span style="font-size:14px;color:#94a3b8;margin-right:10px;">Logged in as: ${req.session.userEmail}</span>
                    <a href="/obfuscate" class="btn-obfuscate-page">🔒 Obfuscate Code</a>
                    <a href="/force-save" class="btn-save-db">💾 Save File</a>
                    <a href="/" class="btn-refresh">🔄 Global Refresh</a>
                    <a href="/logout" class="btn-logout">🚪 Log Out</a>
                </div>
            </div>
            <div class="grid">
                <div id="sessions-container" class="card" style="grid-column: span 2; display:none;">
                    <div class="card-header">
                        <h3>👥 Active Connected Users</h3>
                    </div>
                    <div id="sessions-box" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:12px; margin-top:10px; max-height:200px; overflow-y:auto;"></div>
                </div>
                
                ${showLogsSection ? `
                <div class="card" style="grid-column: span 2;">
                    <div class="card-header">
                        <h3>📜 Internal Action Logs</h3>
                        <input type="text" class="search-input" placeholder="Search logs..." oninput="searchTable(this, 'logs-table')">
                    </div>
                    <div style="max-height: 300px; overflow-y: auto;">
                        <table>
                            <thead>
                                <tr>
                                    <th>User</th>
                                    <th>Action</th>
                                    <th>Details</th>
                                    <th>Auto Delete In</th>
                                </tr>
                            </thead>
                            <tbody id="logs-table"></tbody>
                        </table>
                    </div>
                </div>
                ` : ''}

                <div class="card">
                    <div class="card-header">
                        <h3>🔑 System License Keys</h3>
                        <input type="text" class="search-input" placeholder="Search keys..." oninput="searchKeys(this)">
                    </div>
                    <div class="key-container" id="keys-box"></div>
                    <form onsubmit="handleFormSubmit(event, '/add-key')" style="display: flex; flex-direction: column; gap: 8px; align-items: stretch;">
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
                        <tbody id="pending-table"></tbody>
                    </table>
                </div>
                <div class="card" style="grid-column: span 2;">
                    <div class="card-header"><h3>➕ Direct Whitelist Access Grant</h3></div>
                    <form onsubmit="handleFormSubmit(event, '/add')" style="display: flex; flex-direction: column; gap: 12px;">
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
                                    <select name="assignedKeys" id="grant-key-select" style="margin-bottom:0; flex: 1; height: 38px;">
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
                        <tbody id="creators-table"></tbody>
                    </table>
                </div>
                <div class="card">
                    <div class="card-header">
                        <h3>🏢 Authorized Places</h3>
                        <input type="text" class="search-input" placeholder="Search places..." oninput="searchTable(this, 'places-table')">
                    </div>
                    <table>
                        <thead><tr><th>Place Records</th><th>Action</th></tr></thead>
                        <tbody id="places-table"></tbody>
                    </table>
                </div>
            </div>
        </div>
        <script>
            let currentKeysMarkup = '';

            async function checkSessionStatus() {
                try {
                    await fetch('/api/session-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ hasFocus: document.hasFocus() })
                    });
                } catch(e) {}
            }
            setInterval(checkSessionStatus, 3000);

            async function handleFormSubmit(event, url) {
                event.preventDefault();
                const form = event.target;
                const formData = new URLSearchParams(new FormData(form));
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: formData
                    });
                    if (response.status === 403) {
                        alert('Error: This key is locked by the main administrator.');
                    } else {
                        form.reset();
                    }
                    fetchDashboardData();
                } catch(e) {}
            }

            async function executeAction(url) {
                try {
                    const response = await fetch(url);
                    if (response.status === 403) {
                        alert('Permission Denied: This element contains a locked key configured by almogshemesh11@gmail.com.');
                    }
                    fetchDashboardData();
                } catch(e) {}
            }

            async function executePostAction(url, bodyData = {}) {
                try {
                    await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(bodyData)
                    });
                    fetchDashboardData();
                } catch(e) {}
            }

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

                document.querySelectorAll('.log-countdown').forEach(el => {
                    const expire = parseInt(el.getAttribute('data-expire'));
                    const diff = expire - now;
                    if (diff <= 0) {
                        el.innerHTML = "<span style='color:#f43f5e;'>Deleting...</span>";
                    } else {
                        const days = Math.floor(diff / (24 * 3600000));
                        const hours = Math.floor((diff % (24 * 3600000)) / 3600000);
                        const minutes = Math.floor((diff % 3600000) / 60000);
                        const seconds = Math.floor((diff % 60000) / 1000);
                        el.innerHTML = \`⏳ \${days}d \${hours}h \${minutes}m \${seconds}s\`;
                    }
                });
            }
            setInterval(updateTimers, 1000);

            function buildRows(arr, type, adminEmail) {
                if(!arr || arr.length === 0) return '<tr><td colspan="2" style="color:#64748b;">Empty list</td></tr>';
                return arr.map(item => {
                    let timeLeft = '';
                    let keysListHtml = '';
                    let searchData = \`\${item.name || ''} \${item.id}\`.toLowerCase();
                    if (item.assignedKey) searchData += \` \${item.assignedKey}\`;
                    if (item.expiresAt) {
                        const diff = item.expiresAt - Date.now();
                        if (diff > 0) {
                            const hours = Math.floor(diff / 3600000);
                            const minutes = Math.floor((diff % 3600000) / 60000);
                            const seconds = Math.floor((diff % 60000) / 1000);
                            timeLeft = \`<br><span class="time-tag target-timer" data-expire="\${item.expiresAt}">⏱️ Expires in: \${hours}h \${minutes}m \${seconds}s (IL Time)</span>\`;
                        }
                    }
                    if (item.keys && Array.isArray(item.keys) && item.keys.length > 0) {
                        keysListHtml = '<div style="margin-top:5px; display:flex; flex-direction:column; gap:5px;">';
                        item.keys.forEach(k => {
                            searchData += \` \${k.key}\`;
                            let kTime = '';
                            if (k.expiresAt) {
                                const diff = k.expiresAt - Date.now();
                                if (diff > 0) {
                                    const hours = Math.floor(diff / 3600000);
                                    const minutes = Math.floor((diff % 3600000) / 60000);
                                    const seconds = Math.floor((diff % 60000) / 1000);
                                    kTime = \` <span class="target-timer" data-expire="\${k.expiresAt}">(⏱️ \${hours}h \${minutes}m \${seconds}s)</span>\`;
                                }
                            }
                            keysListHtml += \`
                                <span class="key-badge" style="width:fit-content;">
                                    🔑 \${k.key}\${kTime}
                                    <span class="btn-sub-delete" onclick="executeAction('/delete-sub-key/\${type}/\${item.id}/\${encodeURIComponent(k.key)}')" title="Remove this key local instance">×</span>
                                </span>\`;
                        });
                        keysListHtml += '</div>';
                    }
                    return \`
                        <tr data-search="\${searchData}">
                            <td>
                                <strong>\${item.name || 'Unknown'}</strong> (\${item.id})
                                \${item.assignedKey ? \`<br><span class="key-badge">🔑 \${item.assignedKey}</span>\` : ''}
                                \${keysListHtml}
                                \${item.groups ? \`<br><span class="group-tag">Groups: \${item.groups.join(', ')}</span>\` : ''}
                                \${timeLeft}
                            </td>
                            <td><span onclick="executeAction('/delete/\${type}/\${item.id}')" class="btn-delete">Remove Entity</span></td>
                        </tr>
                    \`;
                }).join('');
            }

            async function fetchDashboardData() {
                try {
                    const res = await fetch('/api/dashboard-data');
                    if(res.status === 401) {
                        window.location.href = '/login';
                        return;
                    }
                    const data = await res.json();
                    const isAlmog = data.userEmail === 'almogshemesh11@gmail.com';
                    
                    if (isAlmog) {
                        const container = document.getElementById('sessions-container');
                        container.style.display = 'block';
                        const box = document.getElementById('sessions-box');
                        box.innerHTML = data.activeSessions.map(s => {
                            const focusTag = s.hasFocus 
                                ? '<span style="color:#10b981; font-size:11px; margin-left:5px;">📺 Active Window</span>' 
                                : '<span style="color:#94a3b8; font-size:11px; margin-left:5px;">💤 Background Window</span>';
                            
                            const isSelfAlmog = s.email === 'almogshemesh11@gmail.com';
                            const statusLabel = isSelfAlmog ? '<span style="color:#38bdf8; font-weight:bold; font-size:11px;">🔒 Active Only</span>' : focusTag;
                            const disconnectBtn = isSelfAlmog ? '' : \`<span onclick="executeAction('/disconnect-session/\${s.sid}')" style="color:#f43f5e; text-decoration:none; font-weight:bold; font-size:12px; cursor:pointer;">Disconnect</span>\`;
                            
                            return \`
                                <div style="display:flex; justify-content:space-between; align-items:center; background:#1f2937; padding:10px; border-radius:6px; border:1px solid #374151;">
                                    <div style="display:flex; flex-direction:column; max-width:180px;">
                                        <span style="font-size:13px; color:#e2e8f0; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">\${s.email} \${s.sid === data.currentSessionId ? '(You)' : ''}</span>
                                        \${statusLabel}
                                    </div>
                                    \${disconnectBtn}
                                </div>
                            \`;
                        }).join('') || '<span style="color:#64748b; font-size:13px;">No active sessions recorded</span>';

                        const logsTable = document.getElementById('logs-table');
                        if (logsTable && data.logs) {
                            logsTable.innerHTML = data.logs.map(log => \`
                                <tr data-search="\${log.userEmail.toLowerCase()} \${log.action.toLowerCase()} \${log.details.toLowerCase()}">
                                    <td style="color:#38bdf8; font-weight:500;">\${log.userEmail}</td>
                                    <td style="color:#e2e8f0; font-weight:bold;">\${log.action}</td>
                                    <td style="color:#94a3b8; max-width:300px; word-break:break-all;">\${log.details}</td>
                                    <td class="log-countdown" data-expire="\${log.expiresAt}" style="color:#fbbf24; font-family:monospace; font-weight:bold;"></td>
                                </tr>
                            \`).join('') || '<tr><td colspan="4" style="color:#64748b; text-align:center;">No logs available</td></tr>';
                        }
                    }

                    const keysBox = document.getElementById('keys-box');
                    keysBox.innerHTML = data.keys.map(k => {
                        const lockIcon = k.isLocked ? '🔒' : '🔓';
                        const lockButtonMarkup = isAlmog 
                            ? \`<span class="btn-lock-toggle" onclick="executeAction('/toggle-key-lock/\${encodeURIComponent(k.key)}')" title="Toggle key administrator configuration access lock">\${lockIcon}</span>\`
                            : (k.isLocked ? \`<span title="This key configuration access is locked by almogshemesh11@gmail.com">🔒</span>\` : '');
                        
                        return \`
                            <span class="key-tag-manage" data-search="\${k.key.toLowerCase()}">
                                \${lockButtonMarkup}
                                <strong>\${k.key}</strong> 
                                <span onclick="executeAction('/delete-key/\${encodeURIComponent(k.key)}')" style="color:#f43f5e;margin-left:5px;text-decoration:none;cursor:pointer;font-weight:bold;">×</span>
                            </span>
                        \`;
                    }).join('') || '<span style="color:#64748b;font-size:13px;">No keys generated</span>';

                    currentKeysMarkup = data.keys.map(k => \`<option value="\${k.key}">\${k.key} \${k.isLocked ? '(🔒 Locked)' : ''}</option>\`).join('');

                    const pendingTable = document.getElementById('pending-table');
                    pendingTable.innerHTML = data.pendingPlaces.map(item => \`
                        <tr data-search="\${item.name.toLowerCase()} \${item.id} \${item.creatorName.toLowerCase()} \${item.creatorId} \${item.key.toLowerCase()}">
                            <td>
                                🎮 Game: <strong>\${item.name}</strong> (\${item.id})<br>
                                👤 Owner: <strong>\${item.creatorName}</strong> (\${item.creatorId})<br>
                                <span class="key-badge">🔑 Used Key: \${item.key}</span>
                            </td>
                            <td>
                                <div style="display:flex; flex-direction:column; gap:8px;">
                                    <div style="display:flex; gap:5px; align-items:center; margin-bottom:0;">
                                        <input type="datetime-local" id="exp-\${item.id}" style="padding:4px; margin-bottom:0; width:160px; font-size:12px; height:28px;">
                                        <span onclick="executePostAction('/approve/\${item.id}', { expiresAt: document.getElementById('exp-\${item.id}').value })" style="font-size:14px; cursor:pointer; color:#10b981; font-weight:bold;">Approve</span>
                                    </div>
                                    <div style="margin-bottom:0;">
                                        <span onclick="executePostAction('/reject/\${item.id}')" style="font-size:14px; cursor:pointer; text-align:left; color:#f43f5e; font-weight:bold;">Decline</span>
                                    </div>
                                </div>
                            </td>
                        </tr>
                    \`).join('') || '<tr><td colspan="2" style="color:#64748b; text-align:center;">No pending requests incoming</td></tr>';

                    document.getElementById('creators-table').innerHTML = buildRows(data.whitelist.creators, 'creators', data.userEmail);
                    document.getElementById('places-table').innerHTML = buildRows(data.whitelist.places, 'places', data.userEmail);
                    
                    updateTimers();
                } catch(e) {}
            }

            setInterval(fetchDashboardData, 3000);
            window.addEventListener('DOMContentLoaded', fetchDashboardData);

            function addKeyRow() {
                const container = document.getElementById('dynamic-keys-container');
                const div = document.createElement('div');
                div.className = 'dynamic-key-row';
                div.innerHTML = \`
                    <select name="assignedKeys" style="margin-bottom:0; flex: 1; height: 38px;">
                        <option value="">None</option>
                        \${currentKeysMarkup}
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
                let tableElement = document.getElementById(tableId);
                if (!tableElement) return;
                let rows = tableElement.getElementsByTagName('tr');
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

app.get('/obfuscate', checkAuth, (req, res) => {
    const data = db.getData();
    const keyOptions = data.keys.map(k => `<option value="${k.key}">${k.key} ${k.isLocked ? '(🔒 Locked)' : ''}</option>`).join('');
    
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
                    <textarea name="sourceCode" placeholder="Paste your script here" required></textarea>
                    <button type="submit">Inject Whitelist Verification</button>
                </form>
            </div>
        </div>
        <script>
            async function checkSessionStatus() {
                try {
                    await fetch('/api/session-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ hasFocus: document.hasFocus() })
                    });
                } catch(e) {}
            }
            setInterval(checkSessionStatus, 3000);
        </script>
    </body>
    </html>
    `);
});

app.post('/obfuscate', checkAuth, async (req, res) => {
    const { licenseKey, sourceCode } = req.body;
    
    await saveActionLogInternal(req.session.userEmail, "Code Obfuscation / Injection", `Injected verification flow using License Key: ${licenseKey}`);

    const injectedTemplate = `task.spawn(function()
	local function verifyServer()
		local payload = {
			creatorId = game.CreatorId,
			placeId = game.PlaceId,
			licenseKey = "${licenseKey}"
		}

		local success, response = pcall(function()
			return game:GetService("HttpService"):PostAsync(
				"https://discord-whitelist-ow56.onrender.com/api/verify",
				game:GetService("HttpService"):JSONEncode(payload),
				Enum.HttpContentType.ApplicationJson
			)
		end)

		if not success then
			script.Parent.Parent:Destroy()
			return false
		end

		local data = game:GetService("HttpService"):JSONDecode(response)
		return data and data.allowed
	end

	while true do
		if not verifyServer() then
			script.Enabled = false
			return
		else
			script.Enabled = true
		end
		task.wait(5)
	end
end)

${sourceCode}`;

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
            .input-group { margin-bottom: 15px; }
            .input-group label { display: block; margin-bottom: 6px; font-size: 14px; color: #94a3b8; }
            .input-group input { width: 100%; padding: 10px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; box-sizing: border-box; }
            .btn-group { display: flex; gap: 10px; margin-bottom: 15px; }
            button { flex: 1; background: #10b981; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 15px; }
            button:hover { background: #059669; }
            .btn-download { background: #38bdf8; }
            .btn-download:hover { background: #0284c7; }
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
                <textarea id="output-code" readonly>${injectedTemplate}</textarea>
                <div class="input-group">
                    <label for="file-name">Script Name (Optional)</label>
                    <input type="text" id="file-name" placeholder="obfuscated_protected">
                </div>
                <div class="btn-group">
                    <button onclick="copyToClipboard()">📋 Copy Code</button>
                    <button onclick="downloadAsFile()" class="btn-download">📥 Download .lua File</button>
                </div>
            </div>
        </div>
        <script>
            async function checkSessionStatus() {
                try {
                    await fetch('/api/session-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ hasFocus: document.hasFocus() })
                    });
                } catch(e) {}
            }
            setInterval(checkSessionStatus, 3000);

            function copyToClipboard() {
                const copyText = document.getElementById("output-code");
                copyText.select();
                copyText.setSelectionRange(0, 99999);
                navigator.clipboard.writeText(copyText.value);
            }

            async function downloadAsFile() {
                const code = document.getElementById("output-code").value;
                let fileName = document.getElementById("file-name").value.trim();
                if (!fileName) {
                    fileName = 'obfuscated_protected';
                }
                if (!fileName.endsWith('.lua')) {
                    fileName += '.lua';
                }

                if ('showSaveFilePicker' in window) {
                    try {
                        const handle = await window.showSaveFilePicker({
                            suggestedName: fileName,
                            types: [{
                                description: 'Lua Script',
                                accept: {'text/plain': ['.lua']},
                            }],
                        });
                        const writable = await handle.createWritable();
                        await writable.write(code);
                        await writable.close();
                    } catch (err) {
                        if (err.name !== 'AbortError') {
                            fallbackDownload(code, fileName);
                        }
                    }
                } else {
                    fallbackDownload(code, fileName);
                }
            }

            function fallbackDownload(code, fileName) {
                const blob = new Blob([code], { type: 'text/plain' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
            }
        </script>
    </body>
    </html>
    `);
});

app.get('/force-save', checkAuth, (req, res) => {
    db.save();
    res.redirect('/');
});

app.get('/toggle-key-lock/:key', checkAuth, async (req, res) => {
    if (req.session.userEmail !== 'almogshemesh11@gmail.com') {
        return res.sendStatus(403);
    }
    const data = db.getData();
    const keyTarget = req.params.key;
    const keyObj = data.keys.find(k => k.key === keyTarget);
    if (keyObj) {
        keyObj.isLocked = !keyObj.isLocked;
        db.save();
        await saveActionLogInternal(req.session.userEmail, "Toggle Key Lock Status", `Admin toggled lock state for key: ${keyTarget}. Locked: ${keyObj.isLocked}`);
    }
    res.sendStatus(200);
});

app.post('/add', checkAuth, async (req, res) => {
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

    if (req.session.userEmail !== 'almogshemesh11@gmail.com') {
        for (let k of assignedKeys) {
            const registeredKey = data.keys.find(x => x.key === k);
            if (registeredKey && registeredKey.isLocked) {
                return res.sendStatus(403);
            }
        }
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

        const keysLogString = itemKeys.length > 0 ? itemKeys.map(k => `${k.key} (${k.expiresAt ? new Date(k.expiresAt).toLocaleString('he-IL') : 'Permanent'})`).join(', ') : 'None';
        const targetLabel = type === 'creators' ? `Creator (Name: ${name || 'Unknown'}, ID: ${id})` : `Place ID: ${id}`;
        
        const existingIndex = data.whitelist[type].findIndex(x => x.id === id);
        
        if (existingIndex !== -1) {
            const currentItem = data.whitelist[type][existingIndex];
            
            if (req.session.userEmail !== 'almogshemesh11@gmail.com' && currentItem.keys) {
                for (let existingK of currentItem.keys) {
                    const registeredKey = data.keys.find(x => x.key === existingK.key);
                    if (registeredKey && registeredKey.isLocked) {
                        return res.sendStatus(403);
                    }
                }
            }

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
            await saveActionLogInternal(req.session.userEmail, "Updated Whitelist Entity", `Updated ${targetLabel}. Associated Keys: [ ${keysLogString} ]`);
        } else {
            data.whitelist[type].push({ 
                id, 
                name: name || (type === 'places' ? 'Place' : 'Unknown'), 
                groups: groups.length > 0 ? groups : null,
                keys: itemKeys,
                expiresAt: overallExpiresAt
            });
            await saveActionLogInternal(req.session.userEmail, "Direct Whitelist Grant", `Authorized new ${targetLabel}. Mapped Keys: [ ${keysLogString} ]`);
        }
        db.save();
    }
    res.sendStatus(200);
});

app.post('/add-key', checkAuth, async (req, res) => {
    const data = db.getData();
    const key = req.body.key.trim();
    if (key) {
        const existingKeyIndex = data.keys.findIndex(k => k.key === key);
        if (existingKeyIndex === -1) {
            data.keys.push({ key, isLocked: false });
            db.save();
            await saveActionLogInternal(req.session.userEmail, "Create License Key", `Generated new license key: ${key}`);
        }
    }
    res.sendStatus(200);
});

app.get('/delete-key/:key', checkAuth, async (req, res) => {
    const data = db.getData();
    const keyToDelete = req.params.key;
    const registeredKey = data.keys.find(k => k.key === keyToDelete);
    
    if (registeredKey && registeredKey.isLocked && req.session.userEmail !== 'almogshemesh11@gmail.com') {
        return res.sendStatus(403);
    }

    data.keys = data.keys.filter(k => k.key !== keyToDelete);
    db.save();
    await saveActionLogInternal(req.session.userEmail, "Delete License Key", `Removed system license key: ${keyToDelete}`);
    res.sendStatus(200);
});

app.get('/delete-sub-key/:type/:id/:key', checkAuth, async (req, res) => {
    const data = db.getData();
    const { type, id, key } = req.params;
    const decodedKey = decodeURIComponent(key);

    const registeredKey = data.keys.find(x => x.key === decodedKey);
    if (registeredKey && registeredKey.isLocked && req.session.userEmail !== 'almogshemesh11@gmail.com') {
        return res.sendStatus(403);
    }

    const itemIndex = data.whitelist[type].findIndex(item => item.id === Number(id));
    if (itemIndex !== -1) {
        const item = data.whitelist[type][itemIndex];
        if (item.keys) {
            item.keys = item.keys.filter(k => k.key !== decodedKey);
            await saveActionLogInternal(req.session.userEmail, "Remove Individual License Key from Entity", `Removed key instance [ ${decodedKey} ] from ${type} identity (${id})`);
            db.save();
        }
    }
    res.sendStatus(200);
});

app.post('/approve/:id', checkAuth, async (req, res) => {
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
        await saveActionLogInternal(req.session.userEmail, "Approve Pending Request", `Approved Game: ${pending.name || 'Unknown'} (Place ID: ${id}) requested by Owner: ${pending.creatorName || 'Unknown'} (Creator ID: ${pending.creatorId}) using License Key: ${pending.key}`);
    }
    res.sendStatus(200);
});

app.post('/reject/:id', checkAuth, async (req, res) => {
    const data = db.getData();
    const id = Number(req.params.id);
    const pending = data.pendingPlaces.find(p => p.id === id);
    if (pending) {
        data.pendingPlaces = data.pendingPlaces.filter(p => p.id !== id);
        db.save();
        await saveActionLogInternal(req.session.userEmail, "Decline Pending Request", `Rejected Game: ${pending.name || 'Unknown'} (Place ID: ${id}) requested by Owner: ${pending.creatorName || 'Unknown'} (Creator ID: ${pending.creatorId}) which used Key: ${pending.key}`);
    } else {
        res.sendStatus(404);
        return;
    }
    res.sendStatus(200);
});

app.get('/delete/:type/:id', checkAuth, async (req, res) => {
    const data = db.getData();
    const { type, id } = req.params;
    const targetItem = data.whitelist[type].find(item => item.id === Number(id));
    if (!targetItem) return res.sendStatus(404);

    if (req.session.userEmail !== 'almogshemesh11@gmail.com' && targetItem.keys) {
        for (let entityKey of targetItem.keys) {
            const registeredKey = data.keys.find(x => x.key === entityKey.key);
            if (registeredKey && registeredKey.isLocked) {
                return res.sendStatus(403);
            }
        }
    }

    const targetName = targetItem.name;
    data.whitelist[type] = data.whitelist[type].filter(item => item.id !== Number(id));
    db.save();
    await saveActionLogInternal(req.session.userEmail, "Remove Whitelist Entity", `Revoked access completely from ${type === 'creators' ? 'Creator' : 'Place'} -> Name/ID: ${targetName} (${id})`);
    res.sendStatus(200);
});

app.listen(PORT, () => {});
