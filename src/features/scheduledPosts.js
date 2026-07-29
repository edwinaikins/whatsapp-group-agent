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
      try {
        const imageFile = post.image_path ? path.join(UPLOADS_DIR, post.image_path) : null;
        if (imageFile && fs.existsSync(imageFile)) {
          await sock.sendMessage(groupJid, {
            image: fs.readFileSync(imageFile),
            caption: post.text || undefined,
          });
        } else {
          await sock.sendMessage(groupJid, { text: post.text || '' });
        }
        markPostSent(post.id);
        console.log(`[scheduledPosts] Sent scheduled post #${post.id}`);
      } catch (err) {
        markPostFailed(post.id, err.message);
        console.error(`[scheduledPosts] Failed to send scheduled post #${post.id}:`, err.message);
      }
    }
  };

  // Checks every minute for anything due — this is independent of
  // config.json since it's driven entirely by rows in scheduled_posts.
  cron.schedule('* * * * *', run, { timezone });
  console.log('[scheduledPosts] Checking for due one-off posts every minute.');
}

module.exports = { register };
