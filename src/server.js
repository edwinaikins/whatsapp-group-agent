const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const basicAuth = require('express-basic-auth');
const multer = require('multer');

const {
  listTitles,
  createTitle,
  updateTitle,
  deleteTitle,
  listPrompts,
  getPromptById,
  createPrompt,
  updatePrompt,
  deletePrompt,
  listBirthdays,
  getBirthdayById,
  createBirthday,
  updateBirthday,
  deleteBirthday,
  listScheduledPosts,
  getScheduledPostById,
  createScheduledPost,
  deleteScheduledPost,
  rescheduleScheduledPost,
  getIdleMembers,
  getKV,
  setKV,
} = require('./db');
const titleRotator = require('./features/titleRotator');
const dailyActivity = require('./features/dailyActivity');

const BIRTHDAY_TEMPLATE_KV_KEY = 'birthday_message_template';

// Only understands the simple "M H * * D" shape the dashboard's day/time
// pickers produce. A cron expression hand-edited in config.json into
// something more exotic (ranges, steps, multiple days) won't match —
// callers should treat a null return as "can't be shown in the simple
// picker, display the raw cron string instead."
function parseSimpleCron(cronExpr) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(String(cronExpr).trim());
  if (!m) return null;
  return {
    minute: Number(m[1]),
    hour: Number(m[2]),
    dayOfWeek: m[3] === '*' ? '*' : Number(m[3]),
  };
}

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function removeUploadedFile(filename) {
  if (!filename) return;
  fs.unlink(path.join(UPLOADS_DIR, filename), (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error(`[server] Failed to remove upload "${filename}":`, err.message);
    }
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

function start(sock, cfg) {
  const app = express();
  app.use(express.json());

  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.warn(
      '[server] ADMIN_PASSWORD is not set in .env — using a random one-time password ' +
      'printed once below, since the dashboard must not be left unauthenticated.'
    );
  }
  const effectivePassword = adminPassword || crypto.randomBytes(16).toString('hex');
  if (!adminPassword) {
    console.warn(`[server] One-time dashboard password: ${effectivePassword}`);
  }

  app.use(
    basicAuth({
      users: { [adminUser]: effectivePassword },
      challenge: true,
      realm: 'whatsapp-group-agent',
    })
  );

  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- Status ----
  app.get('/api/status', async (req, res) => {
    try {
      const metadata = await sock.groupMetadata(cfg.groupJid);
      const idle = getIdleMembers(cfg.idleReport.idleAfterDays);
      res.json({
        connected: true,
        groupJid: cfg.groupJid,
        groupName: metadata.subject,
        memberCount: metadata.participants.length,
        idleCount: idle.length,
      });
    } catch (err) {
      res.json({ connected: false, error: err.message });
    }
  });

  // ---- Titles ----
  app.get('/api/titles', (req, res) => res.json(listTitles()));

  app.post('/api/titles', (req, res) => {
    const { text, sortOrder } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const id = createTitle({ text, sortOrder: Number(sortOrder) || 0 });
    res.json({ id });
  });

  app.put('/api/titles/:id', (req, res) => {
    updateTitle(req.params.id, {
      text: req.body.text,
      sortOrder: req.body.sortOrder !== undefined ? Number(req.body.sortOrder) : undefined,
    });
    res.json({ ok: true });
  });

  app.delete('/api/titles/:id', (req, res) => {
    deleteTitle(req.params.id);
    res.json({ ok: true });
  });

  // ---- Activity prompts ----
  app.get('/api/prompts', (req, res) => res.json(listPrompts()));

  app.post('/api/prompts', upload.single('image'), (req, res) => {
    const { text, sortOrder } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const id = createPrompt({
      text,
      sortOrder: Number(sortOrder) || 0,
      imagePath: req.file ? req.file.filename : null,
    });
    res.json({ id });
  });

  app.put('/api/prompts/:id', upload.single('image'), (req, res) => {
    const existing = req.file ? getPromptById(req.params.id) : null;
    updatePrompt(req.params.id, {
      text: req.body.text,
      sortOrder: req.body.sortOrder !== undefined ? Number(req.body.sortOrder) : undefined,
      imagePath: req.file ? req.file.filename : undefined,
    });
    if (existing) removeUploadedFile(existing.image_path);
    res.json({ ok: true });
  });

  app.delete('/api/prompts/:id', (req, res) => {
    const existing = getPromptById(req.params.id);
    deletePrompt(req.params.id);
    if (existing) removeUploadedFile(existing.image_path);
    res.json({ ok: true });
  });

  // ---- Birthdays ----
  app.get('/api/birthdays', (req, res) => res.json(listBirthdays()));

  app.post('/api/birthdays', upload.single('photo'), (req, res) => {
    const { name, phone, month, day } = req.body;
    if (!name || !phone || !month || !day) {
      return res.status(400).json({ error: 'name, phone, month, and day are required' });
    }
    const id = createBirthday({
      name,
      phone,
      month: Number(month),
      day: Number(day),
      photoPath: req.file ? req.file.filename : null,
    });
    res.json({ id });
  });

  app.put('/api/birthdays/:id', upload.single('photo'), (req, res) => {
    const { name, phone, month, day } = req.body;
    const existing = req.file ? getBirthdayById(req.params.id) : null;
    updateBirthday(req.params.id, {
      name,
      phone,
      month: month !== undefined ? Number(month) : undefined,
      day: day !== undefined ? Number(day) : undefined,
      photoPath: req.file ? req.file.filename : undefined,
    });
    if (existing) removeUploadedFile(existing.photo_path);
    res.json({ ok: true });
  });

  app.delete('/api/birthdays/:id', (req, res) => {
    const existing = getBirthdayById(req.params.id);
    deleteBirthday(req.params.id);
    if (existing) removeUploadedFile(existing.photo_path);
    res.json({ ok: true });
  });

  // ---- Birthday message template ----
  app.get('/api/settings/birthday-template', (req, res) => {
    res.json({ template: getKV(BIRTHDAY_TEMPLATE_KV_KEY, cfg.birthdays.messageTemplate) });
  });

  app.post('/api/settings/birthday-template', (req, res) => {
    const { template } = req.body;
    if (!template || !template.trim()) {
      return res.status(400).json({ error: 'template is required' });
    }
    setKV(BIRTHDAY_TEMPLATE_KV_KEY, template);
    res.json({ ok: true });
  });

  // ---- Posting schedule (title rotation / daily activity) ----
  // These change WHEN the two recurring features fire. What they post
  // (titles, prompts) is managed by the sections above/below; this is
  // purely the cron timing, editable here instead of config.json + restart.
  app.get('/api/settings/schedules', (req, res) => {
    const titleCron = getKV(titleRotator.CRON_KV_KEY, cfg.titleRotation.cron);
    const activityCron = getKV(dailyActivity.CRON_KV_KEY, cfg.dailyActivity.cron);
    const titleParsed = parseSimpleCron(titleCron);
    const activityParsed = parseSimpleCron(activityCron);

    res.json({
      titleRotation: {
        cron: titleCron,
        enabled: cfg.titleRotation.enabled,
        custom: !titleParsed,
        ...(titleParsed || {}),
      },
      dailyActivity: {
        cron: activityCron,
        enabled: cfg.dailyActivity.enabled,
        custom: !activityParsed,
        ...(activityParsed || {}),
      },
    });
  });

  app.post('/api/settings/schedules/title-rotation', (req, res) => {
    const hour = Number(req.body.hour);
    const minute = Number(req.body.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return res.status(400).json({ error: 'hour must be 0-23' });
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      return res.status(400).json({ error: 'minute must be 0-59' });
    }
    let dayOfWeek = req.body.dayOfWeek;
    if (dayOfWeek === undefined || dayOfWeek === null || dayOfWeek === '' || dayOfWeek === '*') {
      dayOfWeek = '*';
    } else {
      dayOfWeek = Number(dayOfWeek);
      if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        return res.status(400).json({ error: 'dayOfWeek must be 0-6 (Sun-Sat) or omitted for every day' });
      }
    }

    const cronExpr = `${minute} ${hour} * * ${dayOfWeek}`;
    const applied = titleRotator.reschedule(cronExpr);
    if (!applied) {
      return res.status(400).json({ error: 'Title rotation is disabled (titleRotation.enabled is false in config.json)' });
    }
    res.json({ ok: true, cron: cronExpr });
  });

  app.post('/api/settings/schedules/daily-activity', (req, res) => {
    const hour = Number(req.body.hour);
    const minute = Number(req.body.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return res.status(400).json({ error: 'hour must be 0-23' });
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      return res.status(400).json({ error: 'minute must be 0-59' });
    }

    const cronExpr = `${minute} ${hour} * * *`;
    const applied = dailyActivity.reschedule(cronExpr);
    if (!applied) {
      return res.status(400).json({ error: 'Daily activity posting is disabled (dailyActivity.enabled is false in config.json)' });
    }
    res.json({ ok: true, cron: cronExpr });
  });

  // ---- Scheduled one-off posts ----
  app.get('/api/scheduled-posts', (req, res) => res.json(listScheduledPosts()));

  app.post('/api/scheduled-posts', upload.single('image'), (req, res) => {
    const { runAt, text } = req.body;
    const type = ['message', 'rename', 'icon'].includes(req.body.type) ? req.body.type : 'message';
    const mentionAll = type === 'message' && ['true', 'on', '1'].includes(req.body.mentionAll);
    const mentionPhones = type === 'message' && req.body.mentionPhones ? req.body.mentionPhones.trim() : null;

    if (!runAt) return res.status(400).json({ error: 'runAt is required' });
    const runAtMs = new Date(runAt).getTime();
    if (Number.isNaN(runAtMs)) return res.status(400).json({ error: 'runAt is not a valid date/time' });

    if (type === 'rename' && !text) {
      return res.status(400).json({ error: 'A new group name is required to schedule a rename' });
    }
    if (type === 'icon' && !req.file) {
      return res.status(400).json({ error: 'An image is required to schedule an icon change' });
    }
    if (type === 'message' && !text && !req.file && !mentionAll && !mentionPhones) {
      return res.status(400).json({ error: 'Add text, an image, or someone to tag' });
    }

    const id = createScheduledPost({
      runAt: runAtMs,
      type,
      text: text || null,
      imagePath: req.file ? req.file.filename : null,
      mentionAll,
      mentionPhones,
    });
    res.json({ id });
  });

  app.delete('/api/scheduled-posts/:id', (req, res) => {
    const existing = getScheduledPostById(req.params.id);
    deleteScheduledPost(req.params.id);
    if (existing && existing.status === 'pending') removeUploadedFile(existing.image_path);
    res.json({ ok: true });
  });

  app.post('/api/scheduled-posts/:id/reschedule', (req, res) => {
    const existing = getScheduledPostById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const { runAt } = req.body;
    if (!runAt) return res.status(400).json({ error: 'runAt is required' });
    const runAtMs = new Date(runAt).getTime();
    if (Number.isNaN(runAtMs)) return res.status(400).json({ error: 'runAt is not a valid date/time' });

    rescheduleScheduledPost(req.params.id, runAtMs);
    res.json({ ok: true });
  });

  // ---- Group controls ----
  app.post('/api/group/name', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      await sock.groupUpdateSubject(cfg.groupJid, name);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/group/icon', upload.single('icon'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'icon file is required' });
      const buffer = fs.readFileSync(req.file.path);
      await sock.updateProfilePicture(cfg.groupJid, buffer);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      // The icon isn't referenced by any DB row, so it doesn't need to
      // stick around in data/uploads/ once WhatsApp has it.
      if (req.file) removeUploadedFile(req.file.filename);
    }
  });

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`[server] Dashboard listening on port ${port} (only reachable via the reverse proxy).`);
  });
}

module.exports = { start };
