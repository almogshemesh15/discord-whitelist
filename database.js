const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');

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
        userPanelLang: {},
        botConfig: null,
        discordLinks: [],
        pendingLinkCodes: {},
        hubProducts: [],
        hubOwnerships: [],
        pendingBotJobs: []
    };
}

function ensureStructure(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (!obj.whitelist || typeof obj.whitelist !== 'object') obj.whitelist = { creators: [], places: [] };
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
    if (!Array.isArray(obj.discordLinks)) obj.discordLinks = [];
    if (!obj.pendingLinkCodes || typeof obj.pendingLinkCodes !== 'object') obj.pendingLinkCodes = {};
    if (!Array.isArray(obj.hubProducts)) obj.hubProducts = [];
    if (!Array.isArray(obj.hubOwnerships)) obj.hubOwnerships = [];
    if (!Array.isArray(obj.pendingBotJobs)) obj.pendingBotJobs = [];
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
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 15000
        });
        pool.on('error', (err) => console.error('[DB] pool error:', err.message || err));
    }
    return pool;
}

async function ensureTables(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS discord_links (
            discord_id TEXT PRIMARY KEY,
            discord_tag TEXT,
            roblox_id TEXT NOT NULL,
            roblox_name TEXT,
            meta JSONB NOT NULL DEFAULT '{}'::jsonb,
            linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_discord_links_roblox ON discord_links (roblox_id);
        CREATE TABLE IF NOT EXISTS hub_products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            image_url TEXT DEFAULT '',
            developer_product_id TEXT NOT NULL,
            key_names JSONB NOT NULL DEFAULT '[]'::jsonb,
            stock INTEGER,
            available BOOLEAN NOT NULL DEFAULT true,
            meta JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS hub_ownerships (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL REFERENCES hub_products(id) ON DELETE CASCADE,
            roblox_id TEXT NOT NULL,
            roblox_name TEXT,
            purchase_id TEXT,
            meta JSONB NOT NULL DEFAULT '{}'::jsonb,
            purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_hub_own_roblox ON hub_ownerships (roblox_id);
        CREATE INDEX IF NOT EXISTS idx_hub_own_product ON hub_ownerships (product_id);
    `);
}

function coreStateOnly(full) {
    const copy = { ...full };
    // stored in other tables
    delete copy.discordLinks;
    delete copy.hubProducts;
    delete copy.hubOwnerships;
    // pending codes stay in app_state (short-lived)
    return copy;
}

async function loadSideTables(client) {
    const links = await client.query('SELECT * FROM discord_links ORDER BY linked_at DESC');
    const products = await client.query('SELECT * FROM hub_products ORDER BY created_at DESC');
    const owns = await client.query('SELECT * FROM hub_ownerships ORDER BY purchased_at DESC');
    return {
        discordLinks: links.rows.map(r => ({
            discordId: r.discord_id,
            discordTag: r.discord_tag,
            robloxId: r.roblox_id,
            robloxName: r.roblox_name,
            linkedAt: r.linked_at ? new Date(r.linked_at).getTime() : null,
            ...(r.meta && typeof r.meta === 'object' ? r.meta : {})
        })),
        hubProducts: products.rows.map(r => {
            const meta = (r.meta && typeof r.meta === 'object') ? r.meta : {};
            return {
                id: r.id,
                name: r.name,
                description: r.description || '',
                imageUrl: r.image_url || '',
                developerProductId: r.developer_product_id,
                keyNames: Array.isArray(r.key_names) ? r.key_names : (r.key_names || []),
                stock: r.stock == null ? null : Number(r.stock),
                available: !!r.available,
                createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
                updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : null,
                // extended fields from meta
                discordRoleIds: meta.discordRoleIds || [],
                deliveryIncludes: meta.deliveryIncludes || ['files', 'links', 'text'],
                deliveryMode: meta.deliveryMode || 'mixed',
                deliveryText: meta.deliveryText || '',
                links: meta.links || [],
                files: meta.files || [],
                discountPercent: meta.discountPercent != null ? meta.discountPercent : null,
                onSale: !!meta.onSale,
                testPlaceId: meta.testPlaceId || null
            };
        }),
        hubOwnerships: owns.rows.map(r => {
            const meta = (r.meta && typeof r.meta === 'object') ? r.meta : {};
            return {
                id: r.id,
                productId: r.product_id,
                robloxId: r.roblox_id,
                robloxName: r.roblox_name,
                purchaseId: r.purchase_id,
                purchasedAt: r.purchased_at ? new Date(r.purchased_at).getTime() : null,
                manual: !!meta.manual
            };
        })
    };
}

async function persistSideTables(client, full) {
    // discord_links upsert from memory
    const links = full.discordLinks || [];
    await client.query('DELETE FROM discord_links');
    for (const l of links) {
        if (!l.discordId || !l.robloxId) continue;
        const meta = { ...l };
        delete meta.discordId; delete meta.discordTag; delete meta.robloxId;
        delete meta.robloxName; delete meta.linkedAt;
        await client.query(
            `INSERT INTO discord_links (discord_id, discord_tag, roblox_id, roblox_name, meta, linked_at)
             VALUES ($1,$2,$3,$4,$5::jsonb, to_timestamp($6/1000.0))
             ON CONFLICT (discord_id) DO UPDATE SET
               discord_tag=EXCLUDED.discord_tag, roblox_id=EXCLUDED.roblox_id,
               roblox_name=EXCLUDED.roblox_name, meta=EXCLUDED.meta, linked_at=EXCLUDED.linked_at`,
            [String(l.discordId), l.discordTag || null, String(l.robloxId), l.robloxName || null,
             JSON.stringify(meta), l.linkedAt || Date.now()]
        );
    }

    const products = full.hubProducts || [];
    const keepP = products.map(p => p.id);
    if (keepP.length) {
        await client.query(`DELETE FROM hub_products WHERE id <> ALL($1::text[])`, [keepP]);
    } else {
        await client.query('DELETE FROM hub_ownerships');
        await client.query('DELETE FROM hub_products');
    }
    for (const p of products) {
        const meta = {
            discordRoleIds: p.discordRoleIds || [],
            deliveryIncludes: Array.isArray(p.deliveryIncludes) ? p.deliveryIncludes : ['files', 'links', 'text'],
            deliveryMode: p.deliveryMode || 'mixed',
            deliveryText: p.deliveryText || '',
            links: p.links || [],
            files: p.files || [],
            discountPercent: p.discountPercent != null ? p.discountPercent : null,
            onSale: !!p.onSale,
            testPlaceId: p.testPlaceId || null
        };
        await client.query(
            `INSERT INTO hub_products (id, name, description, image_url, developer_product_id, key_names, stock, available, meta, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,NOW())
             ON CONFLICT (id) DO UPDATE SET
               name=EXCLUDED.name, description=EXCLUDED.description, image_url=EXCLUDED.image_url,
               developer_product_id=EXCLUDED.developer_product_id, key_names=EXCLUDED.key_names,
               stock=EXCLUDED.stock, available=EXCLUDED.available, meta=EXCLUDED.meta, updated_at=NOW()`,
            [p.id, p.name || 'Product', p.description || '', p.imageUrl || '',
             String(p.developerProductId || '0'), JSON.stringify(p.keyNames || []),
             p.stock == null || p.stock === '' ? null : Number(p.stock), p.available !== false,
             JSON.stringify(meta)]
        );
    }

    const owns = full.hubOwnerships || [];
    const keepO = owns.map(o => o.id);
    if (keepO.length) {
        await client.query(`DELETE FROM hub_ownerships WHERE id <> ALL($1::text[])`, [keepO]);
    } else {
        await client.query('DELETE FROM hub_ownerships');
    }
    for (const o of owns) {
        const meta = { manual: !!o.manual };
        await client.query(
            `INSERT INTO hub_ownerships (id, product_id, roblox_id, roblox_name, purchase_id, meta, purchased_at)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb, to_timestamp($7/1000.0))
             ON CONFLICT (id) DO UPDATE SET
               product_id=EXCLUDED.product_id, roblox_id=EXCLUDED.roblox_id,
               roblox_name=EXCLUDED.roblox_name, purchase_id=EXCLUDED.purchase_id, meta=EXCLUDED.meta`,
            [o.id, o.productId, String(o.robloxId), o.robloxName || null, o.purchaseId || null,
             JSON.stringify(meta), o.purchasedAt || Date.now()]
        );
    }
}

async function migrateFromLegacyJson(client, incoming) {
    // If side tables empty but JSON has arrays — one-time migrate
    const c1 = await client.query('SELECT COUNT(*)::int AS n FROM discord_links');
    const c2 = await client.query('SELECT COUNT(*)::int AS n FROM hub_products');
    if (c1.rows[0].n === 0 && Array.isArray(incoming.discordLinks) && incoming.discordLinks.length) {
        console.log('[DB] Migrating discordLinks to table…');
    }
    if (c2.rows[0].n === 0 && Array.isArray(incoming.hubProducts) && incoming.hubProducts.length) {
        console.log('[DB] Migrating hub products to table…');
    }
    // Always prefer table data after ensure; if tables empty use JSON then write
    const side = await loadSideTables(client);
    if (!side.discordLinks.length && incoming.discordLinks && incoming.discordLinks.length) {
        side.discordLinks = incoming.discordLinks;
    }
    if (!side.hubProducts.length && incoming.hubProducts && incoming.hubProducts.length) {
        side.hubProducts = incoming.hubProducts;
    }
    if (!side.hubOwnerships.length && incoming.hubOwnerships && incoming.hubOwnerships.length) {
        side.hubOwnerships = incoming.hubOwnerships;
    }
    return side;
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
        if (typeof payload === 'string') payload = JSON.parse(payload.trim());
        if (payload && typeof payload.data === 'string') {
            try { payload = JSON.parse(payload.data); } catch (_) {}
        } else if (payload && payload.data && payload.data.whitelist) {
            payload = payload.data;
        }
        if (payload && payload.whitelist && hasMeaningfulData(payload)) {
            ensureStructure(payload);
            return payload;
        }
        return null;
    } catch (e) {
        console.error('[DB] Sheets import failed:', e.message || e);
        return null;
    }
}

async function init() {
    if (!DATABASE_URL) {
        lastLoadOk = false;
        lastLoadError = 'DATABASE_URL not set — data only in memory';
        console.error('[DB]', lastLoadError);
        return false;
    }
    const p = getPool();
    const client = await p.connect();
    try {
        await ensureTables(client);
        const result = await client.query('SELECT data FROM app_state WHERE id = 1');
        let incoming;
        if (!result.rows.length) {
            let seed = await importFromGoogleSheets();
            if (!seed) seed = defaultData();
            ensureStructure(seed);
            await client.query(
                `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
                [JSON.stringify(coreStateOnly(seed))]
            );
            incoming = seed;
        } else {
            const row = result.rows[0].data;
            incoming = typeof row === 'string' ? JSON.parse(row) : row;
            ensureStructure(incoming);
        }
        const side = await migrateFromLegacyJson(client, incoming);
        incoming.discordLinks = side.discordLinks;
        incoming.hubProducts = side.hubProducts;
        incoming.hubOwnerships = side.hubOwnerships;
        // write side if migrated from json
        await persistSideTables(client, incoming);
        data = incoming;
        console.log('[DB] Loaded — creators:', data.whitelist.creators.length,
            'places:', data.whitelist.places.length, 'keys:', (data.keys || []).length,
            'links:', data.discordLinks.length, 'hubProducts:', data.hubProducts.length);
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
        const client = await p.connect();
        try {
            const result = await client.query('SELECT data FROM app_state WHERE id = 1');
            if (!result.rows.length) {
                lastLoadOk = false;
                lastLoadError = 'No app_state row';
                return false;
            }
            const row = result.rows[0].data;
            const incoming = typeof row === 'string' ? JSON.parse(row) : row;
            ensureStructure(incoming);
            const side = await loadSideTables(client);
            incoming.discordLinks = side.discordLinks;
            incoming.hubProducts = side.hubProducts;
            incoming.hubOwnerships = side.hubOwnerships;
            if (!hasMeaningfulData(incoming) && hasMeaningfulData(data)) {
                lastLoadOk = false;
                lastLoadError = 'DB payload empty — kept memory';
                return false;
            }
            data = incoming;
            lastLoadOk = true;
            lastLoadError = null;
            lastLoadAt = Date.now();
            return true;
        } finally {
            client.release();
        }
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
    const client = await p.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW())
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
            [JSON.stringify(coreStateOnly(data))]
        );
        await persistSideTables(client, data);
        await client.query('COMMIT');
        lastLoadAt = Date.now();
        lastLoadOk = true;
        lastLoadError = null;
        return true;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function save() {
    if (saveInFlight) { saveQueued = true; return; }
    saveInFlight = true;
    try {
        await persist();
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

function newId() {
    return crypto.randomBytes(8).toString('hex');
}

readyPromise = init().catch((e) => console.error('[DB] boot error:', e.message || e));

module.exports = {
    getData: () => data,
    save,
    loadData,
    checkExpiration,
    newId,
    getLoadStatus: () => ({
        lastLoadOk,
        lastLoadError,
        lastLoadAt,
        hasDatabaseUrl: !!DATABASE_URL,
        engine: 'postgres-split'
    }),
    ready: () => readyPromise
};
