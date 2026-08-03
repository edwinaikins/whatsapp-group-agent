const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

const AUTH_DIR = path.join(__dirname, '..', 'auth_state');

// Baileys 7.x (package renamed from @whiskeysockets/baileys to plain
// "baileys") is published ESM-only — a bare require() of it throws
// ERR_REQUIRE_ESM. The rest of this project stays CommonJS (no reason
// to convert every file just for one dependency), so we bridge with a
// dynamic import() instead. Node caches the resolved module namespace
// after the first import, so calling this again on every reconnect
// doesn't re-run the module's top-level code.
async function loadBaileys() {
  const baileys = await import('baileys');
  return {
    makeWASocket: baileys.default,
    useMultiFileAuthState: baileys.useMultiFileAuthState,
    DisconnectReason: baileys.DisconnectReason,
    fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
  };
}

/**
 * Connects to WhatsApp and returns a stable proxy object that always
 * forwards calls to whichever underlying socket is currently live.
 *
 * This indirection matters because Baileys creates a brand-new socket
 * instance on every reconnect (a network blip, "connection replaced",
 * the periodic restart-required disconnect, etc.) — WITHOUT it, every
 * caller that grabbed a reference to the original socket once at
 * startup (the dashboard, the scheduled features) would keep calling a
 * dead connection after the very first reconnect, even though the logs
 * would still say "Reconnecting..." and look healthy.
 *
 * `onSocketCreated(sock)` is invoked with every socket the moment it's
 * created — including on reconnects — so the caller can (re-)attach
 * its own event listeners (e.g. tracking incoming messages) to
 * whichever socket is currently live. Listeners attached to an old
 * socket's `.ev` emitter go dead the same way a stale method
 * reference would.
 */
async function connect(botPhoneNumber, { onSocketCreated } = {}) {
  let currentSock = null;
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
    await loadBaileys();

  const proxy = new Proxy({}, {
    get(_target, prop) {
      if (!currentSock) return undefined;
      const value = currentSock[prop];
      return typeof value === 'function' ? value.bind(currentSock) : value;
    },
  });

  async function connectOnce() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'warn' });

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
    });
    currentSock = sock;
    if (onSocketCreated) onSocketCreated(sock);

    const usePairingCode = !sock.authState.creds.registered && !!botPhoneNumber;

    if (usePairingCode) {
      // Baileys needs a brief moment after socket creation before a pairing
      // code can be requested.
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(botPhoneNumber);
          console.log('\n=================================');
          console.log(' WhatsApp pairing code:', code);
          console.log(' Open WhatsApp on the bot number -> Linked Devices');
          console.log(' -> Link a Device -> Link with phone number instead');
          console.log(' -> enter the code above.');
          console.log('=================================\n');
        } catch (err) {
          console.error('Failed to request pairing code:', err);
        }
      }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    return new Promise((resolve, reject) => {
      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !usePairingCode) {
          console.log('Scan this QR code with the bot WhatsApp account (Linked Devices):');
          // eslint-disable-next-line global-require
          require('qrcode-terminal').generate(qr, { small: true });
        }

        if (connection === 'open') {
          console.log('WhatsApp connection established.');
          resolve();
        }

        if (connection === 'close') {
          const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          console.log('Connection closed. Logged out:', loggedOut, 'statusCode:', statusCode);
          if (loggedOut) {
            reject(new Error('Session logged out. Delete auth_state/ and re-link.'));
          } else {
            console.log('Reconnecting...');
            connectOnce().then(resolve).catch(reject);
          }
        }
      });
    });
  }

  await connectOnce();
  return proxy;
}

module.exports = { connect, AUTH_DIR };
