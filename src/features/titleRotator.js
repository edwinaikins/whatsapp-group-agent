const cron = require('node-cron');
const { getKV, setKV } = require('../db');
const { getTable } = require('../airtable');

function register(sock, cfg) {
  const { titleRotation, groupJid, timezone } = cfg;
  if (!titleRotation.enabled) return;

  const run = async () => {
    try {
      const records = await getTable('Titles', { sortField: 'Order' });
      const titles = records.map((r) => r.fields.Title).filter(Boolean);
      if (!titles.length) {
        console.warn('[titleRotator] No titles found in Airtable (or cache); skipping this run.');
        return;
      }

      const idx = parseInt(getKV('title_rotation_index', '-1'), 10) + 1;
      const nextIdx = idx % titles.length;
      const title = titles[nextIdx];
      await sock.groupUpdateSubject(groupJid, title);
      setKV('title_rotation_index', nextIdx);
      console.log(`[titleRotator] Group title changed to: "${title}"`);
    } catch (err) {
      console.error('[titleRotator] Failed to update group title:', err.message);
    }
  };

  cron.schedule(titleRotation.cron, run, { timezone });
  console.log(`[titleRotator] Scheduled with cron "${titleRotation.cron}" (${timezone})`);
}

module.exports = { register };
