const cron = require('node-cron');
const { getIdleMembers, syncMembershipList, getKV, setKV, phoneFromJid, getContactInfo } = require('../db');

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

async function refreshMembership(sock, groupJid, botPhoneNumber) {
  const metadata = await sock.groupMetadata(groupJid);
  // The bot's own number shows up as a normal participant in
  // groupMetadata() (it has to be a group member to operate at all), but
  // it has no business appearing in the Active/Inactive dashboard lists.
  // Filter it out before anything else touches the participant list, so
  // it's excluded from both the idle-report tagging and syncMembershipList
  // (whose existing "no longer a participant" cleanup then removes any
  // pre-existing members row for it too). Matched on phone digits rather
  // than JID, since the bot can show up under either a phone-based JID or
  // an @lid one depending on how WhatsApp resolves it.
  const rawParticipants = botPhoneNumber
    ? metadata.participants.filter((p) => {
        const resolvedPhone = p.phoneNumber ? p.phoneNumber.split('@')[0] : null;
        const idPhone = phoneFromJid(p.id);
        return resolvedPhone !== botPhoneNumber && idPhone !== botPhoneNumber;
      })
    : metadata.participants;
  if (DIAG_LOG_MEMBERSHIP) {
    const lidCount = rawParticipants.filter((p) => p.id.endsWith('@lid')).length;
    const withPhoneNumber = rawParticipants.filter((p) => !!p.phoneNumber).length;
    console.log(
      `[idleReport:diag] ${rawParticipants.length} participants (bot excluded) — ${lidCount} are @lid, ${withPhoneNumber} have phoneNumber set`
    );
  }
  const participants = rawParticipants.map((p) => {
    // Prefer an actual WhatsApp name Baileys already knows (push name,
    // then verified/business name), then whatever the contacts-sync
    // cache learned about this JID previously (see upsertContactInfo()
    // in db.js — it exists specifically because contacts.upsert can
    // fire before this participant's members row does, so the name it
    // carried would otherwise be lost by the time this ever runs).
    // Deliberately do NOT fall back further to the resolved phone
    // number itself — the dashboard has its own dedicated Contact
    // column for that, and this `name` value gets upserted into
    // members.name via a COALESCE that treats non-null as "use this".
    // Falling back to resolvedPhone would mean every dashboard load
    // (server.js calls refreshMembership() on every /api/member-activity
    // request) overwrites a real name already learned via
    // contacts.upsert with a plain digit string. Passing null instead
    // lets that COALESCE leave the real name alone.
    const resolvedPhone = p.phoneNumber ? p.phoneNumber.split('@')[0] : null;
    // contacts.upsert/update often hands us the phone-based JID as
    // `c.id` (that's how WhatsApp's own address-book sync identifies
    // someone), even though groupMetadata() reports this same person
    // under their opaque @lid `p.id` for privacy. Looking the cache up
    // by p.id alone misses that entry entirely — check the phone-based
    // JID too whenever we have one, since that's very often the key it
    // was actually cached under.
    const phoneJid = resolvedPhone ? `${resolvedPhone}@s.whatsapp.net` : null;
    const cached = getContactInfo(p.id) || (phoneJid ? getContactInfo(phoneJid) : null);
    if (DIAG_LOG_MEMBERSHIP) {
      console.log(
        `[idleReport:diag] id=${p.id} phoneNumber=${p.phoneNumber || 'none'} name=${p.name || 'none'} notify=${p.notify || 'none'} verifiedName=${p.verifiedName || 'none'} cachedName=${(cached && cached.name) || 'none'}`
      );
    }
    return {
      jid: p.id,
      name: p.name || p.notify || p.verifiedName || (cached && cached.name) || null,
      // Prefer WhatsApp's own resolved phone number for this participant
      // (only available some of the time for @lid participants); fall
      // back to the contacts-sync cache, then to pulling it straight
      // out of the JID, which only works when the JID itself is a real
      // phone-based one.
      phone: resolvedPhone || (cached && cached.phone) || phoneFromJid(p.id),
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
      await refreshMembership(sock, groupJid, cfg.botPhoneNumber);
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
