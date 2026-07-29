const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.timezone = process.env.TIMEZONE || 'Africa/Accra';
  cfg.groupJid = process.env.GROUP_JID || '';
  cfg.reportToJid = process.env.REPORT_TO_JID || '';
  cfg.botPhoneNumber = (process.env.BOT_PHONE_NUMBER || '').replace(/\D/g, '');
  return cfg;
}

module.exports = { loadConfig, CONFIG_PATH };
