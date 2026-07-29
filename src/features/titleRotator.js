const cron = require('node-cron');
const { getKV, setKV } = require('../db');

function register(sock, cfg) {
  const { titleRotation, groupJid, timezone } = cfg;
  if (!titleRotation.enabled || !titleRotation.titles.length) return;

  const run = async () => {
    try {
      const idx = parseInt(getKV('title_rotation_index', '-1'), 10) + 1;
      const nextIdx = idx % titleRotation.titles.length;
      const title = titleRotation.titles[nextIdx];
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
