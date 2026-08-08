/* Eloá — atendimento automático a leads novos (coluna "I.A." do kanban).
   Assim que um lead chega (via webhook do Autoconf ou cadastro manual), a Eloá
   já inicia o primeiro contato por IA (Gemini, ver gemini.js), seguindo o
   perfil em persona.md e a base de conhecimento em base-conhecimento.md —
   não existe mais mensagem fixa, nem pra saudação nem pra conversa. Depois
   da mensagem de abertura ainda manda uma foto real do veículo de interesse.
   A IA decide quando encaminhar pra um consultor humano (visita agendada,
   pergunta comercial, pedido explícito do cliente); até lá, o lead permanece
   em "I.A." e a Eloá conduz a conversa sozinha, objetivo principal sendo
   agendar uma visita à loja.

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
   depois que o cliente escreve algo. As chaves ficam num arquivo .env
   nesta pasta (nunca commitado) — ver .env.example. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino')({ level: 'silent' });
const qrcode = require('qrcode');
const { fbList, fbUpdate } = require('./firestore');
const { gerarResposta } = require('./gemini');
const { gerarNotaDeVoz } = require('./voz');
const ESTOQUE_RTCAR = require('./estoque.json');

const INTERVALO_POLL_MS = 20000; // checa leads novos a cada 20s
const NOTIFICACAO_PESSOAL = '5551998050105@s.whatsapp.net'; // avisa o Rubens quando um consultor humano precisa assumir

/* Liga/desliga nota de voz nas respostas da conversa (não na saudação
   inicial). Escolha do provedor em voz.js via ELOA_VOZ_PROVEDOR. Ainda não
   testado de ponta a ponta — ver aviso no topo de voz.js. */
const MODO_VOZ = (process.env.ELOA_MODO_VOZ || '').toLowerCase() === 'true';

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
function hoje() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
/* Sempre usar só os últimos 8 dígitos como chave pro Map telefone->lead —
   evita depender de o número vir com ou sem o "9" extra do celular
   brasileiro (WhatsApp é inconsistente nisso), mesmo problema já visto e
   corrigido no agente de resgate (Cora) e na demo original da Eloá. */
function chaveTel(tel) {
  return (tel || '').replace(/\D/g, '').slice(-8);
}
function paraJid(tel) {
  const digitos = (tel || '').replace(/\D/g, '');
  if (!digitos) return null;
  const comDDI = digitos.startsWith('55') ? digitos : `55${digitos}`;
  return `${comDDI}@s.whatsapp.net`;
}

/* Checkpoint persistido em disco pra nunca mais varrer o backlog inteiro de
   leads antigos "I.A." — incidente real em 07/08/2026: sem isso, a Eloá
   cumprimentou 36 leads reais e antigos na primeira vez que conectou com um
   número de WhatsApp válido. Na primeira execução (arquivo não existe), o
   checkpoint começa em "agora", então nada anterior a isso é processado. */
const CHECKPOINT_PATH = path.join(__dirname, 'ultimo-check.json');
const MAX_SAUDACOES_POR_CICLO = 3; // trava extra: nunca mandar mais que isso de uma vez

function lerCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8')).ultimoCheck; } catch { return null; }
}
function salvarCheckpoint(iso) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({ ultimoCheck: iso }));
}
let checkpoint = lerCheckpoint();
if (!checkpoint) {
  checkpoint = new Date().toISOString();
  salvarCheckpoint(checkpoint);
  console.log(`Primeira execução — checkpoint iniciado em ${checkpoint}. Leads criados antes disso não serão cumprimentados.`);
}

async function getLeadsNovos() {
  const leads = await fbList('leads');
  return leads
    .filter((l) => l.st === 'ia' && !l.eloaEnviadoEm && l.clienteTel && l.origem !== 'Teste' && l._criadoEm && l._criadoEm > checkpoint)
    .sort((a, b) => a._criadoEm.localeCompare(b._criadoEm))
    .slice(0, MAX_SAUDACOES_POR_CICLO);
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
      const chave = chaveTel(l.clienteTel);
      if (chave) telParaLeadId.set(chave, l.id);
    });
}

/* Envia cada mensagem como bolha separada (texto ou nota de voz, conforme
   MODO_VOZ), com uma pequena pausa entre elas pra imitar cadência humana. */
async function enviarMensagens(jid, mensagens) {
  for (let i = 0; i < mensagens.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
    if (MODO_VOZ) {
      try {
        const audio = await gerarNotaDeVoz(mensagens[i]);
        await sock.sendMessage(jid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        continue;
      } catch (e) {
        console.error('Nota de voz falhou, mandando texto:', e.message);
      }
    }
    await sock.sendMessage(jid, { text: mensagens[i] });
  }
}

/* Segunda barreira, além da instrução em persona.md: se a resposta da IA
   mesmo assim citar preço/financiamento, ela é substituída e o lead é
   forçado a encaminhar pro consultor — preço é sensível demais pra confiar
   só no comportamento do modelo. */
function garantirSemPreco(mensagens) {
  if (!mensagens.some((m) => PADRAO_PRECO.test(m))) return { mensagens, forcarEncaminhar: false };
  console.warn(`⚠️ Resposta da IA continha preço/financiamento — bloqueada e encaminhada. Texto original: ${JSON.stringify(mensagens)}`);
  return {
    mensagens: ['Essa parte de valores e condições eu prefiro confirmar com um consultor pra te passar certinho — já vou te conectar com alguém.'],
    forcarEncaminhar: true,
  };
}

async function enviarFotoVeiculo(jid, lead) {
  const veiculo = buscarVeiculoEstoque(lead.veiculo);
  if (!veiculo?.foto) {
    console.log(`(enviarFotos pedido, mas nenhuma foto encontrada no estoque para "${lead.veiculo}")`);
    return;
  }
  await sock.sendMessage(jid, { image: { url: veiculo.foto }, caption: `${veiculo.b} ${veiculo.m}` });
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

  const veiculo = buscarVeiculoEstoque(lead.veiculo);

  let resultado;
  try {
    resultado = await gerarResposta(
      { ...lead, _primeiroContato: true },
      [],
      '(sem mensagem do cliente ainda — inicie o primeiro contato, conduzindo para o agendamento de visita)',
    );
  } catch (e) {
    console.error(`Erro ao gerar saudação por IA para ${lead.clienteNome}:`, e.message);
    return; // não manda nada fixo — melhor tentar de novo no próximo ciclo do que mandar mensagem genérica
  }

  const { mensagens } = garantirSemPreco(resultado.mensagens);

  try {
    await enviarMensagens(jid, mensagens);
    if (veiculo?.foto) {
      await new Promise((r) => setTimeout(r, 1200));
      await sock.sendMessage(jid, { image: { url: veiculo.foto }, caption: `${veiculo.b} ${veiculo.m}` });
    }

    telParaLeadId.set(chaveTel(jid.split('@')[0]), lead.id);
    telParaLeadId.set(chaveTel(lead.clienteTel), lead.id);

    const respostaCompleta = mensagens.join(' ');
    const conversaEloa = [{ role: 'model', texto: respostaCompleta }];
    const historico = [...(lead.historico || []), { dt: hoje(), icone: 'purple', acao: '🤖 Primeiro contato (Eloá)', obs: respostaCompleta, by: 'Eloá' }];
    await fbUpdate('leads', lead.id, { eloaEnviadoEm: new Date().toISOString(), conversaEloa, historico });
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

  const seguro = garantirSemPreco(resultado.mensagens);
  const mensagens = seguro.mensagens;
  const encaminharConsultor = resultado.encaminharConsultor || seguro.forcarEncaminhar;

  try {
    await enviarMensagens(jid, mensagens);
    if (resultado.enviarFotos) await enviarFotoVeiculo(jid, lead);
  } catch (e) {
    console.error(`Erro ao enviar resposta da IA para ${leadId}:`, e.message);
    return;
  }

  const respostaCompleta = mensagens.join(' ');
  const novaConversa = [...conversa, { role: 'user', texto: mensagemCliente }, { role: 'model', texto: respostaCompleta }];
  const historico = [...(lead.historico || []), { dt: hoje(), icone: 'blue', acao: '💬 Conversa Eloá', obs: `Cliente: "${mensagemCliente}" · Eloá: "${respostaCompleta}"`, by: 'Eloá' }];
  await fbUpdate('leads', leadId, { conversaEloa: novaConversa, historico });

  if (encaminharConsultor) {
    const leadAtualizado = { ...lead, conversaEloa: novaConversa, historico };
    await encaminharParaConsultor(leadAtualizado, 'Assunto exigia consultor humano (preço/financiamento/pedido do cliente) ou conversa já madura.');
  }
}

async function cicloPoll() {
  const inicioDoCiclo = new Date().toISOString();
  try {
    const novos = await getLeadsNovos();
    if (novos.length) console.log(`${novos.length} lead(s) novo(s) — cumprimentando (máx. ${MAX_SAUDACOES_POR_CICLO} por ciclo).`);
    for (const lead of novos) await cumprimentarLead(lead);
  } catch (e) {
    console.error('Erro no ciclo de checagem de leads novos:', e.message);
  }
  // Avança o checkpoint só depois de processar, e só até o início deste ciclo
  // (nunca além de "agora"), pra não pular um lead que chegou durante o ciclo.
  checkpoint = inicioDoCiclo;
  salvarCheckpoint(checkpoint);
  setTimeout(cicloPoll, INTERVALO_POLL_MS);
}

let pollJaIniciado = false;
function iniciarPollUmaVez() {
  if (pollJaIniciado) return;
  pollJaIniciado = true;
  cicloPoll();
}

async function start() {
  await reconstruirTelParaLeadId();
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({ auth: state, logger: P, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  // Código de pareamento é mais robusto que QR (não expira em segundos) —
  // usado só se ELOA_TEL estiver definida no .env; senão cai no QR normal.
  const telPareamento = process.env.ELOA_TEL;
  if (!state.creds.registered && telPareamento) {
    try {
      await new Promise((r) => setTimeout(r, 3000)); // deixa o socket estabilizar antes de pedir o código
      const codigo = await sock.requestPairingCode(telPareamento);
      console.log(`\n=== CÓDIGO DE PAREAMENTO: ${codigo} ===`);
      console.log(`No WhatsApp desse número: Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone → digite ${codigo}\n`);
    } catch (e) {
      console.error('Erro ao solicitar código de pareamento:', e.message);
    }
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !telPareamento) {
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
      iniciarPollUmaVez();
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    const jidTel = msg.key.remoteJidAlt || msg.key.remoteJid;
    const chave = chaveTel(jidTel.split('@')[0]);
    const leadId = telParaLeadId.get(chave);
    if (!leadId) return; // não é um número que a Eloá cumprimentou
    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!texto) return; // figurinha, áudio, reação, mensagem automática de ausência etc. — não é fala real do cliente
    responderComIA(jid, leadId, texto).catch(console.error);
  });
}

start().catch((e) => console.error('Erro ao iniciar Eloá:', e));
