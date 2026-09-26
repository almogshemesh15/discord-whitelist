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
            product_id TEXT NOT NULL,
            roblox_id TEXT NOT NULL,
            roblox_name TEXT,
            purchase_id TEXT,
            meta JSONB NOT NULL DEFAULT '{}'::jsonb,
            purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_hub_own_roblox ON hub_ownerships (roblox_id);
        CREATE INDEX IF NOT EXISTS idx_hub_own_product ON hub_ownerships (product_id);
        CREATE TABLE IF NOT EXISTS hub_owners (
            roblox_id TEXT PRIMARY KEY,
            roblox_name TEXT,
            discord_id TEXT,
            discord_tag TEXT,
            products JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    // Ensure discord columns exist on older hub_owners
    try {
        await client.query(`ALTER TABLE hub_owners ADD COLUMN IF NOT EXISTS discord_id TEXT`);
        await client.query(`ALTER TABLE hub_owners ADD COLUMN IF NOT EXISTS discord_tag TEXT`);
    } catch (_) {}
    // Migrate flat hub_ownerships → hub_owners once, then we stop writing to hub_ownerships
    try {
        const cF = await client.query(`SELECT COUNT(*)::int AS n FROM hub_ownerships`);
        if (cF.rows[0].n > 0) {
            console.log('[DB] Merging hub_ownerships into hub_owners…');
            const rows = await client.query('SELECT * FROM hub_ownerships');
            const by = new Map();
            for (const r of rows.rows) {
                const rid = String(r.roblox_id);
                if (!by.has(rid)) by.set(rid, { name: r.roblox_name, products: [] });
                const e = by.get(rid);
                if (r.roblox_name) e.name = r.roblox_name;
                const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
                // dedupe by productId
                if (!e.products.some(p => String(p.productId) === String(r.product_id))) {
                    e.products.push({
                        id: r.id,
                        productId: r.product_id,
                        purchaseId: r.purchase_id || null,
                        purchasedAt: r.purchased_at ? new Date(r.purchased_at).getTime() : Date.now(),
                        manual: !!meta.manual
                    });
                }
            }
            // merge discord from discord_links
            let links = [];
            try {
                const lr = await client.query('SELECT discord_id, discord_tag, roblox_id FROM discord_links');
                links = lr.rows;
            } catch (_) {}
            for (const [rid, e] of by) {
                const link = links.find(l => String(l.roblox_id) === rid);
                // merge with existing owner products
                const existing = await client.query('SELECT products, roblox_name, discord_id, discord_tag FROM hub_owners WHERE roblox_id=$1', [rid]);
                let products = e.products;
                let name = e.name;
                let discordId = link ? link.discord_id : null;
                let discordTag = link ? link.discord_tag : null;
                if (existing.rows[0]) {
                    let prev = existing.rows[0].products;
                    if (typeof prev === 'string') try { prev = JSON.parse(prev); } catch (_) { prev = []; }
                    if (!Array.isArray(prev)) prev = [];
                    const seen = new Set(prev.map(p => String(p.productId)));
                    for (const pr of products) {
                        if (!seen.has(String(pr.productId))) prev.push(pr);
                    }
                    products = prev;
                    if (!name) name = existing.rows[0].roblox_name;
                    if (!discordId) discordId = existing.rows[0].discord_id;
                    if (!discordTag) discordTag = existing.rows[0].discord_tag;
                }
                await client.query(
                    `INSERT INTO hub_owners (roblox_id, roblox_name, discord_id, discord_tag, products, updated_at)
                     VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
                     ON CONFLICT (roblox_id) DO UPDATE SET
                       roblox_name=COALESCE(EXCLUDED.roblox_name, hub_owners.roblox_name),
                       discord_id=COALESCE(EXCLUDED.discord_id, hub_owners.discord_id),
                       discord_tag=COALESCE(EXCLUDED.discord_tag, hub_owners.discord_tag),
                       products=EXCLUDED.products, updated_at=NOW()`,
                    [rid, name || null, discordId || null, discordTag || null, JSON.stringify(products)]
                );
            }
            await client.query('DELETE FROM hub_ownerships');
            console.log('[DB] hub_owners merged; hub_ownerships cleared');
        }
    } catch (e) {
        console.warn('[DB] owners migrate:', e.message || e);
    }
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
    let hubOwnershipsFlat = [];
    try {
        const owners = await client.query('SELECT * FROM hub_owners');
        for (const r of owners.rows) {
            let products = r.products;
            if (typeof products === 'string') {
                try { products = JSON.parse(products); } catch (_) { products = []; }
            }
            if (!Array.isArray(products)) products = [];
            for (const pr of products) {
                hubOwnershipsFlat.push({
                    id: pr.id || (String(r.roblox_id) + '_' + String(pr.productId)),
                    productId: pr.productId,
                    robloxId: String(r.roblox_id),
                    robloxName: r.roblox_name || '',
                    discordId: r.discord_id || null,
                    discordTag: r.discord_tag || null,
                    purchaseId: pr.purchaseId || null,
                    purchasedAt: pr.purchasedAt || null,
                    manual: !!pr.manual
                });
            }
        }
    } catch (e) {
        console.warn('[DB] load hub_owners:', e.message || e);
    }
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
        hubOwnerships: hubOwnershipsFlat
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

    // One row per user: roblox + discord + all products
    const owns = full.hubOwnerships || [];
    const discordLinksArr = full.discordLinks || [];
    const byUser = new Map();
    for (const o of owns) {
        const rid = String(o.robloxId);
        if (!byUser.has(rid)) {
            byUser.set(rid, {
                robloxName: o.robloxName || '',
                discordId: o.discordId || null,
                discordTag: o.discordTag || null,
                products: []
            });
        }
        const e = byUser.get(rid);
        if (o.robloxName) e.robloxName = o.robloxName;
        if (o.discordId) e.discordId = o.discordId;
        if (o.discordTag) e.discordTag = o.discordTag;
        e.products.push({
            id: o.id,
            productId: o.productId,
            purchaseId: o.purchaseId || null,
            purchasedAt: o.purchasedAt || Date.now(),
            manual: !!o.manual
        });
    }
    // fill discord from links if missing
    for (const [rid, e] of byUser) {
        if (!e.discordId) {
            const link = discordLinksArr.find(l => String(l.robloxId) === rid);
            if (link) {
                e.discordId = link.discordId || null;
                e.discordTag = link.discordTag || null;
            }
        }
    }
    const keepR = [...byUser.keys()];
    if (keepR.length) {
        await client.query(`DELETE FROM hub_owners WHERE roblox_id <> ALL($1::text[])`, [keepR]);
    } else {
        await client.query('DELETE FROM hub_owners');
    }
    for (const [rid, e] of byUser) {
        await client.query(
            `INSERT INTO hub_owners (roblox_id, roblox_name, discord_id, discord_tag, products, updated_at)
             VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
             ON CONFLICT (roblox_id) DO UPDATE SET
               roblox_name=EXCLUDED.roblox_name,
               discord_id=EXCLUDED.discord_id,
               discord_tag=EXCLUDED.discord_tag,
               products=EXCLUDED.products,
               updated_at=NOW()`,
            [rid, e.robloxName || null, e.discordId || null, e.discordTag || null, JSON.stringify(e.products)]
        );
    }
    // Legacy table no longer used — keep empty
    try { await client.query('DELETE FROM hub_ownerships'); } catch (_) {}
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
