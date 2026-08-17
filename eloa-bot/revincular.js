/* Revincula a sessão do WhatsApp (usada pela Eloá e pelo Resgate v2) do zero,
   depois que a sessão anterior ficou com erro de criptografia. Só conecta e
   pede o código de pareamento — não faz mais nada (não envia, não escuta
   lead).

   Uso: node revincular.js
*/
require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const P = require('pino')({ level: 'silent' });

async function main() {
  const telPareamento = process.env.ELOA_TEL;
  if (!telPareamento) {
    console.log('ELOA_TEL não configurada no .env — não dá pra pedir código de pareamento.');
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered) {
    await new Promise((r) => setTimeout(r, 3000));
    const codigo = await sock.requestPairingCode(telPareamento);
    console.log(`\n=== CÓDIGO DE PAREAMENTO: ${codigo} ===`);
    console.log('No WhatsApp desse número: Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone → digite o código acima.\n');
  }

  await new Promise((resolve) => {
    sock.ev.on('connection.update', (update) => {
      console.log('connection.update:', update.connection);
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
