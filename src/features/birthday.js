const cron = require('node-cron');
const { getTable } = require('../airtable');

function register(sock, cfg) {
  const { birthdays, groupJid, timezone } = cfg;
  if (!birthdays.enabled) return;

  const run = async () => {
    try {
      const records = await getTable('Birthdays');
      const now = new Date();
      const todays = records.filter((r) => {
        const f = r.fields || {};
        return Number(f.Month) === now.getMonth() + 1 && Number(f.Day) === now.getDate();
      });

      if (!todays.length) {
        console.log('[birthday] No birthdays today.');
        return;
      }

      for (const rec of todays) {
        const f = rec.fields || {};
        const name = f.Name || 'friend';
        const phone = String(f.Phone || '').replace(/\D/g, '');
        const jid = phone ? `${phone}@s.whatsapp.net` : undefined;
        const text = birthdays.messageTemplate.replace('{name}', name);
        const photoUrl = Array.isArray(f.Photo) && f.Photo[0] ? f.Photo[0].url : undefined;
        const mentions = jid ? [jid] : undefined;

        if (photoUrl) {
          await sock.sendMessage(groupJid, { image: { url: photoUrl }, caption: text, mentions });
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
