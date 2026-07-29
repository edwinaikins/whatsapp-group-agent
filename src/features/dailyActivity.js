const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { getKV, setKV, listPrompts } = require('../db');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

function register(sock, cfg) {
  const { dailyActivity, groupJid, timezone } = cfg;
  if (!dailyActivity.enabled) return;

  const run = async () => {
    try {
      const prompts = listPrompts().filter((p) => p.text);
      if (!prompts.length) {
        console.warn('[dailyActivity] No prompts configured in the dashboard; skipping this run.');
        return;
      }

      const idx = parseInt(getKV('activity_index', '-1'), 10) + 1;
      const nextIdx = idx % prompts.length;
      const prompt = prompts[nextIdx];

      const imageFile = prompt.image_path ? path.join(UPLOADS_DIR, prompt.image_path) : null;
      if (imageFile && fs.existsSync(imageFile)) {
        await sock.sendMessage(groupJid, { image: fs.readFileSync(imageFile), caption: prompt.text });
      } else {
        await sock.sendMessage(groupJid, { text: prompt.text });
      }
      setKV('activity_index', nextIdx);
      console.log(`[dailyActivity] Posted: "${prompt.text}"${imageFile ? ' (with image)' : ''}`);
    } catch (err) {
      console.error('[dailyActivity] Failed to post activity:', err.message);
    }
  };

  cron.schedule(dailyActivity.cron, run, { timezone });
  console.log(`[dailyActivity] Scheduled with cron "${dailyActivity.cron}" (${timezone})`);
}

module.exports = { register };
