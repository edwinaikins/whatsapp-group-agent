const cron = require('node-cron');
const { getKV, setKV } = require('../db');
const { getTable } = require('../airtable');

function register(sock, cfg) {
  const { dailyActivity, groupJid, timezone } = cfg;
  if (!dailyActivity.enabled) return;

  const run = async () => {
    try {
      const records = await getTable('ActivityPrompts', { sortField: 'Order' });
      const prompts = records
        .map((r) => ({
          text: r.fields.Prompt,
          // Airtable attachment URLs are pre-signed and expire after a
          // couple of hours, which is fine here since we always fetch
          // fresh right before sending rather than caching them for long.
          imageUrl: Array.isArray(r.fields.Image) && r.fields.Image[0] ? r.fields.Image[0].url : undefined,
        }))
        .filter((p) => p.text);

      if (!prompts.length) {
        console.warn('[dailyActivity] No prompts found in Airtable (or cache); skipping this run.');
        return;
      }

      const idx = parseInt(getKV('activity_index', '-1'), 10) + 1;
      const nextIdx = idx % prompts.length;
      const prompt = prompts[nextIdx];

      if (prompt.imageUrl) {
        await sock.sendMessage(groupJid, { image: { url: prompt.imageUrl }, caption: prompt.text });
      } else {
        await sock.sendMessage(groupJid, { text: prompt.text });
      }
      setKV('activity_index', nextIdx);
      console.log(`[dailyActivity] Posted: "${prompt.text}"${prompt.imageUrl ? ' (with image)' : ''}`);
    } catch (err) {
      console.error('[dailyActivity] Failed to post activity:', err.message);
    }
  };

  cron.schedule(dailyActivity.cron, run, { timezone });
  console.log(`[dailyActivity] Scheduled with cron "${dailyActivity.cron}" (${timezone})`);
}

module.exports = { register };
