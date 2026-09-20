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

    // Axios may already parse JSON; if not, parse string
    if (typeof payload === 'string') {
        const trimmed = payload.trim();
        if (!trimmed) return null;
        try {
            payload = JSON.parse(trimmed);
        } catch (e) {
            console.error('parseIncoming: first JSON.parse failed', e.message);
            return null;
        }
    }

    if (!payload || typeof payload !== 'object') return null;

    // Wrapper forms used by some GAS scripts
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

    // Still a string after unwrap?
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

async function loadData() {
    try {
        const res = await axios.get(GOOGLE_SHEET_URL, {
            timeout: 20000,
            // Force text so we always control JSON parsing (GAS content-type is inconsistent)
            transformResponse: [(body) => body],
            headers: { Accept: 'application/json, text/plain, */*' }
        });

        const incoming = parseIncoming(res.data);
        if (!incoming) {
            lastLoadOk = false;
            lastLoadError = 'Could not parse Google Sheets response (invalid JSON or missing whitelist)';
            console.error('loadData:', lastLoadError, 'raw type:', typeof res.data,
                typeof res.data === 'string' ? res.data.slice(0, 120) : '');
            return false;
        }

        ensureStructure(incoming);

        // Never replace healthy local data with an empty remote payload
        if (!hasMeaningfulData(incoming) && hasMeaningfulData(data)) {
            lastLoadOk = false;
            lastLoadError = 'Remote data is empty — kept local data';
            console.warn('loadData: refused to overwrite local data with empty remote payload');
            return false;
        }

        data = incoming;
        lastLoadOk = true;
        lastLoadError = null;
        lastLoadAt = Date.now();
        console.log('loadData OK — creators:', data.whitelist.creators.length,
            'places:', data.whitelist.places.length, 'keys:', data.keys.length);
        return true;
    } catch (e) {
        lastLoadOk = false;
        lastLoadError = e.message || String(e);
        console.error('loadData error:', lastLoadError);
        return false;
    }
}

async function save() {
    try {
        ensureStructure(data);
        const payload = {
            action: 'update',
            data: JSON.stringify(data)
        };
        const res = await axios.post(GOOGLE_SHEET_URL, payload, {
            timeout: 25000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('save OK');
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

// Auto-sync from Google Sheets every 60s (less aggressive; less race with saves)
setInterval(() => {
    loadData().catch(() => {});
}, 60000);

// Initial load
loadData().catch(() => {});

module.exports = {
    getData: () => data,
    save,
    loadData,
    checkExpiration,
    getLoadStatus: () => ({ lastLoadOk, lastLoadError, lastLoadAt })
};
