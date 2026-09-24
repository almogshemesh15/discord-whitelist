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

app.set('trust proxy', 1);
const isProd = !!process.env.RENDER || process.env.NODE_ENV === 'production';

app.use(session({
    secret: process.env.SESSION_SECRET || 'secure_whitelist_hub_secret_key',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'lax',
        httpOnly: true,
        secure: isProd
    }
}));

const PORT = process.env.PORT || 3000;
// Direct Discord URL (fallback). Prefer proxy to avoid Render IP ban (CF 1015).
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL
    || 'https://discord.com/api/webhooks/1551702764545904741/c5tFO456-VY-FjvJ44uXAk9mNQgyhUPl44D8q_3l-ffg_hunopzBPIywjnJI4mA7A7tJ';
// Cloudflare Worker proxy (set in Render env after deploying the Worker)
const DISCORD_WEBHOOK_PROXY_URL = (process.env.DISCORD_WEBHOOK_PROXY_URL || '').replace(/\/$/, '');
const DISCORD_PROXY_SECRET = process.env.DISCORD_PROXY_SECRET || '';


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
const BOT_API_SECRET = process.env.BOT_API_SECRET || '';

/** Live status from Mac bot heartbeats (in-memory on Render) */
let botRuntime = {
    lastSeen: null,
    tag: null,
    guilds: 0,
    pingMs: null,
    error: null,
    startedAt: null,
    version: null
};

const DEFAULT_BOT_COMMANDS = [
    { id: 'wl-link', name: 'link', description: 'Link Discord to Roblox with an in-game code', enabled: true, roleIds: ['ALL'] },
    { id: 'wl-switchaccount', name: 'switchaccount', description: 'Switch linked Roblox or Discord account', enabled: true, roleIds: ['ALL'] },
    { id: 'wl-profile', name: 'profile', description: 'View linked Roblox profile and hub products', enabled: true, roleIds: ['ALL'] },
    { id: 'wl-hub', name: 'hub', description: 'Show Hub store products and game link', enabled: true, roleIds: ['ALL'] },
    { id: 'wl-retrieve', name: 'retrieve', description: 'DM your files for a product you own', enabled: true, roleIds: ['ALL'] }
];


function syncHubKeysForProduct(data, product, oldKeys) {
    const owners = (data.hubOwnerships || []).filter(o => o.productId === product.id);
    const newKeys = product.keyNames || [];
    const prev = Array.isArray(oldKeys) ? oldKeys : [];
    for (const o of owners) {
        let creator = (data.whitelist.creators || []).find(c => String(c.id) === String(o.robloxId));
        if (!creator) {
            creator = { id: Number(o.robloxId) || o.robloxId, name: o.robloxName || String(o.robloxId), keys: [], groups: null };
            data.whitelist.creators.push(creator);
        }
        if (!Array.isArray(creator.keys)) creator.keys = [];
        // Remove hub keys that were from this product but no longer granted
        creator.keys = creator.keys.filter(k => {
            if (!k.fromHub || k.hubProductId !== product.id) return true;
            return newKeys.includes(k.key);
        });
        for (const kn of newKeys) {
            const existing = creator.keys.find(k => k.key === kn);
            if (!existing) {
                creator.keys.push({ key: kn, expiresAt: null, fromHub: true, hubProductId: product.id });
            } else {
                existing.fromHub = true;
                existing.hubProductId = product.id;
            }
        }
    }
}
function ensureHubStores(data) {
    if (!Array.isArray(data.hubProducts)) data.hubProducts = [];
    if (!Array.isArray(data.hubOwnerships)) data.hubOwnerships = [];
    if (!Array.isArray(data.pendingBotJobs)) data.pendingBotJobs = [];
}
function publicBaseUrl(req) {
    const env = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
    if (env) return env.replace(/\/$/, '');
    if (req && req.headers && req.headers.host) {
        const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
        return proto + '://' + req.headers.host;
    }
    return 'https://discord-whitelist-ow56.onrender.com';
}
function enqueueBotJob(data, type, payload) {
    ensureHubStores(data);
    const job = {
        id: newHubId(),
        type: String(type),
        payload: payload || {},
        createdAt: Date.now(),
        tries: 0
    };
    data.pendingBotJobs.push(job);
    return job;
}
function rolesForRoblox(data, robloxId) {
    const set = new Set();
    for (const o of (data.hubOwnerships || [])) {
        if (String(o.robloxId) !== String(robloxId)) continue;
        const p = (data.hubProducts || []).find(x => x.id === o.productId);
        if (!p) continue;
        for (const r of (p.discordRoleIds || [])) {
            if (r && String(r).toUpperCase() !== 'ALL') set.add(String(r));
        }
    }
    return [...set];
}
function fileMetaList(product, base) {
    return (product.files || []).map(f => ({
        id: f.id,
        name: f.name,
        size: f.size || 0,
        url: base + '/api/hub/files/' + f.token
    }));
}

function allHubRoleIds(data) {
    const set = new Set();
    for (const p of (data.hubProducts || [])) {
        for (const r of (p.discordRoleIds || [])) {
            if (r && String(r).toUpperCase() !== 'ALL') set.add(String(r));
        }
    }
    return [...set];
}
function notifyProductRevoked(data, product, robloxId) {
    ensureLinkStores(data);
    const link = (data.discordLinks || []).find(l => String(l.robloxId) === String(robloxId));
    if (!link || !link.discordId) return;
    enqueueBotJob(data, 'roles_sync', {
        discordId: String(link.discordId),
        robloxId: String(robloxId),
        roleIds: rolesForRoblox(data, robloxId),
        managedRoleIds: allHubRoleIds(data)
    });
}
function notifyProductGranted(data, product, robloxId, robloxName, base) {
    ensureLinkStores(data);
    const link = (data.discordLinks || []).find(l => String(l.robloxId) === String(robloxId));
    const roles = rolesForRoblox(data, robloxId);
    if (link && link.discordId) {
        enqueueBotJob(data, 'product_granted', {
            discordId: String(link.discordId),
            robloxId: String(robloxId),
            robloxName: robloxName || null,
            productId: product.id,
            productName: product.name,
            roleIds: roles,
            managedRoleIds: allHubRoleIds(data),
            files: fileMetaList(product, base || publicBaseUrl())
        });
    } else {
        enqueueBotJob(data, 'product_granted_pending_link', {
            robloxId: String(robloxId),
            productId: product.id
        });
    }
}

function newHubId() {
    try { return require('crypto').randomBytes(8).toString('hex'); } catch (_) {
        return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
}
function ensureLinkStores(data) {
    if (!Array.isArray(data.discordLinks)) data.discordLinks = [];
    if (!data.pendingLinkCodes || typeof data.pendingLinkCodes !== 'object') data.pendingLinkCodes = {};
}

/** 8-char unique code, never collides with active pending or recent */
function generateUniqueLinkCode(data) {
    ensureLinkStores(data);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
    for (let attempt = 0; attempt < 50; attempt++) {
        let code = '';
        for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
        const pending = data.pendingLinkCodes[code];
        if (pending && pending.expiresAt > Date.now()) continue;
        return code;
    }
    // fallback ultra-unique
    return ('X' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase().slice(0, 10);
}

function purgeExpiredLinkCodes(data) {
    ensureLinkStores(data);
    const now = Date.now();
    for (const [code, row] of Object.entries(data.pendingLinkCodes)) {
        if (!row || !row.expiresAt || row.expiresAt <= now) delete data.pendingLinkCodes[code];
    }
}

function normalizeRoleIds(raw) {
    let list = [];
    if (typeof raw === 'string') {
        list = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(raw)) {
        list = raw.map(String).map(s => s.trim()).filter(Boolean);
    }
    const upper = list.map(s => s.toUpperCase());
    if (upper.includes('ALL') || upper.includes('@EVERYONE') || upper.includes('EVERYONE')) {
        return ['ALL'];
    }
    return list;
}

function ensureBotConfig(data) {
    if (!data.botConfig || typeof data.botConfig !== 'object') {
        data.botConfig = { enabled: true, commands: [], robloxGameUrl: '', hubShowPrices: true, updatedAt: Date.now() };
    }
    if (typeof data.botConfig.enabled !== 'boolean') data.botConfig.enabled = true;
    if (typeof data.botConfig.robloxGameUrl !== 'string') data.botConfig.robloxGameUrl = data.botConfig.robloxGameUrl || '';
    if (typeof data.botConfig.hubShowPrices !== 'boolean') data.botConfig.hubShowPrices = true;
    if (!Array.isArray(data.botConfig.commands)) data.botConfig.commands = [];
    const byId = {};
    data.botConfig.commands.forEach(c => { if (c && c.id) byId[c.id] = c; });
    const merged = DEFAULT_BOT_COMMANDS.map(def => {
        const cur = byId[def.id] || {};
        let name = (cur.name != null ? String(cur.name) : def.name).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
        if (!name) name = def.name;
        const roleIds = normalizeRoleIds(cur.roleIds != null ? cur.roleIds : def.roleIds);
        return {
            id: def.id,
            name,
            description: (cur.description != null ? String(cur.description) : def.description).slice(0, 100),
            enabled: cur.enabled !== false,
            roleIds
        };
    });
    data.botConfig.commands = merged;
    return data.botConfig;
}

function checkBotAuth(req, res, next) {
    if (!BOT_API_SECRET) {
        return res.status(503).json({ error: 'BOT_API_SECRET not configured on server' });
    }
    const secret = req.headers['x-bot-secret'] || (req.body && req.body.secret) || req.query.secret;
    if (!secret || secret !== BOT_API_SECRET) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

function getBotDashboardStatus() {
    const ONLINE_MS = 90 * 1000;
    const online = !!(botRuntime.lastSeen && (Date.now() - botRuntime.lastSeen) < ONLINE_MS);
    const data = db.getData();
    const cfg = ensureBotConfig(data);
    return {
        online,
        lastSeen: botRuntime.lastSeen,
        lastSeenAgoSec: botRuntime.lastSeen ? Math.round((Date.now() - botRuntime.lastSeen) / 1000) : null,
        tag: botRuntime.tag,
        guilds: botRuntime.guilds,
        pingMs: botRuntime.pingMs,
        error: botRuntime.error,
        startedAt: botRuntime.startedAt,
        version: botRuntime.version,
        secretConfigured: !!BOT_API_SECRET,
        botEnabled: !!cfg.enabled,
        commands: cfg.commands,
        configUpdatedAt: cfg.updatedAt || null
    };
}


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
        personalHint: 'Personal rules override defaults — except Maintenance, which always wins. You can bind a message to a key, place, creator, or creator+tag.',
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
        disconnect: 'Disconnect',
        reason_maintenance: 'Maintenance mode',
        reason_invalid_key: 'Invalid license key',
        reason_key_frozen: 'System key frozen',
        reason_entity_frozen: 'Place / Creator frozen',
        reason_tag_frozen: 'Tag frozen on entity',
        reason_tag_expired: 'Tag / license expired',
        reason_pending: 'Pending approval',
        reason_not_whitelisted: 'Not authorized',
        reason_missing_ids: 'Missing IDs (rare)',
        scopeKey: 'Key / Tag only',
        scopePlace: 'Place ID',
        scopeCreator: 'Creator (user)',
        scopeCreatorKey: 'Creator + Tag',
        tagLabel: 'Tag / Key',
        resolveBtn: 'Resolve username',
        targetHint: 'Username or ID — will save as Name (id)',
        userLangTitle: 'User message language',
        userLangHint: 'Choose English or Hebrew for a specific creator or Place ID. Hebrew translates messages live for that target. Place overrides creator when both match.',
        userLangSave: 'Save language',
        noUserLang: 'No per-user languages set',
        scopeUser: 'Creator (user)',
        scopePlaceId: 'Place ID'
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
        personalHint: 'כללים אישיים גוברים על ברירת מחדל — חוץ מתחזוקה, שתמיד מנצחת. אפשר לקשור הודעה למפתח, מפה, יוצר, או יוצר+טאג.',
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
        disconnect: 'ניתוק',
        reason_maintenance: 'מצב תחזוקה',
        reason_invalid_key: 'מפתח רישיון לא תקין',
        reason_key_frozen: 'מפתח מערכת מוקפא',
        reason_entity_frozen: 'מפה / יוצר מוקפא',
        reason_tag_frozen: 'טאג מוקפא על ישות',
        reason_tag_expired: 'טאג / רישיון פג תוקף',
        reason_pending: 'ממתין לאישור',
        reason_not_whitelisted: 'אין הרשאה',
        reason_missing_ids: 'חסרים מזהים (נדיר)',
        scopeKey: 'מפתח / טאג בלבד',
        scopePlace: 'מזהה מפה',
        scopeCreator: 'יוצר (משתמש)',
        scopeCreatorKey: 'יוצר + טאג',
        tagLabel: 'טאג / מפתח',
        resolveBtn: 'פתור שם משתמש',
        targetHint: 'שם משתמש או ID — יישמר כ־Name (id)',
        userLangTitle: 'שפת הודעות למשתמש',
        userLangHint: 'בחר אנגלית או עברית ליוצר או ל־Place ID. עברית מתורגמת בלייב ליעד הזה. Place גובר על יוצר כששניהם מוגדרים.',
        userLangSave: 'שמור שפה',
        noUserLang: 'לא הוגדרו שפות לפי משתמש',
        scopeUser: 'יוצר (משתמש)',
        scopePlaceId: 'מזהה מפה (Place ID)'
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

const DEFAULT_PANEL_MESSAGES_HE = {
    maintenance: 'המערכת בתחזוקה כרגע.\nהגישה נחסמה זמנית.\nנא לנסות שוב מאוחר יותר.',
    invalid_key: 'מפתח הרישיון אינו תקין.\nהגישה נדחתה.',
    key_frozen: 'מפתח הרישיון הוקפא.\nהשימוש במפתח זה נחסם עד להפשרה.',
    entity_frozen: 'הגישה לישות זו הוקפאה.\nפנה למנהל המערכת.',
    tag_frozen: 'רישיון המוצר הוקפא.\nהטאג נעול עד להפשרה.',
    tag_expired: 'תוקף הרישיון פג.\nיש לחדש את הרישיון כדי להמשיך.',
    pending: 'הבקשה ממתינה לאישור.\nהגישה טרם אושרה.',
    not_whitelisted: 'אין הרשאה למקום זה.\nפנה למנהל לקבלת גישה.',
    missing_ids: 'חסרים מזהים (creatorId / placeId).'
};

/** English panel messages (defaults + admin overrides). Never stores Hebrew. */
function getPanelMessagesEn(data) {
    const stored = (data && data.panelMessages) || {};
    const out = { ...DEFAULT_PANEL_MESSAGES };
    for (const k of Object.keys(DEFAULT_PANEL_MESSAGES)) {
        if (typeof stored[k] === 'string' && stored[k].trim()) out[k] = stored[k];
    }
    return out;
}

/** In-memory only — never written to Google Sheets / DB */
const liveTranslateCache = new Map();

/**
 * Live EN→HE translation at request time.
 * Result is cached in RAM only so changing English defaults picks up on next miss after cache clear,
 * and we never persist translations.
 */
async function translateEnToHeLive(text) {
    if (!text || typeof text !== 'string') return text;
    if (liveTranslateCache.has(text)) return liveTranslateCache.get(text);
    try {
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=he&dt=t&q='
            + encodeURIComponent(text);
        const res = await axios.get(url, { timeout: 6000 });
        let out = '';
        if (Array.isArray(res.data) && Array.isArray(res.data[0])) {
            out = res.data[0].map(part => (part && part[0]) || '').join('');
        }
        if (out) {
            liveTranslateCache.set(text, out);
            return out;
        }
    } catch (e) {
        console.warn('live translate failed:', e.message || e);
    }
    // Fallback: static HE defaults by matching exact default EN string
    for (const k of Object.keys(DEFAULT_PANEL_MESSAGES)) {
        if (DEFAULT_PANEL_MESSAGES[k] === text && DEFAULT_PANEL_MESSAGES_HE[k]) {
            liveTranslateCache.set(text, DEFAULT_PANEL_MESSAGES_HE[k]);
            return DEFAULT_PANEL_MESSAGES_HE[k];
        }
    }
    return text;
}

/**
 * userPanelLang structure (normalized):
 * { creators: { "123": { lang, name } }, places: { "456": { lang, name } } }
 * Legacy flat map is treated as creators. Place wins over creator when both match.
 */
function normalizePanelLangMap(raw) {
    const out = { creators: {}, places: {} };
    if (!raw || typeof raw !== 'object') return out;
    if (raw.creators || raw.places) {
        for (const [id, val] of Object.entries(raw.creators || {})) {
            if (!/^\d+$/.test(String(id))) continue;
            if (typeof val === 'string') out.creators[String(id)] = { lang: val === 'he' ? 'he' : 'en', name: null };
            else if (val && typeof val === 'object') {
                out.creators[String(id)] = {
                    lang: val.lang === 'he' ? 'he' : 'en',
                    name: val.name ? String(val.name) : null
                };
            }
        }
        for (const [id, val] of Object.entries(raw.places || {})) {
            if (!/^\d+$/.test(String(id))) continue;
            if (typeof val === 'string') out.places[String(id)] = { lang: val === 'he' ? 'he' : 'en', name: null };
            else if (val && typeof val === 'object') {
                out.places[String(id)] = {
                    lang: val.lang === 'he' ? 'he' : 'en',
                    name: val.name ? String(val.name) : null
                };
            }
        }
        return out;
    }
    for (const [id, val] of Object.entries(raw)) {
        if (!/^\d+$/.test(String(id))) continue;
        if (typeof val === 'string') out.creators[String(id)] = { lang: val === 'he' ? 'he' : 'en', name: null };
        else if (val && typeof val === 'object') {
            const bucket = val.type === 'place' ? 'places' : 'creators';
            out[bucket][String(id)] = {
                lang: val.lang === 'he' ? 'he' : 'en',
                name: val.name ? String(val.name) : null
            };
        }
    }
    return out;
}

function getUserPanelLang(data, ctx) {
    // Support legacy call: getUserPanelLang(data, creatorId)
    const creatorId = (ctx && typeof ctx === 'object') ? ctx.creatorId : ctx;
    const placeId = (ctx && typeof ctx === 'object') ? ctx.placeId : null;
    const map = normalizePanelLangMap(data && data.userPanelLang);
    if (placeId != null && map.places[String(placeId)]) {
        return map.places[String(placeId)].lang === 'he' ? 'he' : 'en';
    }
    if (creatorId != null && map.creators[String(creatorId)]) {
        return map.creators[String(creatorId)].lang === 'he' ? 'he' : 'en';
    }
    return 'en';
}

function entityHasFrozenAllTag(item, data) {
    if (!item || !item.keys || !Array.isArray(item.keys)) return false;
    const keys = data.keys || [];
    return item.keys.some(k => {
        if (!k.frozen) return false;
        const reg = keys.find(x => x.key === k.key);
        return isAllAccessKey(reg, k.key);
    });
}

/** Extract numeric id from "Name (12345)" or plain "12345" */
function extractTargetId(target) {
    if (target == null) return null;
    const s = String(target).trim();
    const m = s.match(/\((\d+)\)\s*$/);
    if (m) return m[1];
    if (/^\d+$/.test(s)) return s;
    return null;
}

function targetMatchesCreator(target, creatorId) {
    if (creatorId == null) return false;
    const id = extractTargetId(target);
    if (id && String(id) === String(creatorId)) return true;
    // also allow exact string match on raw target
    return String(target) === String(creatorId);
}

/**
 * Custom personal messages:
 * { id, scope: 'key'|'place'|'creator'|'creator_key', target, tag?, message }
 * - key: matches licenseKey
 * - place: matches placeId
 * - creator: matches creatorId (target stored as "username (id)")
 * - creator_key: matches creatorId AND tag (license key)
 * Custom messages NEVER override maintenance.
 */
/**
 * Build the English message for a reason (customs first, then EN defaults).
 * If user language is Hebrew → translate that English text LIVE (RAM cache only).
 */
async function resolvePanelMessage(data, reason, { licenseKey, placeId, creatorId } = {}) {
    const userLang = getUserPanelLang(data, { creatorId, placeId });
    const enMsgs = getPanelMessagesEn(data);

    const finalize = async (englishText) => {
        const text = englishText || enMsgs[reason] || DEFAULT_PANEL_MESSAGES[reason] || 'Access denied.';
        if (userLang === 'he') return translateEnToHeLive(text);
        return text;
    };

    // Maintenance always wins — no personal override (still live-translated if needed)
    if (reason === 'maintenance') {
        return finalize(enMsgs.maintenance || DEFAULT_PANEL_MESSAGES.maintenance);
    }

    const customs = (data && data.customPanelMessages) || [];

    // 1) Most specific: creator + tag
    if (creatorId != null && licenseKey) {
        const hit = customs.find(c =>
            c.scope === 'creator_key' &&
            targetMatchesCreator(c.target, creatorId) &&
            String(c.tag || '') === String(licenseKey)
        );
        if (hit && hit.message) return finalize(hit.message);
    }

    // 2) place + tag
    if (placeId != null && licenseKey) {
        const hit = customs.find(c =>
            c.scope === 'place_key' &&
            String(extractTargetId(c.target) || c.target) === String(placeId) &&
            String(c.tag || '') === String(licenseKey)
        );
        if (hit && hit.message) return finalize(hit.message);
    }

    // 3) key only
    if (licenseKey) {
        const hit = customs.find(c => c.scope === 'key' && String(c.target) === String(licenseKey));
        if (hit && hit.message) return finalize(hit.message);
    }

    // 4) place only
    if (placeId != null) {
        const hit = customs.find(c =>
            c.scope === 'place' &&
            String(extractTargetId(c.target) || c.target) === String(placeId)
        );
        if (hit && hit.message) return finalize(hit.message);
    }

    // 5) creator only
    if (creatorId != null) {
        const hit = customs.find(c =>
            c.scope === 'creator' &&
            targetMatchesCreator(c.target, creatorId)
        );
        if (hit && hit.message) return finalize(hit.message);
    }

    return finalize(enMsgs[reason] || DEFAULT_PANEL_MESSAGES[reason]);
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

let discordBlockedUntil = 0; // timestamp ms

function formatBlockDuration(ms) {
    if (ms <= 0) return '0s';
    const s = Math.ceil(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return m + 'm ' + rs + 's';
}

async function postDiscordWebhook(payload, label) {
    const now = Date.now();
    if (now < discordBlockedUntil) {
        const left = discordBlockedUntil - now;
        console.warn('[Discord] ' + label + ' SKIPPED — still blocked for ' + formatBlockDuration(left) + ' (until ' + new Date(discordBlockedUntil).toISOString() + ')');
        return { ok: false, blocked: true, blockedForMs: left };
    }
    // Prefer Cloudflare Worker proxy (bypasses Render IP ban on discord.com)
    const targetUrl = DISCORD_WEBHOOK_PROXY_URL || DISCORD_WEBHOOK_URL;
    const headers = { 'Content-Type': 'application/json' };
    if (DISCORD_WEBHOOK_PROXY_URL && DISCORD_PROXY_SECRET) {
        headers['X-Proxy-Secret'] = DISCORD_PROXY_SECRET;
    }
    if (DISCORD_WEBHOOK_PROXY_URL) {
        console.log('[Discord] ' + label + ' via Cloudflare Worker proxy');
    }
    try {
        const res = await axios.post(targetUrl, payload, {
            timeout: 15000,
            headers,
            validateStatus: () => true
        });
        if (res.status === 204 || (res.status >= 200 && res.status < 300)) {
            console.log('[Discord] ' + label + ' OK (HTTP ' + res.status + ')');
            return { ok: true };
        }
        if (res.status === 429) {
            const data = res.data || {};
            const isCf = !!(data.cloudflare_error || data.error_code === 1015);
            let retrySec = 30;
            if (data.retry_after != null) retrySec = Number(data.retry_after);
            else if (data.retry_after === 0) retrySec = 30;
            // Cloudflare 1015 from Render often needs longer
            if (isCf) retrySec = Math.max(retrySec, 300); // at least 5 min
            const blockMs = Math.ceil(retrySec * 1000);
            discordBlockedUntil = Date.now() + blockMs;
            console.error('[Discord] ' + label + ' RATE LIMITED (HTTP 429)');
            console.error('[Discord] Cloudflare/Discord block: ' + (isCf ? 'YES (error 1015)' : 'Discord webhook limit'));
            console.error('[Discord] Blocked for: ' + formatBlockDuration(blockMs) + ' (retry_after=' + retrySec + 's)');
            console.error('[Discord] Unblock at: ' + new Date(discordBlockedUntil).toISOString());
            if (data.detail) console.error('[Discord] Detail:', String(data.detail).slice(0, 200));
            return { ok: false, status: 429, blockedForMs: blockMs, isCf: isCf };
        }
        console.error('[Discord] ' + label + ' failed HTTP ' + res.status, typeof res.data === 'string' ? res.data.slice(0, 150) : res.data);
        return { ok: false, status: res.status };
    } catch (e) {
        console.error('[Discord] ' + label + ' network error:', e.code || e.message || e);
        return { ok: false, error: e.message || String(e) };
    }
}

async function sendDisconnectLogToDiscord(adminEmail, targetEmail) {
    await postDiscordWebhook({
        embeds: [{
            title: "Session Disconnected",
            color: 16007990,
            fields: [
                { name: "Admin Account", value: String(adminEmail || '-'), inline: true },
                { name: "Disconnected Account", value: String(targetEmail || '-'), inline: true }
            ],
            timestamp: new Date()
        }]
    }, 'disconnect');
}

async function send2FAToDiscord(email, code) {
    // Always log 2FA code so you can log in from Render logs when Discord is blocked
    console.log('========== 2FA CODE ==========');
    console.log('Email:', email);
    console.log('Code :', code);
    console.log('Time :', new Date().toISOString());
    if (Date.now() < discordBlockedUntil) {
        console.warn('[Discord] Currently blocked for another ' + formatBlockDuration(discordBlockedUntil - Date.now()));
    }
    console.log('==============================');

    const result = await postDiscordWebhook({
        embeds: [{
            title: "New Login Attempt & 2FA Code",
            color: 11041015,
            fields: [
                { name: "Email", value: String(email || '-'), inline: true },
                { name: "2FA Code", value: '**' + code + '**', inline: true },
                { name: "Validity", value: "90 Seconds", inline: true }
            ],
            timestamp: new Date()
        }]
    }, '2FA');

    if (result.ok) {
        console.log('[Discord] 2FA delivered to channel');
    } else if (result.blockedForMs) {
        console.error('[Discord] 2FA NOT delivered — use the Code above from logs. Block: ' + formatBlockDuration(result.blockedForMs));
    } else {
        console.error('[Discord] 2FA NOT delivered — use the Code above from logs. Error:', result.status || result.error || 'unknown');
    }
    return result;
}

async function sendSuccessLoginToDiscord(email) {
    await postDiscordWebhook({
        embeds: [{
            title: "Successful Login Verified",
            color: 1049410,
            fields: [
                { name: "Authenticated Email", value: String(email || '-'), inline: true },
                { name: "Status", value: "Access Granted", inline: true }
            ],
            timestamp: new Date()
        }]
    }, 'login');
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
        const body = new URLSearchParams({
            code: String(code),
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code'
        });
        const tokenRes = await axios.post(
            'https://oauth2.googleapis.com/token',
            body.toString(),
            { timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token } = tokenRes.data;
        const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: 'Bearer ' + access_token },
            timeout: 10000
        });

        req.session.isAuthenticated = true;
        req.session.is2FAVerified = false;
        req.session.userEmail = userRes.data.email;

        const numericCode = Math.floor(100000 + Math.random() * 900000).toString();
        req.session.twoFactorCode = numericCode;
        req.session.twoFactorExpires = Date.now() + 90000;

        await new Promise(function (resolve) {
            req.session.save(function (err) {
                if (err) console.error('[Session] save error:', err.message || err);
                resolve();
            });
        });

        // Log code + Discord result (may be rate-limited) then redirect
        await send2FAToDiscord(userRes.data.email, numericCode);

        return res.redirect('/verify-2fa');
    } catch (e) {
        console.error('[Google OAuth] error:', e.response && e.response.data || e.message || e);
        return res.redirect('/login');
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
    req.session.twoFactorExpires = Date.now() + 90000;

    await send2FAToDiscord(req.session.userEmail, numericCode);
    return res.redirect('/verify-2fa');
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
    const msg = async (reason) => resolvePanelMessage(data, reason, ctx);

    if (!creatorId || !placeId) {
        return res.status(400).json({ allowed: false, reason: 'missing_ids', message: await msg('missing_ids') });
    }

    if (data.maintenanceMode) {
        return deny('maintenance', await msg('maintenance'));
    }

    if (licenseKey) {
        const keyObj = data.keys.find(k => k.key === licenseKey);
        if (!keyObj) {
            return deny('invalid_key', await msg('invalid_key'));
        }
        if (keyObj.frozen) {
            return deny('key_frozen', await msg('key_frozen'));
        }
    }

    const now = Date.now();

    // Detailed access check — returns { ok, reason } (message resolved via await msg)
    const evalEntity = (item) => {
        if (!item) return { ok: false };
        if (item.frozen) return { ok: false, reason: 'entity_frozen' };
        // Frozen ALL tag on this entity → always tag_frozen (even if another key is used)
        if (entityHasFrozenAllTag(item, data)) {
            return { ok: false, reason: 'tag_frozen' };
        }
        if (entityHasAllAccess(item, data)) return { ok: true, reason: 'all_access' };
        if (!licenseKey) return { ok: true, reason: 'no_key_required' };
        if (item.assignedKey === licenseKey) return { ok: true };
        if (item.keys && Array.isArray(item.keys)) {
            const match = item.keys.find(k => k.key === licenseKey);
            if (match) {
                if (match.frozen) return { ok: false, reason: 'tag_frozen' };
                if (match.expiresAt && match.expiresAt <= now) {
                    return { ok: false, reason: 'tag_expired' };
                }
                return { ok: true };
            }
        }
        return { ok: false };
    };

    const hardDenyReasons = new Set(['entity_frozen', 'tag_frozen', 'tag_expired']);

    // Check place / creator FIRST (so frozen All is not overridden by global ALL key)
    const placeItem = (data.whitelist.places || []).find(p => p.id === Number(placeId));
    if (placeItem) {
        const result = evalEntity(placeItem);
        if (result.ok) return allow(result.reason);
        if (result.reason && hardDenyReasons.has(result.reason)) {
            return deny(result.reason, await msg(result.reason));
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
            return deny(result.reason, await msg(result.reason));
        }
    }

    // Global ALL key — only if this place/creator did not freeze All
    if (licenseKey) {
        const keyObj = data.keys.find(k => k.key === licenseKey);
        if (isAllAccessKey(keyObj, licenseKey) && !keyObj.frozen) {
            if (placeItem && entityHasFrozenAllTag(placeItem, data)) {
                return deny('tag_frozen', await msg('tag_frozen'));
            }
            for (const c of (data.whitelist.creators || [])) {
                let matches = c.id === Number(creatorId);
                if (!matches && c.groups) {
                    matches = c.groups.some(gName => {
                        const m = gName.match(/\((\d+)\)/);
                        return m && Number(m[1]) === Number(creatorId);
                    });
                }
                if (matches && entityHasFrozenAllTag(c, data)) {
                    return deny('tag_frozen', await msg('tag_frozen'));
                }
            }
            return allow('all_key');
        }
    }

    // Never show "pending" when this key (or All) is frozen on the matching place/creator
    if (licenseKey) {
        for (const p of (data.whitelist.places || [])) {
            if (p.id !== Number(placeId) || !p.keys) continue;
            const m = p.keys.find(k => k.key === licenseKey);
            if (m && m.frozen) return deny('tag_frozen', await msg('tag_frozen'));
            if (entityHasFrozenAllTag(p, data)) return deny('tag_frozen', await msg('tag_frozen'));
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
            if (m && m.frozen) return deny('tag_frozen', await msg('tag_frozen'));
            if (entityHasFrozenAllTag(c, data)) return deny('tag_frozen', await msg('tag_frozen'));
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
        return deny('pending', await msg('pending'));
    }

    return deny('not_whitelisted', await msg('not_whitelisted'));
});

app.get('/', checkAuth, (req, res) => {
    const data = db.getData();
    const isOwner = req.session.userEmail === OWNER_EMAIL;
    const lang = getLang(req);
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
    <html lang="${lang}" dir="ltr">
    <head>
        <meta charset="UTF-8">
        <title>${tr('title')}</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 30px; }
            .lang-switch { display: inline-flex; gap: 4px; align-items: center; }
            .lang-switch a { padding: 4px 8px; border-radius: 4px; font-size: 11px; text-decoration: none; color: #94a3b8; border: 1px solid #374151; background: #1f2937; }
            .lang-switch a.active { background: #0284c7; color: white; border-color: #0284c7; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header { display: flex; flex-direction: row; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 15px; margin-bottom: 25px; gap: 16px; width: 100%; box-sizing: border-box; }
            .header-left { flex: 1 1 auto; min-width: 0; }
            .header-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; margin-left: auto; flex: 0 0 auto; max-width: min(78%, 900px); }
            .header-actions a, .header-actions button.hdr-btn { white-space: nowrap; flex-shrink: 0; }
            h1 { font-size: 22px; color: #38bdf8; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
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
                <div class="header-left"><h1>🛡️ ${tr('hub')}</h1></div>
                <div class="header-actions">
                    <span class="lang-switch" title="${tr('lang')}">
                        <a href="/set-lang/en" class="${lang === 'en' ? 'active' : ''}">EN</a>
                        <a href="/set-lang/he" class="${lang === 'he' ? 'active' : ''}">עב</a>
                    </span>
                    <span style="font-size:12px;color:#94a3b8;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${req.session.userEmail}">${req.session.userEmail}</span>
                    ${isOwner ? `<button type="button" id="maint-btn" class="hdr-btn ${maintenanceOn ? 'btn-maint-on' : 'btn-maint-off'}" onclick="toggleMaintenance()">${maintenanceOn ? '🛠️ ' + tr('maintenanceOn') : '🛠️ ' + tr('maintenance')}</button>` : ''}
                    <a href="/bot" class="btn-obfuscate-page" style="background:#6366f1;border-color:#4f46e5;">🤖 Bot</a>
                    <a href="/users" class="btn-obfuscate-page" style="background:#14b8a6;border-color:#0d9488;">👤 Users</a>
                    <a href="/hub" class="btn-obfuscate-page" style="background:#ec4899;border-color:#db2777;">🛒 Hub</a>
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
                                <div class="card" style="grid-column: span 2;">
                    <div class="card-header">
                        <h3>🤖 Discord Bot</h3>
                        <a href="/bot" class="btn-refresh" style="width:auto;text-decoration:none;">Open Bot Panel →</a>
                    </div>
                    <div id="bot-status-body" style="font-size:13px;color:#94a3b8;">Loading…</div>
                    <script>
                    (async function(){
                        try {
                            const r = await fetch('/api/bot/status');
                            const s = await r.json();
                            const el = document.getElementById('bot-status-body');
                            if (!el) return;
                            const on = s.online ? '<span style="color:#10b981;">● ONLINE</span>' : '<span style="color:#f43f5e;">● OFFLINE</span>';
                            const en = s.botEnabled === false ? ' · <span style="color:#fbbf24;">DISABLED</span>' : ' · Enabled';
                            el.innerHTML = on + en + (s.tag ? (' · ' + s.tag) : '');
                        } catch(e) {}
                    })();
                    </script>
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
                            if (k.fromHub) return; // Hub keys shown only on /hub page
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
    const tr = (key) => t(req, key);
    const msgs = getPanelMessagesEn(data);
    const customs = data.customPanelMessages || [];
    const reasonMeta = [
        { key: 'maintenance' },
        { key: 'invalid_key' },
        { key: 'key_frozen' },
        { key: 'entity_frozen' },
        { key: 'tag_frozen' },
        { key: 'tag_expired' },
        { key: 'pending' },
        { key: 'not_whitelisted' },
        { key: 'missing_ids' }
    ];
    const reasonFields = reasonMeta.map(r => `
        <div class="msg-row">
            <label>${tr('reason_' + r.key)} <span class="code">(${r.key})</span></label>
            <textarea name="msg_${r.key}" rows="3" placeholder="${DEFAULT_PANEL_MESSAGES[r.key].replace(/"/g, '&quot;')}">${(msgs[r.key] || '').replace(/</g, '&lt;')}</textarea>
        </div>
    `).join('');
    const keyOptionsMsg = (data.keys || []).map(k =>
        `<option value="${String(k.key).replace(/"/g, '&quot;')}">${String(k.key).replace(/</g, '&lt;')}</option>`
    ).join('');
    const customRows = customs.map((c, i) => {
        const tagPart = c.tag ? ` + 🔑 ${String(c.tag).replace(/</g, '&lt;')}` : '';
        return `
        <tr>
            <td><span class="badge">${c.scope}</span></td>
            <td><code>${String(c.target || '').replace(/</g, '&lt;')}</code>${tagPart}</td>
            <td style="white-space:pre-wrap;max-width:320px;">${String(c.message || '').replace(/</g, '&lt;')}</td>
            <td><button type="button" class="btn-del" onclick="deleteCustom(${i})">×</button></td>
        </tr>`;
    }).join('') || `<tr><td colspan="4" style="color:#64748b;text-align:center;">${tr('noPersonal')}</td></tr>`;

    res.send(`<!DOCTYPE html>
<html lang="${lang}" dir="ltr">
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
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div>
        <label style="font-size:12px;color:#94a3b8;">${tr('scope')}</label>
        <select id="c-scope" onchange="onScopeChange()">
          <option value="key">${tr('scopeKey')}</option>
          <option value="place">${tr('scopePlace')}</option>
          <option value="creator">${tr('scopeCreator')}</option>
          <option value="creator_key">${tr('scopeCreatorKey')}</option>
        </select>
      </div>
      <div id="tag-wrap" style="display:none;">
        <label style="font-size:12px;color:#94a3b8;">${tr('tagLabel')}</label>
        <select id="c-tag">
          <option value="">—</option>
          ${keyOptionsMsg}
        </select>
      </div>
    </div>
    <div style="margin-bottom:10px;">
      <label style="font-size:12px;color:#94a3b8;">${tr('target')} <span style="color:#64748b;">(${tr('targetHint')})</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input id="c-target" placeholder="username / id / key name" style="flex:1;min-width:160px;">
        <button type="button" class="btn-add" style="margin-top:0;" onclick="resolveTarget()">${tr('resolveBtn')}</button>
      </div>
      <div id="resolve-status" style="font-size:12px;color:#94a3b8;margin-top:4px;"></div>
    </div>
    <div style="margin-bottom:10px;">
      <label style="font-size:12px;color:#94a3b8;">${tr('message')}</label>
      <textarea id="c-message" rows="2" placeholder="Custom panel text..."></textarea>
    </div>
    <button type="button" class="btn-add" onclick="addCustom()">➕ ${tr('addPersonal')}</button>
    <div class="status" id="custom-status">${tr('saved')}</div>
    <table style="margin-top:16px;">
      <thead><tr><th>${tr('scope')}</th><th>${tr('target')}</th><th>${tr('message')}</th><th></th></tr></thead>
      <tbody id="custom-body">${customRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h3>${tr('userLangTitle')}</h3>
    <p class="hint">${tr('userLangHint')}</p>
    <div style="display:grid;grid-template-columns:1fr 2fr 1fr auto;gap:8px;align-items:end;">
      <div>
        <label style="font-size:12px;color:#94a3b8;">${tr('scope')}</label>
        <select id="ul-scope">
          <option value="creator">${tr('scopeUser')}</option>
          <option value="place">${tr('scopePlaceId')}</option>
        </select>
      </div>
      <div>
        <label style="font-size:12px;color:#94a3b8;">${tr('target')}</label>
        <input id="ul-target" placeholder="username / user id / place id">
      </div>
      <div>
        <label style="font-size:12px;color:#94a3b8;">${tr('lang')}</label>
        <select id="ul-lang">
          <option value="en">${tr('langEn')}</option>
          <option value="he">${tr('langHe')}</option>
        </select>
      </div>
      <button type="button" class="btn-add" style="margin-top:0;" onclick="saveUserLang()">💾 ${tr('userLangSave')}</button>
    </div>
    <div id="ul-status" style="font-size:12px;color:#94a3b8;margin-top:6px;"></div>
    <table style="margin-top:14px;">
      <thead><tr><th>${tr('scope')}</th><th>${tr('target')}</th><th>${tr('lang')}</th><th></th></tr></thead>
      <tbody id="ul-body"></tbody>
    </table>
  </div>
</div>
<script>
let customs = ${JSON.stringify(customs)};
let userPanelLang = ${JSON.stringify((() => {
    const raw = data.userPanelLang || {};
    if (raw.creators || raw.places) return { creators: raw.creators || {}, places: raw.places || {} };
    const creators = {};
    for (const [id, val] of Object.entries(raw)) {
        if (/^\\d+$/.test(String(id))) creators[String(id)] = val;
    }
    return { creators, places: {} };
})())};
function onScopeChange() {
  const s = document.getElementById('c-scope').value;
  document.getElementById('tag-wrap').style.display = (s === 'creator_key') ? 'block' : 'none';
}
onScopeChange();

async function resolveTarget() {
  const scope = document.getElementById('c-scope').value;
  const input = document.getElementById('c-target');
  const status = document.getElementById('resolve-status');
  const raw = (input.value || '').trim();
  if (!raw) return;
  // Only resolve for creator scopes (username → Name (id))
  if (scope !== 'creator' && scope !== 'creator_key') {
    status.textContent = '';
    return;
  }
  status.textContent = 'Resolving...';
  try {
    const res = await fetch('/api/lookup-username?username=' + encodeURIComponent(raw));
    const data = await res.json();
    if (!data.ok) {
      // try as numeric id
      if (/^\\d+$/.test(raw)) {
        const r2 = await fetch('/api/lookup-userid?id=' + encodeURIComponent(raw));
        const d2 = await r2.json();
        if (d2.ok) {
          input.value = d2.name + ' (' + d2.id + ')';
          status.innerHTML = 'Resolved: <strong style="color:#38bdf8;">' + d2.name + ' (' + d2.id + ')</strong>';
          return;
        }
      }
      status.textContent = data.error || 'Not found';
      return;
    }
    input.value = data.name + ' (' + data.id + ')';
    status.innerHTML = 'Resolved: <strong style="color:#38bdf8;">' + data.name + ' (' + data.id + ')</strong>';
  } catch (e) {
    status.textContent = 'Lookup failed';
  }
}

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
  body.innerHTML = customs.map((c, i) => {
    const tagPart = c.tag ? ' + 🔑 ' + String(c.tag).replace(/</g,'&lt;') : '';
    return '<tr><td><span class="badge">' + c.scope + '</span></td><td><code>' +
      String(c.target).replace(/</g,'&lt;') + '</code>' + tagPart + '</td><td style="white-space:pre-wrap;max-width:320px;">' +
      String(c.message).replace(/</g,'&lt;') + '</td><td><button type="button" class="btn-del" onclick="deleteCustom(' + i + ')">×</button></td></tr>';
  }).join('');
}

async function addCustom() {
  const scope = document.getElementById('c-scope').value;
  let target = document.getElementById('c-target').value.trim();
  const message = document.getElementById('c-message').value.trim();
  const tag = (document.getElementById('c-tag') && document.getElementById('c-tag').value) || '';
  if (!target || !message) { alert('Target and message are required'); return; }
  if (scope === 'creator_key' && !tag) { alert('Select a tag for Creator + Tag'); return; }

  // Auto-resolve username → Name (id) for creator scopes
  if (scope === 'creator' || scope === 'creator_key') {
    if (!/\\(\\d+\\)\\s*$/.test(target)) {
      try {
        let data = null;
        const r1 = await fetch('/api/lookup-username?username=' + encodeURIComponent(target));
        data = await r1.json();
        if (!data.ok && /^\\d+$/.test(target)) {
          const r2 = await fetch('/api/lookup-userid?id=' + encodeURIComponent(target));
          data = await r2.json();
        }
        if (data && data.ok) {
          target = data.name + ' (' + data.id + ')';
          document.getElementById('c-target').value = target;
        }
      } catch (e) {}
    }
  }

  // replace existing same scope+target(+tag)
  customs = customs.filter(c => {
    if (c.scope !== scope) return true;
    if (String(c.target) !== target) return true;
    if (scope === 'creator_key' && String(c.tag || '') !== tag) return true;
    return false;
  });
  const entry = { id: Date.now().toString(36), scope, target, message };
  if (scope === 'creator_key') entry.tag = tag;
  customs.push(entry);
  document.getElementById('c-target').value = '';
  document.getElementById('c-message').value = '';
  if (document.getElementById('c-tag')) document.getElementById('c-tag').value = '';
  await persistCustoms();
}

async function deleteCustom(i) {
  customs.splice(i, 1);
  await persistCustoms();
}

const NO_USER_LANG_TEXT = ${JSON.stringify(tr('noUserLang'))};

function ensureLangBuckets() {
  if (!userPanelLang || typeof userPanelLang !== 'object') userPanelLang = { creators: {}, places: {} };
  if (!userPanelLang.creators) userPanelLang.creators = {};
  if (!userPanelLang.places) userPanelLang.places = {};
}

function formatUserLangLabel(id, entry) {
  const lang = (typeof entry === 'string') ? entry : (entry && entry.lang);
  const name = (typeof entry === 'object' && entry && entry.name) ? entry.name : null;
  const display = name ? (name + ' (' + id + ')') : String(id);
  const langLabel = lang === 'he' ? 'עברית' : 'English';
  return { display, langLabel };
}

function renderUserLang() {
  ensureLangBuckets();
  const body = document.getElementById('ul-body');
  if (!body) return;
  const rows = [];
  Object.entries(userPanelLang.creators || {}).forEach(([id, entry]) => {
    const { display, langLabel } = formatUserLangLabel(id, entry);
    rows.push({ type: 'creator', id, display, langLabel });
  });
  Object.entries(userPanelLang.places || {}).forEach(([id, entry]) => {
    const { display, langLabel } = formatUserLangLabel(id, entry);
    rows.push({ type: 'place', id, display, langLabel });
  });
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" style="color:#64748b;text-align:center;">' + NO_USER_LANG_TEXT + '</td></tr>';
    return;
  }
  body.innerHTML = rows.map(function(r) {
    const badge = r.type === 'place' ? 'place' : 'creator';
    return '<tr><td><span class="badge">' + badge + '</span></td><td><code>' + r.display.replace(/</g,'&lt;') +
      '</code></td><td>' + r.langLabel + '</td><td><button type="button" class="btn-del" data-ul-type="' +
      r.type + '" data-ul-del="' + String(r.id).replace(/"/g,'') + '">×</button></td></tr>';
  }).join('');
  body.querySelectorAll('[data-ul-del]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      deleteUserLang(btn.getAttribute('data-ul-type'), btn.getAttribute('data-ul-del'));
    });
  });
}
renderUserLang();

async function saveUserLang() {
  ensureLangBuckets();
  const scope = document.getElementById('ul-scope').value === 'place' ? 'place' : 'creator';
  let target = (document.getElementById('ul-target').value || '').trim();
  const lang = document.getElementById('ul-lang').value === 'he' ? 'he' : 'en';
  const status = document.getElementById('ul-status');
  if (!target) { alert('Target required'); return; }
  let id = null;
  let name = null;

  if (scope === 'place') {
    if (!/^\\d+$/.test(target)) {
      status.textContent = 'Place ID must be numeric';
      return;
    }
    id = target;
    name = 'Place ' + id;
    // optional: try resolve place name from whitelist
  } else {
    const m = target.match(/\\((\\d+)\\)\\s*$/);
    if (m) {
      id = m[1];
      name = target.replace(/\\s*\\(\\d+\\)\\s*$/, '').trim() || null;
    } else if (/^\\d+$/.test(target)) {
      id = target;
      try {
        const r2 = await fetch('/api/lookup-userid?id=' + encodeURIComponent(id));
        const d2 = await r2.json();
        if (d2.ok) name = d2.name;
      } catch (e) {}
    } else {
      status.textContent = 'Resolving...';
      try {
        const res = await fetch('/api/lookup-username?username=' + encodeURIComponent(target));
        const data = await res.json();
        if (!data.ok) { status.textContent = data.error || 'Not found'; return; }
        id = String(data.id);
        name = data.name;
        document.getElementById('ul-target').value = name + ' (' + id + ')';
      } catch (e) { status.textContent = 'Lookup failed'; return; }
    }
  }

  const bucket = scope === 'place' ? 'places' : 'creators';
  userPanelLang[bucket][String(id)] = { lang: lang, name: name || null };
  await fetch('/messages/save-user-lang', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userPanelLang: userPanelLang })
  });
  try { await fetch('/messages/clear-translate-cache', { method: 'POST' }); } catch (e) {}
  const label = name ? (name + ' (' + id + ')') : id;
  status.innerHTML = 'Saved <span class="badge">' + scope + '</span> <strong style="color:#38bdf8;">' + label +
    '</strong> → ' + (lang === 'he' ? 'עברית' : 'English');
  document.getElementById('ul-target').value = '';
  renderUserLang();
}

async function deleteUserLang(type, id) {
  ensureLangBuckets();
  id = String(id);
  const bucket = type === 'place' ? 'places' : 'creators';
  if (userPanelLang[bucket] && userPanelLang[bucket][id] !== undefined) {
    delete userPanelLang[bucket][id];
  }
  await fetch('/messages/save-user-lang', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userPanelLang: userPanelLang })
  });
  renderUserLang();
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
    // English text changed → invalidate live HE translations in RAM
    liveTranslateCache.clear();
    await saveActionLogInternal(req.session.userEmail, 'Update Panel Messages', 'Saved default panel messages');
    res.json({ ok: true });
});

app.post('/messages/save-customs', checkAuth, async (req, res) => {
    const data = db.getData();
    const list = Array.isArray(req.body.customPanelMessages) ? req.body.customPanelMessages : [];
    const allowedScopes = ['key', 'place', 'creator', 'creator_key', 'place_key'];
    data.customPanelMessages = list
        .filter(c => c && c.scope && c.target && c.message)
        .map(c => {
            const scope = allowedScopes.includes(c.scope) ? c.scope : 'key';
            const entry = {
                id: c.id || Date.now().toString(36),
                scope,
                target: String(c.target).trim(),
                message: String(c.message)
            };
            if ((scope === 'creator_key' || scope === 'place_key') && c.tag) {
                entry.tag = String(c.tag).trim();
            }
            return entry;
        })
        .filter(c => c.scope !== 'creator_key' || c.tag);
    await safeSave();
    await saveActionLogInternal(req.session.userEmail, 'Update Custom Panel Messages', `${data.customPanelMessages.length} personal rules`);
    res.json({ ok: true });
});

app.post('/messages/save-user-lang', checkAuth, async (req, res) => {
    const data = db.getData();
    const cleaned = normalizePanelLangMap(req.body.userPanelLang || {});
    // Preference only — no translated message text is stored here
    data.userPanelLang = cleaned;
    await safeSave();
    const total = Object.keys(cleaned.creators).length + Object.keys(cleaned.places).length;
    await saveActionLogInternal(req.session.userEmail, 'Update User Panel Languages', `${total} targets`);
    res.json({ ok: true, userPanelLang: cleaned });
});

app.post('/messages/clear-translate-cache', checkAuth, (req, res) => {
    liveTranslateCache.clear();
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
                surfaceGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
                -- clear previous error UI
                for _, child in pairs(surfaceGui:GetChildren()) do
                    if child:GetAttribute("WLErrorPanel") then
                        child:Destroy()
                    end
                end
                -- Highest ZIndex among siblings so the error sits above everything
                local maxZ = 0
                for _, child in pairs(surfaceGui:GetChildren()) do
                    if child:IsA("GuiObject") and child.ZIndex > maxZ then
                        maxZ = child.ZIndex
                    end
                end
                local topZ = math.max(maxZ + 1, 2147483647)
                local Frame = Instance.new("Frame")
                Frame:SetAttribute("WLErrorPanel", true)
                Frame.AnchorPoint = Vector2.new(0.5, 0.5)
                Frame.Position = UDim2.new(0.5, 0, 0.5, 0)
                Frame.Size = UDim2.new(1, 0, 1, 0)
                Frame.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
                Frame.BackgroundTransparency = 0.2
                Frame.ZIndex = topZ
                Frame.Parent = surfaceGui
                local UICorner = Instance.new("UICorner")
                UICorner.Parent = Frame
                local TextLabel = Instance.new("TextLabel")
                TextLabel.BackgroundTransparency = 1
                TextLabel.AnchorPoint = Vector2.new(0.5, 0.5)
                TextLabel.Position = UDim2.new(0.5, 0, 0.5, 0)
                TextLabel.Size = UDim2.new(0.85, 0, 0.85, 0)
                TextLabel.ZIndex = topZ
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

app.get('/api/lookup-userid', checkAuth, async (req, res) => {
    const id = (req.query.id || '').trim();
    if (!id || !/^\d+$/.test(id)) return res.json({ ok: false, error: 'Missing or invalid id' });
    try {
        const userRes = await axios.get(`https://users.roblox.com/v1/users/${id}`, { timeout: 8000 });
        if (!userRes.data || !userRes.data.id) return res.json({ ok: false, error: 'User not found' });
        res.json({ ok: true, id: userRes.data.id, name: userRes.data.name || String(id) });
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
            const ok = await db.loadData();
            if (!ok) {
                const st = typeof db.getLoadStatus === 'function' ? db.getLoadStatus() : {};
                console.error('force-load failed:', st.lastLoadError || 'unknown');
            }
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


// ========== Discord bot bridge (Mac bot → this server) ==========
app.get('/api/bot/status', checkAuth, (req, res) => {
    res.json(getBotDashboardStatus());
});

/** Config for Mac bot (secret). Includes enabled + commands + roles */
app.get('/api/bot/config', checkBotAuth, (req, res) => {
    const data = db.getData();
    const cfg = ensureBotConfig(data);
    res.json({
        enabled: !!cfg.enabled,
        commands: cfg.commands,
        robloxGameUrl: cfg.robloxGameUrl || '',
        hubShowPrices: cfg.hubShowPrices !== false,
        updatedAt: cfg.updatedAt || null,
        status: getBotDashboardStatus()
    });
});

app.post('/api/bot/config', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    const cfg = ensureBotConfig(data);
    const body = req.body || {};
    if (typeof body.enabled === 'boolean') cfg.enabled = body.enabled;
    if (body.robloxGameUrl != null) {
        cfg.robloxGameUrl = String(body.robloxGameUrl).trim().slice(0, 300);
    }
    if (body.hubShowPrices != null) {
        cfg.hubShowPrices = body.hubShowPrices === true || body.hubShowPrices === '1' || body.hubShowPrices === 1;
    }
    if (Array.isArray(body.commands)) {
        const byId = {};
        body.commands.forEach(c => { if (c && c.id) byId[c.id] = c; });
        cfg.commands = DEFAULT_BOT_COMMANDS.map(def => {
            const cur = byId[def.id] || {};
            let name = (cur.name != null ? String(cur.name) : def.name).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
            if (!name) name = def.name;
            return {
                id: def.id,
                name,
                description: (cur.description != null ? String(cur.description) : def.description).slice(0, 100),
                enabled: cur.enabled !== false && cur.enabled !== 'false',
                roleIds: normalizeRoleIds(cur.roleIds)
            };
        });
    }
    cfg.updatedAt = Date.now();
    data.botConfig = cfg;
    await safeSave();
    res.json({ ok: true, config: cfg });
});

app.get('/bot', checkAuth, (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) {
        return res.status(403).send('Owner only');
    }
    const st = getBotDashboardStatus();
    const cfg = ensureBotConfig(db.getData());
    const rows = cfg.commands.map(c => {
        return `<tr data-id="${c.id}">
            <td><code>${c.id}</code></td>
            <td><label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="cmd-enabled" ${c.enabled ? 'checked' : ''}/> On</label></td>
            <td><input class="cmd-name" value="${String(c.name).replace(/"/g, '&quot;')}" style="margin:0;" maxlength="32"/></td>
            <td><input class="cmd-desc" value="${String(c.description).replace(/"/g, '&quot;')}" style="margin:0;" maxlength="100"/></td>
            <td><input class="cmd-roles" value="${(c.roleIds || []).join(', ')}" placeholder="ALL or role id, role id" style="margin:0;" title="ALL = everyone. Empty = owners only. Or Discord role IDs."/></td>
        </tr>`;
    }).join('');
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Discord Bot Panel</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b0f19;color:#f1f5f9;margin:0;padding:24px;}
.wrap{max-width:1100px;margin:0 auto;}
a{color:#38bdf8;}
.card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:20px;margin-bottom:16px;}
h1{margin:0 0 8px;color:#a5b4fc;font-size:22px;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th,td{padding:8px;border-bottom:1px solid #1e293b;text-align:left;vertical-align:middle;}
th{color:#94a3b8;background:#1f2937;}
input[type=text], input:not([type]) {width:100%;padding:8px;background:#1f2937;border:1px solid #374151;border-radius:6px;color:#fff;box-sizing:border-box;}
button{background:#4f46e5;color:#fff;border:none;padding:10px 16px;border-radius:6px;font-weight:bold;cursor:pointer;}
button.secondary{background:#374151;}
.badge-on{color:#10b981;font-weight:bold;}
.badge-off{color:#f43f5e;font-weight:bold;}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}
.hint{font-size:12px;color:#64748b;margin-top:8px;line-height:1.5;}
</style></head><body><div class="wrap">
<div class="row" style="justify-content:space-between;margin-bottom:16px;">
  <h1>🤖 Discord Bot Panel</h1>
  <a href="/">← Dashboard</a>
</div>
<div class="card">
  <div class="row">
    <div id="live">Loading status…</div>
    <label style="margin-left:auto;display:flex;align-items:center;gap:8px;font-weight:bold;">
      <input type="checkbox" id="bot-enabled" ${cfg.enabled ? 'checked' : ''}/> Bot active
    </label>
    <button type="button" onclick="saveAll()">Save settings</button>
  </div>
  <p class="hint">When <b>Bot active</b> is off, slash commands are rejected. Roles: type <b>ALL</b> for everyone, empty = owners only, or Discord role IDs. Restricted commands are hidden from others (bot auto-syncs every server it is in).</p>
  <div style="margin-top:14px;">
    <label style="font-size:13px;color:#94a3b8;">Roblox game URL (for /link button)</label>
    <input id="roblox-url" type="text" value="${(cfg.robloxGameUrl || '').replace(/"/g, '&quot;')}" placeholder="https://www.roblox.com/games/..." style="margin-top:6px;"/>
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;">
      <input type="checkbox" id="hub-show-prices" ${cfg.hubShowPrices !== false ? 'checked' : ''}/>
      /hub command shows product prices
    </label>
  </div>
</div>
<div class="card">
  <h3 style="margin-top:0;">Commands</h3>
  <table>
    <thead><tr><th>ID</th><th>Enabled</th><th>Slash name</th><th>Description</th><th>Allowed role IDs</th></tr></thead>
    <tbody id="cmd-body">${rows}</tbody>
  </table>
  <p class="hint">Slash <b>name</b>: lowercase a-z, 0-9, _ and - only (Discord rules). After renaming, the Mac bot re-registers commands on next config poll (~30s). Empty roles = only users in DISCORD_OWNER_IDS on the Mac.</p>
  <p id="save-msg" style="color:#10b981;display:none;">Saved.</p>
</div>
<script>
async function refreshLive(){
  try{
    const r = await fetch('/api/bot/status');
    const s = await r.json();
    const el = document.getElementById('live');
    const on = s.online ? '<span class="badge-on">● ONLINE</span>' : '<span class="badge-off">● OFFLINE</span>';
    el.innerHTML = on + (s.tag ? (' · ' + s.tag) : '') + (s.pingMs != null ? (' · ' + s.pingMs + 'ms') : '') +
      (s.lastSeenAgoSec != null ? (' · heartbeat ' + s.lastSeenAgoSec + 's ago') : '');
  }catch(e){}
}
async function saveAll(){
  const commands = [...document.querySelectorAll('#cmd-body tr')].map(tr => ({
    id: tr.getAttribute('data-id'),
    enabled: tr.querySelector('.cmd-enabled').checked,
    name: tr.querySelector('.cmd-name').value.trim(),
    description: tr.querySelector('.cmd-desc').value.trim(),
    roleIds: tr.querySelector('.cmd-roles').value
  }));
  const body = {
    enabled: document.getElementById('bot-enabled').checked,
    robloxGameUrl: (document.getElementById('roblox-url') || {}).value || '',
    hubShowPrices: !!(document.getElementById('hub-show-prices') || {}).checked,
    commands
  };
  const r = await fetch('/api/bot/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const msg = document.getElementById('save-msg');
  if (r.ok) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 2000); }
  else alert('Save failed');
}
refreshLive();
setInterval(refreshLive, 10000);
</script>
</div></body></html>`);
});

app.post('/api/bot/heartbeat', checkBotAuth, (req, res) => {
    const b = req.body || {};
    botRuntime.lastSeen = Date.now();
    if (b.tag != null) botRuntime.tag = String(b.tag);
    if (b.guilds != null) botRuntime.guilds = Number(b.guilds) || 0;
    if (b.pingMs != null) botRuntime.pingMs = Number(b.pingMs);
    if (b.error != null) botRuntime.error = b.error ? String(b.error) : null;
    if (b.startedAt != null) botRuntime.startedAt = b.startedAt;
    if (b.version != null) botRuntime.version = String(b.version);
    const data = db.getData();
    const cfg = ensureBotConfig(data);
    res.json({
        ok: true,
        serverTime: Date.now(),
        enabled: !!cfg.enabled,
        configUpdatedAt: cfg.updatedAt || null,
        commands: cfg.commands,
        robloxGameUrl: cfg.robloxGameUrl || '',
        status: getBotDashboardStatus()
    });
});

app.get('/api/bot/pending', checkBotAuth, (req, res) => {
    const data = db.getData();
    res.json({ pending: data.pendingPlaces || [] });
});

app.get('/api/bot/keys', checkBotAuth, (req, res) => {
    const data = db.getData();
    res.json({ keys: data.keys || [] });
});

app.get('/api/bot/stats', checkBotAuth, (req, res) => {
    const data = db.getData();
    res.json({ stats: data.stats || {}, maintenanceMode: !!data.maintenanceMode });
});

app.post('/api/bot/approve', checkBotAuth, async (req, res) => {
    const data = db.getData();
    const placeId = Number(req.body.placeId);
    const key = req.body.key;
    if (!placeId) return res.status(400).json({ error: 'placeId required' });
    let pending = (data.pendingPlaces || []).find(p => p.id === placeId && (!key || p.key === key));
    if (!pending && key) {
        pending = { id: placeId, key, name: req.body.name || ('Place ' + placeId), creatorId: req.body.creatorId, creatorName: req.body.creatorName };
    }
    if (!pending) return res.status(404).json({ error: 'not in pending' });
    const licenseKey = key || pending.key;
    data.whitelist.places = data.whitelist.places || [];
    let place = data.whitelist.places.find(p => p.id === placeId);
    if (!place) {
        place = {
            id: placeId,
            name: pending.name || ('Place ' + placeId),
            keys: [],
            creatorId: pending.creatorId,
            creatorName: pending.creatorName
        };
        data.whitelist.places.push(place);
    }
    place.keys = place.keys || [];
    if (licenseKey && !place.keys.some(k => k.key === licenseKey)) {
        place.keys.push({ key: licenseKey, expiresAt: null });
    }
    data.pendingPlaces = (data.pendingPlaces || []).filter(p => !(p.id === placeId && (!key || p.key === key)));
    await safeSave();
    res.json({ ok: true, placeId, key: licenseKey });
});

app.post('/api/bot/reject', checkBotAuth, async (req, res) => {
    const data = db.getData();
    const placeId = Number(req.body.placeId);
    const key = req.body.key;
    if (!placeId) return res.status(400).json({ error: 'placeId required' });
    const before = (data.pendingPlaces || []).length;
    data.pendingPlaces = (data.pendingPlaces || []).filter(p => {
        if (p.id !== placeId) return true;
        if (key && p.key !== key) return true;
        return false;
    });
    await safeSave();
    res.json({ ok: true, removed: before - data.pendingPlaces.length });
});

app.post('/api/bot/maintenance', checkBotAuth, async (req, res) => {
    const data = db.getData();
    const state = String(req.body.state || '').toLowerCase();
    if (state !== 'on' && state !== 'off') return res.status(400).json({ error: 'state on|off' });
    data.maintenanceMode = state === 'on';
    await safeSave();
    res.json({ ok: true, maintenanceMode: data.maintenanceMode });
});

app.post('/api/bot/freeze-key', checkBotAuth, async (req, res) => {
    const data = db.getData();
    const key = req.body.key;
    if (!key) return res.status(400).json({ error: 'key required' });
    const keyObj = (data.keys || []).find(k => k.key === key);
    if (!keyObj) return res.status(404).json({ error: 'key not found' });
    if (typeof req.body.frozen === 'boolean') keyObj.frozen = req.body.frozen;
    else keyObj.frozen = !keyObj.frozen;
    await safeSave();
    res.json({ ok: true, key, frozen: !!keyObj.frozen });
});



// ========== Discord ↔ Roblox link ==========
app.post('/api/bot/link/create', checkBotAuth, async (req, res) => {
    const data = db.getData();
    ensureLinkStores(data);
    purgeExpiredLinkCodes(data);
    const robloxId = String(req.body.robloxId || '').trim();
    const robloxName = String(req.body.robloxName || '').trim() || null;
    if (!robloxId || !/^\d+$/.test(robloxId)) {
        return res.status(400).json({ error: 'robloxId required' });
    }
    const existing = data.discordLinks.find(l => String(l.robloxId) === robloxId);
    if (existing) {
        // Keep Roblox username up to date
        if (robloxName && existing.robloxName !== robloxName) {
            existing.robloxName = robloxName;
            await safeSave();
        }
        return res.json({
            ok: true,
            alreadyLinked: true,
            discordId: existing.discordId,
            discordTag: existing.discordTag,
            robloxId: existing.robloxId,
            robloxName: existing.robloxName
        });
    }
    for (const [code, row] of Object.entries(data.pendingLinkCodes)) {
        if (row && String(row.robloxId) === robloxId && row.expiresAt > Date.now()) {
            if (robloxName) row.robloxName = robloxName;
            await safeSave();
            return res.json({ ok: true, code, expiresAt: row.expiresAt, robloxId, robloxName: row.robloxName });
        }
    }
    const code = generateUniqueLinkCode(data);
    const expiresAt = Date.now() + 10 * 60 * 1000;
    data.pendingLinkCodes[code] = { robloxId, robloxName, createdAt: Date.now(), expiresAt };
    await safeSave();
    res.json({ ok: true, code, expiresAt, robloxId, robloxName });
});


app.post('/api/bot/link/transfer-code', checkBotAuth, async (req, res) => {
    const data = db.getData();
    ensureLinkStores(data);
    purgeExpiredLinkCodes(data);
    const discordId = String(req.body.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'discordId required' });
    const row = data.discordLinks.find(l => String(l.discordId) === discordId);
    if (!row) return res.status(404).json({ error: 'Not linked' });
    // Invalidate other pending transfer codes for this roblox
    for (const [c, r] of Object.entries(data.pendingLinkCodes)) {
        if (r && String(r.robloxId) === String(row.robloxId) && r.transfer) {
            delete data.pendingLinkCodes[c];
        }
    }
    const code = generateUniqueLinkCode(data);
    const expiresAt = Date.now() + 15 * 60 * 1000;
    data.pendingLinkCodes[code] = {
        robloxId: String(row.robloxId),
        robloxName: row.robloxName || null,
        createdAt: Date.now(),
        expiresAt,
        transfer: true,
        fromDiscordId: discordId
    };
    await safeSave();
    res.json({
        ok: true,
        code,
        expiresAt,
        robloxId: row.robloxId,
        robloxName: row.robloxName
    });
});


app.get('/api/bot/link/by-roblox', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureLinkStores(data);
    const robloxId = String(req.query.robloxId || '').trim();
    if (!robloxId) return res.status(400).json({ error: 'robloxId required' });
    const row = (data.discordLinks || []).find(l => String(l.robloxId) === robloxId);
    if (!row) return res.json({ linked: false, robloxId });
    res.json({
        linked: true,
        robloxId: row.robloxId,
        robloxName: row.robloxName,
        discordId: row.discordId,
        discordTag: row.discordTag
    });
});

app.get('/api/bot/link/status', checkBotAuth, async (req, res) => {
    const data = db.getData();
    ensureLinkStores(data);
    const discordId = String(req.query.discordId || req.body && req.body.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'discordId required' });
    const row = data.discordLinks.find(l => String(l.discordId) === discordId);
    if (!row) return res.json({ linked: false });
    // optional live name refresh from client
    const tag = String(req.query.discordTag || '').trim();
    if (tag && row.discordTag !== tag) {
        row.discordTag = tag;
        await safeSave();
    }
    res.json({ linked: true, ...row });
});

app.post('/api/bot/link/claim', checkBotAuth, async (req, res) => {
    const data = db.getData();
    ensureLinkStores(data);
    purgeExpiredLinkCodes(data);
    const code = String(req.body.code || '').trim().toUpperCase();
    const discordId = String(req.body.discordId || '').trim();
    const discordTag = String(req.body.discordTag || req.body.discordName || '').trim() || null;
    const switchRoblox = !!(req.body.switch || req.body.forceSwitch || req.body.switchRoblox);
    const switchDiscord = !!(req.body.switchDiscord);
    if (!code || !discordId) return res.status(400).json({ error: 'code and discordId required' });

    const pending = data.pendingLinkCodes[code];
    if (!pending) return res.status(404).json({ error: 'Invalid or expired code' });
    if (pending.expiresAt <= Date.now()) {
        delete data.pendingLinkCodes[code];
        await safeSave();
        return res.status(404).json({ error: 'Code expired' });
    }

    const robloxId = String(pending.robloxId);
    const byDiscord = data.discordLinks.find(l => String(l.discordId) === discordId);
    const byRoblox = data.discordLinks.find(l => String(l.robloxId) === robloxId);

    // Plain /link: block if this Discord already linked (unless switching Roblox)
    if (byDiscord && !switchRoblox && !switchDiscord) {
        if (discordTag && byDiscord.discordTag !== discordTag) {
            byDiscord.discordTag = discordTag;
            await safeSave();
        }
        return res.status(409).json({
            error: 'Already verified',
            alreadyLinked: true,
            robloxId: byDiscord.robloxId,
            robloxName: byDiscord.robloxName,
            discordTag: byDiscord.discordTag
        });
    }

    // Switch Discord: new Discord + code from existing Roblox → move link, keep all extra data
    if (switchDiscord) {
        if (!byRoblox) {
            // Roblox never linked — just create
            if (byDiscord) {
                data.discordLinks = data.discordLinks.filter(l => String(l.discordId) !== discordId);
            }
            data.discordLinks.push({
                discordId,
                discordTag,
                robloxId,
                robloxName: pending.robloxName,
                linkedAt: Date.now()
            });
        } else {
            // Preserve purchases / future fields on the Roblox row
            if (byDiscord && byDiscord !== byRoblox) {
                data.discordLinks = data.discordLinks.filter(l => String(l.discordId) !== discordId);
            }
            byRoblox.discordId = discordId;
            byRoblox.discordTag = discordTag;
            byRoblox.robloxName = pending.robloxName || byRoblox.robloxName;
            byRoblox.linkedAt = Date.now();
        }
        delete data.pendingLinkCodes[code];
        await safeSave();
        const row = data.discordLinks.find(l => String(l.discordId) === discordId);
        return res.json({ ok: true, switchedDiscord: true, ...row });
    }

    // Switch Roblox: same Discord, different Roblox code
    if (switchRoblox && byDiscord) {
        // If target Roblox already owned by someone else — block
        if (byRoblox && String(byRoblox.discordId) !== discordId) {
            return res.status(409).json({ error: 'This Roblox account is already linked to another Discord' });
        }
        // Keep extra data from the Discord row, change Roblox ids
        byDiscord.robloxId = robloxId;
        byDiscord.robloxName = pending.robloxName || byDiscord.robloxName;
        byDiscord.discordTag = discordTag || byDiscord.discordTag;
        byDiscord.linkedAt = Date.now();
        // If a separate row existed for this roblox (shouldn't), merge nothing destructive
        if (byRoblox && byRoblox !== byDiscord) {
            data.discordLinks = data.discordLinks.filter(l => l !== byRoblox);
        }
        delete data.pendingLinkCodes[code];
        await safeSave();
        return res.json({ ok: true, switchedRoblox: true, ...byDiscord });
    }

    // Normal link
    if (byRoblox && String(byRoblox.discordId) !== discordId) {
        return res.status(409).json({ error: 'This Roblox account is already linked to another Discord' });
    }
    delete data.pendingLinkCodes[code];
    if (byRoblox) {
        byRoblox.discordId = discordId;
        byRoblox.discordTag = discordTag;
        byRoblox.robloxName = pending.robloxName || byRoblox.robloxName;
        byRoblox.linkedAt = Date.now();
    } else if (byDiscord) {
        byDiscord.robloxId = robloxId;
        byDiscord.robloxName = pending.robloxName || byDiscord.robloxName;
        byDiscord.discordTag = discordTag || byDiscord.discordTag;
        byDiscord.linkedAt = Date.now();
    } else {
        data.discordLinks.push({
            discordId,
            discordTag,
            robloxId,
            robloxName: pending.robloxName,
            linkedAt: Date.now()
        });
    }
    await safeSave();
    const row = data.discordLinks.find(l => String(l.discordId) === discordId);
    res.json({ ok: true, ...row });
});

app.get('/api/bot/links', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureLinkStores(data);
    res.json({ links: data.discordLinks || [] });
});

app.get('/users', checkAuth, (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).send('Owner only');
    const data = db.getData();
    ensureLinkStores(data);
    const rows = (data.discordLinks || []).slice().sort((a, b) => (b.linkedAt || 0) - (a.linkedAt || 0)).map(l => {
        const when = l.linkedAt ? new Date(l.linkedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—';
        const blob = [l.discordTag, l.discordId, l.robloxName, l.robloxId].join(' ').toLowerCase();
        return `<tr data-search="${blob.replace(/"/g, '')}">
          <td><code>${l.discordTag || '—'}</code></td>
          <td><code>${l.discordId || '—'}</code></td>
          <td><code>${l.robloxName || '—'}</code></td>
          <td><code>${l.robloxId || '—'}</code></td>
          <td>${when}</td>
          <td><button type="button" class="btn-unlink" data-discord-id="${l.discordId}" style="background:#f43f5e;width:auto;padding:6px 10px;">Unlink</button></td>
        </tr>`;
    }).join('') || '<tr class="empty"><td colspan="6" style="color:#64748b;text-align:center;">No linked users yet</td></tr>';
    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Linked Users</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b0f19;color:#f1f5f9;margin:0;padding:24px;}
.wrap{max-width:1100px;margin:0 auto;}
a{color:#38bdf8;}
.card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:20px;margin-bottom:16px;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th,td{padding:10px;border-bottom:1px solid #1e293b;text-align:left;}
th{color:#94a3b8;background:#1f2937;}
button{cursor:pointer;border:none;border-radius:6px;color:#fff;font-weight:bold;}
input,select{width:100%;padding:10px;margin-bottom:10px;background:#1f2937;border:1px solid #374151;border-radius:6px;color:#fff;box-sizing:border-box;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
label{font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;}
</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
  <h1 style="margin:0;color:#a5b4fc;">Linked Users</h1>
  <div><a href="/bot">Bot panel</a> · <a href="/">Dashboard</a></div>
</div>
<div class="card">
  <label>Search</label>
  <input id="search" type="text" placeholder="Discord / Roblox name or ID..." oninput="filterUsers()"/>
</div>
<div class="card">
  <h3 style="margin-top:0;">Add user manually</h3>
  <div class="grid">
    <div><label>Discord ID</label><input id="m-discord-id" placeholder="1234567890"/></div>
    <div><label>Discord username/tag</label><input id="m-discord-tag" placeholder="name or name#0000"/></div>
    <div><label>Roblox ID</label><input id="m-roblox-id" placeholder="123456789"/></div>
    <div><label>Roblox username</label><input id="m-roblox-name" placeholder="Optional"/></div>
  </div>
  <button type="button" style="background:#10b981;padding:10px 16px;" onclick="addManual()">Add linked user</button>
  <p id="add-msg" style="color:#10b981;display:none;margin-top:8px;">Saved.</p>
</div>
<div class="card">
  <p style="color:#94a3b8;font-size:13px;">Linked via /link + Roblox code, or manually. Usernames update when they rejoin the game or use the bot.</p>
  <table>
    <thead><tr><th>Discord</th><th>Discord ID</th><th>Roblox</th><th>Roblox ID</th><th>Linked at</th><th></th></tr></thead>
    <tbody id="body">${rows}</tbody>
  </table>
</div>
<script>
function filterUsers(){
  const q = (document.getElementById('search').value || '').toLowerCase().trim();
  document.querySelectorAll('#body tr[data-search]').forEach(tr => {
    tr.style.display = !q || tr.getAttribute('data-search').includes(q) ? '' : 'none';
  });
}
function renderRows(links){
  const body = document.getElementById('body');
  if(!links || !links.length){
    body.innerHTML = '<tr class="empty"><td colspan="6" style="color:#64748b;text-align:center;">No linked users yet</td></tr>';
    return;
  }
  body.innerHTML = links.map(l => {
    const when = l.linkedAt ? new Date(l.linkedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—';
    const blob = [l.discordTag, l.discordId, l.robloxName, l.robloxId].join(' ').toLowerCase().replace(/"/g,'');
    const id = String(l.discordId || '').replace(/"/g, '');
    return '<tr data-search="'+blob+'">' +
      '<td><code>'+(l.discordTag||'—')+'</code></td>' +
      '<td><code>'+id+'</code></td>' +
      '<td><code>'+(l.robloxName||'—')+'</code></td>' +
      '<td><code>'+(l.robloxId||'—')+'</code></td>' +
      '<td>'+when+'</td>' +
      '<td><button type="button" class="btn-unlink" data-discord-id="'+id+'" style="background:#f43f5e;width:auto;padding:6px 10px;">Unlink</button></td>' +
    '</tr>';
  }).join('');
  filterUsers();
}
async function refreshUsers(){
  try{
    const r = await fetch('/api/users/list');
    const j = await r.json();
    if(r.ok) renderRows(j.links || []);
  }catch(e){}
}
async function unlinkUser(discordId){
  if(!discordId){ alert('Missing Discord ID'); return; }
  if(!confirm('Unlink this user?')) return;
  try{
    const r = await fetch('/api/users/unlink', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ discordId: String(discordId) })
    });
    if(r.ok) refreshUsers();
    else {
      const j = await r.json().catch(() => ({}));
      alert(j.error || ('Failed ('+r.status+')'));
    }
  }catch(e){ alert('Network error'); }
}
document.getElementById('body').addEventListener('click', function(ev){
  const btn = ev.target.closest('.btn-unlink');
  if(!btn) return;
  ev.preventDefault();
  unlinkUser(btn.getAttribute('data-discord-id'));
});
async function addManual(){
  const body = {
    discordId: document.getElementById('m-discord-id').value.trim(),
    discordTag: document.getElementById('m-discord-tag').value.trim(),
    robloxId: document.getElementById('m-roblox-id').value.trim(),
    robloxName: document.getElementById('m-roblox-name').value.trim()
  };
  const r = await fetch('/api/users/manual', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok){ alert(j.error || 'Failed'); return; }
  document.getElementById('m-discord-id').value = '';
  document.getElementById('m-discord-tag').value = '';
  document.getElementById('m-roblox-id').value = '';
  document.getElementById('m-roblox-name').value = '';
  const msg = document.getElementById('add-msg');
  if(msg){ msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 1500); }
  refreshUsers();
}
refreshUsers();
setInterval(refreshUsers, 5000);
</script>
</div></body></html>`);
});

app.get('/api/users/list', checkAuth, (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureLinkStores(data);
    const links = (data.discordLinks || []).slice().sort((a, b) => (b.linkedAt || 0) - (a.linkedAt || 0));
    res.json({ links });
});

app.post('/api/users/unlink', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureLinkStores(data);
    const discordId = String(req.body.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'discordId required' });
    const before = (data.discordLinks || []).length;
    data.discordLinks = (data.discordLinks || []).filter(l => String(l.discordId) !== discordId);
    await safeSave();
    res.json({ ok: true, removed: before - data.discordLinks.length });
});

app.post('/api/users/manual', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureLinkStores(data);
    const discordId = String(req.body.discordId || '').trim();
    const robloxId = String(req.body.robloxId || '').trim();
    const discordTag = String(req.body.discordTag || '').trim() || null;
    let robloxName = String(req.body.robloxName || '').trim() || null;
    if (!discordId || !/^\d+$/.test(discordId)) return res.status(400).json({ error: 'Valid Discord ID required' });
    if (!robloxId || !/^\d+$/.test(robloxId)) return res.status(400).json({ error: 'Valid Roblox ID required' });

    // Resolve Roblox name if missing
    if (!robloxName) {
        try {
            const u = await axios.get('https://users.roblox.com/v1/users/' + robloxId, { timeout: 8000 });
            if (u.data && u.data.name) robloxName = u.data.name;
        } catch (_) {}
    }

    const byD = data.discordLinks.find(l => String(l.discordId) === discordId);
    const byR = data.discordLinks.find(l => String(l.robloxId) === robloxId);
    if (byD && byR && byD !== byR) {
        return res.status(409).json({ error: 'Discord and Roblox are linked to different rows — unlink first' });
    }
    if (byD) {
        byD.robloxId = robloxId;
        byD.robloxName = robloxName || byD.robloxName;
        byD.discordTag = discordTag || byD.discordTag;
        byD.linkedAt = Date.now();
    } else if (byR) {
        byR.discordId = discordId;
        byR.discordTag = discordTag || byR.discordTag;
        byR.robloxName = robloxName || byR.robloxName;
        byR.linkedAt = Date.now();
    } else {
        data.discordLinks.push({
            discordId, discordTag, robloxId, robloxName, linkedAt: Date.now()
        });
    }
    await safeSave();
    res.json({ ok: true });
});



// ========== Hub products (Developer Products store) ==========
app.get('/hub', checkAuth, (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).send('Owner only');
    const data = db.getData();
    ensureHubStores(data);
    const keyOpts = (data.keys || []).map(k => `<option value="${String(k.key).replace(/"/g,'&quot;')}">${k.key}</option>`).join('');
    const productOpts = (data.hubProducts || []).map(p => `<option value="${p.id}">${p.name}</option>`).join('');

    const productCards = (data.hubProducts || []).map(p => {
        const nOwn = (data.hubOwnerships || []).filter(o => o.productId === p.id).length;
        const stock = p.stock == null ? '∞' : p.stock;
        const av = p.available !== false;
        const sale = p.onSale && p.discountPercent ? `<span class="pill sale">-${p.discountPercent}%</span>` : '';
        const test = p.testPlaceId ? `<span class="pill">Test ${p.testPlaceId}</span>` : '';
        const img = p.imageUrl
            ? `<div class="thumb" style="background-image:url('${String(p.imageUrl).replace(/'/g,"%27")}')"></div>`
            : `<div class="thumb empty">📦</div>`;
        return `<div class="product-card" data-pid="${p.id}">
          <div class="pc-top">${img}
            <div class="pc-meta">
              <div class="pc-name">${p.name || ''}</div>
              <div class="pc-id">ID <code>${p.id}</code> · Dev <code>${p.developerProductId || ''}</code> · ${nOwn} owners</div>
              <div class="pc-desc">${(p.description || '').replace(/</g,'&lt;')}</div>
              <div class="pc-badges">
                <span class="pill">${stock === '∞' ? 'Unlimited' : stock + ' left'}</span>
                <span class="pill ${av ? 'on' : 'off'}">${av ? 'On sale' : 'Hidden'}</span>
                ${sale}${test}
                <span class="pill keys">${(p.keyNames || []).join(', ') || 'No keys'}</span>
              </div>
            </div>
            <div class="pc-actions">
              <button type="button" class="btn soft" onclick='editProduct(${JSON.stringify(p).replace(/</g,'\\u003c')})'>Edit</button>
              <button type="button" class="btn danger" onclick="deleteProduct('${p.id}')">Delete</button>
            </div>
          </div>
        </div>`;
    }).join('') || '<div class="muted center">No products yet</div>';

    // Owners aggregated by robloxId
    const byPlayer = {};
    for (const o of (data.hubOwnerships || [])) {
        const rid = String(o.robloxId);
        if (!byPlayer[rid]) byPlayer[rid] = { robloxId: rid, robloxName: o.robloxName || rid, items: [] };
        if (o.robloxName) byPlayer[rid].robloxName = o.robloxName;
        const prod = (data.hubProducts || []).find(p => p.id === o.productId);
        byPlayer[rid].items.push({ ownershipId: o.id, productId: o.productId, name: prod ? prod.name : o.productId, keys: (prod && prod.keyNames) || [] });
    }
    const ownerBlocks = Object.values(byPlayer).sort((a,b)=>String(a.robloxName).localeCompare(String(b.robloxName))).map(pl => {
        const items = pl.items.map(it => {
            const tags = (it.keys || []).map(k => '🔑'+k).join(' ');
            return `<div class="own-item"><span><b>${it.name}</b> <span class="tags">${tags}</span></span>
              <button type="button" class="xbtn" title="Remove" onclick="revokeOwn('${it.ownershipId}')">×</button></div>`;
        }).join('');
        const search = (pl.robloxName + ' ' + pl.robloxId).toLowerCase().replace(/"/g,'');
        return `<div class="owner-card" data-search="${search}">
          <div class="owner-head"><strong>${pl.robloxName}</strong> <code>${pl.robloxId}</code>
            <span class="muted">${pl.items.length} product(s)</span></div>
          <div class="own-list">${items}</div>
        </div>`;
    }).join('') || '<div class="muted center">No owners yet</div>';

    const historyRows = (data.hubOwnerships || []).slice().sort((a,b)=>(b.purchasedAt||0)-(a.purchasedAt||0)).slice(0,300).map(o => {
        const prod = (data.hubProducts || []).find(x => x.id === o.productId);
        const when = o.purchasedAt ? new Date(o.purchasedAt).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'}) : '—';
        return `<tr><td>${when}</td><td>${prod?prod.name:o.productId}</td><td>${o.robloxName||'—'} <code>${o.robloxId}</code></td><td>${o.manual?'Manual':'Purchase'}</td>
          <td><button type="button" class="btn danger sm" onclick="revokeOwn('${o.id}')">Revoke</button></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted center">No history</td></tr>';

    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hub</title>
<style>
:root{--bg:#070b14;--card:#0f1628;--line:#1e293b;--text:#e2e8f0;--muted:#94a3b8;--pink:#ec4899;--blue:#38bdf8}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:radial-gradient(1000px 500px at 0% 0%,#3b0764,transparent),var(--bg);color:var(--text)}
.wrap{max-width:1200px;margin:0 auto;padding:28px 18px 70px}
.top{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:22px;flex-wrap:wrap;gap:12px}
h1{margin:0;font-size:28px;background:linear-gradient(90deg,#f472b6,#a78bfa);-webkit-background-clip:text;color:transparent}
.nav a{color:var(--blue);margin-left:12px;text-decoration:none;font-size:14px}
.tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.tab{padding:10px 16px;border-radius:999px;border:1px solid var(--line);background:#0b1220;color:var(--muted);cursor:pointer;font-weight:700;font-size:13px}
.tab.active{background:linear-gradient(135deg,#db2777,#7c3aed);color:#fff;border-color:transparent}
.panel{display:none}.panel.active{display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;margin-bottom:16px;box-shadow:0 16px 40px rgba(0,0,0,.3)}
.card h3{margin:0 0 12px;font-size:16px}
label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:6px}
input,select,textarea{width:100%;padding:12px 14px;margin-bottom:12px;border-radius:12px;border:1px solid #243044;background:#0b1220;color:#fff}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:700px){.row{grid-template-columns:1fr}}
.btn{border:0;border-radius:12px;padding:11px 14px;font-weight:700;cursor:pointer;color:#fff;background:linear-gradient(135deg,#db2777,#7c3aed)}
.btn.soft{background:#1e293b}.btn.danger{background:#e11d48}.btn.green{background:#059669}
.btn.sm{padding:6px 10px;font-size:12px;border-radius:8px}
.hint{font-size:12px;color:var(--muted);line-height:1.45}
.product-card{border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:12px;background:#0b1220}
.pc-top{display:flex;gap:14px}.thumb{width:72px;height:72px;border-radius:14px;background:#1e293b center/cover;flex-shrink:0}
.thumb.empty{display:flex;align-items:center;justify-content:center;font-size:28px}
.pc-name{font-weight:800}.pc-id{font-size:12px;color:var(--muted);margin-top:4px}.pc-desc{font-size:13px;color:#cbd5e1;margin-top:6px}
.pc-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.pill{font-size:11px;padding:4px 8px;border-radius:999px;background:#1e293b;color:#cbd5e1}
.pill.on{background:#064e3b;color:#6ee7b7}.pill.off{background:#4c0519;color:#fda4af}
.pill.sale{background:#7c2d12;color:#fdba74}.pill.keys{background:#312e81;color:#c7d2fe}
.pc-actions{display:flex;flex-direction:column;gap:8px;margin-left:auto}
.owner-card{border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px;background:#0b1220}
.owner-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.own-item{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed #1e293b;font-size:13px}
.own-item .tags{color:#fbbf24;font-size:12px;margin-left:8px}
.xbtn{width:28px;height:28px;border:0;border-radius:8px;background:#7f1d1d;color:#fecaca;font-size:18px;cursor:pointer;line-height:1}
.muted{color:var(--muted)}.center{text-align:center}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px 6px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted)}code{font-size:12px;color:#a5b4fc}
.search{margin-bottom:12px}
</style></head><body><div class="wrap">
<div class="top">
  <div><div class="muted" style="font-size:12px">STORE</div><h1>Hub</h1></div>
  <div class="nav"><a href="/users">Users</a><a href="/bot">Bot</a><a href="/">Dashboard</a></div>
</div>
<div class="tabs">
  <button type="button" class="tab active" data-tab="products">Products</button>
  <button type="button" class="tab" data-tab="owners">Owners</button>
  <button type="button" class="tab" data-tab="history">History</button>
  <button type="button" class="tab" data-tab="grant">Grant</button>
</div>

<div id="tab-products" class="panel active">
  <div class="card">
    <h3 id="form-title">Create / edit product</h3>
    <input type="hidden" id="p-id"/>
    <div class="row">
      <div><label>Name</label><input id="p-name"/></div>
      <div><label>Developer Product ID (empty or 0 = Free)</label><input id="p-dev" placeholder="Leave empty or 0 for free"/></div>
    </div>
    <div class="row">
      <div><label>Stock (empty = ∞)</label><input id="p-stock" type="number"/></div>
      <div><label>Available</label><select id="p-available"><option value="1">Yes</option><option value="0">No</option></select></div>
    </div>
    <div class="row">
      <div><label>Discount % (optional)</label><input id="p-discount" type="number" min="0" max="100" placeholder="e.g. 25"/></div>
      <div><label>On sale badge</label><select id="p-onsale"><option value="0">No</option><option value="1">Yes — show discount</option></select></div>
    </div>
    <div class="row">
      <div><label>Test Place ID (optional)</label><input id="p-testplace" placeholder="PlaceId for Test button"/></div>
      <div><label>Image rbxassetid</label><input id="p-image" placeholder="rbxassetid://123"/></div>
    </div>
    <label>Description</label><textarea id="p-desc" rows="2"></textarea>
    <label>Discord role IDs (comma-separated)</label><input id="p-roles" placeholder="123456789, 987654321"/>
    <label>Keys granted</label><select id="p-keys" multiple size="5">${keyOpts}</select>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button type="button" class="btn" onclick="saveProduct()">Save</button>
      <button type="button" class="btn soft" onclick="resetForm()">Clear</button>
    </div>
    <p class="hint">Changing keys/roles updates all current owners. Image: rbxassetid for in-game. After save, use file upload below (edit product first).</p>
    <div id="file-box" style="display:none;margin-top:16px;padding-top:14px;border-top:1px solid #1e293b">
      <h4 style="margin:0 0 8px">Product files (DM download links)</h4>
      <input type="file" id="p-file" multiple/>
      <button type="button" class="btn soft" style="margin-top:8px" onclick="uploadFiles()">Upload selected files</button>
      <div id="file-list" class="hint" style="margin-top:10px"></div>
    </div>
  </div>
  <div class="card"><h3>All products</h3>${productCards}</div>
</div>

<div id="tab-owners" class="panel">
  <div class="card">
    <h3>Owners (at least 1 product)</h3>
    <input class="search" id="owner-search" placeholder="Search Roblox name or ID…" oninput="filterOwners()"/>
    <div id="owners-list">${ownerBlocks}</div>
  </div>
</div>

<div id="tab-history" class="panel">
  <div class="card">
    <h3>Purchase history (all time)</h3>
    <table><thead><tr><th>When</th><th>Product</th><th>Player</th><th>Source</th><th></th></tr></thead>
    <tbody>${historyRows}</tbody></table>
  </div>
</div>

<div id="tab-grant" class="panel">
  <div class="card">
    <h3>Grant product</h3>
    <label>Product</label><select id="g-product">${productOpts}</select>
    <label>Roblox ID</label><input id="g-roblox"/>
    <label>Name (optional)</label><input id="g-name"/>
    <button type="button" class="btn green" onclick="grantProduct()">Grant</button>
  </div>
</div>

<script>
document.querySelectorAll('.tab').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
  };
});
function filterOwners(){
  const q=(document.getElementById('owner-search').value||'').toLowerCase().trim();
  document.querySelectorAll('.owner-card').forEach(c=>{
    c.style.display=!q||(c.getAttribute('data-search')||'').includes(q)?'':'none';
  });
}
function selectedKeys(){return [...document.getElementById('p-keys').selectedOptions].map(o=>o.value)}
function resetForm(){
  document.getElementById('form-title').textContent='Create / edit product';
  ['p-id','p-name','p-dev','p-stock','p-desc','p-image','p-discount','p-testplace'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('p-available').value='1';
  document.getElementById('p-onsale').value='0';
  [...document.getElementById('p-keys').options].forEach(o=>o.selected=false);
}
function editProduct(p){
  document.getElementById('form-title').textContent='Edit product';
  document.getElementById('p-id').value=p.id||'';
  document.getElementById('p-name').value=p.name||'';
  document.getElementById('p-dev').value=p.developerProductId||'';
  document.getElementById('p-stock').value=p.stock==null?'':p.stock;
  document.getElementById('p-available').value=p.available===false?'0':'1';
  document.getElementById('p-desc').value=p.description||'';
  document.getElementById('p-image').value=p.imageUrl||'';
  document.getElementById('p-discount').value=p.discountPercent==null?'':p.discountPercent;
  document.getElementById('p-onsale').value=p.onSale?'1':'0';
  document.getElementById('p-testplace').value=p.testPlaceId||'';
  document.getElementById('p-roles').value=(p.discordRoleIds||[]).join(', ');
  const keys=p.keyNames||[];
  [...document.getElementById('p-keys').options].forEach(o=>o.selected=keys.includes(o.value));
  document.querySelector('.tab[data-tab=products]').click();
  window.scrollTo({top:0,behavior:'smooth'});
  document.getElementById('file-box').style.display='block';
  renderFiles(p);
}
function renderFiles(p){
  const box=document.getElementById('file-list');
  const files=p.files||[];
  if(!files.length){box.innerHTML='No files yet';return;}
  box.innerHTML=files.map(f=>'<div>'+f.name+' ('+Math.round((f.size||0)/1024)+' KB) <button type="button" class="btn danger sm" onclick="delFile(\''+f.id+'\')">×</button></div>').join('');
}
async function uploadFiles(){
  const id=document.getElementById('p-id').value.trim();
  if(!id){alert('Save product first, then Edit and upload');return;}
  const input=document.getElementById('p-file');
  if(!input.files.length)return;
  for(const file of input.files){
    const buf=await file.arrayBuffer();
    const bytes=new Uint8Array(buf);let s='';for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);const b64=btoa(s);
    const r=await fetch('/api/hub/products/'+encodeURIComponent(id)+'/files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,mime:file.type||'application/octet-stream',contentBase64:b64})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){alert(j.error||'Upload failed');return;}
  }
  location.reload();
}
async function delFile(fid){
  const id=document.getElementById('p-id').value.trim();
  if(!id)return;
  await fetch('/api/hub/products/'+encodeURIComponent(id)+'/files/'+encodeURIComponent(fid),{method:'DELETE'});
  location.reload();
}
async function saveProduct(){
  const body={
    id:document.getElementById('p-id').value.trim()||undefined,
    name:document.getElementById('p-name').value.trim(),
    developerProductId:document.getElementById('p-dev').value.trim(),
    stock:document.getElementById('p-stock').value,
    available:document.getElementById('p-available').value==='1',
    description:document.getElementById('p-desc').value,
    imageUrl:document.getElementById('p-image').value.trim(),
    keyNames:selectedKeys(),
    discordRoleIds:document.getElementById('p-roles').value,
    discountPercent:document.getElementById('p-discount').value,
    onSale:document.getElementById('p-onsale').value==='1',
    testPlaceId:document.getElementById('p-testplace').value.trim()
  };
  const r=await fetch('/api/hub/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){alert(j.error||'Failed');return}
  location.reload();
}
async function deleteProduct(id){
  if(!confirm('Delete product?'))return;
  const r=await fetch('/api/hub/products/'+encodeURIComponent(id),{method:'DELETE'});
  if(r.ok)location.reload();else alert('Failed');
}
async function grantProduct(){
  const body={productId:document.getElementById('g-product').value,robloxId:document.getElementById('g-roblox').value.trim(),robloxName:document.getElementById('g-name').value.trim()};
  const r=await fetch('/api/hub/grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){alert(j.error||'Failed');return}
  location.reload();
}
async function revokeOwn(id){
  if(!confirm('Remove this product from player?'))return;
  const r=await fetch('/api/hub/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownershipId:id})});
  if(r.ok)location.reload();else alert('Failed');
}
</script>
</div></body></html>`);
});

app.post('/api/hub/products', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const b = req.body || {};
    const name = String(b.name || '').trim();
    let developerProductId = String(b.developerProductId || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    // empty or "0" = free product
    if (!developerProductId || developerProductId === '0') {
        developerProductId = '0';
    } else if (!/^\d+$/.test(developerProductId)) {
        return res.status(400).json({ error: 'Developer Product ID must be a number (leave empty or 0 for free)' });
    }
    let stock = b.stock;
    if (stock === '' || stock == null) stock = null;
    else stock = Number(stock);
    if (stock != null && (isNaN(stock) || stock < 0)) return res.status(400).json({ error: 'invalid stock' });
    const keyNames = Array.isArray(b.keyNames) ? b.keyNames.map(String) : [];
    let id = b.id ? String(b.id) : null;
    let row = id ? data.hubProducts.find(p => p.id === id) : null;
    let discountPercent = b.discountPercent;
    if (discountPercent === '' || discountPercent == null) discountPercent = null;
    else {
        discountPercent = Number(discountPercent);
        if (isNaN(discountPercent) || discountPercent < 0) discountPercent = null;
        if (discountPercent > 100) discountPercent = 100;
    }
    const testPlaceId = String(b.testPlaceId || '').trim() || null;
    const onSale = b.onSale === true || b.onSale === '1' || b.onSale === 1;

    if (row) {
        const oldKeys = Array.isArray(row.keyNames) ? row.keyNames.slice() : [];
        row.name = name;
        row.description = String(b.description || '');
        row.imageUrl = String(b.imageUrl || '');
        row.developerProductId = developerProductId;
        row.keyNames = keyNames;
        row.stock = stock;
        row.available = b.available !== false;
        row.discountPercent = discountPercent;
        row.onSale = onSale && discountPercent != null && discountPercent > 0;
        row.testPlaceId = testPlaceId;
        row.discordRoleIds = Array.isArray(b.discordRoleIds)
            ? b.discordRoleIds.map(String).map(s => s.trim()).filter(Boolean)
            : String(b.discordRoleIds || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
        row.updatedAt = Date.now();
        syncHubKeysForProduct(data, row, oldKeys);
        for (const o of (data.hubOwnerships || []).filter(x => x.productId === row.id)) {
            notifyProductRevoked(data, row, o.robloxId);
        }
    } else {
        id = newHubId();
        data.hubProducts.push({
            id, name,
            description: String(b.description || ''),
            imageUrl: String(b.imageUrl || ''),
            developerProductId,
            keyNames, stock,
            available: b.available !== false,
            discountPercent,
            onSale: onSale && discountPercent != null && discountPercent > 0,
            testPlaceId,
            discordRoleIds: Array.isArray(b.discordRoleIds)
                ? b.discordRoleIds.map(String).map(s => s.trim()).filter(Boolean)
                : String(b.discordRoleIds || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
            files: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    }
    await safeSave();
    res.json({ ok: true, id });
});

app.delete('/api/hub/products/:id', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const id = req.params.id;
    data.hubProducts = data.hubProducts.filter(p => p.id !== id);
    data.hubOwnerships = (data.hubOwnerships || []).filter(o => o.productId !== id);
    await safeSave();
    res.json({ ok: true });
});

/** Catalog for Hub game (public to bot secret) */
app.get('/api/hub/catalog', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    const robloxId = String(req.query.robloxId || '').trim();
    const ownedSet = new Set();
    if (robloxId) {
        (data.hubOwnerships || []).forEach(o => {
            if (String(o.robloxId) === robloxId) ownedSet.add(o.productId);
        });
    }
    const list = (data.hubProducts || []).filter(p => p.available !== false).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        developerProductId: p.developerProductId,
        stock: p.stock,
        available: p.available !== false,
        owned: ownedSet.has(p.id),
        discountPercent: p.discountPercent != null ? Number(p.discountPercent) : null,
        onSale: !!(p.onSale && p.discountPercent),
        testPlaceId: p.testPlaceId || null,
        isFree: !p.developerProductId || String(p.developerProductId).trim() === '' || String(p.developerProductId).trim() === '0'
    }));
    res.json({ products: list, ownedProductIds: [...ownedSet] });
});

/** Process Developer Product purchase from Hub place */
app.post('/api/hub/purchase', checkBotAuth, async (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    const robloxId = String(req.body.robloxId || '').trim();
    const robloxName = String(req.body.robloxName || '').trim() || null;
    const developerProductId = String(req.body.developerProductId || '').trim();
    const productId = String(req.body.productId || '').trim();
    const purchaseId = String(req.body.purchaseId || '').trim() || null;
    const freeClaim = !!(req.body.freeClaim || req.body.free);
    if (!robloxId) {
        return res.status(400).json({ error: 'robloxId required' });
    }
    let product = null;
    if (productId) {
        product = data.hubProducts.find(p => p.id === productId);
    }
    if (!product && developerProductId) {
        product = data.hubProducts.find(p => String(p.developerProductId) === developerProductId);
    }
    if (!product) return res.status(404).json({ error: 'Unknown product' });
    const devId = String(product.developerProductId || '').trim();
    const isFree = !devId || devId === '0';
    if (freeClaim) {
        if (!isFree) return res.status(403).json({ error: 'Product is not free' });
        if (!productId || product.id !== productId) {
            return res.status(400).json({ error: 'productId required for free claim' });
        }
    } else {
        if (isFree) return res.status(400).json({ error: 'Free product must use freeClaim' });
        // Paid: only accept matching developer product id from Roblox receipt
        if (!developerProductId || String(developerProductId) !== devId) {
            return res.status(403).json({ error: 'developerProductId mismatch' });
        }
    }
    if (product.available === false) return res.status(403).json({ error: 'Product not available' });
    if (product.stock != null && product.stock <= 0) return res.status(403).json({ error: 'Out of stock' });

    if (purchaseId && data.hubOwnerships.some(o => o.purchaseId && o.purchaseId === purchaseId)) {
        return res.json({ ok: true, duplicate: true, productId: product.id });
    }
    // Already owns this product (manual grant or earlier purchase)
    const existingOwn = data.hubOwnerships.find(o =>
        o.productId === product.id && String(o.robloxId) === String(robloxId)
    );
    if (existingOwn) {
        if (purchaseId && !existingOwn.purchaseId) existingOwn.purchaseId = purchaseId;
        if (robloxName) existingOwn.robloxName = robloxName;
        // still sync keys
        const keyNamesDup = product.keyNames || [];
        if (keyNamesDup.length) {
            let creator = data.whitelist.creators.find(c => String(c.id) === String(robloxId));
            if (!creator) {
                creator = { id: Number(robloxId) || robloxId, name: robloxName || String(robloxId), keys: [], groups: null };
                data.whitelist.creators.push(creator);
            }
            if (!Array.isArray(creator.keys)) creator.keys = [];
            for (const kn of keyNamesDup) {
                const existing = creator.keys.find(k => k.key === kn);
                if (!existing) creator.keys.push({ key: kn, expiresAt: null, fromHub: true, hubProductId: product.id });
                else { existing.fromHub = true; existing.hubProductId = product.id; }
            }
        }
        await safeSave();
        return res.json({ ok: true, duplicate: true, productId: product.id, ownershipId: existingOwn.id });
    }

    if (product.stock != null) product.stock = Number(product.stock) - 1;

    const ownId = newHubId();
    data.hubOwnerships.push({
        id: ownId,
        productId: product.id,
        robloxId,
        robloxName,
        purchaseId,
        purchasedAt: Date.now()
    });

    // Grant license keys to this Roblox user as creator whitelist
    const keyNames = product.keyNames || [];
    if (keyNames.length) {
        let creator = data.whitelist.creators.find(c => String(c.id) === String(robloxId));
        if (!creator) {
            creator = { id: Number(robloxId) || robloxId, name: robloxName || String(robloxId), keys: [], groups: null };
            data.whitelist.creators.push(creator);
        }
        if (!Array.isArray(creator.keys)) creator.keys = [];
        if (robloxName) creator.name = robloxName;
        for (const kn of keyNames) {
            const existing = creator.keys.find(k => k.key === kn);
            if (!existing) {
                creator.keys.push({ key: kn, expiresAt: null, fromHub: true, hubProductId: product.id });
            } else {
                existing.fromHub = true;
                existing.hubProductId = product.id;
            }
        }
    }
    notifyProductGranted(data, product, robloxId, robloxName, publicBaseUrl(req));
    await safeSave();
    res.json({ ok: true, productId: product.id, ownershipId: ownId, keysGranted: keyNames });
});


app.post('/api/hub/grant', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const productId = String(req.body.productId || '').trim();
    const robloxId = String(req.body.robloxId || '').trim();
    let robloxName = String(req.body.robloxName || '').trim() || null;
    if (!productId || !robloxId) return res.status(400).json({ error: 'productId and robloxId required' });
    const product = data.hubProducts.find(p => p.id === productId);
    if (!product) return res.status(404).json({ error: 'product not found' });
    if (!robloxName) {
        try {
            const u = await axios.get('https://users.roblox.com/v1/users/' + robloxId, { timeout: 8000 });
            if (u.data && u.data.name) robloxName = u.data.name;
        } catch (_) {}
    }
    if (data.hubOwnerships.some(o => o.productId === productId && String(o.robloxId) === String(robloxId))) {
        return res.status(409).json({ error: 'Player already owns this product' });
    }
    data.hubOwnerships.push({
        id: newHubId(),
        productId,
        robloxId,
        robloxName,
        purchaseId: 'manual-' + Date.now(),
        purchasedAt: Date.now(),
        manual: true
    });
    const keyNames = product.keyNames || [];
    if (keyNames.length) {
        let creator = data.whitelist.creators.find(c => String(c.id) === String(robloxId));
        if (!creator) {
            creator = { id: Number(robloxId) || robloxId, name: robloxName || String(robloxId), keys: [], groups: null };
            data.whitelist.creators.push(creator);
        }
        if (!Array.isArray(creator.keys)) creator.keys = [];
        if (robloxName) creator.name = robloxName;
        for (const kn of keyNames) {
            const existing = creator.keys.find(k => k.key === kn);
            if (!existing) creator.keys.push({ key: kn, expiresAt: null, fromHub: true, hubProductId: product.id });
            else { existing.fromHub = true; existing.hubProductId = product.id; }
        }
    }
    notifyProductGranted(data, product, robloxId, robloxName, publicBaseUrl(req));
    await safeSave();
    res.json({ ok: true });
});

app.post('/api/hub/revoke', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const ownershipId = String(req.body.ownershipId || '').trim();
    const before = data.hubOwnerships.length;
    const removed = data.hubOwnerships.find(o => o.id === ownershipId);
    data.hubOwnerships = data.hubOwnerships.filter(o => o.id !== ownershipId);
    if (removed) {
        const prod = data.hubProducts.find(pr => pr.id === removed.productId);
        if (prod) notifyProductRevoked(data, prod, removed.robloxId);
    }
    await safeSave();
    res.json({ ok: true, removed: before - data.hubOwnerships.length });
});

app.get('/api/bot/profile', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureLinkStores(data);
    ensureHubStores(data);
    const discordId = String(req.query.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'discordId required' });
    const link = (data.discordLinks || []).find(l => String(l.discordId) === discordId);
    if (!link) return res.json({ linked: false, discordId });
    const owns = (data.hubOwnerships || []).filter(o => String(o.robloxId) === String(link.robloxId));
    const products = owns.map(o => {
        const p = (data.hubProducts || []).find(x => x.id === o.productId);
        return {
            ownershipId: o.id,
            productId: o.productId,
            name: p ? p.name : o.productId,
            purchasedAt: o.purchasedAt
        };
    });
    res.json({
        linked: true,
        discordId: link.discordId,
        discordTag: link.discordTag,
        robloxId: link.robloxId,
        robloxName: link.robloxName,
        products
    });
});



// ---- Hub files + bot jobs ----
app.get('/api/hub/files/:token', (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).send('bad token');
    for (const prod of (data.hubProducts || [])) {
        const f = (prod.files || []).find(x => x.token === token);
        if (f && f.contentBase64) {
            const buf = Buffer.from(f.contentBase64, 'base64');
            res.setHeader('Content-Type', f.mime || 'application/octet-stream');
            res.setHeader('Content-Disposition', 'attachment; filename="' + String(f.name || 'file').replace(/"/g, '') + '"');
            res.setHeader('Content-Length', buf.length);
            return res.send(buf);
        }
    }
    return res.status(404).send('File not found');
});

app.post('/api/hub/products/:id/files', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const product = data.hubProducts.find(p => p.id === req.params.id);
    if (!product) return res.status(404).json({ error: 'product not found' });
    if (!Array.isArray(product.files)) product.files = [];
    const name = String(req.body.name || 'file').slice(0, 120);
    const mime = String(req.body.mime || 'application/octet-stream').slice(0, 80);
    const contentBase64 = String(req.body.contentBase64 || '');
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 required' });
    const size = Buffer.from(contentBase64, 'base64').length;
    if (size > 5 * 1024 * 1024) return res.status(400).json({ error: 'Max 5MB per file' });
    if (product.files.length >= 10) return res.status(400).json({ error: 'Max 10 files per product' });
    const file = {
        id: newHubId(),
        name,
        mime,
        size,
        token: newHubId() + newHubId(),
        contentBase64,
        uploadedAt: Date.now()
    };
    product.files.push(file);
    await safeSave();
    res.json({ ok: true, id: file.id, token: file.token, name: file.name, size: file.size, url: publicBaseUrl(req) + '/api/hub/files/' + file.token });
});

app.delete('/api/hub/products/:id/files/:fileId', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const product = data.hubProducts.find(p => p.id === req.params.id);
    if (!product) return res.status(404).json({ error: 'product not found' });
    product.files = (product.files || []).filter(f => f.id !== req.params.fileId);
    await safeSave();
    res.json({ ok: true });
});

app.get('/api/bot/jobs', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    res.json({ jobs: (data.pendingBotJobs || []).slice(0, 30) });
});

app.post('/api/bot/jobs/:id/complete', checkBotAuth, async (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    const id = req.params.id;
    data.pendingBotJobs = (data.pendingBotJobs || []).filter(j => j.id !== id);
    await safeSave();
    res.json({ ok: true });
});

app.post('/api/bot/jobs/:id/fail', checkBotAuth, async (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    const job = (data.pendingBotJobs || []).find(j => j.id === req.params.id);
    if (job) {
        job.tries = (job.tries || 0) + 1;
        job.lastError = String((req.body && req.body.error) || '').slice(0, 300);
        job.lastTriedAt = Date.now();
        // drop after many failures
        if (job.tries >= 25) {
            data.pendingBotJobs = data.pendingBotJobs.filter(j => j.id !== job.id);
        }
    }
    await safeSave();
    res.json({ ok: true });
});

app.get('/api/bot/hub-catalog', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    ensureBotConfig(data);
    const cfg = data.botConfig;
    const list = (data.hubProducts || []).filter(p => p.available !== false).map(p => {
        const stock = p.stock;
        const soldOut = stock != null && Number(stock) <= 0;
        return {
            id: p.id,
            name: p.name,
            description: p.description || '',
            stock: stock == null ? null : Number(stock),
            soldOut,
            isFree: !p.developerProductId || String(p.developerProductId) === '0',
            developerProductId: p.developerProductId
        };
    });
    res.json({
        products: list,
        robloxGameUrl: cfg.robloxGameUrl || '',
        showPrices: cfg.hubShowPrices !== false
    });
});

app.get('/api/bot/retrieve', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    ensureLinkStores(data);
    const discordId = String(req.query.discordId || '').trim();
    const productName = String(req.query.product || '').trim().toLowerCase();
    if (!discordId || !productName) return res.status(400).json({ error: 'discordId and product required' });
    const link = (data.discordLinks || []).find(l => String(l.discordId) === discordId);
    if (!link) return res.status(404).json({ error: 'Discord not linked to Roblox' });
    const product = (data.hubProducts || []).find(p => String(p.name || '').toLowerCase() === productName)
        || (data.hubProducts || []).find(p => String(p.name || '').toLowerCase().includes(productName));
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const owns = (data.hubOwnerships || []).some(o => o.productId === product.id && String(o.robloxId) === String(link.robloxId));
    if (!owns) return res.status(403).json({ error: 'You do not own this product' });
    const base = publicBaseUrl(req);
    res.json({
        productName: product.name,
        files: fileMetaList(product, base)
    });
});


app.listen(PORT, () => {});
