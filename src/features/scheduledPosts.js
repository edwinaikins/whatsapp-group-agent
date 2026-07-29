const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { getDuePosts, markPostSent, markPostFailed } = require('../db');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

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
        } else if (imageFile && fs.existsSync(imageFile)) {
          await sock.sendMessage(groupJid, {
            image: fs.readFileSync(imageFile),
            caption: post.text || undefined,
          });
        } else {
          await sock.sendMessage(groupJid, { text: post.text || '' });
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
