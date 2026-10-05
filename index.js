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

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
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
    { id: 'wl-retrieve', name: 'retrieve', description: 'DM your product delivery (files/links/text)', enabled: true, roleIds: ['ALL'] },
    { id: 'wl-sendproduct', name: 'sendproduct', description: 'DM product delivery to another Discord user', enabled: true, roleIds: [] },
    { id: 'wl-delete', name: 'delete', description: 'Delete bot DMs or channel messages', enabled: true, roleIds: [] }
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
function ensureBlacklist(data) {
    if (!Array.isArray(data.blacklist)) data.blacklist = [];
}
function isBlacklisted(data, opts) {
    ensureBlacklist(data);
    const dId = opts && opts.discordId != null ? String(opts.discordId).trim() : '';
    const rId = opts && opts.robloxId != null ? String(opts.robloxId).trim() : '';
    const dName = opts && opts.discordTag ? String(opts.discordTag).toLowerCase().replace(/^@/, '') : '';
    const rName = opts && opts.robloxName ? String(opts.robloxName).toLowerCase() : '';
    for (const e of data.blacklist) {
        if (!e) continue;
        if (dId && e.discordId && String(e.discordId) === dId) return e;
        if (rId && e.robloxId && String(e.robloxId) === rId) return e;
        if (dName && e.discordTag && String(e.discordTag).toLowerCase().replace(/^@/, '') === dName) return e;
        if (rName && e.robloxName && String(e.robloxName).toLowerCase() === rName) return e;
    }
    return null;
}

function ensureHubStores(data) {
    if (!Array.isArray(data.hubProducts)) data.hubProducts = [];
    if (!Array.isArray(data.hubOwnerships)) data.hubOwnerships = [];
    ensureBlacklist(data);
    if (!Array.isArray(data.pendingBotJobs)) data.pendingBotJobs = [];
    // never persist composer message loads
    if (data.composerLoadRequests) delete data.composerLoadRequests;
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
/** Live waiters for Composer load — resolved when bot fetches Discord message; nothing kept after response */
const composerLoadWaiters = new Map();



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
function cancelPendingProductJobs(data, productId, robloxId) {
    ensureHubStores(data);
    const before = (data.pendingBotJobs || []).length;
    data.pendingBotJobs = (data.pendingBotJobs || []).filter(j => {
        if (j.type !== 'product_granted' && j.type !== 'product_granted_pending_link') return true;
        const p = j.payload || {};
        if (productId && String(p.productId) !== String(productId)) return true;
        if (robloxId && String(p.robloxId) !== String(robloxId)) return true;
        return false; // cancel matching grant jobs
    });
    return before - data.pendingBotJobs.length;
}
function notifyProductRevoked(data, product, robloxId) {
    ensureLinkStores(data);
    cancelPendingProductJobs(data, product && product.id, robloxId);
    const link = (data.discordLinks || []).find(l => String(l.robloxId) === String(robloxId));
    if (!link || !link.discordId) return;
    enqueueBotJob(data, 'roles_sync', {
        discordId: String(link.discordId),
        robloxId: String(robloxId),
        roleIds: rolesForRoblox(data, robloxId),
        managedRoleIds: allHubRoleIds(data)
    });
}
function normalizeLinks(links) {
    if (!Array.isArray(links)) return [];
    return links.map((item, i) => {
        if (typeof item === 'string') {
            const url = item.trim();
            if (!url) return null;
            return { id: 'l' + i, name: url, url };
        }
        const url = String(item.url || item.href || '').trim();
        if (!url) return null;
        return {
            id: item.id || ('l' + i),
            name: String(item.name || item.label || url).slice(0, 120),
            url
        };
    }).filter(Boolean).slice(0, 20);
}
function notifyProductGranted(data, product, robloxId, robloxName, base) {
    ensureLinkStores(data);
    const link = (data.discordLinks || []).find(l => String(l.robloxId) === String(robloxId));
    const roles = rolesForRoblox(data, robloxId);
    const baseUrl = base || publicBaseUrl();
    const includes = Array.isArray(product.deliveryIncludes) && product.deliveryIncludes.length
        ? product.deliveryIncludes.map(String)
        : ['files', 'links', 'text'];
    if (link && link.discordId) {
        const payload = {
            discordId: String(link.discordId),
            robloxId: String(robloxId),
            robloxName: robloxName || null,
            productId: product.id,
            productName: product.name,
            roleIds: roles,
            managedRoleIds: allHubRoleIds(data),
            deliveryIncludes: includes,
            files: includes.includes('files') ? fileMetaList(product, baseUrl) : [],
            links: includes.includes('links') ? normalizeLinks(product.links) : [],
            deliveryText: includes.includes('text') ? String(product.deliveryText || '') : ''
        };
        enqueueBotJob(data, 'product_granted', payload);
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
        data.botConfig = { enabled: true, commands: [], robloxGameUrl: '', updatedAt: Date.now() };
    }
    if (typeof data.botConfig.enabled !== 'boolean') data.botConfig.enabled = true;
    if (typeof data.botConfig.robloxGameUrl !== 'string') data.botConfig.robloxGameUrl = data.botConfig.robloxGameUrl || '';
    if (!Array.isArray(data.botConfig.commands)) data.botConfig.commands = [];
    if (!data.botConfig.verificationStatus || typeof data.botConfig.verificationStatus !== 'object') {
        data.botConfig.verificationStatus = { enabled: false, role1: '', role2: '', intervalSec: 5 };
    }
    if (!Array.isArray(data.botConfig.statusChannels)) data.botConfig.statusChannels = [];
    if (!data.botConfig.statusMessages || typeof data.botConfig.statusMessages !== 'object') data.botConfig.statusMessages = {};
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
    data.botConfig.commands = merged.filter(c => c && c.id !== 'wl-verificationstatus' && c.name !== 'verificationstatus');
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
        configUpdatedAt: cfg.updatedAt || null,
        verificationStatus: cfg.verificationStatus || { enabled: false, role1: '', role2: '', intervalSec: 5 }
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
    blacklisted: 'Access denied.\nYour account is blacklisted.',
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
    blacklisted: 'הגישה נדחתה.\nהחשבון שלך ברשימה השחורה.',
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
    // one-shot slim: drop heavy arrays if present
    if (data.stats) {
        if (Array.isArray(data.stats.recent) && data.stats.recent.length) data.stats.recent = [];
        if (data.stats.byPlace && Object.keys(data.stats.byPlace).length > 50) {
            // keep counts but user asked not to store per-place — clear
            data.stats.byPlace = {};
        }
    }

    if (!data.stats) {
        data.stats = { total: 0, allowed: 0, denied: 0, byKey: {}, byPlace: {}, recent: [] };
    }
    if (!data.stats.byKey) data.stats.byKey = {};
    if (!data.stats.byPlace) data.stats.byPlace = {};
    data.stats.recent = []; // do not store per-request history
    data.stats.byPlace = {}; // do not store per-place rows
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
    /* per-request place + recent log removed — only aggregate counters */
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
    // Aggregate-only stats (no per-request log)
    const last24hAllowed = data.stats.last24hAllowed || 0;
    const last24hDenied = data.stats.last24hDenied || 0;
    const topKeysWeek = Object.entries(data.stats.byKey || {})
        .map(([key, s]) => ({
            key,
            total: (s.allowed || 0) + (s.denied || 0),
            allowed: s.allowed || 0,
            denied: s.denied || 0
        }))
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
        hubEnabled: data.hubEnabled !== false,
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

    if (isBlacklisted(data, { robloxId: creatorId })) {
        return deny('blacklisted', await msg('blacklisted'));
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
                    ${isOwner ? `<button type="button" id="hub-btn" class="hdr-btn" onclick="toggleHub()" style="background:${(data.hubEnabled !== false) ? '#059669' : '#9f1239'};border-color:${(data.hubEnabled !== false) ? '#10b981' : '#be123c'};">${(data.hubEnabled !== false) ? '🛒 Hub ON' : '🛒 Hub OFF'}</button>` : ''}
                    <a href="/blacklist" class="btn-obfuscate-page" style="background:#9f1239;border-color:#be123c;">🚫 Blacklist</a>
                    <a href="/inbox" class="btn-obfuscate-page" style="background:#0e7490;border-color:#0891b2;">💬 DM Inbox</a>
                    <a href="/bot" class="btn-obfuscate-page" style="background:#6366f1;border-color:#4f46e5;">🤖 Bot</a>
                    <a href="/users" class="btn-obfuscate-page" style="background:#14b8a6;border-color:#0d9488;">👤 Users</a>
                    <a href="/hub" class="btn-obfuscate-page" style="background:#ec4899;border-color:#db2777;">🛒 Hub</a>
                    <a href="/composer" class="btn-obfuscate-page" style="background:#8b5cf6;border-color:#7c3aed;">✉️ Composer</a>
                    <a href="/messages" class="btn-obfuscate-page" style="background:#f59e0b;border-color:#d97706;">💬 ${tr('messages')}</a>
                    <a href="/obfuscate" class="btn-obfuscate-page">🔒 ${tr('obfuscate')}</a>
                    <a href="/force-save" class="btn-save-db">💾 ${tr('save')}</a>
                    <a href="/force-load" class="btn-load-db">📂 ${tr('load')}</a>
                    <a href="/" class="btn-refresh">🔄 ${tr('refresh')}</a>
                    <a href="/logout" class="btn-logout">🚪 ${tr('logout')}</a>
                </div>
            </div>
            <div id="maint-banner" class="maint-banner" style="${maintenanceOn ? 'display:block;' : 'display:none;'}">⚠️ ${tr('maintenanceBanner')}</div>
            <div id="hub-banner" class="maint-banner" style="${(data.hubEnabled === false) ? 'display:block;background:#9f1239;' : 'display:none;'}">🛒 Hub Store is OFF — players will not see products in the Hub game</div>
            <div class="grid">
                <div class="card" style="grid-column: span 2;">
                    <div class="card-header"><h3>📊 ${tr('stats')}</h3></div>
                    <div class="stat-grid" id="stats-grid">
                        <div class="stat-box"><div class="num" id="stat-total">—</div><div class="lbl">${tr('totalChecks')}</div></div>
                        <div class="stat-box"><div class="num" id="stat-allowed" style="color:#10b981;">—</div><div class="lbl">${tr('allowed')}</div></div>
                        <div class="stat-box"><div class="num" id="stat-denied" style="color:#f43f5e;">—</div><div class="lbl">${tr('denied')}</div></div>
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

            async function toggleHub() {
                try {
                    const res = await fetch('/toggle-hub', { method: 'POST' });
                    if (res.status === 403) {
                        alert(tt('onlyOwnerMaint') || 'Owner only');
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
                    const hubBtn = document.getElementById('hub-btn');
                    const hubOn = data.hubEnabled !== false;
                    if (hubBtn) {
                        hubBtn.textContent = hubOn ? '🛒 Hub ON' : '🛒 Hub OFF';
                        hubBtn.style.background = hubOn ? '#059669' : '#9f1239';
                        hubBtn.style.borderColor = hubOn ? '#10b981' : '#be123c';
                    }
                    const hubBanner = document.getElementById('hub-banner');
                    if (hubBanner) hubBanner.style.display = hubOn ? 'none' : 'block';

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

                    // Authorized Creators = only manual whitelist keys (not Hub product grants)
                    const manualCreators = (data.whitelist.creators || []).filter(c => {
                        const keys = Array.isArray(c.keys) ? c.keys : [];
                        // At least one key that was NOT granted via Hub
                        return keys.some(k => {
                            if (typeof k === 'string') return true; // legacy plain key string = manual
                            return !k.fromHub;
                        });
                    }).map(c => {
                        // Hide Hub keys in the object used for display (buildRows also skips them)
                        const keys = (c.keys || []).filter(k => typeof k === 'string' || !k.fromHub);
                        return Object.assign({}, c, { keys });
                    });
                    document.getElementById('creators-table').innerHTML = buildRows(manualCreators, 'creators', data.userEmail);
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
        { key: 'blacklisted' },
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
                    <button class="btn-obfuscate" onclick="runObfuscation()">✨ Obfuscate</button>
                    <button class="btn-copy" onclick="copyToClipboard()">📋 Copy</button>
                    <button class="btn-download" onclick="saveFile()">📥 Save As...</button>
                </div>
            </div>
        </div>
        <script>
            const logo = String.raw\`--[[
     █████╗ ███████╗    ██████╗ ██████╗  ██████╗ ██████╗ ██╗   ██╗ ██████╗████████╗██╗ ██████╗ ███╗   ██╗███████╗
    ██╔══██╗██╔════╝    ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗██║   ██║██╔════╝╚══██╔══╝██║██╔═══██╗████╗  ██║██╔════╝
    ███████║███████╗    ██████╔╝██████╔╝██║   ██║██║  ██║██║   ██║██║        ██║   ██║██║   ██║██╔██╗ ██║███████╗
    ██╔══██║╚════██║    ██╔═══╝ ██╔══██╗██║   ██║██║  ██║██║   ██║██║        ██║   ██║██║   ██║██║╚██╗██║╚════██║
    ██║  ██║███████║    ██║     ██║  ██║╚██████╔╝██████╔╝╚██████╔╝╚██████╗   ██║   ██║╚██████╔╝██║ ╚████║███████║
    ╚═╝  ╚═╝╚══════╝    ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝  ╚═════╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝
--]]

\`;

            async function runObfuscation() {
                const area = document.getElementById("output-code");
                const code = area.value;
                if (!code || !code.trim()) { alert('Nothing to obfuscate'); return; }
                area.value = "-- Obfuscating...";
                try {
                    const response = await fetch('/api/perform-obfuscate', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ code })
                    });
                    const result = await response.text();
                    if (!response.ok) {
                        area.value = result || ('-- Error HTTP ' + response.status);
                        return;
                    }
                    area.value = logo + result;
                } catch (e) {
                    area.value = '-- Error: ' + (e.message || e);
                }
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





// ========== Local Lua/Luau obfuscator (NO loadstring, single-line output) ==========
function obfRandomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}
function obfRandomName(len) {
    const chars = 'OIlabcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
    let s = '_';
    for (let i = 0; i < (len || 10); i++) s += chars[obfRandomInt(0, chars.length - 1)];
    return s;
}
function obfStripLuaComments(src) {
    let out = '';
    let i = 0;
    const s = String(src);
    while (i < s.length) {
        if (s[i] === '-' && s[i + 1] === '-' && s[i + 2] === '[' && s[i + 3] === '[') {
            const endPos = s.indexOf(']]', i + 4);
            i = endPos < 0 ? s.length : endPos + 2;
            continue;
        }
        if (s[i] === '-' && s[i + 1] === '-') {
            while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
            continue;
        }
        if (s[i] === '[' && s[i + 1] === '[') {
            const endPos = s.indexOf(']]', i + 2);
            if (endPos < 0) { out += s.slice(i); break; }
            out += s.slice(i, endPos + 2);
            i = endPos + 2;
            continue;
        }
        if (s[i] === '"' || s[i] === "'") {
            const q = s[i];
            out += q;
            i++;
            while (i < s.length) {
                if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
                out += s[i];
                if (s[i] === q) { i++; break; }
                i++;
            }
            continue;
        }
        out += s[i];
        i++;
    }
    return out;
}
function obfEncryptStrings(src, decName, key) {
    let out = '';
    let i = 0;
    const s = String(src);
    while (i < s.length) {
        if (s[i] === '[' && s[i + 1] === '[') {
            const endPos = s.indexOf(']]', i + 2);
            if (endPos < 0) { out += s.slice(i); break; }
            const inner = s.slice(i + 2, endPos);
            const bytes = Buffer.from(inner, 'utf8');
            const enc = [];
            for (let j = 0; j < bytes.length; j++) enc.push(bytes[j] ^ key[j % key.length]);
            out += decName + '({' + enc.join(',') + '})';
            i = endPos + 2;
            continue;
        }
        if (s[i] === '"' || s[i] === "'") {
            const q = s[i];
            i++;
            let raw = '';
            while (i < s.length) {
                if (s[i] === '\\' && i + 1 < s.length) {
                    const n = s[i + 1];
                    if (n === 'n') raw += '\n';
                    else if (n === 't') raw += '\t';
                    else if (n === 'r') raw += '\r';
                    else if (n === '\\') raw += '\\';
                    else if (n === q) raw += q;
                    else raw += n;
                    i += 2;
                    continue;
                }
                if (s[i] === q) { i++; break; }
                raw += s[i];
                i++;
            }
            const bytes = Buffer.from(raw, 'utf8');
            const enc = [];
            for (let j = 0; j < bytes.length; j++) enc.push(bytes[j] ^ key[j % key.length]);
            out += decName + '({' + enc.join(',') + '})';
            continue;
        }
        out += s[i];
        i++;
    }
    return out;
}
function obfuscateLuaLocal(sourceCode) {
    let src = String(sourceCode || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!src.trim()) throw new Error('empty code');

    src = src.replace(/--[[\s\S]*?Whitelist Systems[\s\S]*?]]\s*/i, '');
    src = src.replace(/^-- Protected by Whitelist Hub[^\n]*\n/i, '');

    src = obfStripLuaComments(src);

    const key = [];
    const keyLen = obfRandomInt(8, 16);
    for (let i = 0; i < keyLen; i++) key.push(obfRandomInt(1, 255));

    const decName = obfRandomName(12);
    const keyName = obfRandomName(10);
    const bitName = obfRandomName(8);
    const iName = obfRandomName(6);
    const nName = obfRandomName(6);
    const tName = obfRandomName(6);
    const bName = obfRandomName(6);
    const sName = obfRandomName(6);
    const junk1 = obfRandomName(9);
    const junk2 = obfRandomName(9);
    const junkA = obfRandomInt(100, 999);
    const junkB = obfRandomInt(100, 999);

    // Keep statement boundaries as semicolons so one-line Lua stays valid
    let body = obfEncryptStrings(src, decName, key);
    body = body.replace(/\n+/g, ';').replace(/;+/g, ';');

    const decryptor = [
        'local ' + junk1 + '=(' + junkA + '~' + junkA + ')',
        'local ' + junk2 + '=(' + junkB + '*0)',
        'local ' + keyName + '={' + key.join(',') + '}',
        'local function ' + bitName + '(x) x=tonumber(x)or 0; if x<0 then x=(-x)%256 end; return x%256 end',
        'local function ' + decName + '(' + tName + ')',
        'if type(' + tName + ')~="table" then return tostring(' + tName + ' or "") end',
        'local ' + sName + '={}',
        'local ' + nName + '=#' + keyName,
        'for ' + iName + '=1,#' + tName + ' do',
        'local ' + bName + '=' + bitName + '(' + tName + '[' + iName + '])',
        'if bit32 and bit32.bxor then ' + bName + '=bit32.bxor(' + bName + ',' + keyName + '[(((' + iName + '-1)%' + nName + ')+1)]) else',
        'local a,bb,r,p=' + bName + ',' + keyName + '[(((' + iName + '-1)%' + nName + ')+1)],0,1;',
        'for _=1,8 do local ab,bd=a%2,bb%2; if ab~=bd then r=r+p end; a,bb,p=(a-ab)/2,(bb-bd)/2,p*2 end;',
        bName + '=r%256 end',
        sName + '[' + iName + ']=string.char(' + bitName + '(' + bName + '))',
        'end',
        'return table.concat(' + sName + ')',
        'end'
    ].join(' ');

    let result = 'do ' + decryptor + ' ' + body + ' end';
    result = result.replace(/[\r\n]+/g, ' ').replace(/[\t ]+/g, ' ').trim();
    return result;
}


app.post('/api/perform-obfuscate', checkAuth, async (req, res) => {
    const { code } = req.body || {};
    try {
        if (!code || !String(code).trim()) {
            return res.status(400).type('text/plain').send('-- Error: empty code');
        }
        let src = String(code);
        // Strip previous logo/comment block so re-obfuscate works
        src = src.replace(/^--[[\s\S]*?]]\s*/i, '');
        src = src.replace(/^-- Protected by Whitelist Hub[^\n]*\n/i, '');

        const response = await axios.post(
            'https://wearedevs.net/api/obfuscate',
            { script: src },
            { timeout: 120000, headers: { 'Content-Type': 'application/json' } }
        );

        let out = null;
        if (response.data) {
            if (typeof response.data === 'string') out = response.data;
            else out = response.data.obfuscated || response.data.code || response.data.script || null;
        }
        if (!out || !String(out).trim()) {
            return res.status(502).type('text/plain').send('-- Error: empty response from obfuscator API');
        }
        out = String(out).trim();

        // Drop WeAreDevs banner — keep from first "return"
        const retIdx = out.search(/\breturn\b/);
        if (retIdx >= 0) out = out.slice(retIdx);
        else out = out.replace(/^--[[\s\S]*?]]\s*/i, '').trim();

        // Single line
        out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).join(' ');
        res.type('text/plain').send(out);
    } catch (e) {
        console.error('[obfuscate]', e.response && e.response.status, e.message);
        const detail = (e.response && e.response.data)
            ? (typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)).slice(0, 300)
            : (e.message || String(e));
        res.status(500).type('text/plain').send('-- Error obfuscating: ' + detail);
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

app.post('/toggle-hub', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) {
        return res.sendStatus(403);
    }
    const data = db.getData();
    // default true; first toggle turns OFF
    data.hubEnabled = data.hubEnabled === false ? true : false;
    await safeSave();
    await saveActionLogInternal(req.session.userEmail, 'Toggle Hub Store', `Hub Store is now ${data.hubEnabled !== false ? 'ON' : 'OFF'}`);
    res.json({ hubEnabled: data.hubEnabled !== false });
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
            data.keys.push({ key, isLocked: true, isAllAccess: !!isAllAccess });
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
        updatedAt: cfg.updatedAt || null,
        statusChannels: cfg.statusChannels || [],
        statusMessages: cfg.statusMessages || {},
        verificationStatus: cfg.verificationStatus || null,
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
    if (body.verificationStatus && typeof body.verificationStatus === 'object') {
        const vs = body.verificationStatus;
        if (!cfg.verificationStatus) cfg.verificationStatus = { enabled: false, role1: '', role2: '', intervalSec: 5 };
        if (vs.enabled != null) cfg.verificationStatus.enabled = !!vs.enabled;
        if (vs.role1 != null) cfg.verificationStatus.role1 = String(vs.role1).replace(/\D/g, '');
        if (vs.role2 != null) cfg.verificationStatus.role2 = String(vs.role2).replace(/\D/g, '');
        cfg.verificationStatus.intervalSec = 5;
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
  <div style="margin-top:18px;padding-top:14px;border-top:1px solid #1e293b;">
    <h3 style="margin:0 0 8px;color:#a78bfa;">Role verification loop</h3>
    <p class="hint">Every 5 seconds: has <b>Role 1</b> → remove Role 2; missing Role 1 → add Role 2. Requires Server Members Intent.</p>
    <div id="verif-live" style="margin:8px 0;font-weight:bold;">Status: —</div>
    <label style="display:flex;align-items:center;gap:8px;margin:10px 0;">
      <input type="checkbox" id="verif-enabled" ${(cfg.verificationStatus && cfg.verificationStatus.enabled) ? 'checked' : ''}/> Loop enabled
    </label>
    <label style="font-size:13px;color:#94a3b8;">Role 1 ID (verified)</label>
    <input id="verif-role1" type="text" value="${((cfg.verificationStatus && cfg.verificationStatus.role1) || '').replace(/"/g, '&quot;')}" placeholder="1234567890" style="margin-top:4px;margin-bottom:10px;"/>
    <label style="font-size:13px;color:#94a3b8;">Role 2 ID (unverified)</label>
    <input id="verif-role2" type="text" value="${((cfg.verificationStatus && cfg.verificationStatus.role2) || '').replace(/"/g, '&quot;')}" placeholder="1234567890" style="margin-top:4px;"/>
  </div>
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
    const vl = document.getElementById('verif-live');
    if (vl && s.verificationStatus) {
      const v = s.verificationStatus;
      vl.innerHTML = v.enabled
        ? '<span class="badge-on">● RUNNING</span> · every 5s · role1 <code>' + (v.role1||'—') + '</code> · role2 <code>' + (v.role2||'—') + '</code>'
        : '<span class="badge-off">● STOPPED</span>';
    }
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
    commands,
    verificationStatus: {
      enabled: !!(document.getElementById('verif-enabled') || {}).checked,
      role1: (document.getElementById('verif-role1') || {}).value || '',
      role2: (document.getElementById('verif-role2') || {}).value || '',
      intervalSec: 5
    }
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
        verificationStatus: cfg.verificationStatus || { enabled: false, role1: '', role2: '', intervalSec: 20 },
        statusChannels: cfg.statusChannels || [],
        statusMessages: cfg.statusMessages || {},
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
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hub</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0b0f19;color:#e2e8f0}
.wrap{max-width:1100px;margin:0 auto;padding:24px}
h1{color:#f472b6;margin:0 0 8px}
a{color:#38bdf8}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}
.tabs button{padding:10px 16px;border-radius:999px;border:1px solid #1e293b;background:#111827;color:#94a3b8;cursor:pointer;font-weight:700}
.tabs button.on{background:linear-gradient(135deg,#db2777,#7c3aed);color:#fff;border-color:transparent}
.panel{display:none}.panel.on{display:block}
.card{background:#111827;border:1px solid #1e293b;border-radius:14px;padding:18px;margin-bottom:14px}
label{display:block;font-size:12px;color:#94a3b8;margin:8px 0 4px}
input,select,textarea{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;box-sizing:border-box}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
button.btn{padding:10px 14px;border:0;border-radius:8px;background:#db2777;color:#fff;font-weight:700;cursor:pointer;margin-right:8px;margin-top:8px}
button.sec{background:#334155}button.danger{background:#e11d48}button.green{background:#059669}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px;border-bottom:1px solid #1e293b;text-align:left}
.muted{color:#64748b;font-size:13px}code{color:#a5b4fc}
.pc{border:1px solid #1e293b;border-radius:12px;padding:12px;margin-bottom:10px;background:#0f172a}
.tags{color:#fbbf24;font-size:12px}
.grant-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;max-height:280px;overflow-y:auto;padding:4px}
.grant-chip{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;border:1px solid #1e293b;background:#0f172a;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;user-select:none;margin:0;color:#e2e8f0;font-size:13px}
.grant-chip:hover{border-color:#475569;background:#111827}
.grant-chip.on{border-color:#a855f7;background:linear-gradient(135deg,rgba(219,39,119,.18),rgba(124,58,237,.18));box-shadow:0 0 0 1px rgba(168,85,247,.35)}
.grant-chip input{accent-color:#a855f7;width:16px;height:16px;flex-shrink:0;margin:0}
.grant-chip span{line-height:1.3;word-break:break-word}
</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
  <h1>Hub Store <span class="muted" id="liveHint" style="font-size:12px;font-weight:400"></span></h1>
  <div><a href="/">Dashboard</a> · <a href="/users">Users</a> · <a href="/composer">Composer</a> · <a href="/bot">Bot</a></div>
</div>
<div class="tabs">
  <button type="button" class="on" data-t="products">Products</button>
  <button type="button" data-t="owners">Owners</button>
  <button type="button" data-t="history">History</button>
  <button type="button" data-t="grant">Grant</button>
</div>

<div id="panel-products" class="panel on">
  <div class="card">
    <h3 id="formTitle">Create product</h3>
    <input type="hidden" id="pId"/>
    <div class="row">
      <div><label>Name</label><input id="pName"/></div>
      <div><label>Developer Product ID (empty/0 = Free)</label><input id="pDev"/></div>
    </div>
    <div class="row">
      <div><label>Stock (empty = unlimited)</label><input id="pStock" type="number"/></div>
      <div><label>Available</label><select id="pAvail"><option value="1">Yes</option><option value="0">No</option></select></div>
    </div>
    <div class="row">
      <div><label>Discount %</label><input id="pDisc" type="number"/></div>
      <div><label>On sale badge</label><select id="pSale"><option value="0">No</option><option value="1">Yes</option></select></div>
    </div>
    <div class="row">
      <div><label>Test Place ID</label><input id="pTest"/></div>
      <div><label>Image (rbxassetid)</label><input id="pImg"/></div>
    </div>
    <div class="row">
      <div><label>StacyPilot support</label>
        <select id="pStacy"><option value="0">No</option><option value="1">Yes</option></select>
      </div>
      <div><label>Layout order (lower = first)</label>
        <input id="pLayout" type="number" placeholder="0"/>
      </div>
    </div>
    <label>Description</label><textarea id="pDesc" rows="2"></textarea>
    <label>Discord role IDs (comma-separated)</label><input id="pRoles"/>
    <label>Delivery includes (combine any)</label>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin:8px 0">
      <label style="display:flex;gap:6px;align-items:center;color:#e2e8f0"><input type="checkbox" id="incFiles" checked/> Files</label>
      <label style="display:flex;gap:6px;align-items:center;color:#e2e8f0"><input type="checkbox" id="incLinks" checked/> Links</label>
      <label style="display:flex;gap:6px;align-items:center;color:#e2e8f0"><input type="checkbox" id="incText" checked/> Text</label>
    </div>
    <div id="textBox">
      <label>Text (DM message)</label>
      <textarea id="pText" rows="3" placeholder="Thanks for buying..."></textarea>
    </div>
    <div id="linksBox" style="margin-top:8px">
      <label>Links (name + URL)</label>
      <div id="linksEditor"></div>
      <button type="button" class="btn sec" id="btnAddLink">+ Add link</button>
    </div>
    <label>Keys (optional — Ctrl/Cmd multi-select, leave empty for none)</label>
    <select id="pKeys" multiple size="5"></select>
    <div id="fileSection" style="margin-top:12px;padding:12px;border:1px dashed #334155;border-radius:10px">
      <h4 style="margin:0 0 6px">📎 Files</h4>
      <p class="muted">Optional display name per file. Existing files can be renamed.</p>
      <input type="file" id="pFiles" multiple/>
      <div id="pendingFileNames" class="muted" style="margin-top:8px"></div>
      <div id="fileList" class="muted" style="margin-top:8px"></div>
    </div>
    <div>
      <button type="button" class="btn" id="btnSave">Save product</button>
      <button type="button" class="btn sec" id="btnClear">Clear form</button>
    </div>
  </div>
  <div class="card"><h3>All products</h3><div id="productList"></div></div>
</div>

<div id="panel-owners" class="panel">
  <div class="card">
    <h3>Owners</h3>
    <input id="ownerSearch" placeholder="Search name or id..." style="margin-bottom:12px"/>
    <div id="ownerList"></div>
  </div>
</div>

<div id="panel-history" class="panel">
  <div class="card">
    <h3>Purchase history</h3>
    <table><thead><tr><th>When</th><th>Product</th><th>Player</th><th>Source</th><th></th></tr></thead>
    <tbody id="histBody"></tbody></table>
  </div>
</div>

<div id="panel-grant" class="panel">
  <div class="card">
    <h3>Grant product</h3>
    <p class="muted">Target must already be Discord-linked in Hub. Select one or more products (already owned are skipped).</p>
    <label>Products</label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <button type="button" class="btn sec" id="gSelectAll" style="margin:0;padding:6px 12px;font-size:12px">Select all</button>
      <button type="button" class="btn sec" id="gSelectNone" style="margin:0;padding:6px 12px;font-size:12px">Clear</button>
      <span class="muted" id="gSelectedCount" style="align-self:center">0 selected</span>
    </div>
    <div id="gProductList" class="grant-grid"></div>
    <label>Lookup type</label>
    <select id="gType">
      <option value="robloxId">Roblox user ID</option>
      <option value="robloxUsername">Roblox username</option>
      <option value="discordId">Discord user ID</option>
    </select>
    <label id="gValueLabel">Roblox user ID</label>
    <input id="gValue"/>
    <label style="display:flex;align-items:center;gap:8px;margin:12px 0;color:#e2e8f0">
      <input type="checkbox" id="gNotify" checked/>
      Send product delivery to user DM
    </label>
    <button type="button" class="btn green" id="btnGrant">Grant</button>
  </div>
</div>

<script>
let PRODUCTS = [];
let OWNERSHIPS = [];
let LINKS = [];
let KEYS = [];
let pendingFiles = [];
let pendingNames = {};

function $(id){ return document.getElementById(id); }

document.querySelectorAll('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('on'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
    btn.classList.add('on');
    const panel = $('panel-' + btn.getAttribute('data-t'));
    if (panel) panel.classList.add('on');
  });
});

if ($('gType')) {
  $('gType').addEventListener('change', () => {
    const t = $('gType').value;
    if ($('gValueLabel')) {
      $('gValueLabel').textContent =
        t === 'robloxUsername' ? 'Roblox username' :
        t === 'discordId' ? 'Discord user ID' : 'Roblox user ID';
    }
  });
}

function fillKeysSelect(){
  const sel = $('pKeys');
  if (!sel) return;
  const prev = Array.from(sel.selectedOptions || []).map(o => o.value);
  sel.innerHTML = '';
  (KEYS || []).forEach(k => {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = k;
    if (prev.indexOf(k) >= 0) o.selected = true;
    sel.appendChild(o);
  });
}

function selectedKeys(){
  const sel = $('pKeys');
  if (!sel) return [];
  return Array.from(sel.selectedOptions || []).map(o => o.value);
}

function linkForRoblox(rid){
  return (LINKS || []).find(l => String(l.robloxId) === String(rid)) || null;
}

function clearForm(){
  if ($('formTitle')) $('formTitle').textContent = 'Create product';
  if ($('pId')) $('pId').value = '';
  ['pName','pDev','pStock','pDesc','pImg','pDisc','pTest','pRoles','pText'].forEach(id => {
    if ($(id)) $(id).value = '';
  });
  if ($('pAvail')) $('pAvail').value = '1';
  if ($('pSale')) $('pSale').value = '0';
  if ($('pStacy')) $('pStacy').value = '0';
  if ($('pLayout')) $('pLayout').value = '';
  if ($('incFiles')) $('incFiles').checked = true;
  if ($('incLinks')) $('incLinks').checked = true;
  if ($('incText')) $('incText').checked = true;
  if ($('pKeys')) Array.from($('pKeys').options).forEach(o => o.selected = false);
  pendingFiles = [];
  pendingNames = {};
  if ($('pFiles')) $('pFiles').value = '';
  if ($('fileList')) $('fileList').textContent = '';
  if ($('pendingFileNames')) $('pendingFileNames').innerHTML = '';
  renderLinksEditor([]);
}

function renderLinksEditor(links){
  const box = $('linksEditor');
  if (!box) return;
  const list = (links && links.length) ? links : [{ name: '', url: '' }];
  box.innerHTML = list.map((l, i) =>
    '<div class="row" style="margin-bottom:6px" data-link-row>' +
    '<div><input placeholder="Display name" data-lname value="' + String(l.name||'').replace(/"/g,'&quot;') + '"/></div>' +
    '<div style="display:flex;gap:6px"><input placeholder="https://..." data-lurl value="' + String(l.url||'').replace(/"/g,'&quot;') + '"/>' +
    '<button type="button" class="btn danger" data-rm-link>×</button></div></div>'
  ).join('');
  box.querySelectorAll('[data-rm-link]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('[data-link-row]');
      if (row) row.remove();
      if (!box.querySelector('[data-link-row]')) renderLinksEditor([]);
    });
  });
}

function collectLinks(){
  const rows = document.querySelectorAll('#linksEditor [data-link-row]');
  const out = [];
  rows.forEach(row => {
    const name = (row.querySelector('[data-lname]') || {}).value || '';
    const url = (row.querySelector('[data-lurl]') || {}).value || '';
    if (String(url).trim()) out.push({ name: String(name).trim() || String(url).trim(), url: String(url).trim() });
  });
  return out;
}

function renderExistingFiles(p){
  const el = $('fileList');
  if (!el) return;
  const files = (p && p.files) || [];
  if (!files.length) { el.textContent = 'No files on server yet.'; return; }
  el.innerHTML = files.map(f =>
    '<div style="display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap">' +
    '<input data-rename="' + f.id + '" value="' + String(f.name||'').replace(/"/g,'&quot;') + '" style="max-width:220px"/>' +
    '<span class="muted">(' + Math.round((f.size||0)/1024) + ' KB)</span>' +
    '<button type="button" class="btn sec" data-save-name="' + f.id + '">Rename</button>' +
    '<button type="button" class="btn danger" data-del-file="' + f.id + '">Delete</button></div>'
  ).join('');
  el.querySelectorAll('[data-save-name]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-save-name');
      const inp = el.querySelector('input[data-rename="' + id + '"]');
      const name = inp ? inp.value.trim() : '';
      if (!name || !$('pId').value) return;
      await fetch('/api/hub/products/' + encodeURIComponent($('pId').value) + '/files/' + encodeURIComponent(id) + '/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      await refreshState(true);
    });
  });
  el.querySelectorAll('[data-del-file]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete file?') || !$('pId').value) return;
      await fetch('/api/hub/products/' + encodeURIComponent($('pId').value) + '/files/' + encodeURIComponent(btn.getAttribute('data-del-file')), {
        method: 'DELETE'
      });
      await refreshState(true);
    });
  });
}

function renderProducts(){
  const box = $('productList');
  if (!box) return;
  if (!PRODUCTS.length) {
    box.innerHTML = '<p class="muted">No products yet</p>';
    return;
  }
  const sorted = PRODUCTS.slice().sort((a, b) => {
    const ao = a.layoutOrder != null ? Number(a.layoutOrder) : 0;
    const bo = b.layoutOrder != null ? Number(b.layoutOrder) : 0;
    if (ao !== bo) return ao - bo;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  box.innerHTML = sorted.map(p => {
    const stock = p.stock == null ? '∞' : p.stock;
    return '<div class="pc"><b>' + (p.name || '') + '</b> <code>' + p.id + '</code>' +
      '<div class="muted">Dev: ' + (p.developerProductId||'') + ' · Stock: ' + stock +
      (p.stacyPilot ? ' · <span style="color:#38bdf8">StacyPilot</span>' : '') +
      (p.layoutOrder != null ? ' · order ' + p.layoutOrder : '') +
      ' · Delivery: ' + ((p.deliveryIncludes||[]).join('+')||'none') +
      ' · Keys: ' + ((p.keyNames||[]).join(', ')||'—') +
      ' · Files: ' + ((p.files||[]).length) + '</div>' +
      '<button type="button" class="btn sec" data-edit="' + p.id + '">Edit</button>' +
      '<button type="button" class="btn danger" data-del="' + p.id + '">Delete</button></div>';
  }).join('');
  box.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await refreshState(false);
      const p = PRODUCTS.find(x => x.id === btn.getAttribute('data-edit'));
      if (p) editProduct(p);
    });
  });
  box.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete product?')) return;
      await fetch('/api/hub/products/' + encodeURIComponent(btn.getAttribute('data-del')), { method: 'DELETE' });
      await refreshState(true);
    });
  });
}

function renderOwners(){
  const box = $('ownerList');
  if (!box) return;
  const by = {};
  OWNERSHIPS.forEach(o => {
    const rid = String(o.robloxId);
    if (!by[rid]) by[rid] = { robloxId: rid, robloxName: o.robloxName || rid, items: [] };
    if (o.robloxName) by[rid].robloxName = o.robloxName;
    const prod = PRODUCTS.find(p => p.id === o.productId);
    const keyTags = ((prod && prod.keyNames) || []).map(k => '🔑' + k).join(' ');
    by[rid].items.push({
      ownershipId: o.id,
      name: prod ? prod.name : o.productId,
      productId: o.productId,
      keys: keyTags
    });
  });
  const q = (($('ownerSearch') && $('ownerSearch').value) || '').toLowerCase().trim();
  const filtered = Object.values(by).filter(pl => {
    if (!q) return true;
    const link = linkForRoblox(pl.robloxId);
    const blob = [pl.robloxName, pl.robloxId, link && link.discordTag, link && link.discordId]
      .filter(Boolean).join(' ').toLowerCase();
    return blob.indexOf(q) >= 0;
  });
  if (!filtered.length) { box.innerHTML = '<p class="muted">No owners</p>'; return; }
  box.innerHTML = filtered.map(pl => {
    const link = linkForRoblox(pl.robloxId);
    const disc = link
      ? ('Discord: <b>' + (link.discordTag || '—') + '</b> <code>' + link.discordId + '</code>')
      : '<span class="muted">Discord: not linked</span>';
    const items = pl.items.map(it =>
      '<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #1e293b">' +
      '<span><b>' + it.name + '</b> <span class="tags">' + (it.keys || '') + '</span></span>' +
      '<button type="button" class="btn danger" data-rev="' + it.ownershipId + '">×</button></div>'
    ).join('');
    return '<div class="pc"><b>' + pl.robloxName + '</b> <code>' + pl.robloxId + '</code><div class="muted" style="margin:4px 0">' + disc + '</div><div>' + items + '</div></div>';
  }).join('');
  box.querySelectorAll('[data-rev]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove product from player?')) return;
      await fetch('/api/hub/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownershipId: btn.getAttribute('data-rev') })
      });
      await refreshState(true);
    });
  });
}

function renderHistory(){
  const body = $('histBody');
  if (!body) return;
  const rows = OWNERSHIPS.slice().sort((a,b) => (b.purchasedAt||0) - (a.purchasedAt||0));
  body.innerHTML = rows.map(o => {
    const prod = PRODUCTS.find(p => p.id === o.productId);
    const when = o.purchasedAt ? new Date(o.purchasedAt).toLocaleString() : '—';
    return '<tr><td>' + when + '</td><td>' + (prod ? prod.name : o.productId) + '</td><td>' +
      (o.robloxName||'') + ' <code>' + o.robloxId + '</code></td><td>' + (o.manual?'Manual':'Purchase') +
      '</td><td><button type="button" class="btn danger" data-rev="' + o.id + '">Revoke</button></td></tr>';
  }).join('') || '<tr><td colspan="5" class="muted">No history</td></tr>';
  body.querySelectorAll('[data-rev]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch('/api/hub/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownershipId: btn.getAttribute('data-rev') })
      });
      await refreshState(true);
    });
  });
}

function updateGrantCount(){
  const box = $('gProductList');
  const n = box ? box.querySelectorAll('input[type=checkbox]:checked').length : 0;
  const el = $('gSelectedCount');
  if (el) el.textContent = n + ' selected';
  if (box) {
    box.querySelectorAll('.grant-chip').forEach(lab => {
      const cb = lab.querySelector('input');
      if (cb && cb.checked) lab.classList.add('on');
      else lab.classList.remove('on');
    });
  }
}

function renderGrant(){
  const box = $('gProductList');
  if (!box) return;
  const prev = new Set(
    Array.from(box.querySelectorAll('input[type=checkbox]:checked')).map(c => c.value)
  );
  if (!PRODUCTS.length) {
    box.innerHTML = '<span class="muted">No products</span>';
    updateGrantCount();
    return;
  }
  box.innerHTML = PRODUCTS.map(p => {
    const on = prev.has(p.id);
    return '<label class="grant-chip' + (on ? ' on' : '') + '">' +
      '<input type="checkbox" value="' + p.id + '"' + (on ? ' checked' : '') + '/>' +
      '<span>' + (p.name || p.id) + '</span></label>';
  }).join('');
  box.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', updateGrantCount);
  });
  updateGrantCount();
}

function editProduct(p){
  if (!p) return;
  if ($('formTitle')) $('formTitle').textContent = 'Edit: ' + (p.name || '');
  if ($('pId')) $('pId').value = p.id || '';
  if ($('pName')) $('pName').value = p.name || '';
  if ($('pDev')) $('pDev').value = p.developerProductId || '';
  if ($('pStock')) $('pStock').value = (p.stock == null ? '' : p.stock);
  if ($('pAvail')) $('pAvail').value = p.available === false ? '0' : '1';
  if ($('pDesc')) $('pDesc').value = p.description || '';
  if ($('pImg')) $('pImg').value = p.imageUrl || '';
  if ($('pDisc')) $('pDisc').value = p.discountPercent == null ? '' : p.discountPercent;
  if ($('pSale')) $('pSale').value = p.onSale ? '1' : '0';
  if ($('pTest')) $('pTest').value = p.testPlaceId || '';
  if ($('pStacy')) $('pStacy').value = p.stacyPilot ? '1' : '0';
  if ($('pLayout')) $('pLayout').value = p.layoutOrder != null ? p.layoutOrder : '';
  if ($('pRoles')) $('pRoles').value = (p.discordRoleIds || []).join(', ');
  const inc = Array.isArray(p.deliveryIncludes)
    ? p.deliveryIncludes
    : ['files', 'links', 'text'];
  if ($('incFiles')) $('incFiles').checked = inc.indexOf('files') >= 0;
  if ($('incLinks')) $('incLinks').checked = inc.indexOf('links') >= 0;
  if ($('incText')) $('incText').checked = inc.indexOf('text') >= 0;
  if ($('pText')) $('pText').value = p.deliveryText != null ? String(p.deliveryText) : '';
  renderLinksEditor(Array.isArray(p.links) ? p.links : []);
  const keys = p.keyNames || [];
  if ($('pKeys')) Array.from($('pKeys').options).forEach(o => { o.selected = keys.indexOf(o.value) >= 0; });
  pendingFiles = [];
  pendingNames = {};
  if ($('pFiles')) $('pFiles').value = '';
  if ($('pendingFileNames')) $('pendingFileNames').innerHTML = '';
  renderExistingFiles(p);
  const tab = document.querySelector('.tabs button[data-t="products"]');
  if (tab) tab.click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function uploadPending(productId){
  if (!pendingFiles.length) return;
  for (let i = 0; i < pendingFiles.length; i++) {
    const file = pendingFiles[i];
    const inp = document.querySelector('#pendingFileNames input[data-pidx="' + i + '"]');
    const displayName = (inp && inp.value.trim()) || file.name;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let j = 0; j < bytes.length; j++) s += String.fromCharCode(bytes[j]);
    const b64 = btoa(s);
    const r = await fetch('/api/hub/products/' + encodeURIComponent(productId) + '/files', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originalName: file.name,
        displayName,
        name: displayName,
        mime: file.type || 'application/octet-stream',
        contentBase64: b64
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Upload failed');
  }
  pendingFiles = [];
  pendingNames = {};
}

async function refreshState(){
  const hint = $('liveHint');
  try {
    const r = await fetch('/api/hub/state', { credentials: 'same-origin' });
    if (!r.ok) {
      if (hint) hint.textContent = '· load error ' + r.status;
      if ($('productList')) $('productList').innerHTML =
        '<p class="muted" style="color:#f43f5e">Failed to load (HTTP ' + r.status + '). Re-login if needed.</p>';
      return;
    }
    const j = await r.json();
    PRODUCTS = Array.isArray(j.products) ? j.products : [];
    OWNERSHIPS = Array.isArray(j.ownerships) ? j.ownerships : [];
    LINKS = Array.isArray(j.links) ? j.links : [];
    KEYS = Array.isArray(j.keys) ? j.keys : [];
    fillKeysSelect();
    renderProducts();
    renderOwners();
    renderHistory();
    renderGrant();
    if (hint) hint.textContent = '· ' + PRODUCTS.length + ' products · ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.error(e);
    if (hint) hint.textContent = '· ' + (e.message || e);
    if ($('productList')) $('productList').innerHTML =
      '<p class="muted" style="color:#f43f5e">Error: ' + String(e.message || e) + '</p>';
  }
}

if ($('pFiles')) {
  $('pFiles').addEventListener('change', () => {
    const added = Array.from($('pFiles').files || []);
    for (const f of added) pendingFiles.push(f);
    if ($('pendingFileNames')) {
      $('pendingFileNames').innerHTML = pendingFiles.map((f, i) =>
        '<div style="margin:4px 0">File: ' + f.name +
        ' → <input data-pidx="' + i + '" placeholder="Display name" value="' +
        String(f.name).replace(/"/g,'&quot;') + '" style="max-width:200px"/></div>'
      ).join('');
    }
    $('pFiles').value = '';
  });
}

if ($('btnAddLink')) {
  $('btnAddLink').addEventListener('click', () => {
    const cur = collectLinks();
    cur.push({ name: '', url: '' });
    renderLinksEditor(cur);
  });
}

if ($('btnClear')) $('btnClear').addEventListener('click', clearForm);

if ($('btnSave')) {
  $('btnSave').addEventListener('click', async () => {
    const name = $('pName') ? $('pName').value.trim() : '';
    if (!name) return alert('Name required');
    const includes = [];
    if ($('incFiles') && $('incFiles').checked) includes.push('files');
    if ($('incLinks') && $('incLinks').checked) includes.push('links');
    if ($('incText') && $('incText').checked) includes.push('text');
    const body = {
      id: $('pId') && $('pId').value.trim() ? $('pId').value.trim() : undefined,
      name,
      developerProductId: $('pDev') ? $('pDev').value.trim() : '',
      stock: $('pStock') ? $('pStock').value : '',
      available: !$('pAvail') || $('pAvail').value !== '0',
      description: $('pDesc') ? $('pDesc').value : '',
      imageUrl: $('pImg') ? $('pImg').value.trim() : '',
      discountPercent: $('pDisc') ? $('pDisc').value : '',
      onSale: $('pSale') && $('pSale').value === '1',
      testPlaceId: $('pTest') ? $('pTest').value.trim() : '',
      stacyPilot: $('pStacy') && $('pStacy').value === '1',
      layoutOrder: $('pLayout') ? $('pLayout').value : '',
      discordRoleIds: $('pRoles') ? $('pRoles').value : '',
      keyNames: selectedKeys(),
      deliveryIncludes: includes,
      deliveryNone: includes.length === 0,
      links: collectLinks(),
      deliveryText: $('pText') ? $('pText').value : ''
    };
    const r = await fetch('/api/hub/products', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error || 'Failed'); return; }
    try {
      if (pendingFiles.length && j.id) await uploadPending(j.id);
    } catch (e) {
      alert(e.message || e);
    }
    clearForm();
    await refreshState();
  });
}

if ($('btnGrant')) {
  $('btnGrant').addEventListener('click', async () => {
    const type = $('gType') ? $('gType').value : 'robloxId';
    const val = $('gValue') ? $('gValue').value.trim() : '';
    if (!val) return alert('Enter a target');
    const box = $('gProductList');
    const productIds = box
      ? Array.from(box.querySelectorAll('input[type=checkbox]:checked')).map(c => c.value)
      : [];
    if (!productIds.length) return alert('Select at least one product');
    const body = {
      productIds,
      notifyDm: !$('gNotify') || $('gNotify').checked
    };
    if (type === 'robloxId') body.robloxId = val;
    else if (type === 'robloxUsername') body.robloxUsername = val;
    else body.discordId = val;
    const r = await fetch('/api/hub/grant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error || 'Failed'); return; }
    const parts = [];
    if (j.granted && j.granted.length) parts.push('Granted: ' + j.granted.join(', '));
    if (j.skipped && j.skipped.length) parts.push('Skipped: ' + j.skipped.join(', '));
    if (j.failed && j.failed.length) parts.push('Failed: ' + j.failed.join(', '));
    alert(parts.join('\\n') || 'Done');
    if ($('gValue')) $('gValue').value = '';
    await refreshState();
  });
}

if ($('gSelectAll')) {
  $('gSelectAll').addEventListener('click', () => {
    const box = $('gProductList');
    if (!box) return;
    box.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; });
    updateGrantCount();
  });
}
if ($('gSelectNone')) {
  $('gSelectNone').addEventListener('click', () => {
    const box = $('gProductList');
    if (!box) return;
    box.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
    updateGrantCount();
  });
}

if ($('ownerSearch')) $('ownerSearch').addEventListener('input', renderOwners);

renderLinksEditor([]);
refreshState();
setInterval(refreshState, 8000);
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
        row.stacyPilot = b.stacyPilot === true || b.stacyPilot === '1' || b.stacyPilot === 1;
        {
            const lo = b.layoutOrder;
            if (lo === '' || lo == null) row.layoutOrder = 0;
            else {
                const n = Number(lo);
                row.layoutOrder = isNaN(n) ? 0 : n;
            }
        }
        row.discordRoleIds = Array.isArray(b.discordRoleIds)
            ? b.discordRoleIds.map(String).map(s => s.trim()).filter(Boolean)
            : String(b.discordRoleIds || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
        let includes = b.deliveryIncludes;
        if (typeof includes === 'string') includes = includes.split(/[\s,]+/);
        // Missing field → default all; explicit [] → none (user unchecked everything)
        if (includes == null) includes = ['files', 'links', 'text'];
        if (!Array.isArray(includes)) includes = ['files', 'links', 'text'];
        includes = includes.map(String).map(s => s.toLowerCase()).filter(x => ['files','links','text'].includes(x));
        if (b.deliveryNone === true || b.deliveryNone === '1') includes = [];
        row.deliveryIncludes = includes;
        row.deliveryMode = includes.length ? includes.join('+') : 'none';
        if (b.links != null) row.links = normalizeLinks(typeof b.links === 'string' ? b.links.split(/\n+/).map(s => ({ url: s })) : b.links);
        if (b.deliveryText != null) row.deliveryText = String(b.deliveryText).slice(0, 4000);
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
            stacyPilot: b.stacyPilot === true || b.stacyPilot === '1' || b.stacyPilot === 1,
            layoutOrder: (function(){
                const lo = b.layoutOrder;
                if (lo === '' || lo == null) return 0;
                const n = Number(lo);
                return isNaN(n) ? 0 : n;
            })(),
            discordRoleIds: Array.isArray(b.discordRoleIds)
                ? b.discordRoleIds.map(String).map(s => s.trim()).filter(Boolean)
                : String(b.discordRoleIds || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
            deliveryIncludes: (function(){
                let includes = b.deliveryIncludes;
                if (typeof includes === 'string') includes = includes.split(/[\s,]+/);
                if (includes == null) includes = ['files','links','text'];
                if (!Array.isArray(includes)) includes = ['files','links','text'];
                includes = includes.map(String).map(s => s.toLowerCase()).filter(x => ['files','links','text'].includes(x));
                if (b.deliveryNone === true || b.deliveryNone === '1') includes = [];
                return includes;
            })(),
            deliveryMode: (function(){
                let includes = b.deliveryIncludes;
                if (typeof includes === 'string') includes = includes.split(/[\s,]+/);
                if (includes == null) includes = ['files','links','text'];
                if (!Array.isArray(includes)) includes = ['files','links','text'];
                includes = includes.map(String).map(s => s.toLowerCase()).filter(x => ['files','links','text'].includes(x));
                if (b.deliveryNone === true || b.deliveryNone === '1') includes = [];
                return includes.length ? includes.join('+') : 'none';
            })(),
            links: normalizeLinks(Array.isArray(b.links) ? b.links : String(b.links||'').split(/\n+/).map(s => ({ url: s }))),
            deliveryText: String(b.deliveryText || '').slice(0, 4000),
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
    if (data.hubEnabled === false) {
        return res.json({ products: [], ownedProductIds: [], hubDisabled: true });
    }
    const robloxId = String(req.query.robloxId || '').trim();
    if (robloxId && isBlacklisted(data, { robloxId })) {
        return res.json({ products: [], ownedProductIds: [], blacklisted: true });
    }
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
        stacyPilot: !!p.stacyPilot,
        layoutOrder: p.layoutOrder != null ? Number(p.layoutOrder) : 0,
        isFree: !p.developerProductId || String(p.developerProductId).trim() === '' || String(p.developerProductId).trim() === '0'
    }));
    list.sort((a, b) => {
        const ao = a.layoutOrder != null ? a.layoutOrder : 0;
        const bo = b.layoutOrder != null ? b.layoutOrder : 0;
        if (ao !== bo) return ao - bo;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
    res.json({ products: list, ownedProductIds: [...ownedSet] });
});

/** Process Developer Product purchase from Hub place */
app.post('/api/hub/purchase', checkBotAuth, async (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    if (data.hubEnabled === false) {
        return res.status(503).json({ error: 'Hub Store is currently disabled', hubDisabled: true });
    }
    const robloxId = String(req.body.robloxId || '').trim();
    const robloxName = String(req.body.robloxName || '').trim() || null;
    const developerProductId = String(req.body.developerProductId || '').trim();
    const productId = String(req.body.productId || '').trim();
    const purchaseId = String(req.body.purchaseId || '').trim() || null;
    const freeClaim = !!(req.body.freeClaim || req.body.free);
    if (!robloxId) {
        return res.status(400).json({ error: 'robloxId required' });
    }
    if (isBlacklisted(data, { robloxId, robloxName })) {
        return res.status(403).json({ error: 'blacklisted', blacklisted: true });
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
    ensureLinkStores(data);

    // productIds[] preferred; legacy productId still works
    let productIds = [];
    if (Array.isArray(req.body.productIds)) productIds = req.body.productIds.map(String).map(s => s.trim()).filter(Boolean);
    else if (req.body.productId) productIds = [String(req.body.productId).trim()].filter(Boolean);
    if (!productIds.length) return res.status(400).json({ error: 'Select at least one product' });

    const notifyDm = req.body.notifyDm !== false && req.body.notifyDm !== '0' && req.body.notifyDm !== 0;

    let robloxId = String(req.body.robloxId || '').trim();
    let robloxName = String(req.body.robloxName || '').trim() || null;
    const discordIdIn = String(req.body.discordId || '').trim();
    const robloxUsername = String(req.body.robloxUsername || req.body.username || '').trim();

    let link = null;
    if (discordIdIn) {
        link = (data.discordLinks || []).find(l => String(l.discordId) === discordIdIn);
        if (!link) return res.status(400).json({ error: 'Discord ID is not linked to Hub' });
        robloxId = String(link.robloxId);
        robloxName = link.robloxName || robloxName;
    } else if (robloxUsername && !robloxId) {
        try {
            const r = await axios.post('https://users.roblox.com/v1/usernames/users', {
                usernames: [robloxUsername],
                excludeBannedUsers: false
            }, { timeout: 10000 });
            const u = (r.data && r.data.data && r.data.data[0]) || null;
            if (!u || !u.id) return res.status(404).json({ error: 'Roblox username not found' });
            robloxId = String(u.id);
            robloxName = u.name || robloxUsername;
        } catch (e) {
            return res.status(502).json({ error: 'Roblox lookup failed' });
        }
        link = (data.discordLinks || []).find(l => String(l.robloxId) === String(robloxId));
        if (!link) return res.status(400).json({ error: 'This Roblox user is not linked to Discord in Hub' });
    } else if (robloxId) {
        link = (data.discordLinks || []).find(l => String(l.robloxId) === String(robloxId));
        if (!link) return res.status(400).json({ error: 'This Roblox ID is not linked to Discord in Hub' });
        if (!robloxName) robloxName = link.robloxName || null;
    } else {
        return res.status(400).json({ error: 'Provide robloxId, robloxUsername, or discordId' });
    }

    if (!robloxName) {
        try {
            const u = await axios.get('https://users.roblox.com/v1/users/' + robloxId, { timeout: 8000 });
            if (u.data && u.data.name) robloxName = u.data.name;
        } catch (_) {}
    }

    const granted = [];
    const skipped = [];
    const failed = [];
    const base = publicBaseUrl(req);

    for (const productId of productIds) {
        const product = data.hubProducts.find(p => p.id === productId);
        if (!product) {
            failed.push(productId);
            continue;
        }
        if (data.hubOwnerships.some(o => o.productId === productId && String(o.robloxId) === String(robloxId))) {
            skipped.push(product.name || productId);
            continue;
        }
        data.hubOwnerships.push({
            id: newHubId(),
            productId,
            robloxId: String(robloxId),
            robloxName,
            purchaseId: 'manual-' + Date.now() + '-' + productId,
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
        if (notifyDm) {
            notifyProductGranted(data, product, robloxId, robloxName, base);
        }
        granted.push(product.name || productId);
    }

    await safeSave();
    res.json({
        ok: true,
        robloxId,
        robloxName,
        discordId: link.discordId,
        notifyDm,
        granted,
        skipped,
        failed
    });
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
app.get('/api/hub/state', checkAuth, (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    try {
    const data = db.getData();
    ensureHubStores(data);
    ensureLinkStores(data);
    const products = (data.hubProducts || []).map(p => ({
        id: p.id,
        name: p.name || '',
        description: p.description || '',
        imageUrl: p.imageUrl || '',
        developerProductId: p.developerProductId || '0',
        keyNames: p.keyNames || [],
        stock: p.stock,
        available: p.available !== false,
        discountPercent: p.discountPercent,
        onSale: !!p.onSale,
        testPlaceId: p.testPlaceId || '',
        stacyPilot: !!p.stacyPilot,
        layoutOrder: p.layoutOrder != null ? Number(p.layoutOrder) : 0,
        discordRoleIds: p.discordRoleIds || [],
        deliveryMode: p.deliveryMode || 'mixed',
        deliveryIncludes: Array.isArray(p.deliveryIncludes) ? p.deliveryIncludes : ['files','links','text'],
        links: normalizeLinks(p.links || []),
        deliveryText: p.deliveryText || '',
        files: (p.files || []).map(f => ({ id: f.id, name: f.name, size: f.size || 0, token: f.token }))
    }));
    const ownerships = (data.hubOwnerships || []).map(o => ({
        id: o.id,
        productId: o.productId,
        robloxId: o.robloxId,
        robloxName: o.robloxName || '',
        purchasedAt: o.purchasedAt || null,
        manual: !!o.manual
    }));
    ensureLinkStores(data);
    const links = (data.discordLinks || []).map(l => ({
        discordId: String(l.discordId),
        discordTag: l.discordTag || '',
        robloxId: String(l.robloxId),
        robloxName: l.robloxName || '',
        linkedAt: l.linkedAt || null
    }));
    res.json({ products, ownerships, links, keys: (data.keys || []).map(k => (typeof k === 'string' ? k : k.key)).filter(Boolean) });
    } catch (e) {
        console.error('[hub/state]', e);
        res.status(500).json({ error: String(e.message || e) });
    }
});

app.get('/api/hub/files/:token' , (req, res) => {
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
    const originalName = String(req.body.originalName || req.body.name || 'file').slice(0, 120);
    const name = String(req.body.displayName || req.body.name || originalName).slice(0, 120) || originalName;
    const mime = String(req.body.mime || 'application/octet-stream').slice(0, 80);
    const contentBase64 = String(req.body.contentBase64 || '');
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 required' });
    const size = Buffer.from(contentBase64, 'base64').length;
    if (size > 5 * 1024 * 1024) return res.status(400).json({ error: 'Max 5MB per file' });
    if (product.files.length >= 10) return res.status(400).json({ error: 'Max 10 files per product' });
    const file = {
        id: newHubId(),
        name,
        originalName,
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

app.post('/api/hub/products/:id/files/:fileId/rename', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const product = data.hubProducts.find(p => p.id === req.params.id);
    if (!product) return res.status(404).json({ error: 'product not found' });
    const file = (product.files || []).find(f => f.id === req.params.fileId);
    if (!file) return res.status(404).json({ error: 'file not found' });
    const name = String(req.body.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'name required' });
    file.name = name;
    await safeSave();
    res.json({ ok: true, name });
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
    if (data.hubEnabled === false) {
        return res.json({ products: [], robloxGameUrl: (data.botConfig && data.botConfig.robloxGameUrl) || '', hubDisabled: true });
    }
    ensureBotConfig(data);
    const cfg = data.botConfig;
    const all = req.query.all === '1' || req.query.all === 'true';
    const list = (data.hubProducts || [])
        .filter(p => all || p.available !== false)
        .map(p => {
            const stock = p.stock;
            const soldOut = stock != null && Number(stock) <= 0;
            return {
                id: p.id,
                name: p.name,
                description: p.description || '',
                stock: stock == null ? null : Number(stock),
                soldOut,
                available: p.available !== false,
                isFree: !p.developerProductId || String(p.developerProductId) === '0',
                developerProductId: p.developerProductId,
                stacyPilot: !!p.stacyPilot,
                layoutOrder: p.layoutOrder != null ? Number(p.layoutOrder) : 0
            };
        });
    list.sort((a, b) => {
        const ao = a.layoutOrder != null ? a.layoutOrder : 0;
        const bo = b.layoutOrder != null ? b.layoutOrder : 0;
        if (ao !== bo) return ao - bo;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
    res.json({
        products: list,
        robloxGameUrl: cfg.robloxGameUrl || ''
    });
});

app.get('/api/bot/retrieve-for', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    ensureLinkStores(data);
    const targetDiscordId = String(req.query.targetDiscordId || '').trim();
    const productName = String(req.query.product || '').trim().toLowerCase();
    if (!targetDiscordId || !productName) return res.status(400).json({ error: 'targetDiscordId and product required' });
    const link = (data.discordLinks || []).find(l => String(l.discordId) === targetDiscordId);
    if (!link) return res.status(404).json({ error: 'Target Discord is not linked' });
    const product = (data.hubProducts || []).find(p => String(p.name || '').toLowerCase() === productName)
        || (data.hubProducts || []).find(p => String(p.name || '').toLowerCase().includes(productName));
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const owns = (data.hubOwnerships || []).some(o => o.productId === product.id && String(o.robloxId) === String(link.robloxId));
    if (!owns) return res.status(403).json({ error: 'Target does not own this product' });
    const base = publicBaseUrl(req);
    const includes = Array.isArray(product.deliveryIncludes) && product.deliveryIncludes.length
        ? product.deliveryIncludes : ['files', 'links', 'text'];
    res.json({
        productName: product.name,
        targetDiscordId,
        robloxName: link.robloxName,
        robloxId: link.robloxId,
        deliveryIncludes: includes,
        files: includes.includes('files') ? fileMetaList(product, base) : [],
        links: includes.includes('links') ? normalizeLinks(product.links) : [],
        deliveryText: includes.includes('text') ? String(product.deliveryText || '') : ''
    });
});


app.get('/api/bot/retrieve-multi', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureHubStores(data);
    ensureLinkStores(data);
    const discordId = String(req.query.discordId || '').trim();
    const raw = String(req.query.products || req.query.product || '').trim();
    if (!discordId || !raw) return res.status(400).json({ error: 'discordId and products required' });
    const link = (data.discordLinks || []).find(l => String(l.discordId) === discordId);
    if (!link) return res.status(404).json({ error: 'Discord not linked to Roblox' });
    const ownedIds = new Set(
        (data.hubOwnerships || [])
            .filter(o => String(o.robloxId) === String(link.robloxId))
            .map(o => o.productId)
    );
    const base = publicBaseUrl(req);
    const allProducts = data.hubProducts || [];
    let targets = [];
    if (raw.toLowerCase() === 'all') {
        targets = allProducts.filter(p => ownedIds.has(p.id));
    } else {
        const tokens = raw.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        for (const tok of tokens) {
            const low = tok.toLowerCase();
            const product = allProducts.find(p => String(p.id) === tok)
                || allProducts.find(p => String(p.name || '').toLowerCase() === low)
                || allProducts.find(p => String(p.name || '').toLowerCase().includes(low));
            if (product && ownedIds.has(product.id) && !targets.some(x => x.id === product.id)) {
                targets.push(product);
            }
        }
    }
    const items = targets.map(product => {
        const includes = Array.isArray(product.deliveryIncludes) && product.deliveryIncludes.length
            ? product.deliveryIncludes.map(String)
            : ['files', 'links', 'text'];
        return {
            productId: product.id,
            productName: product.name,
            deliveryIncludes: includes,
            files: includes.includes('files') ? fileMetaList(product, base) : [],
            links: includes.includes('links') ? normalizeLinks(product.links) : [],
            deliveryText: includes.includes('text') ? String(product.deliveryText || '') : ''
        };
    });
    res.json({ items, count: items.length });
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
    const includes = Array.isArray(product.deliveryIncludes) && product.deliveryIncludes.length
        ? product.deliveryIncludes.map(String)
        : ['files', 'links', 'text'];
    res.json({
        productName: product.name,
        deliveryIncludes: includes,
        files: includes.includes('files') ? fileMetaList(product, base) : [],
        links: includes.includes('links') ? normalizeLinks(product.links) : [],
        deliveryText: includes.includes('text') ? String(product.deliveryText || '') : ''
    });
});



// ========== Discord message composer (inline) ==========
app.get('/composer', checkAuth, (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).send('Owner only');
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Message Composer</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0b0f19;color:#e2e8f0}
.wrap{max-width:960px;margin:0 auto;padding:24px}
h1{color:#a78bfa;margin:0 0 8px}
a{color:#38bdf8}
.card{background:#111827;border:1px solid #1e293b;border-radius:14px;padding:18px;margin-bottom:14px}
label{display:block;font-size:12px;color:#94a3b8;margin:10px 0 4px}
input,textarea{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;box-sizing:border-box}
textarea{min-height:90px;font-family:ui-monospace,monospace}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
button.btn{padding:10px 14px;border:0;border-radius:8px;background:#7c3aed;color:#fff;font-weight:700;cursor:pointer;margin-right:8px;margin-top:10px}
button.sec{background:#334155}button.green{background:#059669}button.danger{background:#e11d48}
.muted{color:#64748b;font-size:13px}
.preview{background:#1e1f22;border-radius:8px;padding:14px;margin-top:12px;max-width:520px}
.preview .emb{background:#2b2d31;border-radius:4px;padding:12px;margin-top:8px;border-left:4px solid #5865f2;overflow:hidden}
.preview .emb img.main{max-width:100%;border-radius:4px;margin-top:10px;display:block}
.preview .thumb{width:80px;height:80px;border-radius:4px;float:right;margin:0 0 8px 8px;object-fit:cover;background:#5865f2}
.preview .content{white-space:pre-wrap;margin-bottom:8px}
.cheat code{background:#0f172a;padding:2px 6px;border-radius:4px;user-select:all}
.cheat td,.cheat th{padding:6px 8px;border-bottom:1px solid #1e293b;text-align:left;font-size:13px}
.img-row{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}
</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
  <h1>Discord Composer</h1>
  <div><a href="/hub">Hub</a> · <a href="/bot">Bot</a> · <a href="/">Dashboard</a></div>
</div>
<p class="muted">Send the same message to a channel and/or users and/or all members with a role (DM). Bot must be online.</p>

<div class="card">
  <h3>Targets (combine any)</h3>
  <label>Channel IDs (optional — post in each, comma-separated)</label>
  <input id="channelIds" placeholder="111, 222"/>
  <label>User IDs (optional — DM each, comma-separated)</label>
  <input id="userIds" placeholder="111, 222"/>
  <label>Role IDs (optional — DM everyone with these roles, comma-separated)</label>
  <input id="roleIds" placeholder="333, 444"/>
  <p class="muted">Combine freely. Large image uploads are OK up to ~20MB total. Role DMs need the bot in that server.</p>
</div>
<div class="card">
  <h3>Live bot status message</h3>
  <p class="muted">Posts/updates an embed showing bot online status (live timestamp). Choose channels below.</p>
  <label>Status channel IDs (comma-separated)</label>
  <input id="statusChannelsInput" placeholder="111, 222"/>
  <button type="button" class="btn green" id="btnStatusDeploy">Deploy / refresh status messages</button>
  <div id="statusDeployHint" class="muted" style="margin-top:8px"></div>
</div>
<div class="card">
  <h3>Compose message</h3>
  <label>Load existing message (paste link)</label>
  <div class="row">
    <div><input id="messageLink" placeholder="https://discord.com/channels/guild/channel/message"/></div>
    <div style="display:flex;align-items:flex-end"><button type="button" class="btn sec" id="btnLoad" style="margin-top:0">Load message</button></div>
  </div>
  <p class="muted" id="loadStatus"></p>
</div>

<div class="card">
  <h3>Content</h3>
  <label>Message content</label><textarea id="content"></textarea>
  <label>Embed title</label><input id="embTitle"/>
  <label>Embed description</label><textarea id="embDesc"></textarea>
  <div class="row">
    <div><label>Embed color (hex)</label><input id="embColor" value="#5865F2"/></div>
    <div><label>Embed footer</label><input id="embFooter"/></div>
  </div>
  <label>Thumbnail URL (optional — small image on the side; leave empty for none)</label>
  <input id="embThumb" placeholder="https://… or leave empty"/>
  <label>Images inside embed (URLs and uploads — first = main image, more = extra embed cards)</label>
  <div id="imageList"></div>
  <div class="img-row">
    <input id="imgUrl" placeholder="https://image.png" style="flex:1"/>
    <button type="button" class="btn sec" id="btnAddUrl" style="margin-top:0">Add URL</button>
  </div>
  <div class="img-row">
    <input type="file" id="imgFile" accept="image/*" multiple/>
    <button type="button" class="btn sec" id="btnAddFiles" style="margin-top:0">Add uploads</button>
  </div>
  <h3 style="margin-top:18px">Buttons</h3>
  <p class="muted">Role add/remove only work in server channels (not DMs). File buttons work everywhere.</p>
  <div id="btnList"></div>
  <button type="button" class="btn sec" id="btnAddButton">+ Add button</button>
  <button type="button" class="btn green" id="btnSend">Send</button>
  <button type="button" class="btn" id="btnEdit">Save edit to loaded message</button>
  <button type="button" class="btn sec" id="btnPreview">Refresh preview</button>
  <div id="status" class="muted" style="margin-top:10px"></div>
  <div class="preview" id="preview"></div>
</div>

<div class="card cheat">
  <h3>Copy helpers — Discord formatting</h3>
  <table style="width:100%;border-collapse:collapse">
    <tr><th>What</th><th>Format</th></tr>
    <tr><td>Large heading</td><td><code># Heading text</code></td></tr>
    <tr><td>Medium heading</td><td><code>## Heading text</code></td></tr>
    <tr><td>Small heading</td><td><code>### Heading text</code></td></tr>
    <tr><td>Subtext (small)</td><td><code>-# small text</code></td></tr>
    <tr><td>Channel</td><td><code>&lt;#CHANNEL_ID&gt;</code></td></tr>
    <tr><td>User</td><td><code>&lt;@USER_ID&gt;</code></td></tr>
    <tr><td>Role</td><td><code>&lt;@&amp;ROLE_ID&gt;</code></td></tr>
    <tr><td>@everyone / @here</td><td><code>@everyone</code> · <code>@here</code></td></tr>
    <tr><td>Custom emoji</td><td><code>&lt;:name:ID&gt;</code></td></tr>
    <tr><td>Animated emoji</td><td><code>&lt;a:name:ID&gt;</code></td></tr>
    <tr><td>Timestamp relative</td><td><code>&lt;t:UNIX:R&gt;</code></td></tr>
    <tr><td>Timestamp full</td><td><code>&lt;t:UNIX:F&gt;</code></td></tr>
    <tr><td>Timestamp date</td><td><code>&lt;t:UNIX:D&gt;</code></td></tr>
    <tr><td>Slash command</td><td><code>&lt;/name:COMMAND_ID&gt;</code></td></tr>
    <tr><td>Spoiler</td><td><code>||text||</code></td></tr>
    <tr><td>Bold / italic / underline</td><td><code>**bold** *italic* __underline__</code></td></tr>
    <tr><td>Code / block</td><td><code>\`code\`</code> · <code>\`\`\`lang\\ncode\\n\`\`\`</code></td></tr>
    <tr><td>Quote</td><td><code>&gt; quoted line</code></td></tr>
  </table>
  <p class="muted" style="margin-top:10px">UNIX now: <code id="unixNow"></code>
  <button type="button" class="btn sec" id="btnUnix" style="margin-top:0">Refresh</button></p>
</div>

<script>
let images = [];
let loadedMessage = null;
function $(id){ return document.getElementById(id); }

function renderImageList(){
  const box = $('imageList');
  if (!images.length) { box.innerHTML = '<p class="muted">No images</p>'; return; }
  box.innerHTML = images.map((img,i) =>
    '<div class="img-row"><span class="muted">' + (img.type==='upload'?'Upload':'URL') +
    '</span><code style="max-width:260px;overflow:hidden;text-overflow:ellipsis">' +
    (img.url||img.name||'') + '</code>' +
    '<button type="button" class="btn danger" data-i="'+i+'" style="margin-top:0">×</button></div>'
  ).join('');
  box.querySelectorAll('[data-i]').forEach(btn => {
    btn.onclick = () => { images.splice(+btn.getAttribute('data-i'),1); renderImageList(); renderPreview(); };
  });
}
$('btnAddUrl').onclick = () => {
  const url = $('imgUrl').value.trim();
  if (!url) return;
  images.push({ type:'url', url });
  $('imgUrl').value='';
  renderImageList(); renderPreview();
};
$('btnAddFiles').onclick = async () => {
  for (const file of Array.from($('imgFile').files||[])) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > 8*1024*1024) { alert('Max 8MB'); continue; }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s=''; for (let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]);
    images.push({ type:'upload', name:file.name, mime:file.type, contentBase64:btoa(s) });
  }
  $('imgFile').value='';
  renderImageList(); renderPreview();
};

/** Build embeds exactly as bot will send (images inside embeds) */
function buildEmbeds(){
  const colorRaw = ($('embColor').value||'#5865F2').replace('#','');
  const color = parseInt(colorRaw,16);
  const title = $('embTitle').value.trim();
  const desc = $('embDesc').value.trim();
  const footer = $('embFooter').value.trim();
  const embeds = [];
  const main = {};
  if (title) main.title = title;
  if (desc) main.description = desc;
  if (!isNaN(color)) main.color = color;
  if (footer) main.footer = { text: footer };
  const thumb = ($('embThumb') && $('embThumb').value || '').trim();
  if (thumb) main.thumbnail = { url: thumb };
  if (images[0]) {
    if (images[0].type === 'url') main.image = { url: images[0].url };
    else if (images[0].contentBase64) main.image = { url: 'data:'+(images[0].mime||'image/png')+';base64,'+images[0].contentBase64 };
  }
  if (title || desc || footer || images[0]) embeds.push(main);
  for (let i=1;i<images.length;i++) {
    const e = { color: isNaN(color)?0x5865F2:color };
    if (images[i].type === 'url') e.image = { url: images[i].url };
    else if (images[i].contentBase64) e.image = { url: 'data:'+(images[i].mime||'image/png')+';base64,'+images[i].contentBase64 };
    embeds.push(e);
  }
  return embeds;
}

let buttons = [];
function renderButtons(){
  const box = $('btnList');
  if (!box) return;
  if (!buttons.length) { box.innerHTML = '<p class="muted">No buttons</p>'; return; }
  box.innerHTML = buttons.map((b,i) =>
    '<div class="card" style="padding:12px;margin:8px 0">' +
    '<div class="row"><div><label>Label</label><input data-bf="label" data-i="'+i+'" value="'+(b.label||'').replace(/"/g,'&quot;')+'"/></div>' +
    '<div><label>Color</label><select data-bf="style" data-i="'+i+'">' +
    ['Primary','Secondary','Success','Danger'].map(s => '<option value="'+s+'"'+(b.style===s?' selected':'')+'>'+s+'</option>').join('') +
    '</select></div></div>' +
    '<div class="row"><div><label>Action</label><select data-bf="action" data-i="'+i+'">' +
    [['role_add','Give role'],['role_remove','Remove role'],['product_file','Send product files']].map(a =>
      '<option value="'+a[0]+'"'+(b.action===a[0]?' selected':'')+'>'+a[1]+'</option>').join('') +
    '</select></div>' +
    '<div><label>Role ID / Product(s)</label><input data-bf="value" data-i="'+i+'" value="'+(b.value||'').replace(/"/g,'&quot;')+'" placeholder="role id · or product1, product2 · or All"/></div></div>' +
    '<label>Log targets (on click) — combine any, comma-separated IDs</label>' +
    '<div class="row"><div><label>Log channel IDs</label><input data-bf="logChannelIds" data-i="'+i+'" value="'+(b.logChannelIds||'').toString().replace(/"/g,'&quot;')+'" placeholder="111, 222"/></div>' +
    '<div><label>Log user IDs</label><input data-bf="logUserIds" data-i="'+i+'" value="'+(b.logUserIds||'').toString().replace(/"/g,'&quot;')+'" placeholder="333"/></div></div>' +
    '<label>Log role IDs (DM everyone with role)</label>' +
    '<input data-bf="logRoleIds" data-i="'+i+'" value="'+(b.logRoleIds||'').toString().replace(/"/g,'&quot;')+'" placeholder="444, 555"/>' +
    '<label style="display:flex;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" data-bf="deleteOnSuccess" data-i="'+i+'" '+(b.deleteOnSuccess?'checked':'')+'/> Delete this message after success (DM only)</label>' +
    '<button type="button" class="btn danger" data-rm-btn="'+i+'" style="margin-top:8px">Remove</button></div>'
  ).join('');
  box.querySelectorAll('[data-bf]').forEach(el => {
    el.onchange = el.oninput = () => {
      const i = +el.getAttribute('data-i');
      const f = el.getAttribute('data-bf');
      if (buttons[i]) buttons[i][f] = (el.type === 'checkbox') ? !!el.checked : el.value;
    };
  });
  box.querySelectorAll('[data-rm-btn]').forEach(btn => {
    btn.onclick = () => { buttons.splice(+btn.getAttribute('data-rm-btn'),1); renderButtons(); };
  });
}
function collectButtons(){
  return buttons.filter(b => b.label && b.action && b.value).map(b => ({
    label: String(b.label).slice(0,80),
    style: b.style || 'Primary',
    action: b.action,
    value: String(b.value).trim(),
    logChannelIds: b.logChannelIds || '',
    logUserIds: b.logUserIds || '',
    logRoleIds: b.logRoleIds || '',
    deleteOnSuccess: !!b.deleteOnSuccess
  })).slice(0, 25);
}
if ($('btnAddButton')) $('btnAddButton').onclick = () => {
  buttons.push({ label: 'Button', style: 'Primary', action: 'role_add', value: '', logChannelIds: '', logUserIds: '', logRoleIds: '', deleteOnSuccess: false });
  renderButtons();
};

function payload(){
  const splitIds = (v) => String(v||'').split(/[,\\s]+/).map(s=>s.trim()).filter(s=>/^\\d+$/.test(s));
  return {
    channelIds: splitIds(($('channelIds')||{}).value||''),
    userIds: splitIds(($('userIds')||{}).value||''),
    roleIds: splitIds(($('roleIds')||{}).value||''),
    messageLink: ($('messageLink').value||'').trim(),
    content: $('content').value||'',
    embeds: buildEmbeds().map(e => {
      const copy = Object.assign({}, e);
      if (copy.thumbnail) copy.thumbnail = Object.assign({}, copy.thumbnail);
      if (copy.image) copy.image = Object.assign({}, copy.image);
      return copy;
    }),
    images: images.map(i => ({
      type: i.type, url: i.url||null, name: i.name||null, mime: i.mime||null, contentBase64: i.contentBase64||null
    })),
    buttons: collectButtons(),
    loaded: loadedMessage
  };
}

function renderPreview(){
  const content = $('content').value||'';
  const embeds = buildEmbeds();
  let html = content ? '<div class="content">'+content.replace(/</g,'&lt;')+'</div>' : '';
  embeds.forEach(e => {
    const col = e.color != null ? e.color.toString(16).padStart(6,'0') : '5865f2';
    html += '<div class="emb" style="border-left-color:#'+col+'">';
    if (e.thumbnail && e.thumbnail.url) html += '<img class="thumb" src="'+String(e.thumbnail.url).replace(/"/g,'')+'" alt=""/>';
    if (e.title) html += '<div style="font-weight:700;font-size:16px">'+e.title.replace(/</g,'&lt;')+'</div>';
    if (e.description) html += '<div style="margin-top:6px;white-space:pre-wrap;color:#dbdee1">'+e.description.replace(/</g,'&lt;')+'</div>';
    if (e.footer && e.footer.text) html += '<div class="muted" style="margin-top:10px;font-size:12px;clear:both">'+e.footer.text.replace(/</g,'&lt;')+'</div>';
    if (e.image && e.image.url) html += '<img class="main" src="'+e.image.url.replace(/"/g,'')+'" alt=""/>';
    html += '</div>';
  });
  if (!html) html = '<span class="muted">(empty)</span>';
  $('preview').innerHTML = html;
}

$('btnPreview').onclick = renderPreview;
['content','embTitle','embDesc','embColor','embFooter','embThumb'].forEach(id => {
  const el=$(id); if(el) el.addEventListener('input', renderPreview);
});

async function post(path,body){
  const r = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(j.error||('HTTP '+r.status));
  return j;
}

$('btnSend').onclick = async () => {
  const st=$('status');
  try {
    const p = payload();
    if (!p.channelIds.length && !p.userIds.length && !p.roleIds.length) throw new Error('Set at least one target: channel(s), user(s), or role(s)');
    if (!p.content && !p.embeds.length && !p.images.length) throw new Error('Add content, embed or image');
    st.textContent='Queuing…';
    await post('/api/composer/send', p);
    st.textContent='Queued. Bot will deliver to all selected targets.';
  } catch(e){ st.textContent=e.message||e; }
};

$('btnEdit').onclick = async () => {
  const st=$('status');
  try {
    const p = payload();
    if (!loadedMessage && !p.messageLink) throw new Error('Load a message first');
    st.textContent='Queuing edit…';
    await post('/api/composer/edit', p);
    st.textContent='Queued edit.';
  } catch(e){ st.textContent=e.message||e; }
};

$('btnLoad').onclick = async () => {
  const st=$('loadStatus');
  try {
    const link=$('messageLink').value.trim();
    if (!link) throw new Error('Paste message link');
    st.textContent='Fetching from Discord via bot…';
    const j = await post('/api/composer/load',{ messageLink: link });
    if (!j || j.status !== 'ok' || !j.message) throw new Error((j && j.error) || 'Load failed');
    const m = j.message;
    loadedMessage={ channelId:m.channelId, messageId:m.messageId };
    $('content').value=m.content||'';
    const emb=(m.embeds&&m.embeds[0])||{};
    $('embTitle').value=emb.title||'';
    $('embDesc').value=emb.description||'';
    $('embFooter').value=(emb.footer&&emb.footer.text)||'';
    if (emb.color!=null) $('embColor').value='#'+Number(emb.color).toString(16).padStart(6,'0');
    if ($('embThumb')) $('embThumb').value=(emb.thumbnail&&emb.thumbnail.url)||'';
    images=[];
    (m.embeds||[]).forEach(e=>{ if(e.image&&e.image.url) images.push({type:'url',url:e.image.url}); });
    (m.attachments||[]).forEach(a=>{ if(a.url) images.push({type:'url',url:a.url,name:a.name}); });
    buttons = Array.isArray(m.buttons) ? m.buttons.map(b => ({
      label: b.label||'Button',
      style: b.style||'Primary',
      action: b.action||'role_add',
      value: b.value||'',
      logChannelIds: Array.isArray(b.logChannelIds) ? b.logChannelIds.join(', ') : (b.logChannelIds || ''),
      logUserIds: Array.isArray(b.logUserIds) ? b.logUserIds.join(', ') : (b.logUserIds || ''),
      logRoleIds: Array.isArray(b.logRoleIds) ? b.logRoleIds.join(', ') : (b.logRoleIds || ''),
      deleteOnSuccess: !!b.deleteOnSuccess
    })) : [];
    if (m.channelId && $('channelIds')) $('channelIds').value=m.channelId;
    renderImageList(); renderButtons(); renderPreview();
    st.textContent='Imported from Discord (not stored). Edit then Save edit.';
  } catch(e){ st.textContent=e.message||e; }
};

$('btnUnix').onclick=()=>{ $('unixNow').textContent=String(Math.floor(Date.now()/1000)); };
$('btnUnix').click();
if ($('btnStatusDeploy')) {
  $('btnStatusDeploy').onclick = async () => {
    const st = $('statusDeployHint');
    try {
      const ids = String(($('statusChannelsInput')||{}).value||'').split(/[,\s]+/).map(s=>s.trim()).filter(Boolean);
      st.textContent = 'Saving…';
      await post('/api/composer/status-channels', { channelIds: ids });
      st.textContent = 'Saved. Bot will post/update status embeds shortly.';
    } catch (e) { st.textContent = e.message || e; }
  };
}
renderImageList(); renderButtons(); renderPreview();
</script>
</div></body></html>`);
});


app.post('/api/composer/status-channels', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    const cfg = ensureBotConfig(data);
    const parseIds = (v) => {
        if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(s => /^\d+$/.test(s));
        return String(v || '').split(/[,\s]+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    };
    cfg.statusChannels = parseIds(req.body.channelIds);
    cfg.updatedAt = Date.now();
    data.botConfig = cfg;
    ensureHubStores(data);
    // Pass channelIds in job so bot does not wait for next heartbeat
    enqueueBotJob(data, 'status_message_sync', {
        force: true,
        channelIds: cfg.statusChannels.slice()
    });
    await safeSave();
    res.json({ ok: true, channelIds: cfg.statusChannels, statusMessages: cfg.statusMessages || {} });
});

app.get('/api/bot/blacklist-check', checkBotAuth, (req, res) => {
    const data = db.getData();
    ensureBlacklist(data);
    const hit = isBlacklisted(data, {
        discordId: req.query.discordId,
        robloxId: req.query.robloxId,
        discordTag: req.query.discordTag,
        robloxName: req.query.robloxName
    });
    res.json({ blacklisted: !!hit, entry: hit || null });
});

app.post('/api/bot/verification-status', checkBotAuth, async (req, res) => {
    const data = db.getData();
    const cfg = ensureBotConfig(data);
    if (req.body.enabled != null) cfg.verificationStatus.enabled = !!req.body.enabled;
    if (req.body.role1 != null) cfg.verificationStatus.role1 = String(req.body.role1).replace(/\D/g, '');
    if (req.body.role2 != null) cfg.verificationStatus.role2 = String(req.body.role2).replace(/\D/g, '');
    if (req.body.intervalSec != null) cfg.verificationStatus.intervalSec = 5;
    cfg.updatedAt = Date.now();
    data.botConfig = cfg;
    await safeSave();
    res.json({ ok: true, verificationStatus: cfg.verificationStatus });
});

app.post('/api/bot/status-messages', checkBotAuth, async (req, res) => {
    const data = db.getData();
    const cfg = ensureBotConfig(data);
    if (req.body.statusMessages && typeof req.body.statusMessages === 'object') {
        cfg.statusMessages = req.body.statusMessages;
    }
    cfg.updatedAt = Date.now();
    data.botConfig = cfg;
    await safeSave();
    res.json({ ok: true });
});

app.post('/api/composer/send', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const parseIds = (v) => {
        if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(s => /^\d+$/.test(s));
        return String(v || '').split(/[,\s]+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    };
    const channelIds = parseIds(req.body.channelIds != null ? req.body.channelIds : req.body.channelId);
    const roleIds = parseIds(req.body.roleIds != null ? req.body.roleIds : req.body.roleId);
    const userIds = parseIds(req.body.userIds);
    if (!channelIds.length && !roleIds.length && !userIds.length) {
        return res.status(400).json({ error: 'Need channel(s), user(s), or role(s)' });
    }
    const content = String(req.body.content || '');
    const embeds = Array.isArray(req.body.embeds) ? req.body.embeds : [];
    const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 8) : [];
    let uploadBytes = 0;
    for (const img of images) {
        if (img && img.contentBase64) uploadBytes += Math.floor(String(img.contentBase64).length * 0.75);
    }
    if (uploadBytes > 20 * 1024 * 1024) {
        return res.status(400).json({ error: 'Images too large (max ~20MB total uploads)' });
    }
    if (!content && !embeds.length && !images.length) return res.status(400).json({ error: 'Empty message' });
    const buttons = Array.isArray(req.body.buttons) ? req.body.buttons.slice(0, 25) : [];
    enqueueBotJob(data, 'discord_message_send', {
        channelIds,
        userIds,
        roleIds,
        content,
        embeds,
        images,
        buttons
    });
    await safeSave();
    res.json({ ok: true });
});

app.post('/api/composer/edit', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    let channelId = req.body.loaded && req.body.loaded.channelId;
    let messageId = req.body.loaded && req.body.loaded.messageId;
    if (!channelId || !messageId) {
        const link = String(req.body.messageLink || '').trim();
        const m = link.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
        if (!m) return res.status(400).json({ error: 'Load a message or valid link' });
        channelId = m[2];
        messageId = m[3];
    }
    enqueueBotJob(data, 'discord_message_edit', {
        channelId: String(channelId),
        messageId: String(messageId),
        content: String(req.body.content || ''),
        embeds: Array.isArray(req.body.embeds) ? req.body.embeds : [],
        images: Array.isArray(req.body.images) ? req.body.images.slice(0, 10) : [],
        buttons: Array.isArray(req.body.buttons) ? req.body.buttons.slice(0, 25) : []
    });
    await safeSave();
    res.json({ ok: true, channelId, messageId });
});


app.post('/api/composer/load', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const link = String(req.body.messageLink || '').trim();
    const m = link.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) return res.status(400).json({ error: 'Invalid message link' });
    const requestId = newHubId();

    const timeoutMs = 28000;
    const resultPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
            composerLoadWaiters.delete(requestId);
            resolve({ status: 'error', error: 'Timeout waiting for bot. Is the bot online?' });
        }, timeoutMs);
        composerLoadWaiters.set(requestId, (payload) => {
            clearTimeout(timer);
            composerLoadWaiters.delete(requestId);
            resolve(payload);
        });
    });

    // Job only carries Discord IDs — bot imports live from Discord
    enqueueBotJob(data, 'discord_message_load', {
        requestId,
        channelId: m[2],
        messageId: m[3]
    });
    await safeSave();

    const result = await resultPromise;
    if (result.status === 'ok') {
        return res.json({ ok: true, status: 'ok', message: result.message });
    }
    return res.status(result.status === 'error' ? 504 : 400).json({
        ok: false,
        status: result.status || 'error',
        error: result.error || 'Load failed'
    });
});

app.post('/api/bot/composer-load-result', checkBotAuth, async (req, res) => {
    const requestId = String(req.body.requestId || '');
    const waiter = composerLoadWaiters.get(requestId);
    if (waiter) {
        if (req.body.error) {
            waiter({ status: 'error', error: String(req.body.error) });
        } else {
            waiter({ status: 'ok', message: req.body.message || null });
        }
    }
    // nothing stored
    res.json({ ok: true });
});




app.get('/api/blacklist', checkAuth, (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureBlacklist(data);
    res.json({ blacklist: data.blacklist || [] });
});

app.post('/api/blacklist', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureBlacklist(data);
    ensureLinkStores(data);
    let discordId = String(req.body.discordId || '').replace(/\D/g, '') || null;
    let robloxId = String(req.body.robloxId || '').replace(/\D/g, '') || null;
    let discordTag = String(req.body.discordTag || '').trim() || null;
    let robloxName = String(req.body.robloxName || req.body.robloxUsername || '').trim() || null;
    const note = String(req.body.note || '').trim().slice(0, 200) || null;

    // 1) Roblox username → id + canonical name
    if (robloxName && !robloxId) {
        try {
            const r = await axios.post('https://users.roblox.com/v1/usernames/users', {
                usernames: [robloxName],
                excludeBannedUsers: false
            }, { timeout: 10000 });
            const u = (r.data && r.data.data && r.data.data[0]) || null;
            if (!u || !u.id) return res.status(404).json({ error: 'Roblox username not found' });
            robloxId = String(u.id);
            robloxName = u.name || robloxName;
        } catch (e) {
            return res.status(502).json({ error: 'Roblox lookup failed: ' + (e.message || e) });
        }
    }

    // 2) Roblox id → username (if missing)
    if (robloxId && !robloxName) {
        try {
            const u = await axios.get('https://users.roblox.com/v1/users/' + robloxId, { timeout: 8000 });
            if (u.data && u.data.name) robloxName = u.data.name;
        } catch (_) {}
    }

    // 3) Fill gaps from Hub Discord links (either direction)
    if (discordId) {
        const link = (data.discordLinks || []).find(l => String(l.discordId) === discordId);
        if (link) {
            if (!robloxId) robloxId = String(link.robloxId);
            if (!robloxName) robloxName = link.robloxName || robloxName;
            if (!discordTag) discordTag = link.discordTag || discordTag;
        }
    }
    if (robloxId) {
        const link = (data.discordLinks || []).find(l => String(l.robloxId) === String(robloxId));
        if (link) {
            if (!discordId) discordId = String(link.discordId);
            if (!discordTag) discordTag = link.discordTag || discordTag;
            if (!robloxName) robloxName = link.robloxName || robloxName;
        }
    }
    // Match by discord tag if only tag given
    if (discordTag && !discordId) {
        const low = discordTag.toLowerCase();
        const link = (data.discordLinks || []).find(l =>
            String(l.discordTag || '').toLowerCase() === low ||
            String(l.discordTag || '').toLowerCase().replace(/#\d+$/, '') === low
        );
        if (link) {
            discordId = String(link.discordId);
            if (!robloxId) robloxId = String(link.robloxId);
            if (!robloxName) robloxName = link.robloxName || robloxName;
            discordTag = link.discordTag || discordTag;
        }
    }

    // 4) If we got robloxId from link but still no name
    if (robloxId && !robloxName) {
        try {
            const u = await axios.get('https://users.roblox.com/v1/users/' + robloxId, { timeout: 8000 });
            if (u.data && u.data.name) robloxName = u.data.name;
        } catch (_) {}
    }

    if (!discordId && !robloxId && !discordTag && !robloxName) {
        return res.status(400).json({ error: 'Need Discord ID/tag or Roblox ID/username' });
    }

    data.blacklist = data.blacklist.filter(e => {
        if (discordId && e.discordId && String(e.discordId) === discordId) return false;
        if (robloxId && e.robloxId && String(e.robloxId) === robloxId) return false;
        return true;
    });
    data.blacklist.push({
        id: newHubId(),
        discordId: discordId || null,
        discordTag: discordTag || null,
        robloxId: robloxId || null,
        robloxName: robloxName || null,
        note,
        createdAt: Date.now()
    });
    await safeSave();
    res.json({ ok: true, blacklist: data.blacklist });
});

app.delete('/api/blacklist/:id', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureBlacklist(data);
    const before = data.blacklist.length;
    data.blacklist = data.blacklist.filter(e => e.id !== req.params.id);
    await safeSave();
    res.json({ ok: true, removed: before - data.blacklist.length, blacklist: data.blacklist });
});

app.get('/blacklist', checkAuth, (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).send('Owner only');
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Blacklist — Whitelist Hub</title>
<style>
body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 30px; }
.container { max-width: 1200px; margin: 0 auto; }
.header { display: flex; flex-direction: row; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 15px; margin-bottom: 25px; gap: 16px; width: 100%; box-sizing: border-box; }
.header-left { flex: 1 1 auto; min-width: 0; }
.header-left h1 { margin: 0; font-size: 22px; }
.header-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; margin-left: auto; }
.btn-refresh, .hdr-btn {
  display: inline-block; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
  text-decoration: none; cursor: pointer; border: 1px solid #374151; background: #1f2937; color: #94a3b8;
}
.btn-refresh:hover, .hdr-btn:hover { background: #374151; color: #fff; }
.card { background: #111827; border: 1px solid #1e293b; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; gap: 10px; }
.card-header h3 { margin: 0; color: #e2e8f0; font-size: 16px; }
label { display: block; font-size: 12px; color: #94a3b8; margin: 10px 0 4px; }
input[type=text] { width: 100%; padding: 10px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: #fff; box-sizing: border-box; }
button.primary { background: #4f46e5; color: #fff; border: none; padding: 10px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; }
button.danger { background: #e11d48; color: #fff; border: none; padding: 8px 12px; border-radius: 6px; font-weight: bold; cursor: pointer; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 700px) { .grid2 { grid-template-columns: 1fr; } }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 10px 8px; border-bottom: 1px solid #1e293b; text-align: left; vertical-align: top; }
th { color: #94a3b8; background: #1f2937; }
code { font-size: 12px; color: #64748b; }
.hint { font-size: 12px; color: #64748b; line-height: 1.5; }
#msg { margin-left: 12px; font-size: 13px; color: #10b981; }
#msg.err { color: #f43f5e; }
</style></head><body>
<div class="container">
  <div class="header">
    <div class="header-left"><h1>🚫 Blacklist</h1></div>
    <div class="header-actions">
      <a href="/" class="btn-refresh">Dashboard</a>
      <a href="/users" class="btn-refresh">Users</a>
      <a href="/hub" class="btn-refresh">Hub</a>
      <a href="/inbox" class="btn-refresh">DM Inbox</a>
      <a href="/bot" class="btn-refresh">Bot</a>
      <a href="/composer" class="btn-refresh">Composer</a>
    </div>
  </div>
  <p class="hint" style="margin-top:-10px;margin-bottom:20px;">Blocked users cannot use Hub, purchase, Discord commands, or pass license verify. Add by Roblox username alone — linked Discord/Roblox IDs are filled automatically when known.</p>
  <div class="card">
    <div class="card-header"><h3>➕ Add entry</h3></div>
    <div class="grid2">
      <div><label>Roblox username (optional — resolves ID)</label><input type="text" id="rName" placeholder="e.g. Builderman"/></div>
      <div><label>Roblox ID (optional)</label><input type="text" id="rId" placeholder="123456789"/></div>
      <div><label>Discord ID (optional)</label><input type="text" id="dId" placeholder="123456789012345678"/></div>
      <div><label>Discord username (optional)</label><input type="text" id="dTag" placeholder="username"/></div>
    </div>
    <label>Note</label>
    <input type="text" id="note" placeholder="Reason…"/>
    <div style="margin-top:14px;display:flex;align-items:center;">
      <button type="button" class="primary" id="btnAdd">Add to blacklist</button>
      <span id="msg"></span>
    </div>
  </div>
  <div class="card">
    <div class="card-header">
      <h3>📋 Entries</h3>
      <button type="button" class="btn-refresh" id="btnRefresh">🔄 Refresh</button>
    </div>
    <table>
      <thead><tr><th>Discord</th><th>Roblox</th><th>Note</th><th style="width:90px;"></th></tr></thead>
      <tbody id="tbody"><tr><td colspan="4" class="hint">Loading…</td></tr></tbody>
    </table>
  </div>
</div>
<script>
async function load(){
  const tb = document.getElementById('tbody');
  try {
    const r = await fetch('/api/blacklist');
    const j = await r.json();
    const list = j.blacklist || [];
    if (!list.length) { tb.innerHTML = '<tr><td colspan="4" class="hint">No entries yet.</td></tr>'; return; }
    tb.innerHTML = list.map(e => '<tr>'+
      '<td><div>'+esc(e.discordTag||'—')+'</div><code>'+esc(e.discordId||'')+'</code></td>'+
      '<td><div>'+esc(e.robloxName||'—')+'</div><code>'+esc(e.robloxId||'')+'</code></td>'+
      '<td>'+esc(e.note||'—')+'</td>'+
      '<td><button type="button" class="danger" data-id="'+e.id+'">Remove</button></td></tr>').join('');
    tb.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
      if (!confirm('Remove?')) return;
      await fetch('/api/blacklist/'+encodeURIComponent(b.getAttribute('data-id')),{method:'DELETE'});
      load();
    });
  } catch(e){ tb.innerHTML = '<tr><td colspan="4" style="color:#f43f5e">Failed</td></tr>'; }
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
document.getElementById('btnRefresh').onclick = load;
document.getElementById('btnAdd').onclick = async () => {
  const msg = document.getElementById('msg');
  msg.className = ''; msg.textContent = 'Saving…';
  try {
    const r = await fetch('/api/blacklist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      discordId: dId.value, discordTag: dTag.value, robloxId: rId.value, robloxName: rName.value, note: note.value
    })});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error||'failed');
    msg.textContent = 'Added' + (j.blacklist && j.blacklist.length ? '' : '');
    dId.value=dTag.value=rId.value=rName.value=note.value='';
    load();
  } catch(e){ msg.className='err'; msg.textContent=e.message||e; }
};
load();
</script>
</body></html>`);
});

/** ---- Bot DM Inbox (live via bot jobs + waiters) ---- */
const inboxWaiters = new Map();
function waitInbox(requestId, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            inboxWaiters.delete(requestId);
            resolve({ status: 'error', error: 'Timeout — is the bot online?' });
        }, timeoutMs || 28000);
        inboxWaiters.set(requestId, (payload) => {
            clearTimeout(timer);
            inboxWaiters.delete(requestId);
            resolve(payload);
        });
    });
}

app.post('/api/bot/inbox-result', checkBotAuth, (req, res) => {
    const requestId = String(req.body.requestId || '');
    const waiter = inboxWaiters.get(requestId);
    if (waiter) {
        if (req.body.error) waiter({ status: 'error', error: String(req.body.error) });
        else waiter({ status: 'ok', ...(req.body.data || {}), data: req.body.data });
    }
    res.json({ ok: true });
});

app.post('/api/inbox/list', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const data = db.getData();
    ensureHubStores(data);
    const requestId = newHubId();
    enqueueBotJob(data, 'inbox_list', { requestId });
    await safeSave();
    const result = await waitInbox(requestId);
    if (result.status !== 'ok') return res.status(504).json(result);
    const fromBot = (result.data && result.data.channels) || result.channels || [];
    const seen = new Set(fromBot.map(c => String(c.userId)));
    // Also show linked Hub users so the list is never empty
    for (const l of (data.discordLinks || [])) {
        const uid = String(l.discordId || '');
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        fromBot.push({
            userId: uid,
            tag: l.discordTag || uid,
            username: l.discordTag || uid,
            robloxName: l.robloxName || null,
            robloxId: l.robloxId || null
        });
    }
    res.json({ ok: true, channels: fromBot });
});

app.post('/api/inbox/messages', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const userId = String(req.body.userId || '').replace(/\D/g, '');
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const data = db.getData();
    ensureHubStores(data);
    const requestId = newHubId();
    enqueueBotJob(data, 'inbox_messages', { requestId, userId, limit: Math.min(100, Number(req.body.limit) || 80) });
    await safeSave();
    const result = await waitInbox(requestId);
    if (result.status !== 'ok') return res.status(504).json(result);
    res.json({ ok: true, ...(result.data || result) });
});

app.post('/api/inbox/send', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const userId = String(req.body.userId || '').replace(/\D/g, '');
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const data = db.getData();
    ensureHubStores(data);
    const requestId = newHubId();
    const files = Array.isArray(req.body.files) ? req.body.files.slice(0, 8).map(f => ({
        name: String(f.name || 'file.bin').slice(0, 80),
        contentBase64: String(f.contentBase64 || '').slice(0, 12 * 1024 * 1024)
    })).filter(f => f.contentBase64) : [];
    enqueueBotJob(data, 'inbox_send', {
        requestId,
        userId,
        title: String(req.body.title || '').slice(0, 200),
        description: String(req.body.description || '').slice(0, 4000),
        color: req.body.color || null,
        replyTo: req.body.replyTo ? String(req.body.replyTo) : null,
        files
    });
    await safeSave();
    const result = await waitInbox(requestId);
    if (result.status !== 'ok') return res.status(504).json(result);
    res.json({ ok: true, ...(result.data || result) });
});

app.post('/api/inbox/delete', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const userId = String(req.body.userId || '').replace(/\D/g, '');
    const messageId = String(req.body.messageId || '').replace(/\D/g, '');
    if (!userId || !messageId) return res.status(400).json({ error: 'userId and messageId required' });
    const data = db.getData();
    ensureHubStores(data);
    const requestId = newHubId();
    enqueueBotJob(data, 'inbox_delete', { requestId, userId, messageId });
    await safeSave();
    const result = await waitInbox(requestId);
    if (result.status !== 'ok') return res.status(504).json(result);
    res.json({ ok: true });
});

app.post('/api/inbox/edit', checkAuth, async (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
    const userId = String(req.body.userId || '').replace(/\D/g, '');
    const messageId = String(req.body.messageId || '').replace(/\D/g, '');
    if (!userId || !messageId) return res.status(400).json({ error: 'userId and messageId required' });
    const data = db.getData();
    ensureHubStores(data);
    const requestId = newHubId();
    enqueueBotJob(data, 'inbox_edit', {
        requestId,
        userId,
        messageId,
        content: String(req.body.content || '').slice(0, 2000),
        title: String(req.body.title || '').slice(0, 200),
        description: String(req.body.description || '').slice(0, 4000),
        color: req.body.color || null
    });
    await safeSave();
    const result = await waitInbox(requestId);
    if (result.status !== 'ok') return res.status(504).json(result);
    res.json({ ok: true, ...(result.data || result) });
});

app.get('/inbox', checkAuth, (req, res) => {
    if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).send('Owner only');
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>DM Inbox — Whitelist Hub</title>
<style>
body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 20px 30px; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; }
.header { display: flex; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 12px; margin-bottom: 12px; gap: 12px; }
.header h1 { margin: 0; font-size: 20px; flex: 1; color: #67e8f9; }
.header-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn-refresh {
  display: inline-block; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
  text-decoration: none; cursor: pointer; border: 1px solid #374151; background: #1f2937; color: #94a3b8;
}
.btn-refresh:hover { background: #374151; color: #fff; }
.layout { display: grid; grid-template-columns: 300px 1fr; gap: 12px; flex: 1; min-height: 0; }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }
.panel { background: #111827; border: 1px solid #1e293b; border-radius: 10px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.panel-h { padding: 12px 14px; border-bottom: 1px solid #1e293b; font-weight: 600; font-size: 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.panel-h input { flex: 1; min-width: 100px; padding: 8px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: #fff; font-size: 12px; }
.list { overflow-y: auto; flex: 1; }
.item { padding: 12px 14px; border-bottom: 1px solid #1e293b; cursor: pointer; }
.item:hover, .item.active { background: #1e293b; }
.item .name { font-weight: 600; font-size: 13px; }
.item .id { font-size: 11px; color: #64748b; }
.chat { display: flex; flex-direction: column; min-height: 0; }
.msgs { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.bubble { max-width: 88%; padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.45; position: relative; }
.bubble.them { background: #1f2937; align-self: flex-start; border: 1px solid #374151; }
.bubble.me { background: #312e81; align-self: flex-end; border: 1px solid #4338ca; }
.bubble .meta { font-size: 10px; color: #94a3b8; margin-bottom: 4px; }
.bubble .emb { margin-top: 6px; padding: 8px; border-left: 3px solid #5865f2; background: #0f172a; border-radius: 4px; }
.bubble .emb img { max-width: 100%; max-height: 280px; border-radius: 4px; margin-top: 6px; }
.bubble .att { margin-top: 6px; padding: 8px; background: #0f172a; border-radius: 6px; border: 1px solid #334155; }
.bubble .att a { color: #38bdf8; }
.bubble .att img { max-width: 100%; max-height: 280px; border-radius: 4px; }
.bubble .acts { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.bubble .acts button { font-size: 11px; padding: 4px 8px; border-radius: 4px; border: none; cursor: pointer; background: #374151; color: #e2e8f0; }
.bubble .acts button.danger { background: #9f1239; }
.composer { border-top: 1px solid #1e293b; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.composer input, .composer textarea { width: 100%; box-sizing: border-box; padding: 10px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: #fff; font-family: inherit; font-size: 13px; }
.composer textarea { min-height: 64px; resize: vertical; }
.composer .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
button.primary { background: #4f46e5; color: #fff; border: none; padding: 10px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; }
button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.reply-bar { font-size: 12px; color: #94a3b8; background: #1e293b; padding: 6px 10px; border-radius: 6px; display: none; justify-content: space-between; align-items: center; }
.reply-bar.show { display: flex; }
.empty { color: #64748b; text-align: center; padding: 40px 20px; font-size: 13px; }
.status { font-size: 12px; color: #64748b; margin-left: auto; }
.file-chips { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #94a3b8; }
.file-chips span { background: #1e293b; padding: 4px 8px; border-radius: 4px; }
</style></head><body>
  <div class="header">
    <h1>💬 Bot DM Inbox</h1>
    <div class="header-actions">
      <a href="/" class="btn-refresh">Dashboard</a>
      <a href="/blacklist" class="btn-refresh">Blacklist</a>
      <a href="/bot" class="btn-refresh">Bot</a>
      <a href="/composer" class="btn-refresh">Composer</a>
    </div>
  </div>
  <div class="layout">
    <div class="panel">
      <div class="panel-h">
        <input id="openId" placeholder="Open by Discord user ID"/>
        <button type="button" class="btn-refresh" id="btnOpen">Open</button>
      </div>
      <div class="panel-h" style="border-bottom:none;padding-top:0;">
        <button type="button" class="btn-refresh" id="btnList" style="width:100%">🔄 Refresh chats</button>
      </div>
      <div class="list" id="list"><div class="empty">Loading chats…</div></div>
    </div>
    <div class="panel chat">
      <div class="panel-h"><span id="chatTitle">Select a conversation</span><span class="status" id="chatStatus"></span></div>
      <div class="msgs" id="msgs"><div class="empty">No conversation selected</div></div>
      <div class="composer">
        <div class="reply-bar" id="replyBar"><span id="replyText"></span><button type="button" class="btn-refresh" id="btnCancelReply">Cancel</button></div>
        <input id="embTitle" placeholder="Embed title"/>
        <textarea id="embDesc" placeholder="Embed description…"></textarea>
        <div class="row">
          <input id="embColor" type="text" placeholder="#5865F2" style="width:110px"/>
          <input type="file" id="fileInput" multiple accept="*/*" style="font-size:12px;color:#94a3b8"/>
          <button type="button" class="primary" id="btnEditSave" style="display:none">Save edit</button>
          <button type="button" class="primary" id="btnSend" disabled>Send embed</button>
        </div>
        <div class="file-chips" id="fileChips"></div>
      </div>
    </div>
  </div>
<script>
let currentUserId = null, replyTo = null, editId = null, botId = null;
let pollTimer = null, pollBusy = false, pendingFiles = [];
let lastMsgSig = '';

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
async function post(url, body){
  const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(j.error || j.message || ('HTTP '+r.status));
  return j;
}
function readFileAsB64(file){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      resolve({ name: file.name, contentBase64: i >= 0 ? s.slice(i+1) : s });
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
function renderFileChips(){
  const box = document.getElementById('fileChips');
  box.innerHTML = pendingFiles.map((f,i) =>
    '<span>'+esc(f.name)+' <a href="#" data-rm="'+i+'" style="color:#f43f5e">×</a></span>').join('');
  box.querySelectorAll('[data-rm]').forEach(a => {
    a.onclick = (ev) => {
      ev.preventDefault();
      pendingFiles.splice(+a.getAttribute('data-rm'), 1);
      renderFileChips();
    };
  });
}
document.getElementById('fileInput').onchange = async (e) => {
  const files = [...(e.target.files || [])];
  for (const f of files) {
    if (f.size > 8 * 1024 * 1024) { alert(f.name + ' too large (max 8MB)'); continue; }
    pendingFiles.push(await readFileAsB64(f));
  }
  renderFileChips();
  e.target.value = '';
};

async function loadList(){
  const list = document.getElementById('list');
  const prev = currentUserId;
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const j = await post('/api/inbox/list', {});
    const ch = j.channels || [];
    if (!ch.length) { list.innerHTML = '<div class="empty">No chats yet. Open by user ID or link users in Hub.</div>'; return; }
    list.innerHTML = ch.map(c => '<div class="item'+(c.userId===prev?' active':'')+'" data-uid="'+c.userId+'">'+
      '<div class="name">'+esc(c.tag||c.username||'User')+'</div>'+
      '<div class="id">'+esc(c.userId)+(c.robloxName ? (' · '+esc(c.robloxName)) : '')+'</div></div>').join('');
    list.querySelectorAll('.item').forEach(el => el.onclick = () => openChat(el.getAttribute('data-uid'), el.querySelector('.name').textContent));
  } catch(e){ list.innerHTML = '<div class="empty" style="color:#f43f5e">'+esc(e.message)+'</div>'; }
}

function msgSignature(messages){
  return (messages || []).map(m => m.id + ':' + (m.editedAt||'') + ':' + (m.content||'').length).join('|');
}

function renderMsgs(messages){
  const box = document.getElementById('msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  if (!messages.length) { box.innerHTML = '<div class="empty">No messages yet</div>'; return; }
  box.innerHTML = messages.map(m => {
    const mine = botId && m.authorId === botId;
    let body = '';
    if (m.content) body += '<div>'+esc(m.content)+'</div>';
    (m.embeds||[]).forEach(e => {
      body += '<div class="emb"><b>'+esc(e.title||'')+'</b><div>'+esc(e.description||'')+'</div>';
      if (e.image && e.image.url) body += '<img src="'+esc(e.image.url)+'" alt=""/>';
      body += '</div>';
    });
    (m.attachments||[]).forEach(a => {
      const isImg = (a.contentType||'').startsWith('image/') || /\\.(png|jpe?g|gif|webp)$/i.test(a.name||'');
      body += '<div class="att">';
      if (isImg && a.url) body += '<a href="'+esc(a.url)+'" target="_blank"><img src="'+esc(a.proxyURL||a.url)+'" alt="'+esc(a.name)+'"/></a>';
      else body += '<a href="'+esc(a.url)+'" target="_blank" rel="noopener">'+esc(a.name||'file')+' — Download</a>';
      body += '</div>';
    });
    if (!body) body = '<i style="color:#64748b">(empty)</i>';
    return '<div class="bubble '+(mine?'me':'them')+'">'+
      '<div class="meta">'+esc(m.authorTag||m.authorId)+' · '+esc(m.createdAt ? new Date(m.createdAt).toLocaleString() : '')+(m.editedAt?' · edited':'')+'</div>'+
      body+
      '<div class="acts"><button type="button" data-reply="'+m.id+'">Reply</button>'+
      (mine?'<button type="button" data-edit="'+m.id+'">Edit</button><button type="button" class="danger" data-del="'+m.id+'">Delete</button>':'')+
      '</div></div>';
  }).join('');
  if (nearBottom) box.scrollTop = box.scrollHeight;
  box.querySelectorAll('[data-reply]').forEach(b => b.onclick = () => {
    replyTo = b.getAttribute('data-reply'); editId = null;
    document.getElementById('replyText').textContent = 'Replying to '+replyTo;
    document.getElementById('replyBar').classList.add('show');
    document.getElementById('btnEditSave').style.display = 'none';
    document.getElementById('btnSend').style.display = '';
  });
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const mid = b.getAttribute('data-edit');
    const m = messages.find(x => x.id === mid);
    editId = mid; replyTo = null;
    document.getElementById('replyBar').classList.remove('show');
    document.getElementById('embTitle').value = (m && m.embeds && m.embeds[0] && m.embeds[0].title) || '';
    document.getElementById('embDesc').value = (m && m.embeds && m.embeds[0] && m.embeds[0].description) || (m && m.content) || '';
    document.getElementById('btnEditSave').style.display = '';
    document.getElementById('btnSend').style.display = 'none';
  });
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete?')) return;
    try { await post('/api/inbox/delete',{userId:currentUserId,messageId:b.getAttribute('data-del')}); await refreshMessages(false); }
    catch(e){ alert(e.message); }
  });
}

async function refreshMessages(forceRender){
  if (!currentUserId || pollBusy) return;
  pollBusy = true;
  try {
    const j = await post('/api/inbox/messages', { userId: currentUserId, limit: 80 });
    botId = j.botId || botId;
    const messages = j.messages || [];
    const sig = msgSignature(messages);
    if (forceRender || sig !== lastMsgSig) {
      lastMsgSig = sig;
      renderMsgs(messages);
    }
    const st = document.getElementById('chatStatus');
    if (st) st.textContent = messages.length + ' msgs';
  } catch (e) {
    // silent fail on background poll — do not clear the chat
    if (forceRender) {
      document.getElementById('msgs').innerHTML = '<div class="empty" style="color:#f43f5e">'+esc(e.message)+'</div>';
    }
  } finally {
    pollBusy = false;
  }
}

async function openChat(uid, title){
  currentUserId = uid;
  replyTo = null; editId = null; lastMsgSig = '';
  document.getElementById('replyBar').classList.remove('show');
  document.getElementById('btnEditSave').style.display = 'none';
  document.getElementById('btnSend').style.display = '';
  document.getElementById('chatTitle').textContent = (title||'User') + ' · ' + uid;
  document.getElementById('btnSend').disabled = false;
  document.getElementById('chatStatus').textContent = 'Loading…';
  document.querySelectorAll('.item').forEach(el => el.classList.toggle('active', el.getAttribute('data-uid')===uid));
  await refreshMessages(true);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => refreshMessages(false), 12000);
}

document.getElementById('btnCancelReply').onclick = () => { replyTo=null; document.getElementById('replyBar').classList.remove('show'); };
document.getElementById('btnList').onclick = loadList;
document.getElementById('btnOpen').onclick = () => {
  const id = document.getElementById('openId').value.replace(/\\D/g,'');
  if (!id) return alert('Enter Discord user ID');
  openChat(id, 'User');
};
document.getElementById('btnSend').onclick = async () => {
  if (!currentUserId) return;
  const title = document.getElementById('embTitle').value.trim();
  const description = document.getElementById('embDesc').value.trim();
  if (!title && !description && !pendingFiles.length) return alert('Write title/description or attach files');
  document.getElementById('btnSend').disabled = true;
  try {
    await post('/api/inbox/send', {
      userId: currentUserId,
      title, description,
      color: document.getElementById('embColor').value.trim() || null,
      replyTo,
      files: pendingFiles
    });
    document.getElementById('embTitle').value = '';
    document.getElementById('embDesc').value = '';
    pendingFiles = [];
    renderFileChips();
    replyTo = null;
    document.getElementById('replyBar').classList.remove('show');
    lastMsgSig = '';
    await refreshMessages(true);
  } catch(e){ alert(e.message); }
  document.getElementById('btnSend').disabled = false;
};
document.getElementById('btnEditSave').onclick = async () => {
  if (!currentUserId || !editId) return;
  try {
    await post('/api/inbox/edit', {
      userId: currentUserId, messageId: editId,
      title: document.getElementById('embTitle').value.trim(),
      description: document.getElementById('embDesc').value.trim(),
      color: document.getElementById('embColor').value.trim() || null
    });
    editId = null;
    document.getElementById('embTitle').value = '';
    document.getElementById('embDesc').value = '';
    document.getElementById('btnEditSave').style.display = 'none';
    document.getElementById('btnSend').style.display = '';
    lastMsgSig = '';
    await refreshMessages(true);
  } catch(e){ alert(e.message); }
};
loadList();
</script></script>
</body></html>`);
});

app.listen(PORT, () => {});
