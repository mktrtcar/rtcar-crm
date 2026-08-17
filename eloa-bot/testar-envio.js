/* Teste ponta a ponta da Eva (persona.md) num número real — gera a saudação
   de primeiro contato via Gemini e manda por WhatsApp, em texto e depois
   como nota de voz (Gemini/Kore), usando a sessão já vinculada em ./auth.
   Envio único, não fica escutando resposta.

   Uso:
     node testar-envio.js <telefone> [veiculo] [origem]
   Exemplo:
     node testar-envio.js 5547991711193 "BYD Song Plus" Webmotors
*/
require('dotenv').config();
// Testes usam uma chave Gemini separada (cota grátis própria), pra não gastar a cota da produção.
if (process.env.GOOGLE_AI_API_KEY_TESTE) process.env.GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY_TESTE;
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const P = require('pino')({ level: 'silent' });
const { gerarResposta } = require('./gemini');
const { gerarNotaDeVoz } = require('./voz');

const [, , TEL, VEICULO = 'BYD Song Plus', ORIGEM = 'Webmotors'] = process.argv;

async function main() {
  if (!TEL) {
    console.log('Uso: node testar-envio.js <telefone> [veiculo] [origem]');
    process.exit(1);
  }

  const lead = { clienteNome: 'teste', veiculo: VEICULO, origem: ORIGEM, _primeiroContato: true };
  const { mensagens } = await gerarResposta(lead, [], '(sem resposta ainda — inicie o primeiro contato)');
  console.log('Mensagens geradas:', JSON.stringify(mensagens, null, 2));

  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  await new Promise((resolve, reject) => {
    sock.ev.on('connection.update', async (update) => {
      if (update.connection === 'open') {
        try {
          const check = await sock.onWhatsApp(TEL);
          const jid = check?.[0]?.exists ? check[0].jid : `${TEL}@s.whatsapp.net`;

          for (let i = 0; i < mensagens.length; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 1200));
            await sock.sendMessage(jid, { text: mensagens[i] });
            console.log(`Texto enviado (${i + 1}/${mensagens.length}):`, mensagens[i]);
          }

          console.log('Gerando e enviando nota de voz da primeira mensagem...');
          const audio = await gerarNotaDeVoz(mensagens[0]);
          await sock.sendMessage(jid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
          console.log('Nota de voz enviada.');

          resolve();
        } catch (e) { reject(e); }
      } else if (update.connection === 'close') {
        reject(new Error('Conexão fechada antes de enviar'));
      }
    });
  });

  process.exit(0);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
