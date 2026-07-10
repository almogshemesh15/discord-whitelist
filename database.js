const fs = require('fs');

const DB_FILE = './database.json';
const BACKUP_FILE = './database_backup.json';

let data = {
    whitelist: { creators: [], places: [] },
    pendingPlaces: [],
    keys: []
};

function loadData() {
    if (fs.existsSync(DB_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {
            if (fs.existsSync(BACKUP_FILE)) {
                try {
                    return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
                } catch (err) {}
            }
        }
    } else if (fs.existsSync(BACKUP_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
        } catch (err) {}
    }
    return null;
}

const parsed = loadData();
if (parsed) {
    if (parsed.whitelist) data.whitelist = parsed.whitelist;
    if (parsed.pendingPlaces) data.pendingPlaces = parsed.pendingPlaces;
    if (parsed.keys) {
        data.keys = parsed.keys.map(k => typeof k === 'string' ? { key: k } : { key: k.key });
    }
} else {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2));
}

function save() {
    const stringified = JSON.stringify(data, null, 2);
    fs.writeFileSync(DB_FILE, stringified);
    fs.writeFileSync(BACKUP_FILE, stringified);
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
        });

        const initialLength = data.whitelist[type].length;
        data.whitelist[type] = data.whitelist[type].filter(item => {
            if (item.keys && Array.isArray(item.keys) && item.keys.length > 0) {
                return true;
            }
            return !item.expiresAt || item.expiresAt > now;
        });

        if (data.whitelist[type].length !== initialLength) changed = true;
    });

    if (changed) save();
}
setInterval(checkExpiration, 1000);

module.exports = {
    getData: () => data,
    save,
    checkExpiration
};
