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
const { buscarDadosReais } = require('./dadosVeiculo');
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
  // Exige que TODAS as palavras significativas casem — um match parcial (ex: só a marca)
  // fazia "Volvo XC90" (que não existe) casar erroneamente com "Volvo XC60" (que existe).
  return melhorScore === palavras.length ? melhor : null;
}
/* Enriquece o lead com dados reais do site (fotos múltiplas + specs), além
   do que já vem do estoque.json. Se a busca no site falhar por qualquer
   motivo, retorna só o que já tinha (marca/modelo/1 foto) — nunca trava a
   conversa por isso. */
/* Acha um veículo do estoque real citado DENTRO de um texto livre (ex: a
   mensagem do cliente) — sem isso, o sistema só teria dados reais do
   veículo original do lead, mesmo quando o cliente muda de assunto pra
   outro veículo no meio da conversa. */
function buscarVeiculoNoTexto(texto) {
  const alvo = normalizarTxt(texto).replace(/\s+/g, '');
  if (!alvo) return null;
  let melhor = null, melhorLen = 0;
  ESTOQUE_RTCAR.forEach((item) => {
    const modelo = normalizarTxt(item.m).replace(/\s+/g, '');
    if (modelo.length >= 3 && alvo.includes(modelo) && modelo.length > melhorLen) { melhor = item; melhorLen = modelo.length; }
  });
  if (melhor) return melhor;
  // Cliente pode citar só a primeira palavra do modelo, sem a variante/trim (ex: "golf" em vez de
  // "Golf GTi") — sem isso, uma menção real e específica ao veículo não era reconhecida.
  ESTOQUE_RTCAR.forEach((item) => {
    const primeira = normalizarTxt(item.m).split(' ')[0];
    if (primeira.length >= 4 && alvo.includes(primeira) && primeira.length > melhorLen) { melhor = item; melhorLen = primeira.length; }
  });
  return melhor;
}
async function buscarDadosCompletos(lead, mensagemAtual) {
  const item = (mensagemAtual && buscarVeiculoNoTexto(mensagemAtual)) || buscarVeiculoEstoque(lead.veiculo);
  if (!item) return null;
  const reais = await buscarDadosReais(item.pagina);
  return { ...item, ...reais, fotos: reais?.fotos?.length ? reais.fotos : (item.foto ? [item.foto] : []) };
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
   MODO_VOZ), com uma pequena pausa entre elas pra imitar cadência humana, e
   mostrando "digitando..."/"gravando áudio..." de verdade enquanto gera.
   `aindaValido()` (opcional) é checado antes de cada bolha — se retornar
   false (o cliente já mandou mensagem nova nesse meio-tempo), interrompe o
   envio das bolhas restantes em vez de terminar de mandar uma resposta que
   já ficou velha. Retorna true se completou, false se foi cancelado no meio. */
async function enviarMensagens(jid, mensagens, aindaValido = () => true) {
  for (let i = 0; i < mensagens.length; i++) {
    if (!aindaValido()) return false;
    if (i > 0) await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
    if (MODO_VOZ) {
      try {
        await sock.sendPresenceUpdate('recording', jid);
        const audio = await gerarNotaDeVoz(mensagens[i]);
        if (!aindaValido()) return false; // já era antiga quando a voz ficou pronta
        await sock.sendMessage(jid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        continue;
      } catch (e) {
        console.error('Nota de voz falhou, mandando texto:', e.message);
      }
    }
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 700));
    if (!aindaValido()) return false;
    await sock.sendMessage(jid, { text: mensagens[i] });
  }
  return true;
}

/* Segunda barreira, além da instrução em persona.md: se a resposta da IA
   mesmo assim citar preço/financiamento, ela é substituída e o lead é
   forçado a encaminhar pro consultor — preço é sensível demais pra confiar
   só no comportamento do modelo. */
function garantirSemPreco(mensagens) {
  if (!mensagens.some((m) => PADRAO_PRECO.test(m))) return { mensagens, forcarEncaminhar: false };
  console.warn(`⚠️ Resposta da IA continha preço/financiamento — bloqueada e encaminhada. Texto original: ${JSON.stringify(mensagens)}`);
  return {
    mensagens: ['Isso eu prefiro confirmar certinho com um consultor — já vou te conectar com alguém.'],
    forcarEncaminhar: true,
  };
}

const MAX_FOTOS_ENVIADAS = 3;

/* Manda até 3 fotos reais do veículo (buscadas do site, com fallback pra 1
   foto do estoque.json se a busca falhar) — a primeira com legenda com
   specs reais (ano, km, câmbio, cor), nunca com preço. */
async function enviarFotoVeiculo(jid, dados) {
  if (!dados?.fotos?.length) {
    console.log(`(enviarFotos pedido, mas nenhuma foto encontrada)`);
    return;
  }
  const specs = [dados.cor, dados.ano, dados.km ? `${dados.km} km` : null, dados.cambio, dados.potencia ? `${dados.potencia}cv` : null].filter(Boolean).join(' · ');
  const legenda = `${dados.b} ${dados.m}${specs ? ' — ' + specs : ''}`;
  const fotos = dados.fotos.slice(0, MAX_FOTOS_ENVIADAS);
  for (let i = 0; i < fotos.length; i++) {
    await sock.sendMessage(jid, i === 0 ? { image: { url: fotos[i] }, caption: legenda } : { image: { url: fotos[i] } });
    if (i < fotos.length - 1) await new Promise((r) => setTimeout(r, 1000));
  }
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

  const dadosVeiculo = await buscarDadosCompletos(lead);

  let resultado;
  try {
    resultado = await gerarResposta(
      { ...lead, _primeiroContato: true, _dadosVeiculo: dadosVeiculo },
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
    if (resultado.enviarFotos) {
      await new Promise((r) => setTimeout(r, 1200));
      await enviarFotoVeiculo(jid, dadosVeiculo);
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

/* Cancelamento cooperativo por lead: cada mensagem nova do cliente incrementa
   o turno daquele lead. Se uma resposta ainda em andamento (gerando texto ou
   voz) descobrir que o turno mudou, ela para de mandar bolhas/fotos em vez
   de terminar uma resposta que já ficou desatualizada. Não cancela a
   requisição de rede já em voo (o fetch do Gemini/TTS que já começou
   continua até terminar, só o resultado é descartado). */
const turnoPorLead = new Map();

async function responderComIA(jid, leadId, mensagemCliente, meuTurno) {
  const leads = await fbList('leads');
  const lead = leads.find((l) => l.id === leadId);
  if (!lead || lead.st !== 'ia') return; // já não está mais em I.A. (evita reprocessar)

  const aindaValido = () => turnoPorLead.get(leadId) === meuTurno;

  const conversa = lead.conversaEloa || [];
  const dadosVeiculo = await buscarDadosCompletos(lead, mensagemCliente);

  let resultado;
  try {
    resultado = await gerarResposta({ ...lead, _dadosVeiculo: dadosVeiculo }, conversa, mensagemCliente);
  } catch (e) {
    console.error(`Erro ao gerar resposta da IA para ${leadId}:`, e.message);
    if (aindaValido()) await encaminharParaConsultor(lead, `A Eloá não conseguiu responder por IA (${e.message}) — encaminhado direto pra não deixar o cliente sem retorno.`);
    return;
  }

  if (!aindaValido()) { console.log(`[cancelado] lead ${leadId}: chegou mensagem nova antes da resposta a "${mensagemCliente}" ficar pronta.`); return; }

  const seguro = garantirSemPreco(resultado.mensagens);
  const mensagens = seguro.mensagens;
  const encaminharConsultor = resultado.encaminharConsultor || seguro.forcarEncaminhar;

  let completou;
  try {
    completou = await enviarMensagens(jid, mensagens, aindaValido);
    if (completou && resultado.enviarFotos) await enviarFotoVeiculo(jid, dadosVeiculo);
  } catch (e) {
    console.error(`Erro ao enviar resposta da IA para ${leadId}:`, e.message);
    return;
  }

  if (!completou) { console.log(`[cancelado] lead ${leadId}: parou de mandar a resposta a "${mensagemCliente}" no meio — mensagem nova chegou.`); return; }

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
    const meuTurno = (turnoPorLead.get(leadId) || 0) + 1;
    turnoPorLead.set(leadId, meuTurno);
    responderComIA(jid, leadId, texto, meuTurno).catch(console.error);
  });
}

start().catch((e) => console.error('Erro ao iniciar Eloá:', e));
