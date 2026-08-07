/* Eloá — atendimento automático a leads novos (coluna "I.A." do kanban).
   Assim que um lead chega (via webhook do Autoconf ou cadastro manual), a Eloá
   manda uma saudação e uma foto real do veículo de interesse. A partir da
   primeira resposta do cliente, a conversa passa a ser conduzida por IA
   (Gemini, ver gemini.js) usando o perfil em persona.md e a base de
   conhecimento em base-conhecimento.md — não é mais mensagem fixa. A IA
   decide quando encaminhar pra um consultor humano (preço, financiamento,
   ou pedido explícito do cliente); até lá, o lead permanece em "I.A." e a
   Eloá continua a conversa sozinha.

   IMPORTANTE — hospedagem: isso usa WhatsApp via Baileys, que precisa de uma
   conexão permanente (não é uma Cloud Function como o webhook-autoconf). Não
   dá pra rodar com "firebase deploy" — precisa de um processo sempre ligado
   em algum lugar (servidor, VM, ou o computador do Rubens, como hoje). Ver
   README.md desta pasta.

   IMPORTANTE — número de WhatsApp: use uma linha própria para a Eloá,
   diferente da que a Cora/agente de resgate usa. As duas usam a mesma
   biblioteca (Baileys) e não podem compartilhar a mesma pasta ./auth — foi
   exatamente esse conflito que causou bugs recorrentes durante os testes.

   IMPORTANTE — chave de IA: precisa da variável de ambiente
   GOOGLE_AI_API_KEY (ver README.md) pra conversa por IA funcionar. Sem ela,
   a Eloá manda a saudação inicial normalmente, mas não consegue responder
   depois que o cliente escreve algo. */
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino')({ level: 'silent' });
const qrcode = require('qrcode');
const { fbList, fbUpdate } = require('./firestore');
const { gerarResposta } = require('./gemini');
const ESTOQUE_RTCAR = require('./estoque.json');

const INTERVALO_POLL_MS = 20000; // checa leads novos a cada 20s
const NOTIFICACAO_PESSOAL = '5551998050105@s.whatsapp.net'; // avisa o Rubens quando um consultor humano precisa assumir

/* Segunda barreira, além da instrução em persona.md: se por algum motivo a
   IA mesmo assim escrever algo que pareça preço (ex: "R$ 45.000"), a
   mensagem NÃO é enviada — cai direto pro encaminhamento humano. Preço é
   informação sensível demais pra confiar só no comportamento do modelo. */
const PADRAO_PRECO = /r\$\s?\d|\b\d{1,3}(\.\d{3})+\s*reais\b|\bfinanciamento\b|\bparcela(s)?\b|\bentrada de\b/i;

/* Ponto que ficou em aberto na reunião de 07/08/2026 com Aline/Rafa. Enquanto
   não for decidido, o comportamento é o mais simples: nunca escalar/reenviar
   sozinha se o lead não responder. Ajustar aqui quando decidido. */
const TIMEOUT_SEM_RESPOSTA_HORAS = null; // TODO (decisão pendente)

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

/* Reconstroi o mapa telefone->lead a partir do Firestore ao iniciar, pra
   sobreviver a reinicios do processo (o Map em memoria some ao reiniciar) —
   mesmo problema já visto e corrigido no agente de resgate (Cora). */
async function reconstruirTelParaLeadId() {
  const leads = await fbList('leads');
  leads
    .filter((l) => l.st === 'ia' && l.eloaEnviadoEm && l.eloaEnviadoEm !== 'NUMERO_INVALIDO' && l.clienteTel)
    .forEach((l) => {
      const digitos = (l.clienteTel || '').replace(/\D/g, '');
      if (digitos) telParaLeadId.set(digitos, l.id);
    });
}

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

async function encaminharParaConsultor(lead, motivoResumo) {
  const historico = [...(lead.historico || []), { dt: hoje(), icone: 'green', acao: '✅ Encaminhado para esteira (Eloá)', obs: motivoResumo, by: 'Eloá' }];
  await fbUpdate('leads', lead.id, { st: 'atendimento', atendimento_at: new Date().toISOString(), historico });
  console.log(`✅ Lead ${lead.id} movido de "I.A." para "Atendimento" — ${motivoResumo}`);
  try {
    await sock.sendMessage(NOTIFICACAO_PESSOAL, { text: `🔔 A Eloá encaminhou ${lead.clienteNome || lead.id} pra atendimento humano.\nMotivo: ${motivoResumo}\nVeículo: ${lead.veiculo || '-'}` });
  } catch (e) {
    console.error('Erro ao notificar Rubens sobre encaminhamento:', e.message);
  }
}

async function responderComIA(jid, leadId, mensagemCliente) {
  const leads = await fbList('leads');
  const lead = leads.find((l) => l.id === leadId);
  if (!lead || lead.st !== 'ia') return; // já não está mais em I.A. (evita reprocessar)

  const conversa = lead.conversaEloa || [];

  let resultado;
  try {
    resultado = await gerarResposta(lead, conversa, mensagemCliente);
  } catch (e) {
    console.error(`Erro ao gerar resposta da IA para ${leadId}:`, e.message);
    await encaminharParaConsultor(lead, `A Eloá não conseguiu responder por IA (${e.message}) — encaminhado direto pra não deixar o cliente sem retorno.`);
    return;
  }

  let { resposta, encaminharConsultor } = resultado;
  if (PADRAO_PRECO.test(resposta)) {
    console.warn(`⚠️ Resposta da IA pro lead ${leadId} continha preço/financiamento — bloqueada e encaminhada. Texto original: "${resposta}"`);
    resposta = 'Essa parte de valores e condições eu prefiro confirmar com um consultor pra te passar certinho — já vou te conectar com alguém.';
    encaminharConsultor = true;
  }

  try {
    await sock.sendMessage(jid, { text: resposta });
  } catch (e) {
    console.error(`Erro ao enviar resposta da IA para ${leadId}:`, e.message);
    return;
  }

  const novaConversa = [...conversa, { role: 'user', texto: mensagemCliente }, { role: 'model', texto: resposta }];
  const historico = [...(lead.historico || []), { dt: hoje(), icone: 'blue', acao: '💬 Conversa Eloá', obs: `Cliente: "${mensagemCliente}" · Eloá: "${resposta}"`, by: 'Eloá' }];
  await fbUpdate('leads', leadId, { conversaEloa: novaConversa, historico });

  if (encaminharConsultor) {
    const leadAtualizado = { ...lead, conversaEloa: novaConversa, historico };
    await encaminharParaConsultor(leadAtualizado, 'Assunto exigia consultor humano (preço/financiamento/pedido do cliente) ou conversa já madura.');
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
  await reconstruirTelParaLeadId();
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
    const jid = msg.key.remoteJid;
    const jidTel = msg.key.remoteJidAlt || msg.key.remoteJid;
    const telDigits = jidTel.split('@')[0].replace(/\D/g, '');
    const leadId = telParaLeadId.get(telDigits) || telParaLeadId.get(telDigits.replace(/^55/, ''));
    if (!leadId) return; // não é um número que a Eloá cumprimentou
    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '(mensagem sem texto)';
    responderComIA(jid, leadId, texto).catch(console.error);
  });
}

start().catch((e) => console.error('Erro ao iniciar Eloá:', e));
