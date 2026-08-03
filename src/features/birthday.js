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

      // Rename the group subject to call out today's birthday person (or
      // everyone, if more than one falls on the same day). Group subjects
      // are plain text only — WhatsApp has no mention/tag rendering
      // outside a message body — so this is just their name(s), not a
      // tappable @tag. Same pattern as titleRotator.js and
      // scheduledPosts.js's own `type === 'rename'` action: a rename is a
      // one-off, permanent change to the subject, not reverted afterward.
      // Concretely here that means titleRotator's own independently
      // scheduled rotation (default weekly) will naturally overwrite this
      // birthday title the next time it runs — consistent with how a
      // manual/scheduled rename already behaves elsewhere in this app.
      const names = todays.map((rec) => rec.name || 'friend');
      let namesList;
      if (names.length === 1) {
        namesList = names[0];
      } else if (names.length === 2) {
        namesList = `${names[0]} & ${names[1]}`;
      } else {
        namesList = `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
      }
      const birthdayTitle = `Happy Birthday ${namesList}!🎉`;
      try {
        await sock.groupUpdateSubject(groupJid, birthdayTitle);
        console.log(`[birthday] Renamed group to "${birthdayTitle}".`);
      } catch (err) {
        console.error('[birthday] Failed to rename group:', err.message);
      }

      for (const rec of todays) {
        const name = rec.name || 'friend';
        const phone = String(rec.phone || '').replace(/\D/g, '');
        const jid = phone ? `${phone}@s.whatsapp.net` : undefined;
        // WhatsApp only renders a mention as a visible, tappable @tag
        // when the message text itself contains the literal
        // "@<number>" for that JID — passing `mentions` alone resolves
        // the tag internally but shows nothing highlighted. Prepending
        // it here (rather than relying on the template to include a
        // placeholder) means it always renders regardless of how the
        // template gets edited from the dashboard. No phone on file
        // means no way to tag this person at all — falls back to
        // plain text, same as before.
        const mentionTag = jid ? `@${phone} ` : '';
        const text = mentionTag + template.replace('{name}', name);
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
