/* Envio avulso de mensagem de resgate — pra casos vindos direto da coluna
   de Insucessos do Autoconf (não fazem parte da fila normal da Cora no
   Firestore). Manda e desconecta, SEM registrar listener de resposta — o
   Rubens assume pessoalmente se o cliente responder. Cada envio já fica
   registrado em AgenteResgateRTCar/registro-resgate-v2.json (mais recente
   primeiro no relatório).

   Uso:
     node enviar-resgate-avulso.js <casoAutoconf> <nome> <telefone> <veiculo> <origem> "<mensagem original do cliente>"

   Exemplo:
     node enviar-resgate-avulso.js 8867851 Eduardo 5547988057335 "BYD Dolphin" WebMotors "Olá, tenho interesse no veículo."
*/
require('dotenv').config();
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const P = require('pino')({ level: 'silent' });
const { gerarResposta } = require('./gemini');
const { registrar } = require(path.join(process.env.USERPROFILE || process.env.HOME, 'AgenteResgateRTCar', 'registroResgateV2.js'));

const [, , CASO_AUTOCONF, NOME_CLIENTE, TEL_CLIENTE, VEICULO, ORIGEM, MENSAGEM_ORIGINAL] = process.argv;

async function main() {
  if (!CASO_AUTOCONF || !NOME_CLIENTE || !TEL_CLIENTE) {
    console.log('Uso: node enviar-resgate-avulso.js <casoAutoconf> <nome> <telefone> <veiculo> <origem> "<mensagem original>"');
    process.exit(1);
  }

  const lead = { clienteNome: NOME_CLIENTE, veiculo: VEICULO, origem: ORIGEM, _persona: 'persona-resgate.md', _mensagemOriginal: MENSAGEM_ORIGINAL };
  const { mensagens } = await gerarResposta(lead, [], '(sem resposta ainda — inicie a mensagem de reconexão)');
  console.log('Mensagens geradas:', JSON.stringify(mensagens, null, 2));

  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  await new Promise((resolve, reject) => {
    sock.ev.on('connection.update', async (update) => {
      if (update.connection === 'open') {
        try {
          const check = await sock.onWhatsApp(TEL_CLIENTE);
          const jid = check?.[0]?.exists ? check[0].jid : `${TEL_CLIENTE}@s.whatsapp.net`;
          for (let i = 0; i < mensagens.length; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 1200));
            await sock.sendMessage(jid, { text: mensagens[i] });
            console.log(`Enviada (${i + 1}/${mensagens.length}):`, mensagens[i]);
          }
          resolve();
        } catch (e) { reject(e); }
      } else if (update.connection === 'close') {
        reject(new Error('Conexão fechada antes de enviar'));
      }
    });
  });

  registrar(CASO_AUTOCONF, NOME_CLIENTE, TEL_CLIENTE, VEICULO, mensagens.join(' '));
  process.exit(0);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
