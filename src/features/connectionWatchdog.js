const cron = require('node-cron');

// Baileys (specifically the pre-release 7.0.0-rc14 this project is
// pinned to) has been observed leaving the socket in a zombie state:
// every call just hangs ("timed out waiting for message" in the logs)
// instead of the underlying WebSocket firing a proper close event —
// which is the ONLY thing that triggers whatsapp.js's own reconnect
// logic. When that happens the process never crashes and never
// recovers on its own; someone has to notice the dashboard is stuck
// on "disconnected" and manually `docker compose restart`.
//
// This watchdog automates that manual step: periodically make a real
// round-trip call to WhatsApp with a hard timeout, and if it keeps
// failing for several checks in a row, exit the process on purpose.
// docker-compose.yml's `restart: unless-stopped` then brings up a
// fresh container with a brand-new socket — exactly what a manual
// restart does today, just without anyone needing to notice first.
//
// This is deliberately generic ("has WhatsApp stopped responding at
// all") rather than specific to any one symptom, so it also covers
// failure modes we haven't seen yet.
const CHECK_CRON = '*/2 * * * *'; // every 2 minutes
const CALL_TIMEOUT_MS = 20000; // generous for a healthy round trip, short enough to catch a stuck socket
const FAILURE_THRESHOLD = 3; // ~4-6 minutes of sustained failure before restarting

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('watchdog check timed out')), ms)),
  ]);
}

function register(sock, cfg) {
  // groupMetadata() needs a group to ask about — nothing to health
  // check yet on a fresh install before GROUP_JID is set.
  if (!cfg.groupJid) return;

  let consecutiveFailures = 0;

  cron.schedule(CHECK_CRON, async () => {
    try {
      await withTimeout(sock.groupMetadata(cfg.groupJid), CALL_TIMEOUT_MS);
      if (consecutiveFailures > 0) {
        console.log(`[watchdog] Connection recovered after ${consecutiveFailures} failed check(s).`);
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      console.warn(`[watchdog] Health check failed (${consecutiveFailures}/${FAILURE_THRESHOLD}): ${err.message}`);
      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        console.error(
          `[watchdog] WhatsApp connection unresponsive for ${FAILURE_THRESHOLD} consecutive checks — ` +
          'restarting the process so Docker can bring up a fresh connection.'
        );
        process.exit(1);
      }
    }
  });

  console.log(
    `[watchdog] Connection health check scheduled (every 2 min, restarts after ${FAILURE_THRESHOLD} consecutive failures).`
  );
}

module.exports = { register };
