const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { getDuePosts, markPostSent, markPostFailed } = require('../db');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

// WhatsApp only renders an @-mention as a tappable tag (and notifies that
// person) if the message text actually contains "@<their number>" — the
// `mentions` array alone isn't enough. So for a tagged post we build both
// the mentions array Baileys needs AND a line of "@number" text to match
// it, the same pattern idleReport.js already uses for its idle list.
async function buildMentions(post, sock, groupJid) {
  let jids;

  if (post.mention_all) {
    const metadata = await sock.groupMetadata(groupJid);
    jids = metadata.participants.map((p) => p.id);
  } else if (post.mention_phones) {
    jids = post.mention_phones
      .split(',')
      .map((p) => p.replace(/\D/g, ''))
      .filter(Boolean)
      .map((p) => `${p}@s.whatsapp.net`);
  }

  if (!jids || !jids.length) return { mentions: undefined, tagLine: '' };
  return { mentions: jids, tagLine: jids.map((j) => `@${j.split('@')[0]}`).join(' ') };
}

function register(sock, cfg) {
  const { groupJid, timezone } = cfg;

  const run = async () => {
    const due = getDuePosts(Date.now());
    for (const post of due) {
      const type = post.type || 'message';
      try {
        const imageFile = post.image_path ? path.join(UPLOADS_DIR, post.image_path) : null;

        if (type === 'rename') {
          if (!post.text) throw new Error('No new group name was saved for this scheduled rename');
          await sock.groupUpdateSubject(groupJid, post.text);
        } else if (type === 'icon') {
          if (!imageFile || !fs.existsSync(imageFile)) {
            throw new Error('No icon image was saved for this scheduled change');
          }
          await sock.updateProfilePicture(groupJid, fs.readFileSync(imageFile));
        } else {
          const { mentions, tagLine } = await buildMentions(post, sock, groupJid);
          const text = tagLine ? `${post.text || ''}\n\n${tagLine}`.trim() : post.text || '';

          if (imageFile && fs.existsSync(imageFile)) {
            await sock.sendMessage(groupJid, {
              image: fs.readFileSync(imageFile),
              caption: text || undefined,
              mentions,
            });
          } else {
            await sock.sendMessage(groupJid, { text, mentions });
          }
        }

        markPostSent(post.id);
        console.log(`[scheduledPosts] Ran scheduled ${type} #${post.id}`);
      } catch (err) {
        markPostFailed(post.id, err.message);
        console.error(`[scheduledPosts] Failed scheduled ${type} #${post.id}:`, err.message);
      }
    }
  };

  // Checks every minute for anything due — this is independent of
  // config.json since it's driven entirely by rows in scheduled_posts.
  cron.schedule('* * * * *', run, { timezone });
  console.log('[scheduledPosts] Checking for due scheduled group actions every minute.');
}

module.exports = { register };
