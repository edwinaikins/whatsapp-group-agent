const { loadConfig } = require('./config');
const { connect } = require('./whatsapp');
const { upsertMemberSeen, phoneFromJid, updateMemberContactInfo } = require('./db');
const server = require('./server');
const titleRotator = require('./features/titleRotator');
const dailyActivity = require('./features/dailyActivity');
const idleReport = require('./features/idleReport');
const birthday = require('./features/birthday');
const scheduledPosts = require('./features/scheduledPosts');

// TEMP DIAGNOSTIC — same purpose as idleReport.js's DIAG_LOG_MEMBERSHIP:
// find out whether contacts.upsert/contacts.update ever actually fire
// for this account, and with what data, now that something is finally
// listening for them. Safe to leave on for a while; only logs. Flip to
// false (or delete the two log lines below) once that's answered.
const DIAG_LOG_CONTACTS = true;

async function main() {
  const cfg = loadConfig();

  // Make sure all Date-based day/month math in features runs in the
  // configured timezone regardless of the host server's default TZ.
  process.env.TZ = cfg.timezone;

  if (!cfg.groupJid) {
    console.warn(
      '[startup] GROUP_JID is not set in .env yet. The bot will still connect and log ' +
      'incoming group JIDs to the console so you can copy the right one in.'
    );
  }

  // Log any group JID we see traffic from, to help first-time setup.
  const seenGroupJids = new Set();

  // These listeners need to be re-attached to every socket connect()
  // creates internally (including reconnects) — a listener attached to
  // one socket's `.ev` emitter goes dead once that socket is replaced,
  // so this callback runs again each time a fresh one comes online.
  const sock = await connect(cfg.botPhoneNumber, {
    onSocketCreated: (freshSock) => {
      freshSock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          const remoteJid = msg.key.remoteJid;
          if (!remoteJid || !remoteJid.endsWith('@g.us')) continue;

          if (!seenGroupJids.has(remoteJid)) {
            seenGroupJids.add(remoteJid);
            console.log(`[startup] Discovered group JID: ${remoteJid}`);
          }

          if (msg.key.fromMe) continue;
          const senderJid = msg.key.participant || remoteJid;
          const pushName = msg.pushName;
          upsertMemberSeen(senderJid, pushName, (msg.messageTimestamp || Date.now() / 1000) * 1000);
        }
      });

      freshSock.ev.on('group-participants.update', async (update) => {
        if (update.id !== cfg.groupJid) return;
        console.log(`[group] ${update.action}:`, update.participants.join(', '));
      });

      // WhatsApp's own account-level contact sync resolving (or
      // updating) something about a JID — independent of messages sent
      // in the group and independent of whatever groupMetadata() itself
      // manages to resolve. This is the one path that can pick up a
      // saved-on-the-bot's-phone contact's real name/number even for
      // members who've never posted, since it isn't gated on a live
      // groupMetadata() lookup at all.
      const handleContactSync = (contacts) => {
        for (const c of contacts) {
          if (!c || !c.id) continue;
          const resolvedPhone = c.phoneNumber ? c.phoneNumber.split('@')[0] : null;
          const phone = resolvedPhone || phoneFromJid(c.id);
          const name = c.name || c.notify || c.verifiedName || null;
          if (DIAG_LOG_CONTACTS) {
            console.log(
              `[contacts:diag] id=${c.id} phoneNumber=${c.phoneNumber || 'none'} name=${c.name || 'none'} notify=${c.notify || 'none'} verifiedName=${c.verifiedName || 'none'}`
            );
          }
          if (name || phone) updateMemberContactInfo(c.id, { name, phone });
        }
      };
      freshSock.ev.on('contacts.upsert', handleContactSync);
      freshSock.ev.on('contacts.update', handleContactSync);
    },
  });
  console.log('[startup] Connected. Bot is live.');

  if (cfg.groupJid) {
    try {
      const metadata = await sock.groupMetadata(cfg.groupJid);
      console.log(`[startup] Connected to group "${metadata.subject}" (${metadata.participants.length} members).`);
    } catch (err) {
      console.error('[startup] Could not fetch group metadata. Is GROUP_JID correct and is the bot a member?', err.message);
    }
  }

  titleRotator.register(sock, cfg);
  dailyActivity.register(sock, cfg);
  idleReport.register(sock, cfg);
  birthday.register(sock, cfg);
  scheduledPosts.register(sock, cfg);

  console.log('[startup] All scheduled features registered. Waiting for cron ticks...');

  server.start(sock, cfg);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
