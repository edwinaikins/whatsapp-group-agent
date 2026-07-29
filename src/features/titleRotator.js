const cron = require('node-cron');
const { getKV, setKV, listTitles } = require('../db');

// The cron expression lives in the kv store once someone edits the
// schedule from the dashboard; config.json's titleRotation.cron is only
// the fallback default for installs that never touch that dashboard field.
const CRON_KV_KEY = 'title_rotation_cron';

// Module-scoped so the dashboard (via reschedule()) can swap the live
// cron.schedule() task without needing a process restart. There's only
// ever one group/bot per process, so a singleton is fine here.
let currentTask = null;
let boundTimezone = null;
let boundRun = null;

function applySchedule(cronExpr) {
  if (currentTask) currentTask.stop();
  currentTask = cron.schedule(cronExpr, boundRun, { timezone: boundTimezone });
  console.log(`[titleRotator] Scheduled with cron "${cronExpr}" (${boundTimezone})`);
}

function register(sock, cfg) {
  const { titleRotation, groupJid, timezone } = cfg;
  if (!titleRotation.enabled) return;

  boundTimezone = timezone;
  boundRun = async () => {
    try {
      const titles = listTitles().map((r) => r.text).filter(Boolean);
      if (!titles.length) {
        console.warn('[titleRotator] No titles configured in the dashboard; skipping this run.');
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

  const cronExpr = getKV(CRON_KV_KEY, titleRotation.cron);
  applySchedule(cronExpr);
}

// Called from the dashboard when the admin changes the schedule. Persists
// the new cron expression (so it survives restarts) and swaps the live
// cron task in place. Returns false if the feature was never registered
// (titleRotation.enabled is false in config.json), since there's no
// running task to reschedule in that case.
function reschedule(cronExpr) {
  if (!boundRun) return false;
  setKV(CRON_KV_KEY, cronExpr);
  applySchedule(cronExpr);
  return true;
}

module.exports = { register, reschedule, CRON_KV_KEY };
