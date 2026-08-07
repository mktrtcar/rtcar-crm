/* Eloá — atendimento automático a leads novos (coluna "I.A." do kanban).
   Assim que um lead chega (via webhook do Autoconf ou cadastro manual), a Eloá
   manda uma saudação, uma foto real do veículo de interesse (sem preço, sem
   link — pedido da Aline) e pergunta se pode passar o contato do cliente para
   um consultor. Quando o cliente responde qualquer coisa, o lead é movido
   automaticamente para "Atendimento".

   IMPORTANTE — hospedagem: isso usa WhatsApp via Baileys, que precisa de uma
   conexão permanente (não é uma Cloud Function como o webhook-autoconf). Não
   dá pra rodar com "firebase deploy" — precisa de um processo sempre ligado
   em algum lugar (servidor, VM, ou o computador do Rubens, como hoje). Ver
   README.md desta pasta.

   IMPORTANTE — número de WhatsApp: use uma linha própria para a Eloá,
   diferente da que a Cora/agente de resgate usa. As duas usam a mesma
   biblioteca (Baileys) e não podem compartilhar a mesma pasta ./auth — foi
   exatamente esse conflito que causou bugs recorrentes durante os testes. */
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino')({ level: 'silent' });
const qrcode = require('qrcode');
const { fbList, fbUpdate } = require('./firestore');
const ESTOQUE_RTCAR = require('./estoque.json');

const INTERVALO_POLL_MS = 20000; // checa leads novos a cada 20s

/* --- Os dois pontos abaixo ficaram em aberto na reunião de 07/08/2026 com
   Aline/Rafa. Enquanto não forem decididos, o comportamento é o mais simples
   e seguro: sem timeout, sem mensagem extra. Ajustar aqui quando decidido. */
const TIMEOUT_SEM_RESPOSTA_HORAS = null; // TODO (decisão pendente): null = nunca escalar/reenviar sozinha
const MENSAGEM_PONTE_CONTINUACAO = null; // TODO (decisão pendente): null = Eloá fica em silêncio após a 1a resposta

function normalizarTxt(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
}
function buscarVeiculoEstoque(veiculoTexto) {
  const alvo = normalizarTxt(veiculoTexto);
  if (!alvo) return null;
  const palavras = alvo.split(' ').filter((p) => p.length >= 3);
  if (!palavras.length) return null;
  let melhor = null, melhorScore = 0;
  ESTOQUE_RTCAR.forEach((item) => {
    const texto = normalizarTxt(item.b + ' ' + item.m);
    const score = palavras.reduce((s, p) => s + (texto.includes(p) ? 1 : 0), 0);
    if (score > melhorScore) { melhorScore = score; melhor = item; }
  });
  return melhorScore > 0 ? melhor : null;
}
function primeiroNomeDe(nome) { return (nome || 'Cliente').trim().split(' ')[0]; }
function hoje() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function paraJid(tel) {
  const digitos = (tel || '').replace(/\D/g, '');
  if (!digitos) return null;
  const comDDI = digitos.startsWith('55') ? digitos : `55${digitos}`;
  return `${comDDI}@s.whatsapp.net`;
}

async function getLeadsNovos() {
  const leads = await fbList('leads');
  return leads.filter((l) => l.st === 'ia' && !l.eloaEnviadoEm && l.clienteTel && l.origem !== 'Teste');
}

let sock = null;
const telParaLeadId = new Map();

async function cumprimentarLead(lead) {
  const jidTentativa = paraJid(lead.clienteTel);
  if (!jidTentativa) return;
  let jid = jidTentativa;
  try {
    const numero = jidTentativa.split('@')[0];
    const check = await sock.onWhatsApp(numero);
    if (check?.[0]?.exists) jid = check[0].jid;
    else {
      console.log(`⚠️ Número de ${lead.clienteNome} (${lead.clienteTel}) não encontrado no WhatsApp — pulando.`);
      await fbUpdate('leads', lead.id, { eloaEnviadoEm: 'NUMERO_INVALIDO' });
      return;
    }
  } catch (e) {
    console.error('Erro ao validar número, tentando mesmo assim:', e.message);
  }

  const nome = primeiroNomeDe(lead.clienteNome);
  const veiculo = buscarVeiculoEstoque(lead.veiculo);

  try {
    await sock.sendMessage(jid, { text: `Olá! Eu sou a Eloá, da RT Car. Vi que você se interessou por esse carro, vou te mandar mais detalhes!` });
    if (veiculo?.foto) {
      await new Promise((r) => setTimeout(r, 1200));
      await sock.sendMessage(jid, { image: { url: veiculo.foto }, caption: `${veiculo.b} ${veiculo.m}` });
    }
    await new Promise((r) => setTimeout(r, 1200));
    await sock.sendMessage(jid, { text: 'Gostou? Posso passar teu contato para um dos nossos consultores para tirar todas as dúvidas?' });

    telParaLeadId.set(jid.split('@')[0], lead.id);
    telParaLeadId.set((lead.clienteTel || '').replace(/\D/g, ''), lead.id);

    const historico = [...(lead.historico || []), { dt: hoje(), icone: 'purple', acao: '🤖 Saudação automática (Eloá)', obs: 'Mensagem de boas-vindas enviada ao lead novo', by: 'Eloá' }];
    await fbUpdate('leads', lead.id, { eloaEnviadoEm: new Date().toISOString(), historico });
    console.log(`✅ Eloá cumprimentou ${lead.clienteNome} (${lead.id}).`);
  } catch (e) {
    console.error(`Erro ao cumprimentar ${lead.clienteNome}:`, e.message);
  }
}

async function moverParaAtendimento(leadId, textoResposta) {
  try {
    const leads = await fbList('leads');
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.st !== 'ia') return; // já não está mais em I.A. (evita reprocessar)
    const historico = [...(lead.historico || []), { dt: hoje(), icone: 'green', acao: '✅ Encaminhado para esteira automaticamente (Eloá)', obs: `Cliente respondeu: "${textoResposta}" — lead movido de I.A. para Atendimento`, by: 'Eloá' }];
    await fbUpdate('leads', leadId, { st: 'atendimento', atendimento_at: new Date().toISOString(), historico });
    console.log(`✅ Lead ${leadId} movido de "I.A." para "Atendimento".`);
  } catch (e) {
    console.error(`Erro ao mover lead ${leadId} para Atendimento:`, e.message);
  }
}

async function cicloPoll() {
  try {
    const novos = await getLeadsNovos();
    for (const lead of novos) await cumprimentarLead(lead);
  } catch (e) {
    console.error('Erro no ciclo de checagem de leads novos:', e.message);
  }
  setTimeout(cicloPoll, INTERVALO_POLL_MS);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({ auth: state, logger: P, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrcode.toFile('./qr.png', qr, { width: 400 }, (err) => {
        if (!err) console.log('\n=== NOVO QR CODE em ./qr.png ===\n');
      });
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log('Conexão fechada. Motivo:', reason);
      if (reason !== DisconnectReason.loggedOut) start();
      else console.log('Sessão desconectada. Apague ./auth e rode de novo.');
    } else if (connection === 'open') {
      console.log(`\n✅ ELOÁ CONECTADA — ${sock.user?.id}`);
      console.log(`Checando leads novos a cada ${INTERVALO_POLL_MS / 1000}s.\n`);
      cicloPoll();
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const jidTel = msg.key.remoteJidAlt || msg.key.remoteJid;
    const telDigits = jidTel.split('@')[0].replace(/\D/g, '');
    const leadId = telParaLeadId.get(telDigits) || telParaLeadId.get(telDigits.replace(/^55/, ''));
    if (!leadId) return; // não é um número que a Eloá cumprimentou
    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '(mensagem sem texto)';
    moverParaAtendimento(leadId, texto).catch(console.error);
  });
}

start().catch((e) => console.error('Erro ao iniciar Eloá:', e));
