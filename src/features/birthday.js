const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { getTodaysBirthdays, getKV } = require('../db');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

// The template lives in the kv store once someone edits it from the
// dashboard; config.json's birthdays.messageTemplate is only the
// fallback default for installs that never touch the dashboard field.
const TEMPLATE_KV_KEY = 'birthday_message_template';

function register(sock, cfg) {
  const { birthdays, groupJid, timezone } = cfg;
  if (!birthdays.enabled) return;

  const run = async () => {
    try {
      const todays = getTodaysBirthdays();
      if (!todays.length) {
        console.log('[birthday] No birthdays today.');
        return;
      }

      const template = getKV(TEMPLATE_KV_KEY, birthdays.messageTemplate);

      for (const rec of todays) {
        const name = rec.name || 'friend';
        const phone = String(rec.phone || '').replace(/\D/g, '');
        const jid = phone ? `${phone}@s.whatsapp.net` : undefined;
        const text = template.replace('{name}', name);
        const mentions = jid ? [jid] : undefined;

        const photoFile = rec.photo_path ? path.join(UPLOADS_DIR, rec.photo_path) : null;
        if (photoFile && fs.existsSync(photoFile)) {
          await sock.sendMessage(groupJid, { image: fs.readFileSync(photoFile), caption: text, mentions });
        } else {
          await sock.sendMessage(groupJid, { text, mentions });
        }
        console.log(`[birthday] Wished ${name} a happy birthday.`);
      }
    } catch (err) {
      console.error('[birthday] Failed to send birthday wishes:', err.message);
    }
  };

  cron.schedule(birthdays.cron, run, { timezone });
  console.log(`[birthday] Scheduled with cron "${birthdays.cron}" (${timezone})`);
}

module.exports = { register };
