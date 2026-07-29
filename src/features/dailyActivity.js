const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { getKV, setKV, listPrompts } = require('../db');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

// Same pattern as titleRotator.js: the cron expression lives in the kv
// store once someone edits the schedule from the dashboard, falling back
// to config.json's dailyActivity.cron for installs that never touch it.
const CRON_KV_KEY = 'daily_activity_cron';

let currentTask = null;
let boundTimezone = null;
let boundRun = null;

function applySchedule(cronExpr) {
  if (currentTask) currentTask.stop();
  currentTask = cron.schedule(cronExpr, boundRun, { timezone: boundTimezone });
  console.log(`[dailyActivity] Scheduled with cron "${cronExpr}" (${boundTimezone})`);
}

function register(sock, cfg) {
  const { dailyActivity, groupJid, timezone } = cfg;
  if (!dailyActivity.enabled) return;

  boundTimezone = timezone;
  boundRun = async () => {
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

  const cronExpr = getKV(CRON_KV_KEY, dailyActivity.cron);
  applySchedule(cronExpr);
}

// See titleRotator.js's reschedule() for the full explanation — same
// persist-then-swap pattern, returns false if the feature is disabled.
function reschedule(cronExpr) {
  if (!boundRun) return false;
  setKV(CRON_KV_KEY, cronExpr);
  applySchedule(cronExpr);
  return true;
}

module.exports = { register, reschedule, CRON_KV_KEY };
