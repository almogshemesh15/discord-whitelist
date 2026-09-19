const axios = require('axios');
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbzlYXcPdq5BtPttfrHBC290DK6tzS69fdc95GKwDD8cSbsiZzmkD-rVogxuUeia0HeL/exec';

let data = {
    whitelist: { creators: [], places: [] },
    pendingPlaces: [],
    keys: [],
    activeSessions: [],
    logs: []
};

function ensureStructure(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (!obj.whitelist || typeof obj.whitelist !== 'object') return false;
    if (!Array.isArray(obj.whitelist.creators)) obj.whitelist.creators = [];
    if (!Array.isArray(obj.whitelist.places)) obj.whitelist.places = [];
    if (!Array.isArray(obj.pendingPlaces)) obj.pendingPlaces = [];
    if (!Array.isArray(obj.keys)) obj.keys = [];
    if (!Array.isArray(obj.activeSessions)) obj.activeSessions = [];
    if (!Array.isArray(obj.logs)) obj.logs = [];
    return true;
}

async function loadData() {
    try {
        const res = await axios.get(GOOGLE_SHEET_URL, { timeout: 15000 });
        // Only accept a valid payload that has the expected shape — never wipe local data with empty/garbage response
        if (res.data && typeof res.data === 'object' && res.data.whitelist) {
            const incoming = JSON.parse(JSON.stringify(res.data));
            if (ensureStructure(incoming)) {
                data = incoming;
            }
        }
    } catch (e) {
        console.error('loadData error:', e.message || e);
    }
}

async function save() {
    try {
        ensureStructure(data);
        await axios.post(GOOGLE_SHEET_URL, {
            action: 'update',
            data: JSON.stringify(data)
        }, { timeout: 20000 });
    } catch (e) {
        console.error('save error:', e.message || e);
    }
}

function checkExpiration() {
    const now = Date.now();
    let changed = false;

    ['creators', 'places'].forEach(type => {
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

    if (changed) save();
}

// Auto-sync from Google Sheets every 30s (only overwrites if response is valid)
setInterval(loadData, 30000);
loadData();

module.exports = {
    getData: () => data,
    save,
    loadData,
    checkExpiration
};
