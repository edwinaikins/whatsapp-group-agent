const cron = require('node-cron');
const { getIdleMembers, syncMembershipList, getKV, setKV, phoneFromJid } = require('../db');

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

// TEMP DIAGNOSTIC — set to true to log exactly what Baileys hands back
// for each participant on the next refresh (raw id, phoneNumber, name,
// notify, verifiedName). Only logs, doesn't change any behavior.
// Originally added to confirm that Baileys 6.7.9 never populates
// phoneNumber for @lid participants at all (confirmed — it doesn't;
// the field didn't exist in that version's Contact type). Left on
// post-upgrade to confirm the opposite: that Baileys 7's restructured
// Contact type (which adds a real phoneNumber field) is actually
// populating it now. Flip back to false (or delete this block and the
// two log lines below) once that's confirmed.
const DIAG_LOG_MEMBERSHIP = true;

async function refreshMembership(sock, groupJid) {
  const metadata = await sock.groupMetadata(groupJid);
  if (DIAG_LOG_MEMBERSHIP) {
    const lidCount = metadata.participants.filter((p) => p.id.endsWith('@lid')).length;
    const withPhoneNumber = metadata.participants.filter((p) => !!p.phoneNumber).length;
    console.log(
      `[idleReport:diag] ${metadata.participants.length} participants — ${lidCount} are @lid, ${withPhoneNumber} have phoneNumber set`
    );
  }
  const participants = metadata.participants.map((p) => {
    // Prefer an actual WhatsApp name Baileys already knows (push name,
    // then verified/business name), then a resolved phone number if
    // this participant's `id` is an opaque @lid id rather than a real
    // phone-based JID. If none of those are available, pass null
    // instead of falling back to the raw JID/LID digits —
    // syncMembershipList() then keeps whatever name we already learned
    // for them (e.g. from a message they sent) instead of overwriting
    // it with a meaningless number. As of Baileys 7, phoneNumber should
    // actually be populated here for most @lid participants (it never
    // was in 6.7.9 — the field didn't exist yet); a participant with
    // neither a name nor a resolvable phone number is now the rare
    // case rather than the norm.
    const resolvedPhone = p.phoneNumber ? p.phoneNumber.split('@')[0] : null;
    if (DIAG_LOG_MEMBERSHIP) {
      console.log(
        `[idleReport:diag] id=${p.id} phoneNumber=${p.phoneNumber || 'none'} name=${p.name || 'none'} notify=${p.notify || 'none'} verifiedName=${p.verifiedName || 'none'}`
      );
    }
    return {
      jid: p.id,
      name: p.name || p.notify || p.verifiedName || resolvedPhone || null,
      // Prefer WhatsApp's own resolved phone number for this participant
      // (only available some of the time for @lid participants); fall
      // back to pulling it straight out of the JID, which only works
      // when the JID itself is a real phone-based one.
      phone: resolvedPhone || phoneFromJid(p.id),
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
