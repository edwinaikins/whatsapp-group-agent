const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

function loadBirthdays(csvPath) {
  const fullPath = path.join(__dirname, '..', '..', csvPath);
  if (!fs.existsSync(fullPath)) return [];
  const lines = fs.readFileSync(fullPath, 'utf8').trim().split('\n');
  const [header, ...rows] = lines;
  const cols = header.split(',').map((c) => c.trim().toLowerCase());
  return rows
    .filter((r) => r.trim())
    .map((row) => {
      const values = row.split(',').map((v) => v.trim());
      const rec = {};
      cols.forEach((c, i) => { rec[c] = values[i]; });
      return {
        phone: (rec.phone || '').replace(/\D/g, ''),
        name: rec.name || 'friend',
        month: parseInt(rec.month, 10),
        day: parseInt(rec.day, 10),
      };
    })
    .filter((r) => r.phone && r.month && r.day);
}

function register(sock, cfg) {
  const { birthdays, groupJid, timezone } = cfg;
  if (!birthdays.enabled) return;

  const run = async () => {
    try {
      const list = loadBirthdays(birthdays.csvPath);
      const now = new Date();
      // "now" is evaluated in the server's local time; cron already runs
      // this in the configured timezone, so getMonth/getDate is fine as
      // long as the process TZ matches — see README for the TZ env note.
      const todays = list.filter(
        (b) => b.month === now.getMonth() + 1 && b.day === now.getDate()
      );
      if (!todays.length) {
        console.log('[birthday] No birthdays today.');
        return;
      }
      for (const person of todays) {
        const jid = `${person.phone}@s.whatsapp.net`;
        const text = birthdays.messageTemplate.replace('{name}', person.name);
        await sock.sendMessage(groupJid, { text, mentions: [jid] });
        console.log(`[birthday] Wished ${person.name} a happy birthday.`);
      }
    } catch (err) {
      console.error('[birthday] Failed to send birthday wishes:', err.message);
    }
  };

  cron.schedule(birthdays.cron, run, { timezone });
  console.log(`[birthday] Scheduled with cron "${birthdays.cron}" (${timezone})`);
}

module.exports = { register, loadBirthdays };
