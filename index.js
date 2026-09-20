const express = require('express');
const axios = require('axios');
const session = require('express-session');
const db = require('./database');
const app = express();
let isSaving = false;

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'secure_whitelist_hub_secret_key',
    resave: false,
    saveUninitialized: false,
    rolling: true, // extends cookie on every request while active
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — stay logged in
        sameSite: 'lax',
        httpOnly: true
    }
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

const OWNER_EMAIL = 'almogshemesh11@gmail.com';

const TRANSLATIONS = {
    en: {
        title: 'Universal Whitelist System',
        hub: 'Universal Whitelist Hub',
        maintenance: 'Maintenance',
        maintenanceOn: 'Maintenance ON',
        maintenanceBanner: 'MAINTENANCE MODE — all game verifies are denied until Owner turns this off',
        messages: 'Messages',
        obfuscate: 'Obfuscate',
        save: 'Save',
        load: 'Load',
        refresh: 'Refresh',
        logout: 'Logout',
        stats: 'Usage Statistics',
        totalChecks: 'Total Checks',
        allowed: 'Allowed',
        denied: 'Denied',
        allowed24h: 'Allowed (24h)',
        denied24h: 'Denied (24h)',
        activeUsers: 'Active Connected Users',
        logs: 'Internal Action Logs',
        searchLogs: 'Search logs...',
        user: 'User',
        action: 'Action',
        details: 'Details',
        autoDelete: 'Auto Delete In',
        systemKeys: 'System License Keys',
        searchKeys: 'Search keys...',
        keyPlaceholder: 'Key string (use ALL for full access)',
        markAll: 'Mark as ALL access key (Owner only)',
        createKey: 'Create Key',
        pending: 'Pending Game Requests',
        searchRequests: 'Search requests...',
        findByUsername: 'Find by username',
        robloxUsername: 'Roblox username...',
        requestMeta: 'Request Metadata',
        actionCol: 'Action',
        grantAccess: 'Direct Whitelist Access Grant',
        targetEntity: 'Target Entity',
        creators: 'Creator (User/Group)',
        places: 'Place ID',
        inputId: 'Username / ID / Place ID',
        assignKeys: 'Assign License Keys',
        addRow: '+ Add Key Row',
        grantBtn: 'Grant Access',
        authCreators: 'Authorized Creators',
        authPlaces: 'Authorized Places',
        searchCreators: 'Search creators...',
        searchPlaces: 'Search places...',
        identity: 'Identity / Metadata',
        freeze: 'Freeze',
        unfreeze: 'Unfreeze',
        remove: 'Remove',
        frozen: 'FROZEN',
        noKeys: 'No keys generated',
        noPending: 'No pending requests incoming',
        emptyList: 'Empty list',
        expiresIn: 'Expires in',
        mostUsedWeek: 'Most used keys this week',
        allTimePerKey: 'All-time per key',
        noWeekly: 'No weekly key usage yet (data builds as verifies come in)',
        noKeyUsage: 'No key usage yet',
        noSessions: 'No active sessions recorded',
        noLogs: 'No logs available',
        lang: 'Language',
        langEn: 'English',
        langHe: 'עברית',
        panelMessagesTitle: 'Panel Error Messages',
        defaultsTitle: 'Default messages by reason',
        defaultsHint: 'These appear on Roblox panels when access is denied. Use new lines for multi-line text. Leave blank to keep the built-in default.',
        saveDefaults: 'Save default messages',
        saved: 'Saved!',
        personalTitle: 'Personal messages',
        personalHint: 'Override the message for a specific key, place ID, or creator ID. Personal rules win over defaults.',
        scope: 'Scope',
        target: 'Target',
        message: 'Message',
        addPersonal: 'Add personal message',
        noPersonal: 'No personal messages yet',
        dashboard: 'Dashboard',
        onlyOwnerMaint: 'Only the Owner can toggle maintenance mode.',
        approve: 'Approve',
        reject: 'Reject',
        you: '(You)',
        disconnect: 'Disconnect'
    },
    he: {
        title: 'מערכת רשימת מורשים',
        hub: 'מרכז רשימת מורשים',
        maintenance: 'תחזוקה',
        maintenanceOn: 'תחזוקה פעילה',
        maintenanceBanner: 'מצב תחזוקה — כל האימותים מהמשחקים נדחים עד שהבעלים מכבה',
        messages: 'הודעות',
        obfuscate: 'עירפול',
        save: 'שמירה',
        load: 'טעינה',
        refresh: 'רענון',
        logout: 'יציאה',
        stats: 'סטטיסטיקות שימוש',
        totalChecks: 'סה״כ בדיקות',
        allowed: 'אושרו',
        denied: 'נדחו',
        allowed24h: 'אושרו (24ש׳)',
        denied24h: 'נדחו (24ש׳)',
        activeUsers: 'משתמשים מחוברים',
        logs: 'יומן פעולות פנימי',
        searchLogs: 'חיפוש ביומן...',
        user: 'משתמש',
        action: 'פעולה',
        details: 'פרטים',
        autoDelete: 'מחיקה אוטומטית בעוד',
        systemKeys: 'מפתחות רישיון מערכת',
        searchKeys: 'חיפוש מפתחות...',
        keyPlaceholder: 'מחרוזת מפתח (ALL = גישה מלאה)',
        markAll: 'סמן כמפתח ALL (Owner בלבד)',
        createKey: 'יצירת מפתח',
        pending: 'בקשות משחק ממתינות',
        searchRequests: 'חיפוש בקשות...',
        findByUsername: 'חיפוש לפי שם משתמש',
        robloxUsername: 'שם משתמש ברובלוקס...',
        requestMeta: 'פרטי בקשה',
        actionCol: 'פעולה',
        grantAccess: 'הענקת גישה ישירה',
        targetEntity: 'ישות יעד',
        creators: 'יוצר (משתמש/קבוצה)',
        places: 'מזהה מפה',
        inputId: 'שם משתמש / ID / Place ID',
        assignKeys: 'שיוך מפתחות רישיון',
        addRow: '+ הוסף שורת מפתח',
        grantBtn: 'הענק גישה',
        authCreators: 'יוצרים מורשים',
        authPlaces: 'מפות מורשות',
        searchCreators: 'חיפוש יוצרים...',
        searchPlaces: 'חיפוש מפות...',
        identity: 'זהות / מטא־דאטה',
        freeze: 'הקפאה',
        unfreeze: 'הפשרה',
        remove: 'הסרה',
        frozen: 'מוקפא',
        noKeys: 'לא נוצרו מפתחות',
        noPending: 'אין בקשות ממתינות',
        emptyList: 'הרשימה ריקה',
        expiresIn: 'פג תוקף בעוד',
        mostUsedWeek: 'המפתחות הכי בשימוש השבוע',
        allTimePerKey: 'סה״כ לפי מפתח',
        noWeekly: 'אין עדיין שימוש שבועי (מתעדכן עם אימותים)',
        noKeyUsage: 'אין עדיין שימוש במפתחות',
        noSessions: 'אין סשנים פעילים',
        noLogs: 'אין רשומות ביומן',
        lang: 'שפה',
        langEn: 'English',
        langHe: 'עברית',
        panelMessagesTitle: 'הודעות שגיאה בפאנלים',
        defaultsTitle: 'הודעות ברירת מחדל לפי סיבה',
        defaultsHint: 'מוצגות בפאנלים ברובלוקס כשנדחית גישה. שורה חדשה = שורה חדשה. ריק = ברירת מחדל מובנית.',
        saveDefaults: 'שמור הודעות ברירת מחדל',
        saved: 'נשמר!',
        personalTitle: 'הודעות אישיות',
        personalHint: 'דריסה להודעה לפי מפתח, Place ID או Creator ID. כלל אישי גובר על ברירת המחדל.',
        scope: 'היקף',
        target: 'יעד',
        message: 'הודעה',
        addPersonal: 'הוסף הודעה אישית',
        noPersonal: 'אין עדיין הודעות אישיות',
        dashboard: 'לוח בקרה',
        onlyOwnerMaint: 'רק הבעלים יכול להפעיל/לכבות מצב תחזוקה.',
        approve: 'אישור',
        reject: 'דחייה',
        you: '(אתה)',
        disconnect: 'ניתוק'
    }
};

function getLang(req) {
    const l = req.session && req.session.lang;
    return l === 'he' ? 'he' : 'en';
}

function t(req, key) {
    const lang = getLang(req);
    return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS.en[key] || key;
}

const DEFAULT_PANEL_MESSAGES = {
    maintenance: 'System is under maintenance.\nAccess is temporarily blocked.\nPlease try again later.',
    invalid_key: 'Invalid license key.\nAccess denied.',
    key_frozen: 'This license key has been frozen.\nAccess is blocked until it is restored.',
    entity_frozen: 'Access to this place/creator has been frozen.\nContact the administrator.',
    tag_frozen: 'The license for this product has been frozen.\nThis tag is locked until unfrozen.',
    tag_expired: 'This license has expired.\nRenew the license to restore access.',
    pending: 'Your request is pending approval.\nAccess has not been granted yet.',
    not_whitelisted: 'Not authorized for this place.\nContact the administrator for access.',
    missing_ids: 'Missing creatorId or placeId.'
};

function getPanelMessages(data) {
    const stored = (data && data.panelMessages) || {};
    const out = { ...DEFAULT_PANEL_MESSAGES };
    for (const k of Object.keys(DEFAULT_PANEL_MESSAGES)) {
        if (typeof stored[k] === 'string' && stored[k].trim()) out[k] = stored[k];
    }
    return out;
}

/** Custom personal messages: { id, scope: 'key'|'place'|'creator', target, message } */
function resolvePanelMessage(data, reason, { licenseKey, placeId, creatorId } = {}) {
    const customs = (data && data.customPanelMessages) || [];
    // Priority: key > place > creator
    if (licenseKey) {
        const hit = customs.find(c => c.scope === 'key' && String(c.target) === String(licenseKey));
        if (hit && hit.message) return hit.message;
    }
    if (placeId != null) {
        const hit = customs.find(c => c.scope === 'place' && String(c.target) === String(placeId));
        if (hit && hit.message) return hit.message;
    }
    if (creatorId != null) {
        const hit = customs.find(c => c.scope === 'creator' && String(c.target) === String(creatorId));
        if (hit && hit.message) return hit.message;
    }
    const msgs = getPanelMessages(data);
    return msgs[reason] || DEFAULT_PANEL_MESSAGES[reason] || 'Access denied.';
}

function isBadMetaName(n) {
    return !n ||
        n === '[TITLE UNAVAILABLE]' ||
        n === '[DESCRIPTION UNAVAILABLE]' ||
        n === '[UNKNOWN]' ||
        n === 'Unknown' ||
        n === 'Unknown Place' ||
        n === 'Place' ||
        n === 'Approved Place';
}

function isAllAccessKey(keyObj, keyStr) {
    if (keyObj && keyObj.isAllAccess) return true;
    if (keyStr && String(keyStr).toUpperCase() === 'ALL') return true;
    return false;
}

function entityHasAllAccess(item, data) {
    if (!item || item.frozen) return false;
    const now = Date.now();
    const keys = data.keys || [];
    if (item.keys && Array.isArray(item.keys)) {
        return item.keys.some(k => {
            if (k.frozen) return false;
            if (k.expiresAt && k.expiresAt <= now) return false;
            const reg = keys.find(x => x.key === k.key);
            if (reg && reg.frozen) return false;
            return isAllAccessKey(reg, k.key);
        });
    }
    if (item.assignedKey) {
        const reg = keys.find(x => x.key === item.assignedKey);
        if (reg && reg.frozen) return false;
        return isAllAccessKey(reg, item.assignedKey);
    }
    return false;
}

function ensureStats(data) {
    if (!data.stats) {
        data.stats = { total: 0, allowed: 0, denied: 0, byKey: {}, byPlace: {}, recent: [] };
    }
    if (!data.stats.byKey) data.stats.byKey = {};
    if (!data.stats.byPlace) data.stats.byPlace = {};
    if (!Array.isArray(data.stats.recent)) data.stats.recent = [];
}

function recordVerifyStat(data, { allowed, licenseKey, placeId }) {
    ensureStats(data);
    data.stats.total = (data.stats.total || 0) + 1;
    if (allowed) data.stats.allowed = (data.stats.allowed || 0) + 1;
    else data.stats.denied = (data.stats.denied || 0) + 1;

    if (licenseKey) {
        if (!data.stats.byKey[licenseKey]) data.stats.byKey[licenseKey] = { allowed: 0, denied: 0 };
        data.stats.byKey[licenseKey][allowed ? 'allowed' : 'denied']++;
    }
    if (placeId != null) {
        const pid = String(placeId);
        if (!data.stats.byPlace[pid]) data.stats.byPlace[pid] = { allowed: 0, denied: 0 };
        data.stats.byPlace[pid][allowed ? 'allowed' : 'denied']++;
    }
    data.stats.recent.push({
        t: Date.now(),
        allowed: !!allowed,
        key: licenseKey || null,
        placeId: placeId != null ? String(placeId) : null
    });
    // Keep 7 days of recent events (for weekly key ranking)
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    data.stats.recent = data.stats.recent.filter(e => e.t > cutoff);
}

function formatIlDate(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    } catch (_) {
        return new Date(ts).toLocaleString('he-IL');
    }
}

/** Resolve place name + creator display (works for private games via develop API). */
async function resolvePlaceMeta(placeId, creatorId) {
    let placeName = 'Unknown Place';
    let creatorName = 'Unknown';
    let resolvedCreatorId = creatorId ? Number(creatorId) : null;

    try {
        const uniRes = await axios.get(
            `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
            { timeout: 8000 }
        );
        const universeId = uniRes.data && uniRes.data.universeId;

        if (universeId) {
            try {
                const devRes = await axios.get(
                    `https://develop.roblox.com/v1/universes/${universeId}`,
                    { timeout: 8000 }
                );
                const u = devRes.data;
                if (u) {
                    if (u.name && !isBadMetaName(u.name)) placeName = u.name;
                    if (u.creatorTargetId) resolvedCreatorId = Number(u.creatorTargetId);
                    if (u.creatorName && !isBadMetaName(u.creatorName)) {
                        if (u.creatorType === 'Group') {
                            try {
                                const gRes = await axios.get(
                                    `https://groups.roblox.com/v1/groups/${u.creatorTargetId}`,
                                    { timeout: 8000 }
                                );
                                const gName = (gRes.data && gRes.data.name) || u.creatorName;
                                const ownerName =
                                    gRes.data && gRes.data.owner && (gRes.data.owner.username || gRes.data.owner.name);
                                creatorName = ownerName ? `${ownerName} | ${gName}` : gName;
                            } catch (_) {
                                creatorName = u.creatorName;
                            }
                        } else {
                            creatorName = u.creatorName;
                        }
                    }
                }
            } catch (_) {}

            if (isBadMetaName(placeName) || isBadMetaName(creatorName)) {
                try {
                    const gameRes = await axios.get(
                        `https://games.roblox.com/v1/games?universeIds=${universeId}`,
                        { timeout: 8000 }
                    );
                    const game = gameRes.data && gameRes.data.data && gameRes.data.data[0];
                    if (game) {
                        if (game.name && !isBadMetaName(game.name)) placeName = game.name;
                        if (game.creator) {
                            if (game.creator.id) resolvedCreatorId = Number(game.creator.id);
                            if (isBadMetaName(creatorName)) {
                                if (game.creator.type === 'Group') {
                                    try {
                                        const gRes = await axios.get(
                                            `https://groups.roblox.com/v1/groups/${game.creator.id}`,
                                            { timeout: 8000 }
                                        );
                                        const gName = (gRes.data && gRes.data.name) || game.creator.name;
                                        const ownerName =
                                            gRes.data && gRes.data.owner && (gRes.data.owner.username || gRes.data.owner.name);
                                        creatorName = ownerName ? `${ownerName} | ${gName}` : (gName || game.creator.name);
                                    } catch (_) {
                                        if (game.creator.name && !isBadMetaName(game.creator.name)) {
                                            creatorName = game.creator.name;
                                        }
                                    }
                                } else if (game.creator.name && !isBadMetaName(game.creator.name)) {
                                    creatorName = game.creator.name;
                                }
                            }
                        }
                    }
                } catch (_) {}
            }
        }
    } catch (_) {}

    if (isBadMetaName(creatorName) && resolvedCreatorId) {
        try {
            const userRes = await axios.get(
                `https://users.roblox.com/v1/users/${resolvedCreatorId}`,
                { timeout: 5000 }
            );
            if (userRes.data && userRes.data.name) {
                creatorName = userRes.data.displayName && userRes.data.displayName !== userRes.data.name
                    ? `${userRes.data.name} (${userRes.data.displayName})`
                    : userRes.data.name;
            }
        } catch (_) {
            try {
                const gRes = await axios.get(
                    `https://groups.roblox.com/v1/groups/${resolvedCreatorId}`,
                    { timeout: 5000 }
                );
                if (gRes.data) {
                    const gName = gRes.data.name || `Group ${resolvedCreatorId}`;
                    const ownerName =
                        gRes.data.owner && (gRes.data.owner.username || gRes.data.owner.name);
                    creatorName = ownerName ? `${ownerName} | ${gName}` : gName;
                }
            } catch (__) {}
        }
    }

    return { placeName, creatorName, creatorId: resolvedCreatorId };
}

function checkAuth(req, res, next) {
    if (req.session.isAuthenticated && req.session.is2FAVerified) {
        return next();
    }
    if (!req.session.isAuthenticated) {
        return res.redirect('/login');
    }
    if (!req.session.is2FAVerified) {
        return res.redirect('/verify-2fa');
    }
}

async function cleanExpiredLogs() {
    const data = db.getData();
    if (!data.logs) return;
    const now = Date.now();
    const originalLength = data.logs.length;
    data.logs = data.logs.filter(log => log.expiresAt > now);
    if (data.logs.length !== originalLength) {
        await safeSave();
    }
}

async function saveActionLogInternal(userEmail, action, details) {
    if (userEmail === 'almogshemesh11@gmail.com') return;
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
    await safeSave();
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
    if (req.session.userEmail === 'almogshemesh11@gmail.com') {
        return res.json({ active: true });
    }
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

app.get('/api/dashboard-data', checkAuth, async (req, res) => {
    db.checkExpiration();
    await cleanExpiredLogs();
    const data = db.getData();

    // Guard against duplicate entries for the same email ever reaching the UI,
    // and self-heal the stored data if duplicates slipped in (e.g. from a past bug).
    if (data.activeSessions && data.activeSessions.length > 0) {
        const uniqueByEmail = new Map();
        data.activeSessions.forEach(s => uniqueByEmail.set(s.email, s));
        const deduped = Array.from(uniqueByEmail.values());
        if (deduped.length !== data.activeSessions.length) {
            data.activeSessions = deduped;
            await safeSave();
        }
    }

    // Refresh missing / bad names for pending + authorized places (a few per request)
    let namesChanged = false;
    try {
        const pendingToFix = (data.pendingPlaces || []).filter(
            p => isBadMetaName(p.name) || isBadMetaName(p.creatorName)
        ).slice(0, 5);
        for (const p of pendingToFix) {
            const meta = await resolvePlaceMeta(p.id, p.creatorId);
            if (!isBadMetaName(meta.placeName)) p.name = meta.placeName;
            if (!isBadMetaName(meta.creatorName)) p.creatorName = meta.creatorName;
            if (meta.creatorId) p.creatorId = meta.creatorId;
            namesChanged = true;
        }

        const placesToFix = (data.whitelist.places || []).filter(
            p => isBadMetaName(p.name) || !p.creatorName || isBadMetaName(p.creatorName)
        ).slice(0, 5);
        for (const p of placesToFix) {
            const meta = await resolvePlaceMeta(p.id, p.creatorId);
            if (!isBadMetaName(meta.placeName)) p.name = meta.placeName;
            if (!isBadMetaName(meta.creatorName)) p.creatorName = meta.creatorName;
            if (meta.creatorId) p.creatorId = meta.creatorId;
            namesChanged = true;
        }

        if (namesChanged) await safeSave();
    } catch (e) {
        console.error('name refresh error:', e.message || e);
    }

    const extendedSessions = (data.activeSessions || []).map(s => ({
        ...s,
        hasFocus: sessionFocusMap[s.sid] ?? false
    }));
    ensureStats(data);
    const recent = data.stats.recent || [];
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const last24 = recent.filter(e => e.t > dayAgo);
    const last24hAllowed = last24.filter(e => e.allowed).length;
    const last24hDenied = last24.filter(e => !e.allowed).length;

    // Weekly key ranking (most used this week)
    const weekKeyMap = {};
    recent.filter(e => e.t > weekAgo && e.key).forEach(e => {
        if (!weekKeyMap[e.key]) weekKeyMap[e.key] = { total: 0, allowed: 0, denied: 0 };
        weekKeyMap[e.key].total++;
        if (e.allowed) weekKeyMap[e.key].allowed++;
        else weekKeyMap[e.key].denied++;
    });
    const topKeysWeek = Object.entries(weekKeyMap)
        .map(([key, s]) => ({ key, ...s }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

    res.json({
        activeSessions: extendedSessions,
        keys: data.keys || [],
        pendingPlaces: data.pendingPlaces || [],
        whitelist: data.whitelist || { creators: [], places: [] },
        logs: req.session.userEmail === OWNER_EMAIL ? (data.logs || []) : [],
        currentSessionId: req.sessionID,
        userEmail: req.session.userEmail,
        maintenanceMode: !!data.maintenanceMode,
        stats: {
            total: data.stats.total || 0,
            allowed: data.stats.allowed || 0,
            denied: data.stats.denied || 0,
            last24hAllowed,
            last24hDenied,
            byKey: data.stats.byKey || {},
            byPlace: data.stats.byPlace || {},
            topKeysWeek
        }
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
            <form action="/verify-2fa" method="POST" id="verify-form">
                <input type="text" name="code" id="code-input" maxlength="6" required placeholder="000000" autocomplete="off" inputmode="numeric" pattern="[0-9]*">
                <button type="submit">Verify & Access</button>
            </form>
            <a href="/resend-2fa" id="resend-btn" class="btn-resend">Resend Verification Code</a>
        </div>
        <script>
            const codeInput = document.getElementById('code-input');
            const verifyForm = document.getElementById('verify-form');
            let isSubmitting = false;
            function tryAutoSubmit() {
                if (isSubmitting) return;
                const val = (codeInput.value || '').replace(/\\D/g, '');
                if (val.length === 6) {
                    codeInput.value = val;
                    isSubmitting = true;
                    verifyForm.submit();
                }
            }
            codeInput.addEventListener('input', tryAutoSubmit);
            codeInput.addEventListener('paste', function() {
                setTimeout(tryAutoSubmit, 10);
            });
            codeInput.focus();

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
        data.activeSessions = (data.activeSessions || []).filter(s => s.email !== req.session.userEmail);
        data.activeSessions.push({ sid: req.sessionID, email: req.session.userEmail });
        // Save + Discord in background so the redirect is instant (no long wait)
        safeSave().catch(e => console.error('safeSave after 2FA:', e));
        sendSuccessLoginToDiscord(req.session.userEmail).catch(() => {});
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

app.get('/set-lang/:lang', (req, res) => {
    const lang = req.params.lang === 'he' ? 'he' : 'en';
    if (req.session) req.session.lang = lang;
    const back = req.get('Referer') || '/';
    // avoid open redirect — only relative paths on same host or just go home
    try {
        const u = new URL(back, 'http://localhost');
        if (u.pathname && u.pathname.startsWith('/')) return res.redirect(u.pathname + (u.search || ''));
    } catch (_) {}
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    const sid = req.sessionID;
    delete sessionFocusMap[sid];
    req.session.destroy(async () => {
        const data = db.getData();
        data.activeSessions = (data.activeSessions || []).filter(s => s.sid !== sid);
        await safeSave();
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
    await safeSave();
    
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

    const deny = (reason, message) => {
        recordVerifyStat(data, { allowed: false, licenseKey, placeId });
        safeSave().catch(() => {});
        return res.json({ allowed: false, reason, message });
    };
    const allow = (reason) => {
        recordVerifyStat(data, { allowed: true, licenseKey, placeId });
        safeSave().catch(() => {});
        return res.json({ allowed: true, reason: reason || 'allowed', message: 'Access granted' });
    };

    const ctx = { licenseKey, placeId, creatorId };
    const msg = (reason) => resolvePanelMessage(data, reason, ctx);

    if (!creatorId || !placeId) {
        return res.status(400).json({ allowed: false, reason: 'missing_ids', message: msg('missing_ids') });
    }

    if (data.maintenanceMode) {
        return deny('maintenance', msg('maintenance'));
    }

    if (licenseKey) {
        const keyObj = data.keys.find(k => k.key === licenseKey);
        if (!keyObj) {
            return deny('invalid_key', msg('invalid_key'));
        }
        if (keyObj.frozen) {
            return deny('key_frozen', msg('key_frozen'));
        }
    }

    const now = Date.now();

    // Detailed access check — returns { ok, reason, message }
    const evalEntity = (item) => {
        if (!item) return { ok: false };
        if (item.frozen) return { ok: false, reason: 'entity_frozen', message: msg('entity_frozen') };
        if (entityHasAllAccess(item, data)) return { ok: true, reason: 'all_access' };
        if (!licenseKey) return { ok: true, reason: 'no_key_required' };
        if (item.assignedKey === licenseKey) return { ok: true };
        if (item.keys && Array.isArray(item.keys)) {
            const match = item.keys.find(k => k.key === licenseKey);
            if (match) {
                if (match.frozen) return { ok: false, reason: 'tag_frozen', message: msg('tag_frozen') };
                if (match.expiresAt && match.expiresAt <= now) {
                    return { ok: false, reason: 'tag_expired', message: msg('tag_expired') };
                }
                return { ok: true };
            }
        }
        return { ok: false };
    };

    if (licenseKey) {
        const keyObj = data.keys.find(k => k.key === licenseKey);
        if (isAllAccessKey(keyObj, licenseKey) && !keyObj.frozen) {
            return allow('all_key');
        }
    }

    const hardDenyReasons = new Set(['entity_frozen', 'tag_frozen', 'tag_expired']);

    const placeItem = (data.whitelist.places || []).find(p => p.id === Number(placeId));
    if (placeItem) {
        const result = evalEntity(placeItem);
        if (result.ok) return allow(result.reason);
        if (result.reason && hardDenyReasons.has(result.reason)) {
            return deny(result.reason, result.message);
        }
    }

    for (const c of (data.whitelist.creators || [])) {
        let matches = c.id === Number(creatorId);
        if (!matches && c.groups && Array.isArray(c.groups)) {
            matches = c.groups.some(gName => {
                const m = gName.match(/\((\d+)\)/);
                return m && Number(m[1]) === Number(creatorId);
            });
        }
        if (!matches) continue;
        const result = evalEntity(c);
        if (result.ok) return allow(result.reason);
        if (result.reason && hardDenyReasons.has(result.reason)) {
            return deny(result.reason, result.message);
        }
    }

    // Never show "pending" when this key is frozen on the matching place/creator
    if (licenseKey) {
        for (const p of (data.whitelist.places || [])) {
            if (p.id !== Number(placeId) || !p.keys) continue;
            const m = p.keys.find(k => k.key === licenseKey);
            if (m && m.frozen) return deny('tag_frozen', msg('tag_frozen'));
        }
        for (const c of (data.whitelist.creators || [])) {
            let matches = c.id === Number(creatorId);
            if (!matches && c.groups) {
                matches = c.groups.some(gName => {
                    const m = gName.match(/\((\d+)\)/);
                    return m && Number(m[1]) === Number(creatorId);
                });
            }
            if (!matches || !c.keys) continue;
            const m = c.keys.find(k => k.key === licenseKey);
            if (m && m.frozen) return deny('tag_frozen', msg('tag_frozen'));
        }
    }

    const validKey = data.keys.find(k => k.key === licenseKey);
    if (licenseKey && validKey) {
        if (!data.pendingPlaces.some(p => p.id === Number(placeId) && p.key === licenseKey)) {
            const meta = await resolvePlaceMeta(placeId, creatorId);
            data.pendingPlaces.push({
                id: Number(placeId),
                creatorId: meta.creatorId || Number(creatorId),
                key: licenseKey,
                name: meta.placeName,
                creatorName: meta.creatorName
            });
            await safeSave();
        }
        return deny('pending', msg('pending'));
    }

    return deny('not_whitelisted', msg('not_whitelisted'));
});

app.get('/', checkAuth, (req, res) => {
    const data = db.getData();
    const isOwner = req.session.userEmail === OWNER_EMAIL;
    const lang = getLang(req);
    const dir = lang === 'he' ? 'rtl' : 'ltr';
    const tr = (key) => t(req, key);
    const keyOptions = data.keys.map(k => {
        const allTag = isAllAccessKey(k, k.key) ? ' 🌐 ALL' : '';
        const lockTag = k.isLocked ? ' 🔒' : '';
        return `<option value="${k.key}">${k.key}${allTag}${lockTag}</option>`;
    }).join('');
    const showLogsSection = isOwner;
    const maintenanceOn = !!data.maintenanceMode;

    res.send(`
    <!DOCTYPE html>
    <html lang="${lang}" dir="${dir}">
    <head>
        <meta charset="UTF-8">
        <title>${tr('title')}</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 30px; }
            .lang-switch { display: inline-flex; gap: 4px; align-items: center; }
            .lang-switch a { padding: 4px 8px; border-radius: 4px; font-size: 11px; text-decoration: none; color: #94a3b8; border: 1px solid #374151; background: #1f2937; }
            .lang-switch a.active { background: #0284c7; color: white; border-color: #0284c7; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 15px; margin-bottom: 25px; flex-wrap: wrap; gap: 12px; }
            .header-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; }
            .header-actions a, .header-actions button.hdr-btn { white-space: nowrap; flex-shrink: 0; }
            h1 { font-size: 22px; color: #38bdf8; margin: 0; white-space: nowrap; }
            .maint-banner { background: #7f1d1d; border: 1px solid #ef4444; color: #fecaca; padding: 10px 16px; border-radius: 8px; margin-bottom: 16px; font-weight: bold; text-align: center; display: none; }
            .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
            .stat-box { background: #1f2937; border: 1px solid #374151; border-radius: 8px; padding: 12px; text-align: center; }
            .stat-box .num { font-size: 22px; font-weight: bold; color: #38bdf8; }
            .stat-box .lbl { font-size: 11px; color: #94a3b8; margin-top: 4px; }
            .btn-maint-on { background: #ef4444 !important; border-color: #dc2626 !important; color: white !important; }
            .btn-maint-off { background: #374151 !important; border-color: #4b5563 !important; color: #e2e8f0 !important; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .card { background: #111827; padding: 20px; border-radius: 10px; border: 1px solid #1e293b; position: relative; }
            .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; gap: 10px; }
            h3 { margin: 0; color: #e2e8f0; font-size: 16px; white-space: nowrap; }
            .search-input { width: 60%; padding: 6px 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; font-size: 13px; box-sizing: border-box; }
            input, select, textarea { width: 100%; padding: 10px; margin-bottom: 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; box-sizing: border-box; }
            button { width: 100%; background: #0284c7; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: bold; cursor: pointer; }
            button:hover { background: #0369a1; }
            .btn-refresh, .btn-save-db, .btn-load-db, .btn-obfuscate-page, .btn-logout, .hdr-btn {
                padding: 6px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; text-decoration: none;
                display: inline-flex; align-items: center; height: 34px; box-sizing: border-box; font-weight: bold; white-space: nowrap;
                border: 1px solid transparent;
            }
            .btn-refresh { background: #1f2937; border: 1px solid #374151; color: #94a3b8; }
            .btn-refresh:hover { background: #374151; color: white; }
            .btn-save-db { background: #10b981; border: 1px solid #059669; color: white; }
            .btn-save-db:hover { background: #059669; }
            .btn-load-db { background: #0ea5e9; border: 1px solid #0284c7; color: white; }
            .btn-load-db:hover { background: #0284c7; }
            .btn-obfuscate-page { background: #a855f7; border: 1px solid #9333ea; color: white; }
            .btn-obfuscate-page:hover { background: #9333ea; }
            .btn-logout { background: #f43f5e; border: 1px solid #e11d48; color: white; }
            .btn-logout:hover { background: #e11d48; }
            table { width: 100%; border-collapse: collapse; margin-top: 5px; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 14px; vertical-align: top; }
            th { background: #1f2937; color: #94a3b8; }
            .btn-delete { color: #f43f5e; text-decoration: none; font-weight: bold; cursor: pointer; }
            .btn-freeze { color: #38bdf8; text-decoration: none; font-weight: bold; cursor: pointer; margin-right: 10px; }
            .btn-freeze.on { color: #fbbf24; }
            .frozen-row { opacity: 0.65; }
            .frozen-badge { font-size: 11px; color: #fbbf24; background: #78350f; padding: 2px 6px; border-radius: 4px; margin-left: 6px; }
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
                <h1>🛡️ ${tr('hub')}</h1>
                <div class="header-actions">
                    <span class="lang-switch" title="${tr('lang')}">
                        <a href="/set-lang/en" class="${lang === 'en' ? 'active' : ''}">EN</a>
                        <a href="/set-lang/he" class="${lang === 'he' ? 'active' : ''}">עב</a>
                    </span>
                    <span style="font-size:12px;color:#94a3b8;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${req.session.userEmail}">${req.session.userEmail}</span>
                    ${isOwner ? `<button type="button" id="maint-btn" class="hdr-btn ${maintenanceOn ? 'btn-maint-on' : 'btn-maint-off'}" onclick="toggleMaintenance()">${maintenanceOn ? '🛠️ ' + tr('maintenanceOn') : '🛠️ ' + tr('maintenance')}</button>` : ''}
                    <a href="/messages" class="btn-obfuscate-page" style="background:#f59e0b;border-color:#d97706;">💬 ${tr('messages')}</a>
                    <a href="/obfuscate" class="btn-obfuscate-page">🔒 ${tr('obfuscate')}</a>
                    <a href="/force-save" class="btn-save-db">💾 ${tr('save')}</a>
                    <a href="/force-load" class="btn-load-db">📂 ${tr('load')}</a>
                    <a href="/" class="btn-refresh">🔄 ${tr('refresh')}</a>
                    <a href="/logout" class="btn-logout">🚪 ${tr('logout')}</a>
                </div>
            </div>
            <div id="maint-banner" class="maint-banner" style="${maintenanceOn ? 'display:block;' : 'display:none;'}">⚠️ ${tr('maintenanceBanner')}</div>
            <div class="grid">
                <div class="card" style="grid-column: span 2;">
                    <div class="card-header"><h3>📊 ${tr('stats')}</h3></div>
                    <div class="stat-grid" id="stats-grid">
                        <div class="stat-box"><div class="num" id="stat-total">—</div><div class="lbl">${tr('totalChecks')}</div></div>
                        <div class="stat-box"><div class="num" id="stat-allowed" style="color:#10b981;">—</div><div class="lbl">${tr('allowed')}</div></div>
                        <div class="stat-box"><div class="num" id="stat-denied" style="color:#f43f5e;">—</div><div class="lbl">${tr('denied')}</div></div>
                        <div class="stat-box"><div class="num" id="stat-24a" style="color:#10b981;">—</div><div class="lbl">${tr('allowed24h')}</div></div>
                        <div class="stat-box"><div class="num" id="stat-24d" style="color:#f43f5e;">—</div><div class="lbl">${tr('denied24h')}</div></div>
                    </div>
                    <div id="stats-by-key" style="margin-top:12px;font-size:12px;color:#94a3b8;max-height:120px;overflow-y:auto;"></div>
                </div>
                <div id="sessions-container" class="card" style="grid-column: span 2; display:none;">
                    <div class="card-header">
                        <h3>👥 ${tr('activeUsers')}</h3>
                    </div>
                    <div id="sessions-box" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:12px; margin-top:10px; max-height:200px; overflow-y:auto;"></div>
                </div>
                
                ${showLogsSection ? `
                <div class="card" style="grid-column: span 2;">
                    <div class="card-header">
                        <h3>📜 ${tr('logs')}</h3>
                        <input type="text" class="search-input" placeholder="${tr('searchLogs')}" oninput="searchTable(this, 'logs-table')">
                    </div>
                    <div style="max-height: 300px; overflow-y: auto;">
                        <table>
                            <thead>
                                <tr>
                                    <th>${tr('user')}</th>
                                    <th>${tr('action')}</th>
                                    <th>${tr('details')}</th>
                                    <th>${tr('autoDelete')}</th>
                                </tr>
                            </thead>
                            <tbody id="logs-table"></tbody>
                        </table>
                    </div>
                </div>
                ` : ''}

                <div class="card">
                    <div class="card-header">
                        <h3>🔑 ${tr('systemKeys')}</h3>
                        <input type="text" class="search-input" placeholder="${tr('searchKeys')}" oninput="searchKeys(this)">
                    </div>
                    <div class="key-container" id="keys-box"></div>
                    <form onsubmit="handleFormSubmit(event, '/add-key')" style="display: flex; flex-direction: column; gap: 8px; align-items: stretch;">
                        <input type="text" name="key" placeholder="${tr('keyPlaceholder')}" required style="margin-bottom:0;">
                        ${isOwner ? `<label style="font-size:12px;color:#fbbf24;display:flex;align-items:center;gap:6px;"><input type="checkbox" name="isAllAccess" value="1" style="width:auto;margin:0;"> 🌐 ${tr('markAll')}</label>` : ''}
                        <button type="submit">${tr('createKey')}</button>
                    </form>
                </div>
                <div class="card">
                    <div class="card-header">
                        <h3>📡 ${tr('pending')}</h3>
                        <input type="text" class="search-input" placeholder="${tr('searchRequests')}" oninput="searchTable(this, 'pending-table')">
                    </div>
                    <div style="display:flex; gap:8px; margin-bottom:10px; align-items:center; flex-wrap:wrap;">
                        <input type="text" id="pending-user-lookup" placeholder="${tr('robloxUsername')}" style="margin-bottom:0; flex:1; min-width:140px; padding:8px; background:#1f2937; border:1px solid #374151; border-radius:6px; color:white;">
                        <button type="button" onclick="lookupPendingByUsername()" style="width:auto; padding:8px 12px; background:#0284c7; border:none; border-radius:6px; color:white; font-weight:bold; cursor:pointer; white-space:nowrap;">🔍 ${tr('findByUsername')}</button>
                    </div>
                    <div id="pending-lookup-status" style="font-size:12px; color:#94a3b8; margin-bottom:8px;"></div>
                    <table>
                        <thead><tr><th>${tr('requestMeta')}</th><th>${tr('actionCol')}</th></tr></thead>
                        <tbody id="pending-table"></tbody>
                    </table>
                </div>
                <div class="card" style="grid-column: span 2;">
                    <div class="card-header"><h3>➕ ${tr('grantAccess')}</h3></div>
                    <form onsubmit="handleFormSubmit(event, '/add')" style="display: flex; flex-direction: column; gap: 12px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                            <div>
                                <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:5px;">${tr('targetEntity')}</label>
                                <select name="type" style="margin-bottom:0;">
                                    <option value="creators">${tr('creators')}</option>
                                    <option value="places">${tr('places')}</option>
                                </select>
                            </div>
                            <div>
                                <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:5px;">${tr('inputId')}</label>
                                <input type="text" name="input" placeholder="${tr('inputId')}" style="margin-bottom:0;" required>
                            </div>
                        </div>
                        <div style="border-top: 1px solid #1e293b; padding-top: 10px;">
                            <label style="font-size:14px;color:#e2e8f0;display:block;margin-bottom:8px;">${tr('assignKeys')}</label>
                            <button type="button" class="btn-add-row" onclick="addKeyRow()">${tr('addRow')}</button>
                            <div id="dynamic-keys-container">
                                <div class="dynamic-key-row">
                                    <select name="assignedKeys" id="grant-key-select" style="margin-bottom:0; flex: 1; height: 38px;">
                                        <option value="">—</option>
                                        ${keyOptions}
                                    </select>
                                    <input type="datetime-local" name="expiresAtKeys" style="margin-bottom:0; flex: 1; height: 38px;">
                                    <button type="button" class="btn-remove-row" onclick="removeKeyRow(this)">×</button>
                                </div>
                            </div>
                        </div>
                        <button type="submit" style="margin-top:10px;">${tr('grantBtn')}</button>
                    </form>
                </div>
                <div class="card">
                    <div class="card-header">
                        <h3>👥 ${tr('authCreators')}</h3>
                        <input type="text" class="search-input" placeholder="${tr('searchCreators')}" oninput="searchTable(this, 'creators-table')">
                    </div>
                    <table>
                        <thead><tr><th>${tr('identity')}</th><th>${tr('actionCol')}</th></tr></thead>
                        <tbody id="creators-table"></tbody>
                    </table>
                </div>
                <div class="card">
                    <div class="card-header">
                        <h3>🏢 ${tr('authPlaces')}</h3>
                        <input type="text" class="search-input" placeholder="${tr('searchPlaces')}" oninput="searchTable(this, 'places-table')">
                    </div>
                    <table>
                        <thead><tr><th>${tr('identity')}</th><th>${tr('actionCol')}</th></tr></thead>
                        <tbody id="places-table"></tbody>
                    </table>
                </div>
            </div>
        </div>
        <script>
            const I18N = ${JSON.stringify(TRANSLATIONS[lang])};
            function tt(k) { return I18N[k] || k; }
            let currentKeysMarkup = '';

                async function checkSessionStatus() {
                    try {
                        const res = await fetch('/api/session-status', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ hasFocus: document.hasFocus() })
                        });
                        const data = await res.json();
                        if (data.active === false) {
                            window.location.href = '/login';
                        }
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

            async function toggleMaintenance() {
                try {
                    const res = await fetch('/toggle-maintenance', { method: 'POST' });
                    if (res.status === 403) {
                        alert(tt('onlyOwnerMaint'));
                        return;
                    }
                    fetchDashboardData();
                } catch(e) {}
            }

            async function lookupPendingByUsername() {
                const input = document.getElementById('pending-user-lookup');
                const status = document.getElementById('pending-lookup-status');
                const username = (input && input.value || '').trim();
                if (!username) {
                    if (status) status.textContent = 'Enter a Roblox username';
                    return;
                }
                if (status) status.textContent = 'Looking up ' + username + '...';
                try {
                    const res = await fetch('/api/lookup-username?username=' + encodeURIComponent(username));
                    const data = await res.json();
                    if (!data.ok) {
                        if (status) status.textContent = data.error || 'User not found';
                        return;
                    }
                    if (status) {
                        status.innerHTML = 'Found <strong style="color:#38bdf8;">' + data.name + '</strong> (ID: ' + data.id + ') — filtering pending...';
                    }
                    // Filter pending table by creatorId or username
                    const table = document.getElementById('pending-table');
                    if (!table) return;
                    const rows = table.getElementsByTagName('tr');
                    let shown = 0;
                    for (let i = 0; i < rows.length; i++) {
                        const searchAttr = (rows[i].getAttribute('data-search') || '');
                        const match =
                            searchAttr.includes(String(data.id)) ||
                            searchAttr.includes((data.name || '').toLowerCase()) ||
                            searchAttr.includes(username.toLowerCase());
                        rows[i].style.display = match ? '' : 'none';
                        if (match) shown++;
                    }
                    if (status) {
                        status.innerHTML += shown
                            ? ' <span style="color:#10b981;">(' + shown + ' match' + (shown > 1 ? 'es' : '') + ')</span>'
                            : ' <span style="color:#f43f5e;">(no pending requests for this user)</span>';
                    }
                } catch (e) {
                    if (status) status.textContent = 'Lookup failed';
                }
            }

            // Enter key on username lookup
            document.addEventListener('DOMContentLoaded', function() {
                const input = document.getElementById('pending-user-lookup');
                if (input) {
                    input.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            lookupPendingByUsername();
                        }
                    });
                }
            });

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
                if(!arr || arr.length === 0) return '<tr><td colspan="2" style="color:#64748b;">' + tt('emptyList') + '</td></tr>';
                return arr.map(item => {
                    let timeLeft = '';
                    let keysListHtml = '';
                    let searchData = \`\${item.name || ''} \${item.id} \${item.creatorName || ''} \${item.creatorId || ''}\`.toLowerCase();
                    if (item.assignedKey) searchData += \` \${item.assignedKey}\`;
                    // Only show entity-level expiry if there are NO per-key expiry dates
                    // (otherwise each key already has its own countdown — avoid a duplicate place timer)
                    const hasKeyExpiries = item.keys && item.keys.some(k => k.expiresAt);
                    if (item.expiresAt && !hasKeyExpiries) {
                        const diff = item.expiresAt - Date.now();
                        if (diff > 0) {
                            const hours = Math.floor(diff / 3600000);
                            const minutes = Math.floor((diff % 3600000) / 60000);
                            const seconds = Math.floor((diff % 60000) / 1000);
                            const dateStr = new Date(item.expiresAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
                            timeLeft = \`<br><span class="time-tag target-timer" data-expire="\${item.expiresAt}">⏱️ Expires in: \${hours}h \${minutes}m \${seconds}s</span> <span style="font-size:11px;color:#64748b;">📅 \${dateStr}</span>\`;
                        }
                    }
                    if (item.keys && Array.isArray(item.keys) && item.keys.length > 0) {
                        keysListHtml = '<div style="margin-top:5px; display:flex; flex-direction:column; gap:5px;">';
                        item.keys.forEach(k => {
                            searchData += \` \${k.key}\`;
                            const isAll = (k.key || '').toUpperCase() === 'ALL';
                            const keyFrozen = !!k.frozen;
                            let kTime = '';
                            if (k.expiresAt) {
                                const diff = k.expiresAt - Date.now();
                                if (diff > 0) {
                                    const hours = Math.floor(diff / 3600000);
                                    const minutes = Math.floor((diff % 3600000) / 60000);
                                    const seconds = Math.floor((diff % 60000) / 1000);
                                    const dateStr = new Date(k.expiresAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
                                    kTime = \` <span class="target-timer" data-expire="\${k.expiresAt}">(⏱️ \${hours}h \${minutes}m \${seconds}s)</span> <span style="font-size:10px;color:#64748b;">📅 \${dateStr}</span>\`;
                                }
                            }
                            keysListHtml += \`
                                <span class="key-badge" style="width:fit-content;\${isAll ? 'background:#4c1d95;color:#e9d5ff;' : ''}\${keyFrozen ? 'opacity:0.55;text-decoration:line-through;' : ''}">
                                    🔑 \${k.key}\${isAll ? ' 🌐' : ''}\${keyFrozen ? ' ❄️' : ''}\${kTime}
                                    <span class="btn-freeze \${keyFrozen ? 'on' : ''}" onclick="executeAction('/toggle-sub-key-freeze/\${type}/\${item.id}/\${encodeURIComponent(k.key)}')" title="\${keyFrozen ? 'Unfreeze this key' : 'Freeze this key'}">\${keyFrozen ? '❄️' : '🧊'}</span>
                                    <span class="btn-sub-delete" onclick="executeAction('/delete-sub-key/\${type}/\${item.id}/\${encodeURIComponent(k.key)}')" title="Remove this key local instance">×</span>
                                </span>\`;
                        });
                        keysListHtml += '</div>';
                    }
                    const ownerLine = (type === 'places' && item.creatorName)
                        ? \`<br><span style="font-size:12px;color:#94a3b8;">👤 \${item.creatorName}\${item.creatorId ? ' (' + item.creatorId + ')' : ''}</span>\`
                        : '';
                    const entityFrozen = !!item.frozen;
                    return \`
                        <tr data-search="\${searchData}" class="\${entityFrozen ? 'frozen-row' : ''}">
                            <td>
                                <strong>\${item.name || 'Unknown'}</strong> (\${item.id})
                                \${entityFrozen ? '<span class="frozen-badge">❄️ ' + tt('frozen') + '</span>' : ''}
                                \${ownerLine}
                                \${item.assignedKey ? \`<br><span class="key-badge">🔑 \${item.assignedKey}</span>\` : ''}
                                \${keysListHtml}
                                \${item.groups ? \`<br><span class="group-tag">Groups: \${item.groups.join(', ')}</span>\` : ''}
                                \${timeLeft}
                            </td>
                            <td style="white-space:nowrap;">
                                <span onclick="executeAction('/toggle-entity-freeze/\${type}/\${item.id}')" class="btn-freeze \${entityFrozen ? 'on' : ''}">\${entityFrozen ? '❄️ ' + tt('unfreeze') : '🧊 ' + tt('freeze')}</span>
                                <span onclick="executeAction('/delete/\${type}/\${item.id}')" class="btn-delete">\${tt('remove')}</span>
                            </td>
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
                        }).join('') || '<span style="color:#64748b; font-size:13px;">' + tt('noSessions') + '</span>';

                        const logsTable = document.getElementById('logs-table');
                        if (logsTable && data.logs) {
                            logsTable.innerHTML = data.logs.map(log => \`
                                <tr data-search="\${log.userEmail.toLowerCase()} \${log.action.toLowerCase()} \${log.details.toLowerCase()}">
                                    <td style="color:#38bdf8; font-weight:500;">\${log.userEmail}</td>
                                    <td style="color:#e2e8f0; font-weight:bold;">\${log.action}</td>
                                    <td style="color:#94a3b8; max-width:300px; word-break:break-all;">\${log.details}</td>
                                    <td class="log-countdown" data-expire="\${log.expiresAt}" style="color:#fbbf24; font-family:monospace; font-weight:bold;"></td>
                                </tr>
                            \`).join('') || '<tr><td colspan="4" style="color:#64748b; text-align:center;">' + tt('noLogs') + '</td></tr>';
                        }
                    }

                    // Stats panel
                    if (data.stats) {
                        const el = (id) => document.getElementById(id);
                        if (el('stat-total')) el('stat-total').textContent = data.stats.total ?? 0;
                        if (el('stat-allowed')) el('stat-allowed').textContent = data.stats.allowed ?? 0;
                        if (el('stat-denied')) el('stat-denied').textContent = data.stats.denied ?? 0;
                        if (el('stat-24a')) el('stat-24a').textContent = data.stats.last24hAllowed ?? 0;
                        if (el('stat-24d')) el('stat-24d').textContent = data.stats.last24hDenied ?? 0;
                        const byKeyBox = document.getElementById('stats-by-key');
                        if (byKeyBox) {
                            let html = '';
                            const week = data.stats.topKeysWeek || [];
                            if (week.length) {
                                html += '<div style="font-weight:bold;margin-bottom:6px;color:#e2e8f0;">🏆 ' + tt('mostUsedWeek') + '</div>';
                                html += week.map((s, i) => {
                                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
                                    return \`<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid #1e293b;"><span>\${medal} 🔑 \${s.key}</span><span style="color:#38bdf8;font-weight:bold;">\${s.total} checks</span> <span><span style="color:#10b981;">✓\${s.allowed||0}</span> / <span style="color:#f43f5e;">✗\${s.denied||0}</span></span></div>\`;
                                }).join('');
                            } else {
                                html += '<div style="color:#64748b;margin-bottom:8px;">' + tt('noWeekly') + '</div>';
                            }
                            if (data.stats.byKey) {
                                const entries = Object.entries(data.stats.byKey).sort((a,b) => (b[1].allowed+b[1].denied) - (a[1].allowed+a[1].denied)).slice(0, 12);
                                if (entries.length) {
                                    html += '<div style="font-weight:bold;margin:10px 0 6px;color:#e2e8f0;">' + tt('allTimePerKey') + '</div>';
                                    html += entries.map(([key, s]) =>
                                        \`<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px solid #1e293b;"><span>🔑 \${key}</span><span><span style="color:#10b981;">✓\${s.allowed||0}</span> / <span style="color:#f43f5e;">✗\${s.denied||0}</span></span></div>\`
                                    ).join('');
                                }
                            }
                            byKeyBox.innerHTML = html || '<span style="color:#64748b;">' + tt('noKeyUsage') + '</span>';
                        }
                    }

                    // Maintenance banner + button state
                    const banner = document.getElementById('maint-banner');
                    if (banner) banner.style.display = data.maintenanceMode ? 'block' : 'none';
                    const maintBtn = document.getElementById('maint-btn');
                    if (maintBtn) {
                        maintBtn.textContent = data.maintenanceMode ? '🛠️ ' + tt('maintenanceOn') : '🛠️ ' + tt('maintenance');
                        maintBtn.className = 'hdr-btn ' + (data.maintenanceMode ? 'btn-maint-on' : 'btn-maint-off');
                    }

                    const keysBox = document.getElementById('keys-box');
                    keysBox.innerHTML = data.keys.map(k => {
                        const lockIcon = k.isLocked ? '🔒' : '🔓';
                        const isAll = !!(k.isAllAccess || (k.key || '').toUpperCase() === 'ALL');
                        const isFrozen = !!k.frozen;
                        const lockButtonMarkup = isAlmog 
                            ? \`<span class="btn-lock-toggle" onclick="executeAction('/toggle-key-lock/\${encodeURIComponent(k.key)}')" title="Toggle key administrator configuration access lock">\${lockIcon}</span>\`
                            : (k.isLocked ? \`<span title="This key configuration access is locked by almogshemesh11@gmail.com">🔒</span>\` : '');
                        
                        return \`
                            <span class="key-tag-manage" data-search="\${k.key.toLowerCase()}" style="\${isAll ? 'border-color:#a855f7;background:#2e1065;' : ''}\${isFrozen ? 'opacity:0.55;' : ''}">
                                \${lockButtonMarkup}
                                <span class="btn-freeze \${isFrozen ? 'on' : ''}" onclick="executeAction('/toggle-key-freeze/\${encodeURIComponent(k.key)}')" title="\${isFrozen ? 'Unfreeze key' : 'Freeze key globally'}">\${isFrozen ? '❄️' : '🧊'}</span>
                                <strong>\${k.key}</strong>\${isAll ? ' <span title="ALL access">🌐</span>' : ''}\${isFrozen ? ' <span title="Frozen">❄️</span>' : ''}
                                <span onclick="executeAction('/delete-key/\${encodeURIComponent(k.key)}')" style="color:#f43f5e;margin-left:5px;text-decoration:none;cursor:pointer;font-weight:bold;">×</span>
                            </span>
                        \`;
                    }).join('') || '<span style="color:#64748b;font-size:13px;">' + tt('noKeys') + '</span>';

                    currentKeysMarkup = data.keys.map(k => {
                        const isAll = !!(k.isAllAccess || (k.key || '').toUpperCase() === 'ALL');
                        return \`<option value="\${k.key}">\${k.key}\${isAll ? ' 🌐 ALL' : ''}\${k.isLocked ? ' (🔒 Locked)' : ''}</option>\`;
                    }).join('');

                    // Don't rebuild the pending table while a datetime-local picker is open/focused
                    // (otherwise the browser closes the picker every 3s when innerHTML is replaced)
                    const activeEl = document.activeElement;
                    const isDatePickerFocused = activeEl && activeEl.type === 'datetime-local';
                    const pendingTable = document.getElementById('pending-table');
                    if (!isDatePickerFocused || !pendingTable.contains(activeEl)) {
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
                                            <input type="datetime-local" id="exp-\${item.id}-\${encodeURIComponent(item.key)}" style="padding:4px; margin-bottom:0; width:160px; font-size:12px; height:28px;">
                                            <span onclick="executePostAction('/approve/\${item.id}/' + encodeURIComponent('\${item.key}'), { expiresAt: document.getElementById('exp-\${item.id}-\${encodeURIComponent(item.key)}').value })" style="font-size:14px; cursor:pointer; color:#10b981; font-weight:bold;">Approve</span>
                                        </div>
                                        <div style="margin-bottom:0;">
                                            <span onclick="executePostAction('/reject/\${item.id}/' + encodeURIComponent('\${item.key}'))" style="font-size:14px; cursor:pointer; text-align:left; color:#f43f5e; font-weight:bold;">Decline</span>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        \`).join('') || '<tr><td colspan="2" style="color:#64748b; text-align:center;">' + tt('noPending') + '</td></tr>';
                    }

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

app.get('/messages', checkAuth, (req, res) => {
    const data = db.getData();
    const lang = getLang(req);
    const dir = lang === 'he' ? 'rtl' : 'ltr';
    const tr = (key) => t(req, key);
    const msgs = getPanelMessages(data);
    const customs = data.customPanelMessages || [];
    const reasonMeta = [
        { key: 'maintenance', label: 'Maintenance mode' },
        { key: 'invalid_key', label: 'Invalid license key' },
        { key: 'key_frozen', label: 'System key frozen' },
        { key: 'entity_frozen', label: 'Place / Creator frozen' },
        { key: 'tag_frozen', label: 'Tag frozen on entity' },
        { key: 'tag_expired', label: 'Tag / license expired' },
        { key: 'pending', label: 'Pending approval' },
        { key: 'not_whitelisted', label: 'Not authorized' },
        { key: 'missing_ids', label: 'Missing IDs (rare)' }
    ];
    const reasonFields = reasonMeta.map(r => `
        <div class="msg-row">
            <label>${r.label} <span class="code">(${r.key})</span></label>
            <textarea name="msg_${r.key}" rows="3" placeholder="${DEFAULT_PANEL_MESSAGES[r.key].replace(/"/g, '&quot;')}">${(msgs[r.key] || '').replace(/</g, '&lt;')}</textarea>
        </div>
    `).join('');
    const customRows = customs.map((c, i) => `
        <tr>
            <td><span class="badge">${c.scope}</span></td>
            <td><code>${String(c.target || '').replace(/</g, '&lt;')}</code></td>
            <td style="white-space:pre-wrap;max-width:320px;">${String(c.message || '').replace(/</g, '&lt;')}</td>
            <td><button type="button" class="btn-del" onclick="deleteCustom(${i})">×</button></td>
        </tr>
    `).join('') || `<tr><td colspan="4" style="color:#64748b;text-align:center;">${tr('noPersonal')}</td></tr>`;

    res.send(`<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8">
<title>${tr('panelMessagesTitle')}</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b0f19;color:#f1f5f9;margin:0;padding:30px;}
.container{max-width:900px;margin:0 auto;}
.header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1e293b;padding-bottom:15px;margin-bottom:25px;flex-wrap:wrap;gap:10px;}
h1{font-size:22px;color:#f59e0b;margin:0;}
.card{background:#111827;padding:20px;border-radius:10px;border:1px solid #1e293b;margin-bottom:20px;}
h3{margin:0 0 12px;color:#e2e8f0;font-size:16px;}
.msg-row{margin-bottom:14px;}
.msg-row label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px;}
.msg-row .code{color:#64748b;font-size:11px;}
textarea,input,select{width:100%;padding:10px;background:#1f2937;border:1px solid #374151;border-radius:6px;color:#f1f5f9;box-sizing:border-box;font-family:inherit;}
textarea{resize:vertical;min-height:70px;}
.btn-save{background:#10b981;border:none;color:white;padding:12px 20px;border-radius:6px;font-weight:bold;cursor:pointer;width:100%;}
.btn-save:hover{background:#059669;}
.btn-back{background:#1f2937;color:#94a3b8;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:bold;border:1px solid #374151;}
.btn-add{background:#0284c7;border:none;color:white;padding:10px 14px;border-radius:6px;font-weight:bold;cursor:pointer;margin-top:8px;}
.btn-del{background:#f43f5e;border:none;color:white;width:32px;height:32px;border-radius:6px;cursor:pointer;font-weight:bold;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th,td{padding:8px;border-bottom:1px solid #1e293b;text-align:left;}
.badge{background:#1e293b;color:#38bdf8;padding:2px 8px;border-radius:4px;font-size:11px;text-transform:uppercase;}
.hint{font-size:12px;color:#64748b;margin-bottom:12px;line-height:1.5;}
.grid-3{display:grid;grid-template-columns:1fr 1fr 2fr;gap:8px;}
@media(max-width:700px){.grid-3{grid-template-columns:1fr;}}
.status{margin-top:10px;font-size:13px;color:#10b981;display:none;}
.lang-switch{display:inline-flex;gap:4px;margin-right:8px;}
.lang-switch a{padding:4px 8px;border-radius:4px;font-size:11px;text-decoration:none;color:#94a3b8;border:1px solid #374151;background:#1f2937;}
.lang-switch a.active{background:#0284c7;color:white;border-color:#0284c7;}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>💬 ${tr('panelMessagesTitle')}</h1>
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="lang-switch">
        <a href="/set-lang/en" class="${lang === 'en' ? 'active' : ''}">EN</a>
        <a href="/set-lang/he" class="${lang === 'he' ? 'active' : ''}">עב</a>
      </span>
      <a href="/" class="btn-back">⬅️ ${tr('dashboard')}</a>
    </div>
  </div>

  <div class="card">
    <h3>${tr('defaultsTitle')}</h3>
    <p class="hint">${tr('defaultsHint')}</p>
    <form id="defaults-form">
      ${reasonFields}
      <button type="submit" class="btn-save">💾 ${tr('saveDefaults')}</button>
      <div class="status" id="defaults-status">${tr('saved')}</div>
    </form>
  </div>

  <div class="card">
    <h3>${tr('personalTitle')}</h3>
    <p class="hint">${tr('personalHint')}</p>
    <div class="grid-3">
      <div>
        <label style="font-size:12px;color:#94a3b8;">${tr('scope')}</label>
        <select id="c-scope">
          <option value="key">Key / Tag</option>
          <option value="place">Place ID</option>
          <option value="creator">Creator ID</option>
        </select>
      </div>
      <div>
        <label style="font-size:12px;color:#94a3b8;">${tr('target')}</label>
        <input id="c-target" placeholder="e.g. Bots or 123456">
      </div>
      <div>
        <label style="font-size:12px;color:#94a3b8;">${tr('message')}</label>
        <input id="c-message" placeholder="Custom panel text...">
      </div>
    </div>
    <button type="button" class="btn-add" onclick="addCustom()">➕ ${tr('addPersonal')}</button>
    <div class="status" id="custom-status">${tr('saved')}</div>
    <table style="margin-top:16px;">
      <thead><tr><th>${tr('scope')}</th><th>${tr('target')}</th><th>${tr('message')}</th><th></th></tr></thead>
      <tbody id="custom-body">${customRows}</tbody>
    </table>
  </div>
</div>
<script>
let customs = ${JSON.stringify(customs)};

document.getElementById('defaults-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const panelMessages = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith('msg_')) panelMessages[k.slice(4)] = v;
  }
  const res = await fetch('/messages/save-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ panelMessages })
  });
  if (res.ok) {
    const s = document.getElementById('defaults-status');
    s.style.display = 'block';
    setTimeout(() => s.style.display = 'none', 2000);
  }
});

async function persistCustoms() {
  await fetch('/messages/save-customs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customPanelMessages: customs })
  });
  const s = document.getElementById('custom-status');
  s.style.display = 'block';
  setTimeout(() => s.style.display = 'none', 2000);
  renderCustoms();
}

function renderCustoms() {
  const body = document.getElementById('custom-body');
  if (!customs.length) {
    body.innerHTML = '<tr><td colspan="4" style="color:#64748b;text-align:center;">No personal messages yet</td></tr>';
    return;
  }
  body.innerHTML = customs.map((c, i) =>
    '<tr><td><span class="badge">' + c.scope + '</span></td><td><code>' +
    String(c.target).replace(/</g,'&lt;') + '</code></td><td style="white-space:pre-wrap;max-width:320px;">' +
    String(c.message).replace(/</g,'&lt;') + '</td><td><button type="button" class="btn-del" onclick="deleteCustom(' + i + ')">×</button></td></tr>'
  ).join('');
}

async function addCustom() {
  const scope = document.getElementById('c-scope').value;
  const target = document.getElementById('c-target').value.trim();
  const message = document.getElementById('c-message').value.trim();
  if (!target || !message) { alert('Target and message are required'); return; }
  // replace existing same scope+target
  customs = customs.filter(c => !(c.scope === scope && String(c.target) === target));
  customs.push({ id: Date.now().toString(36), scope, target, message });
  document.getElementById('c-target').value = '';
  document.getElementById('c-message').value = '';
  await persistCustoms();
}

async function deleteCustom(i) {
  customs.splice(i, 1);
  await persistCustoms();
}
</script>
</body>
</html>`);
});

app.post('/messages/save-defaults', checkAuth, async (req, res) => {
    const data = db.getData();
    const incoming = req.body.panelMessages || {};
    data.panelMessages = data.panelMessages || {};
    for (const k of Object.keys(DEFAULT_PANEL_MESSAGES)) {
        if (typeof incoming[k] === 'string') {
            data.panelMessages[k] = incoming[k];
        }
    }
    await safeSave();
    await saveActionLogInternal(req.session.userEmail, 'Update Panel Messages', 'Saved default panel messages');
    res.json({ ok: true });
});

app.post('/messages/save-customs', checkAuth, async (req, res) => {
    const data = db.getData();
    const list = Array.isArray(req.body.customPanelMessages) ? req.body.customPanelMessages : [];
    data.customPanelMessages = list
        .filter(c => c && c.scope && c.target && c.message)
        .map(c => ({
            id: c.id || Date.now().toString(36),
            scope: ['key', 'place', 'creator'].includes(c.scope) ? c.scope : 'key',
            target: String(c.target).trim(),
            message: String(c.message)
        }));
    await safeSave();
    await saveActionLogInternal(req.session.userEmail, 'Update Custom Panel Messages', `${data.customPanelMessages.length} personal rules`);
    res.json({ ok: true });
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
            .row { display: flex; gap: 15px; margin-bottom: 15px; }
            .row > div { flex: 1; }
            select, textarea { width: 100%; padding: 10px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; box-sizing: border-box; }
            textarea { font-family: monospace; height: 250px; resize: vertical; margin-bottom: 15px; }
            button { width: 100%; background: #a855f7; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 15px; }
            button:hover { background: #9333ea; }
            .btn-back { background: #1f2937; border: 1px solid #374151; color: #94a3b8; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; height: 38px; font-weight: bold; }
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
                    <select name="licenseKey" style="margin-bottom: 15px;" required>
                        ${keyOptions || '<option value="">No keys available</option>'}
                    </select>
                    
                    <div class="row">
                        <div>
                            <label>Script Type</label>
                            <select name="type" id="type" onchange="document.getElementById('depth').disabled = (this.value === 'module')">
                                <option value="script">Script</option>
                                <option value="module">Module</option>
                            </select>
                        </div>
                        <div>
                            <label>Parent Depth</label>
                            <select name="parentLevel" id="depth">
                                ${[...Array(10)].map((_, i) => `<option value="${i+1}" ${i+1 === 2 ? 'selected' : ''}>${i+1}</option>`).join('')}
                            </select>
                        </div>
                    </div>

                    <label>Paste your Lua Source Code</label>
                    <textarea name="sourceCode" placeholder="Paste your script here" required></textarea>
                    <button type="submit">Inject Whitelist Verification</button>
                </form>
            </div>
        </div>
    </body>
    </html>
    `);
});

app.post('/obfuscate', checkAuth, async (req, res) => {
    const { licenseKey, sourceCode, type, parentLevel } = req.body;

    await saveActionLogInternal(req.session.userEmail, "Code Obfuscation / Injection", `Injected verification flow using License Key: ${licenseKey}`);

    let destroyLogic = "";
    let loopLogic = "";
    let panelRoot = "script";
    let panelErrorFn = ""; // only for Script type

    if (type === "module") {
        destroyLogic = "script:Destroy()";
        loopLogic = `    while true do
        local status, errMsg = verifyServer()
        if status == "DESTROY" then
            return
        end
        task.wait(5)
    end`;
    } else {
        let parents = "";
        const depth = parseInt(parentLevel) || 2;
        for (let i = 0; i < depth; i++) {
            parents += ".Parent";
        }
        panelRoot = `script${parents}`;
        destroyLogic = `${panelRoot}:Destroy()`;

        // Show error text on all Parts named "Panel" under the same parent depth
        panelErrorFn = `
    local function showPanelError(msg)
        local ok, root = pcall(function()
            return ${panelRoot}
        end)
        if not ok or not root then return end
        for _, Panel in pairs(root:GetDescendants()) do
            if Panel:IsA("BasePart") and Panel.Name == "Panel" then
                local surfaceGui = nil
                for _, child in pairs(Panel:GetChildren()) do
                    if child:IsA("SurfaceGui") then
                        if child.Face == Enum.NormalId.Front or child.Face == Enum.NormalId.Top then
                            surfaceGui = child
                            break
                        end
                    end
                end
                if not surfaceGui then
                    surfaceGui = Instance.new("SurfaceGui")
                    surfaceGui.Face = Enum.NormalId.Front
                    surfaceGui.Parent = Panel
                end
                -- clear previous error UI
                for _, child in pairs(surfaceGui:GetChildren()) do
                    if child:GetAttribute("WLErrorPanel") then
                        child:Destroy()
                    end
                end
                local Frame = Instance.new("Frame")
                Frame:SetAttribute("WLErrorPanel", true)
                Frame.AnchorPoint = Vector2.new(0.5, 0.5)
                Frame.Position = UDim2.new(0.5, 0, 0.5, 0)
                Frame.Size = UDim2.new(1, 0, 1, 0)
                Frame.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
                Frame.BackgroundTransparency = 0.2
                Frame.Parent = surfaceGui
                local UICorner = Instance.new("UICorner")
                UICorner.Parent = Frame
                local TextLabel = Instance.new("TextLabel")
                TextLabel.BackgroundTransparency = 1
                TextLabel.AnchorPoint = Vector2.new(0.5, 0.5)
                TextLabel.Position = UDim2.new(0.5, 0, 0.5, 0)
                TextLabel.Size = UDim2.new(0.85, 0, 0.85, 0)
                -- Prefer Rubik Bold; fallback to SourceSansBold if unavailable
                local fontOk = pcall(function()
                    TextLabel.FontFace = Font.new("rbxasset://fonts/families/Rubik.json", Enum.FontWeight.Bold, Enum.FontStyle.Normal)
                end)
                if not fontOk then
                    TextLabel.Font = Enum.Font.SourceSansBold
                end
                TextLabel.Text = tostring(msg or "Access denied")
                TextLabel.TextColor3 = Color3.fromRGB(255, 90, 90)
                TextLabel.TextScaled = true
                TextLabel.TextWrapped = true
                TextLabel.Parent = Frame
                local UIStroke = Instance.new("UIStroke")
                UIStroke.Thickness = 3
                UIStroke.Parent = TextLabel
            end
        end
    end
`;

        loopLogic = `    while true do
        local status, errMsg = verifyServer()
        if status == "DESTROY" then
            return
        elseif status == "DENIED" then
            showPanelError(errMsg or "Access denied")
            script.Enabled = false
            return
        elseif status == "ALLOWED" then
            script.Enabled = true
        end
        task.wait(5)
    end`;
    }

    const rawCode = `task.spawn(function()
    local isFirstCheck = true
${panelErrorFn}
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
            if isFirstCheck then
                ${destroyLogic}
                return "DESTROY", "Connection failed"
            end
            return "SKIP", nil
        end
        isFirstCheck = false
        local decodeSuccess, data = pcall(function()
            return game:GetService("HttpService"):JSONDecode(response)
        end)
        if decodeSuccess and data and data.allowed then
            return "ALLOWED", nil
        else
            local msg = "Access denied"
            if decodeSuccess and data then
                if type(data.message) == "string" and data.message ~= "" then
                    msg = data.message
                elseif type(data.reason) == "string" and data.reason ~= "" then
                    msg = data.reason
                end
            end
            return "DENIED", msg
        end
    end
${loopLogic}
end)
    
${sourceCode}`;

    res.send(`<!DOCTYPE html>
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
            .options-bar { margin-bottom: 15px; padding: 10px; background: #1f2937; border-radius: 6px; }
            textarea { width: 100%; padding: 10px; margin-bottom: 15px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: #10b981; box-sizing: border-box; font-family: monospace; height: 350px; }
            .btn-group { display: flex; gap: 10px; margin-bottom: 15px; }
            button { flex: 1; border: none; padding: 12px; border-radius: 6px; font-weight: bold; cursor: pointer; color: white; }
            .btn-obfuscate { background: #a855f7; }
            .btn-copy { background: #10b981; }
            .btn-download { background: #38bdf8; }
            .btn-back { background: #1f2937; color: #94a3b8; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold; border: 1px solid #374151; }
            .btn-back:hover { background: #374151; color: white; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🛡️ Code Protection Panel</h1>
                <a href="/obfuscate" class="btn-back">⬅️ Back</a>
            </div>
            <div class="card">
                <div class="options-bar">
                    <label>Selected Type: <b>${type}</b></label>
                    <label style="margin-left: 20px;">Selected Depth: <b>${type === 'module' ? 'N/A' : parentLevel}</b></label>
                </div>
                <textarea id="output-code">${rawCode.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>
                <div class="btn-group">
                    <button class="btn-obfuscate" onclick="runObfuscation()">✨ Obfuscate Code</button>
                    <button class="btn-copy" onclick="copyToClipboard()">📋 Copy</button>
                    <button class="btn-download" onclick="saveFile()">📥 Save As...</button>
                </div>
            </div>
        </div>
        <script>
            const logo = String.raw\`--[[
            █████╗ ███████╗    ██████╗ ██████╗  ██████╗ ██████╗ ██╗    ██╗ ██████╗████████╗██╗ ██████╗ ███╗   ██╗███████╗
           ██╔══██╗██╔════╝    ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗██║    ██║██╔════╝╚══██╔══╝██║██╔═══██╗████╗  ██║██╔════╝
           ███████║███████╗    ██████╔╝██████╔╝██║   ██║██║  ██║██║    ██║██║       ██║   ██║██║   ██║██╔██╗ ██║███████╗
           ██╔══██║╚════██║    ██╔═══╝ ██╔══██╗██║   ██║██║  ██║██║    ██║██║       ██║   ██║██║   ██║██║╚██╗██║╚════██║
           ██║  ██║███████║    ██║     ██║  ██║╚██████╔╝██████╔╝╚██████╔╝╚██████╗  ██║   ██║╚██████╔╝██║ ╚████║███████║
           ╚═╝  ╚═╝╚══════╝    ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝  ╚═════╝  ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝
--]]\\n\\n\`;

            async function runObfuscation() {
                const area = document.getElementById("output-code");
                const code = area.value;
                area.value = "-- Obfuscating...";
                
                const response = await fetch('/api/perform-obfuscate', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ code })
                });
                const result = await response.text();
                area.value = logo + result;
            }

            function copyToClipboard() {
                const area = document.getElementById("output-code");
                area.select();
                document.execCommand("copy");
            }

            async function saveFile() {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: 'protected_script.lua',
                        types: [{ description: 'Lua File', accept: {'text/plain': ['.lua']} }],
                    });
                    const stream = await handle.createWritable();
                    await stream.write(document.getElementById("output-code").value);
                    await stream.close();
                } catch (e) {
                    console.log("Save cancelled or not supported");
                }
            }
        </script>
    </body>
    </html>`);
});

app.post('/api/perform-obfuscate', checkAuth, async (req, res) => {
    const { code } = req.body;
    try {
        const response = await axios.post('https://magicsec.vip/api/obfuscate', {
            code, platform: "roblox", options: { antiTamper: true, encryptStrings: true }
        });
        res.send(response.data.code || response.data.script || response.data);
    } catch (e) {
        res.status(500).send("-- Error obfuscating");
    }
});

app.get('/force-save', checkAuth, async (req, res) => {
    await safeSave();
    res.redirect('/');
});

app.post('/toggle-maintenance', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) {
        return res.sendStatus(403);
    }
    const data = db.getData();
    data.maintenanceMode = !data.maintenanceMode;
    await safeSave();
    await saveActionLogInternal(req.session.userEmail, 'Toggle Maintenance Mode', `Maintenance is now ${data.maintenanceMode ? 'ON' : 'OFF'}`);
    res.json({ maintenanceMode: !!data.maintenanceMode });
});

app.get('/api/lookup-username', checkAuth, async (req, res) => {
    const username = (req.query.username || '').trim();
    if (!username) return res.json({ ok: false, error: 'Missing username' });
    try {
        const userRes = await axios.post(
            'https://users.roblox.com/v1/usernames/users',
            { usernames: [username], excludeBannedUsers: false },
            { timeout: 8000 }
        );
        const row = userRes.data && userRes.data.data && userRes.data.data[0];
        if (!row) return res.json({ ok: false, error: 'User not found' });
        res.json({ ok: true, id: row.id, name: row.name || row.requestedUsername || username });
    } catch (e) {
        res.json({ ok: false, error: 'Roblox lookup failed' });
    }
});

app.get('/toggle-entity-freeze/:type/:id', checkAuth, async (req, res) => {
    const data = db.getData();
    const { type, id } = req.params;
    if (!data.whitelist[type]) return res.sendStatus(404);
    const item = data.whitelist[type].find(x => x.id === Number(id));
    if (!item) return res.sendStatus(404);
    item.frozen = !item.frozen;
    await safeSave();
    await saveActionLogInternal(
        req.session.userEmail,
        item.frozen ? 'Freeze Entity' : 'Unfreeze Entity',
        `${type} ${item.name || ''} (${id}) is now ${item.frozen ? 'FROZEN' : 'active'}`
    );
    res.sendStatus(200);
});

app.get('/toggle-sub-key-freeze/:type/:id/:key', checkAuth, async (req, res) => {
    const data = db.getData();
    const { type, id, key } = req.params;
    const decodedKey = decodeURIComponent(key);
    if (!data.whitelist[type]) return res.sendStatus(404);
    const item = data.whitelist[type].find(x => x.id === Number(id));
    if (!item || !item.keys) return res.sendStatus(404);
    const k = item.keys.find(x => x.key === decodedKey);
    if (!k) return res.sendStatus(404);
    k.frozen = !k.frozen;
    await safeSave();
    await saveActionLogInternal(
        req.session.userEmail,
        k.frozen ? 'Freeze Entity Key' : 'Unfreeze Entity Key',
        `Key [${decodedKey}] on ${type} (${id}) is now ${k.frozen ? 'FROZEN' : 'active'}`
    );
    res.sendStatus(200);
});

app.get('/toggle-key-freeze/:key', checkAuth, async (req, res) => {
    const data = db.getData();
    const keyTarget = decodeURIComponent(req.params.key);
    const keyObj = data.keys.find(k => k.key === keyTarget);
    if (!keyObj) return res.sendStatus(404);
    // Only owner can freeze ALL keys / locked keys handling
    if (req.session.userEmail !== OWNER_EMAIL) {
        if (keyObj.isLocked || isAllAccessKey(keyObj, keyTarget)) {
            return res.sendStatus(403);
        }
    }
    keyObj.frozen = !keyObj.frozen;
    await safeSave();
    await saveActionLogInternal(
        req.session.userEmail,
        keyObj.frozen ? 'Freeze System Key' : 'Unfreeze System Key',
        `System key [${keyTarget}] is now ${keyObj.frozen ? 'FROZEN' : 'active'}`
    );
    res.sendStatus(200);
});

app.get('/force-load', checkAuth, async (req, res) => {
    // Re-load data from Google Sheets (same place Save writes to)
    try {
        if (typeof db.loadData === 'function') {
            await db.loadData();
        } else {
            console.warn('force-load: db.loadData not available');
        }
    } catch (e) {
        console.error('force-load error:', e);
    }
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
        await safeSave();
        await saveActionLogInternal(req.session.userEmail, "Toggle Key Lock Status", `Admin toggled lock state for key: ${keyTarget}. Locked: ${keyObj.isLocked}`);
    }
    res.sendStatus(200);
});

let saveQueued = false;

async function persistToDb() {
    // Support whichever persistence method the db module actually exposes.
    if (typeof db.save === 'function') return db.save();
    if (typeof db.saveData === 'function') return db.saveData();
    if (typeof db.write === 'function') return db.write();
    if (typeof db.persist === 'function') return db.persist();
    console.error('safeSave: db module has no save/saveData/write/persist method - data is NOT being persisted to disk!');
}

async function safeSave() {
    if (isSaving) {
        // A save is already running - don't drop this write, queue it so it runs
        // right after the current one finishes. This is what prevents data loss
        // (like duplicated/ghost active users) when multiple requests hit at once.
        saveQueued = true;
        return;
    }
    isSaving = true;
    try {
        await persistToDb();
    } catch (e) {
        console.error('safeSave error:', e);
    } finally {
        isSaving = false;
    }
    if (saveQueued) {
        saveQueued = false;
        await safeSave();
    }
}

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

    if (req.session.userEmail !== OWNER_EMAIL) {
        for (let k of assignedKeys) {
            const registeredKey = data.keys.find(x => x.key === k);
            if (registeredKey && registeredKey.isLocked) {
                return res.sendStatus(403);
            }
            // Only Owner may assign ALL access keys
            if (isAllAccessKey(registeredKey, k)) {
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
            groups = groupsRes.data.data.filter(g => g.role.rank === 255).map(g => `${g.group.name} (${g.group.id})`);
        } catch (e) {}
    }

    let placeCreatorName = null;
    let placeCreatorId = null;
    if (type === 'places' && id) {
        const meta = await resolvePlaceMeta(id, null);
        if (!isBadMetaName(meta.placeName)) name = meta.placeName;
        if (!isBadMetaName(meta.creatorName)) placeCreatorName = meta.creatorName;
        if (meta.creatorId) placeCreatorId = meta.creatorId;
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
                expiresAt: overallExpiresAt || currentItem.expiresAt,
                ...(type === 'places' ? {
                    creatorName: placeCreatorName || currentItem.creatorName,
                    creatorId: placeCreatorId || currentItem.creatorId
                } : {})
            };
            await saveActionLogInternal(req.session.userEmail, "Updated Whitelist Entity", `Updated ${targetLabel}. Associated Keys: [ ${keysLogString} ]`);
        } else {
            const newItem = { 
                id, 
                name: name || (type === 'places' ? 'Place' : 'Unknown'), 
                groups: groups.length > 0 ? groups : null,
                keys: itemKeys,
                expiresAt: overallExpiresAt
            };
            if (type === 'places') {
                newItem.creatorName = placeCreatorName;
                newItem.creatorId = placeCreatorId;
            }
            data.whitelist[type].push(newItem);
            await saveActionLogInternal(req.session.userEmail, "Direct Whitelist Grant", `Authorized new ${targetLabel}. Mapped Keys: [ ${keysLogString} ]`);
        }
        await safeSave();
    }
    res.sendStatus(200);
});

app.post('/add-key', checkAuth, async (req, res) => {
    const data = db.getData();
    const key = (req.body.key || '').trim();
    const wantAll = req.body.isAllAccess === '1' || req.body.isAllAccess === 'on' || req.body.isAllAccess === true;
    if (key) {
        // Only Owner can create ALL access keys (name ALL or checkbox)
        if ((wantAll || key.toUpperCase() === 'ALL') && req.session.userEmail !== OWNER_EMAIL) {
            return res.sendStatus(403);
        }
        const existingKeyIndex = data.keys.findIndex(k => k.key === key);
        if (existingKeyIndex === -1) {
            const isAllAccess = wantAll || key.toUpperCase() === 'ALL';
            data.keys.push({ key, isLocked: false, isAllAccess: !!isAllAccess });
            await safeSave();
            await saveActionLogInternal(
                req.session.userEmail,
                'Create License Key',
                `Generated new license key: ${key}${isAllAccess ? ' [ALL ACCESS]' : ''}`
            );
        }
    }
    res.sendStatus(200);
});

app.get('/delete-key/:key', checkAuth, async (req, res) => {
    const data = db.getData();
    const keyToDelete = req.params.key;
    const registeredKey = data.keys.find(k => k.key === keyToDelete);
    
    if (req.session.userEmail !== OWNER_EMAIL) {
        if (registeredKey && registeredKey.isLocked) return res.sendStatus(403);
        if (isAllAccessKey(registeredKey, keyToDelete)) return res.sendStatus(403);
    }

    data.keys = data.keys.filter(k => k.key !== keyToDelete);
    await safeSave();
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
            await safeSave();
        }
    }
    res.sendStatus(200);
});

app.post('/approve/:id/:key', checkAuth, async (req, res) => {
    const data = db.getData();
    const id = Number(req.params.id);
    const keyParam = decodeURIComponent(req.params.key);
    const expiresAtRaw = req.body.expiresAt;
    const pending = data.pendingPlaces.find(p => p.id === id && p.key === keyParam);
    
    if (pending) {
        const registeredKey = data.keys.find(x => x.key === pending.key);
        if (req.session.userEmail !== OWNER_EMAIL) {
            if (registeredKey && registeredKey.isLocked) return res.sendStatus(403);
            if (isAllAccessKey(registeredKey, pending.key)) return res.sendStatus(403);
        }

        const expiresTime = expiresAtRaw ? parseLocalTime(expiresAtRaw) : null;

        // Ensure we have real names before storing in Authorized Places
        let placeName = pending.name;
        let creatorName = pending.creatorName;
        let creatorIdVal = pending.creatorId;
        if (isBadMetaName(placeName) || isBadMetaName(creatorName)) {
            const meta = await resolvePlaceMeta(id, pending.creatorId);
            if (!isBadMetaName(meta.placeName)) placeName = meta.placeName;
            if (!isBadMetaName(meta.creatorName)) creatorName = meta.creatorName;
            if (meta.creatorId) creatorIdVal = meta.creatorId;
        }

        const existingIndex = data.whitelist.places.findIndex(p => p.id === id);
        
        if (existingIndex !== -1) {
            const currentItem = data.whitelist.places[existingIndex];
            const updatedKeys = currentItem.keys && Array.isArray(currentItem.keys) ? [...currentItem.keys] : [];
            const keyIdx = updatedKeys.findIndex(k => k.key === pending.key);
            if (keyIdx !== -1) {
                updatedKeys[keyIdx].expiresAt = expiresTime;
            } else {
                updatedKeys.push({ key: pending.key, expiresAt: expiresTime });
            }
            data.whitelist.places[existingIndex] = {
                ...currentItem,
                name: (!isBadMetaName(placeName) ? placeName : currentItem.name) || currentItem.name,
                creatorName: creatorName || currentItem.creatorName,
                creatorId: creatorIdVal || currentItem.creatorId,
                keys: updatedKeys,
                expiresAt: expiresTime || currentItem.expiresAt
            };
        } else {
            data.whitelist.places.push({
                id,
                name: placeName || 'Approved Place',
                creatorName: creatorName || null,
                creatorId: creatorIdVal || null,
                keys: [{ key: pending.key, expiresAt: expiresTime }],
                expiresAt: expiresTime
            });
        }
        data.pendingPlaces = data.pendingPlaces.filter(p => !(p.id === id && p.key === keyParam));
        await safeSave();
        await saveActionLogInternal(req.session.userEmail, "Approve Pending Request", `Approved Game: ${pending.name || 'Unknown'} (Place ID: ${id}) requested by Owner: ${pending.creatorName || 'Unknown'} (Creator ID: ${pending.creatorId}) using License Key: ${pending.key}`);
    }
    res.sendStatus(200);
});

app.post('/reject/:id/:key', checkAuth, async (req, res) => {
    const data = db.getData();
    const id = Number(req.params.id);
    const keyParam = decodeURIComponent(req.params.key);
    const pending = data.pendingPlaces.find(p => p.id === id && p.key === keyParam);
    if (pending) {
        data.pendingPlaces = data.pendingPlaces.filter(p => !(p.id === id && p.key === keyParam));
        await safeSave();
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
    await safeSave();
    await saveActionLogInternal(req.session.userEmail, "Remove Whitelist Entity", `Revoked access completely from ${type === 'creators' ? 'Creator' : 'Place'} -> Name/ID: ${targetName} (${id})`);
    res.sendStatus(200);
});

app.listen(PORT, () => {});
