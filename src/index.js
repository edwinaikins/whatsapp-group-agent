const { loadConfig } = require('./config');
const { connect } = require('./whatsapp');
const { upsertMemberSeen } = require('./db');
const server = require('./server');
const titleRotator = require('./features/titleRotator');
const dailyActivity = require('./features/dailyActivity');
const idleReport = require('./features/idleReport');
const birthday = require('./features/birthday');
const scheduledPosts = require('./features/scheduledPosts');

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

  const sock = await connect(cfg.botPhoneNumber);
  console.log('[startup] Connected. Bot is live.');

  // Log any group JID we see traffic from, to help first-time setup.
  const seenGroupJids = new Set();

  sock.ev.on('messages.upsert', ({ messages, type }) => {
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

  sock.ev.on('group-participants.update', async (update) => {
    if (update.id !== cfg.groupJid) return;
    console.log(`[group] ${update.action}:`, update.participants.join(', '));
  });

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
