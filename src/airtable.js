const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'airtable-cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function cachePath(table) {
  return path.join(CACHE_DIR, `${table.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

function readCache(table) {
  const p = cachePath(table);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(table, records) {
  try {
    fs.writeFileSync(cachePath(table), JSON.stringify(records, null, 2));
  } catch (err) {
    console.error(`[airtable] Failed to write cache for "${table}":`, err.message);
  }
}

async function fetchAllRecords(table, { sortField } = {}) {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    throw new Error('AIRTABLE_TOKEN / AIRTABLE_BASE_ID not set in .env');
  }

  let records = [];
  let offset;
  do {
    const params = new URLSearchParams();
    params.set('pageSize', '100');
    if (sortField) {
      params.set('sort[0][field]', sortField);
      params.set('sort[0][direction]', 'asc');
    }
    if (offset) params.set('offset', offset);

    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?${params.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Airtable fetch failed for "${table}": HTTP ${res.status} ${body}`);
    }
    const data = await res.json();
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return records;
}

/**
 * Fetches a table live from Airtable. On any failure (missing
 * credentials, network issue, Airtable outage), falls back to the last
 * successful fetch cached on disk so a scheduled post/report still has
 * something to work with. Returns [] only if there's no cache either.
 */
async function getTable(table, opts) {
  try {
    const records = await fetchAllRecords(table, opts);
    writeCache(table, records);
    return records;
  } catch (err) {
    console.error(`[airtable] Live fetch of "${table}" failed (${err.message}); using last cached copy.`);
    return readCache(table) || [];
  }
}

module.exports = { getTable };
