/* Variante do revincular.js usando QR code em vez de código de pareamento —
   gera uma imagem PNG do QR pra ser enviada ao Rubens escanear pela câmera
   (WhatsApp: Aparelhos conectados → Conectar um aparelho → aponta a câmera).
   Só conecta e salva o QR — não envia, não escuta lead. */
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const P = require('pino')({ level: 'silent' });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  let qrSalvo = false;

  await new Promise((resolve) => {
    sock.ev.on('connection.update', async (update) => {
      console.log('connection.update:', update.connection);
      if (update.qr && !qrSalvo) {
        qrSalvo = true;
        await QRCode.toFile('./qr-parear.png', update.qr, { width: 400 });
        console.log('\n=== QR CODE SALVO EM eloa-bot/qr-parear.png ===\n');
      }
      if (update.connection === 'close') {
        const err = update.lastDisconnect?.error;
        console.log('close reason:', err?.output?.statusCode, err?.message);
        resolve();
      }
      if (update.connection === 'open') {
        console.log('\n✅ CONECTADO COM SUCESSO — sessão nova, limpa.\n');
        resolve();
      }
    });
  });

  process.exit(0);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
