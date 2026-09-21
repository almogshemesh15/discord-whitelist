const axios = require('axios');
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbzlYXcPdq5BtPttfrHBC290DK6tzS69fdc95GKwDD8cSbsiZzmkD-rVogxuUeia0HeL/exec';

let data = {
    whitelist: { creators: [], places: [] },
    pendingPlaces: [],
    keys: [],
    activeSessions: [],
    logs: [],
    stats: { total: 0, allowed: 0, denied: 0, byKey: {}, byPlace: {}, recent: [] },
    maintenanceMode: false,
    panelMessages: {},
    customPanelMessages: []
};

let lastLoadOk = false;
let lastLoadError = null;
let lastLoadAt = null;
let consecutiveFailures = 0;
let loadInFlight = false;
let lastLoggedOkAt = 0;

// How often to pull from Google (ms). GAS is slow/flaky — don't hammer it.
const LOAD_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const LOAD_TIMEOUT_MS = 45000;
// After failures, wait longer before trying again
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

function ensureStructure(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (!obj.whitelist || typeof obj.whitelist !== 'object') {
        obj.whitelist = { creators: [], places: [] };
    }
    if (!Array.isArray(obj.whitelist.creators)) obj.whitelist.creators = [];
    if (!Array.isArray(obj.whitelist.places)) obj.whitelist.places = [];
    if (!Array.isArray(obj.pendingPlaces)) obj.pendingPlaces = [];
    if (!Array.isArray(obj.keys)) obj.keys = [];
    if (!Array.isArray(obj.activeSessions)) obj.activeSessions = [];
    if (!Array.isArray(obj.logs)) obj.logs = [];
    if (!obj.stats || typeof obj.stats !== 'object') {
        obj.stats = { total: 0, allowed: 0, denied: 0, byKey: {}, byPlace: {}, recent: [] };
    }
    if (!obj.stats.byKey) obj.stats.byKey = {};
    if (!obj.stats.byPlace) obj.stats.byPlace = {};
    if (!Array.isArray(obj.stats.recent)) obj.stats.recent = [];
    if (typeof obj.maintenanceMode !== 'boolean') obj.maintenanceMode = false;
    if (!obj.panelMessages || typeof obj.panelMessages !== 'object') obj.panelMessages = {};
    if (!Array.isArray(obj.customPanelMessages)) obj.customPanelMessages = [];
    return true;
}

/** Google Apps Script often returns a JSON string, double-encoded JSON, or { data: "..." } */
function parseIncoming(raw) {
    let payload = raw;

    if (typeof payload === 'string') {
        const trimmed = payload.trim();
        if (!trimmed) return null;
        // HTML error page from GAS
        if (trimmed.startsWith('<!') || trimmed.startsWith('<html')) return null;
        try {
            payload = JSON.parse(trimmed);
        } catch (e) {
            return null;
        }
    }

    if (!payload || typeof payload !== 'object') return null;

    if (typeof payload.data === 'string') {
        try {
            const inner = JSON.parse(payload.data);
            if (inner && typeof inner === 'object') payload = inner;
        } catch (_) {}
    } else if (payload.data && typeof payload.data === 'object' && payload.data.whitelist) {
        payload = payload.data;
    } else if (payload.result && typeof payload.result === 'object' && payload.result.whitelist) {
        payload = payload.result;
    }

    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (_) {
            return null;
        }
    }

    if (!payload || typeof payload !== 'object') return null;
    if (!payload.whitelist) return null;
    return payload;
}

function hasMeaningfulData(obj) {
    if (!obj || !obj.whitelist) return false;
    const c = (obj.whitelist.creators && obj.whitelist.creators.length) || 0;
    const p = (obj.whitelist.places && obj.whitelist.places.length) || 0;
    const k = (obj.keys && obj.keys.length) || 0;
    return c + p + k > 0;
}

function backoffMs() {
    if (consecutiveFailures <= 0) return 0;
    const ms = BACKOFF_BASE_MS * Math.pow(2, Math.min(consecutiveFailures - 1, 4));
    return Math.min(ms, BACKOFF_MAX_MS);
}

async function loadData(force) {
    if (loadInFlight) return false;
    if (!force && consecutiveFailures > 0) {
        const wait = backoffMs();
        if (lastLoadAt && Date.now() - lastLoadAt < wait) {
            return false; // still in backoff — keep local data, stay quiet
        }
    }

    loadInFlight = true;
    try {
        const res = await axios.get(GOOGLE_SHEET_URL, {
            timeout: LOAD_TIMEOUT_MS,
            maxRedirects: 5,
            transformResponse: [(body) => body],
            headers: {
                Accept: 'application/json, text/plain, */*',
                'Cache-Control': 'no-cache'
            },
            // Treat 404/5xx as error without throwing weird shapes
            validateStatus: (s) => s >= 200 && s < 300
        });

        const incoming = parseIncoming(res.data);
        if (!incoming) {
            consecutiveFailures++;
            lastLoadOk = false;
            lastLoadError = 'Invalid / empty Google Sheets response';
            // Only log every few failures to avoid spam
            if (consecutiveFailures <= 2 || consecutiveFailures % 5 === 0) {
                console.warn('loadData: bad response (kept local data). failures=', consecutiveFailures);
            }
            return false;
        }

        ensureStructure(incoming);

        if (!hasMeaningfulData(incoming) && hasMeaningfulData(data)) {
            consecutiveFailures++;
            lastLoadOk = false;
            lastLoadError = 'Remote empty — kept local data';
            if (consecutiveFailures <= 2) {
                console.warn('loadData: refused empty remote payload');
            }
            return false;
        }

        data = incoming;
        lastLoadOk = true;
        lastLoadError = null;
        lastLoadAt = Date.now();
        const wasFailing = consecutiveFailures > 0;
        consecutiveFailures = 0;

        // Log OK only on recovery or at most once per 10 minutes
        if (wasFailing || Date.now() - lastLoggedOkAt > 10 * 60 * 1000) {
            console.log(
                'loadData OK — creators:', data.whitelist.creators.length,
                'places:', data.whitelist.places.length,
                'keys:', data.keys.length
            );
            lastLoggedOkAt = Date.now();
        }
        return true;
    } catch (e) {
        consecutiveFailures++;
        lastLoadOk = false;
        const status = e.response && e.response.status;
        const code = e.code;
        lastLoadError = status
            ? `HTTP ${status}`
            : (e.message || String(e));

        // Quiet spam: log first 2 failures, then every 5th
        if (consecutiveFailures <= 2 || consecutiveFailures % 5 === 0) {
            if (code === 'ECONNABORTED' || /timeout/i.test(lastLoadError)) {
                console.warn('loadData: Google timeout (kept local). failures=', consecutiveFailures);
            } else if (status === 404) {
                console.warn('loadData: Google 404 — check Apps Script deploy URL. failures=', consecutiveFailures);
            } else {
                console.warn('loadData error:', lastLoadError, 'failures=', consecutiveFailures);
            }
        }
        return false;
    } finally {
        loadInFlight = false;
        if (!lastLoadAt) lastLoadAt = Date.now();
    }
}

async function save() {
    try {
        ensureStructure(data);
        const payload = {
            action: 'update',
            data: JSON.stringify(data)
        };
        await axios.post(GOOGLE_SHEET_URL, payload, {
            timeout: 45000,
            maxRedirects: 5,
            headers: { 'Content-Type': 'application/json' }
        });
        return true;
    } catch (e) {
        console.error('save error:', e.message || e);
        return false;
    }
}

function checkExpiration() {
    const now = Date.now();
    let changed = false;

    ['creators', 'places'].forEach(type => {
        if (!data.whitelist[type]) return;
        data.whitelist[type].forEach(item => {
            if (item.keys && Array.isArray(item.keys)) {
                const initialLength = item.keys.length;
                item.keys = item.keys.filter(k => !k.expiresAt || k.expiresAt > now);
                if (item.keys.length !== initialLength) changed = true;
            }
            if (item.expiresAt && item.expiresAt <= now) {
                item.expiresAt = null;
                changed = true;
            }
        });
    });

    if (changed) save().catch(() => {});
}

// Periodic sync — slow on purpose (GAS is unreliable under load)
setInterval(() => {
    loadData(false).catch(() => {});
}, LOAD_INTERVAL_MS);

// Initial load
loadData(true).catch(() => {});

module.exports = {
    getData: () => data,
    save,
    loadData,
    checkExpiration,
    getLoadStatus: () => ({
        lastLoadOk,
        lastLoadError,
        lastLoadAt,
        consecutiveFailures,
        backoffMs: backoffMs()
    })
};
