const { Pool } = require('pg');
const axios = require('axios');

const DATABASE_URL = process.env.DATABASE_URL || '';
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || '';

let pool = null;

let data = defaultData();
let lastLoadOk = false;
let lastLoadError = null;
let lastLoadAt = null;
let saveInFlight = false;
let saveQueued = false;
let readyPromise = null;

function defaultData() {
    return {
        whitelist: { creators: [], places: [] },
        pendingPlaces: [],
        keys: [],
        activeSessions: [],
        logs: [],
        stats: { total: 0, allowed: 0, denied: 0, byKey: {}, byPlace: {}, recent: [] },
        maintenanceMode: false,
        panelMessages: {},
        customPanelMessages: [],
        userPanelLang: {}
    };
}

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
    if (!obj.userPanelLang || typeof obj.userPanelLang !== 'object') obj.userPanelLang = {};
    return true;
}

function hasMeaningfulData(obj) {
    if (!obj || !obj.whitelist) return false;
    const c = (obj.whitelist.creators && obj.whitelist.creators.length) || 0;
    const p = (obj.whitelist.places && obj.whitelist.places.length) || 0;
    const k = (obj.keys && obj.keys.length) || 0;
    return c + p + k > 0;
}

function getPool() {
    if (!DATABASE_URL) return null;
    if (!pool) {
        pool = new Pool({
            connectionString: DATABASE_URL,
            ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
            max: 3,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 15000
        });
        pool.on('error', (err) => {
            console.error('[DB] pool error:', err.message || err);
        });
    }
    return pool;
}

async function ensureTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
}

async function importFromGoogleSheets() {
    if (!GOOGLE_SHEET_URL) return null;
    try {
        console.log('[DB] Importing from Google Sheets (one-time)...');
        const res = await axios.get(GOOGLE_SHEET_URL, {
            timeout: 45000,
            transformResponse: [(body) => body],
            headers: { Accept: 'application/json, text/plain, */*' }
        });
        let payload = res.data;
        if (typeof payload === 'string') {
            payload = JSON.parse(payload.trim());
        }
        if (payload && typeof payload.data === 'string') {
            try { payload = JSON.parse(payload.data); } catch (_) {}
        } else if (payload && payload.data && payload.data.whitelist) {
            payload = payload.data;
        }
        if (payload && payload.whitelist && hasMeaningfulData(payload)) {
            ensureStructure(payload);
            console.log('[DB] Sheets import OK — creators:', payload.whitelist.creators.length,
                'places:', payload.whitelist.places.length, 'keys:', payload.keys.length);
            return payload;
        }
        console.warn('[DB] Sheets import: no meaningful data');
        return null;
    } catch (e) {
        console.error('[DB] Sheets import failed:', e.message || e);
        return null;
    }
}

async function init() {
    if (!DATABASE_URL) {
        lastLoadOk = false;
        lastLoadError = 'DATABASE_URL not set — data only in memory (will reset on restart!)';
        console.error('[DB]', lastLoadError);
        return false;
    }

    const p = getPool();
    const client = await p.connect();
    try {
        await ensureTable(client);
        const result = await client.query('SELECT data FROM app_state WHERE id = 1');
        if (result.rows.length === 0) {
            // Empty DB — try import from Sheets once, else seed default
            let seed = await importFromGoogleSheets();
            if (!seed) seed = defaultData();
            ensureStructure(seed);
            await client.query(
                `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW())
                 ON CONFLICT (id) DO NOTHING`,
                [JSON.stringify(seed)]
            );
            data = seed;
            console.log('[DB] Seeded app_state row');
        } else {
            const row = result.rows[0].data;
            const incoming = typeof row === 'string' ? JSON.parse(row) : row;
            ensureStructure(incoming);
            data = incoming;
            console.log('[DB] Loaded — creators:', data.whitelist.creators.length,
                'places:', data.whitelist.places.length, 'keys:', (data.keys || []).length);
        }
        lastLoadOk = true;
        lastLoadError = null;
        lastLoadAt = Date.now();
        return true;
    } catch (e) {
        lastLoadOk = false;
        lastLoadError = e.message || String(e);
        console.error('[DB] init failed:', lastLoadError);
        return false;
    } finally {
        client.release();
    }
}

async function loadData() {
    if (!DATABASE_URL) return false;
    try {
        const p = getPool();
        const result = await p.query('SELECT data FROM app_state WHERE id = 1');
        if (!result.rows.length) {
            lastLoadOk = false;
            lastLoadError = 'No app_state row';
            return false;
        }
        const row = result.rows[0].data;
        const incoming = typeof row === 'string' ? JSON.parse(row) : row;
        ensureStructure(incoming);

        // Never replace healthy memory with empty DB (shouldn't happen, but safe)
        if (!hasMeaningfulData(incoming) && hasMeaningfulData(data)) {
            lastLoadOk = false;
            lastLoadError = 'DB payload empty — kept memory';
            console.warn('[DB] refused empty load');
            return false;
        }

        data = incoming;
        lastLoadOk = true;
        lastLoadError = null;
        lastLoadAt = Date.now();
        return true;
    } catch (e) {
        lastLoadOk = false;
        lastLoadError = e.message || String(e);
        console.error('[DB] loadData error:', lastLoadError);
        return false;
    }
}

async function persist() {
    if (!DATABASE_URL) {
        console.error('[DB] save skipped — no DATABASE_URL');
        return false;
    }
    ensureStructure(data);
    const p = getPool();
    await p.query(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data, updated_at = NOW()`,
        [JSON.stringify(data)]
    );
    lastLoadAt = Date.now();
    lastLoadOk = true;
    lastLoadError = null;
    return true;
}

async function save() {
    if (saveInFlight) {
        saveQueued = true;
        return;
    }
    saveInFlight = true;
    try {
        await persist();
        // quiet success — uncomment if you want spam: console.log('[DB] save OK');
    } catch (e) {
        console.error('[DB] save error:', e.message || e);
        lastLoadError = e.message || String(e);
        lastLoadOk = false;
    } finally {
        saveInFlight = false;
    }
    if (saveQueued) {
        saveQueued = false;
        await save();
    }
}

function checkExpiration() {
    const now = Date.now();
    let changed = false;

    ['creators', 'places'].forEach((type) => {
        if (!data.whitelist[type]) return;
        data.whitelist[type].forEach((item) => {
            if (item.keys && Array.isArray(item.keys)) {
                const initialLength = item.keys.length;
                item.keys = item.keys.filter((k) => !k.expiresAt || k.expiresAt > now);
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

// Boot
readyPromise = init().catch((e) => {
    console.error('[DB] boot error:', e.message || e);
});

module.exports = {
    getData: () => data,
    save,
    loadData,
    checkExpiration,
    getLoadStatus: () => ({
        lastLoadOk,
        lastLoadError,
        lastLoadAt,
        hasDatabaseUrl: !!DATABASE_URL,
        engine: 'postgres'
    }),
    /** Wait until first DB init finished (optional use in index) */
    ready: () => readyPromise
};
