const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const AUTH_DIR = path.join(__dirname, '..', 'auth_state');

/**
 * Connects to WhatsApp. Resolves with the live socket once the
 * connection is fully open (state === 'open').
 */
async function connect(botPhoneNumber) {
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
        resolve(sock);
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log('Connection closed. Logged out:', loggedOut, 'statusCode:', statusCode);
        if (loggedOut) {
          reject(new Error('Session logged out. Delete auth_state/ and re-link.'));
        } else {
          console.log('Reconnecting...');
          connect(botPhoneNumber).then(resolve).catch(reject);
        }
      }
    });
  });
}

module.exports = { connect, AUTH_DIR };
