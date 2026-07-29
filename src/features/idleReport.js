const cron = require('node-cron');
const { getIdleMembers, syncMembershipList, getKV, setKV } = require('../db');

// Same pattern as titleRotator.js / dailyActivity.js — the cron
// expression lives in the kv store once someone edits the schedule from
// the dashboard, falling back to config.json's idleReport.cron.
const CRON_KV_KEY = 'idle_report_cron';

let currentTask = null;
let boundTimezone = null;
let boundRun = null;

function applySchedule(cronExpr) {
  if (currentTask) currentTask.stop();
  currentTask = cron.schedule(cronExpr, boundRun, { timezone: boundTimezone });
  console.log(`[idleReport] Scheduled with cron "${cronExpr}" (${boundTimezone})`);
}

async function refreshMembership(sock, groupJid) {
  const metadata = await sock.groupMetadata(groupJid);
  const participants = metadata.participants.map((p) => {
    // Prefer an actual WhatsApp name Baileys already knows (push name,
    // then verified/business name), then a resolved phone number if
    // this participant's `id` is an opaque @lid id rather than a real
    // phone-based JID. If none of those are available, pass null
    // instead of falling back to the raw JID/LID digits —
    // syncMembershipList() then keeps whatever name we already learned
    // for them (e.g. from a message they sent) instead of overwriting
    // it with a meaningless number. Some group members WhatsApp's
    // privacy "LID" system anonymizes may never resolve to anything
    // better than a raw number until they post — that's a known
    // limitation of WhatsApp/Baileys, not something fixable here.
    const resolvedPhone = p.phoneNumber ? p.phoneNumber.split('@')[0] : null;
    return {
      jid: p.id,
      name: p.name || p.notify || p.verifiedName || resolvedPhone || null,
      admin: !!p.admin,
    };
  });
  syncMembershipList(participants);
  return participants;
}

function formatIdleList(idleMembers) {
  return idleMembers
    .map((m, i) => {
      const days = m.last_seen_at
        ? Math.floor((Date.now() - m.last_seen_at) / (24 * 60 * 60 * 1000))
        : null;
      const activity = days === null ? 'no messages seen yet' : `quiet for ${days} day(s)`;
      return `${i + 1}. @${m.jid.split('@')[0]} — ${activity}`;
    })
    .join('\n');
}

function register(sock, cfg) {
  const { idleReport, groupJid, reportToJid, timezone } = cfg;
  if (!idleReport.enabled) return;

  boundTimezone = timezone;
  boundRun = async () => {
    try {
      await refreshMembership(sock, groupJid);
      const idleMembers = getIdleMembers(idleReport.idleAfterDays);
      if (!idleMembers.length) {
        console.log('[idleReport] No idle members this cycle.');
        return;
      }
      const header = `📋 Idle member report (quiet ${idleReport.idleAfterDays}+ days):`;
      const body = formatIdleList(idleMembers);
      const text = `${header}\n${body}`;
      const target = idleReport.postInGroup || !reportToJid ? groupJid : reportToJid;
      const mentions = idleMembers.map((m) => m.jid);
      await sock.sendMessage(target, { text, mentions });
      console.log(`[idleReport] Sent report for ${idleMembers.length} idle member(s).`);
    } catch (err) {
      console.error('[idleReport] Failed to generate report:', err.message);
    }
  };

  const cronExpr = getKV(CRON_KV_KEY, idleReport.cron);
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

module.exports = { register, reschedule, refreshMembership, CRON_KV_KEY };
