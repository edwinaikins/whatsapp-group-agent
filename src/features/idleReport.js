const cron = require('node-cron');
const { getIdleMembers, syncMembershipList } = require('../db');

async function refreshMembership(sock, groupJid) {
  const metadata = await sock.groupMetadata(groupJid);
  const participants = metadata.participants.map((p) => ({
    jid: p.id,
    name: p.name || p.notify || p.id.split('@')[0],
    admin: !!p.admin,
  }));
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

  const run = async () => {
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

  cron.schedule(idleReport.cron, run, { timezone });
  console.log(`[idleReport] Scheduled with cron "${idleReport.cron}" (${timezone})`);
}

module.exports = { register, refreshMembership };
