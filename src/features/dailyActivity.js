const cron = require('node-cron');
const { getKV, setKV } = require('../db');

function register(sock, cfg) {
  const { dailyActivity, groupJid, timezone } = cfg;
  if (!dailyActivity.enabled || !dailyActivity.prompts.length) return;

  const run = async () => {
    try {
      const idx = parseInt(getKV('activity_index', '-1'), 10) + 1;
      const nextIdx = idx % dailyActivity.prompts.length;
      const text = dailyActivity.prompts[nextIdx];
      await sock.sendMessage(groupJid, { text });
      setKV('activity_index', nextIdx);
      console.log(`[dailyActivity] Posted: "${text}"`);
    } catch (err) {
      console.error('[dailyActivity] Failed to post activity:', err.message);
    }
  };

  cron.schedule(dailyActivity.cron, run, { timezone });
  console.log(`[dailyActivity] Scheduled with cron "${dailyActivity.cron}" (${timezone})`);
}

module.exports = { register };
