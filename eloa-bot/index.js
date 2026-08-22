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
const { fbList, fbGet, fbUpdate } = require('./firestore');
const { gerarResposta, gerarFollowUp } = require('./claude');
const { gerarNotaDeVoz } = require('./voz');
const { buscarDadosReais } = require('./dadosVeiculo');
const ESTOQUE_RTCAR = require('./estoque.json');

const INTERVALO_POLL_MS = 20000; // checa leads novos a cada 20s

/* MVP temporário (18/08/2026, a pedido do Rubens; ajustado 19/08/2026 a
   pedido da Aline): enquanto a Eva ainda tem bugs em produção, ela
   cumprimenta e, assim que o cliente responder qualquer coisa pela primeira
   vez, manda a foto do veículo (forçando o envio se já tivermos os dados,
   mesmo sem pedido explícito) e já encaminha pro vendedor — sem continuar a
   conversa completa. O persona.md e o fluxo completo continuam intactos no
   código pra quando quisermos reativar; só mudar isto pra false. */
const MODO_SIMPLES_ATIVO = true;
const NOTIFICACAO_PESSOAL = '5551998050105@s.whatsapp.net'; // avisa o Rubens quando um consultor humano precisa assumir (fallback se o vendedor do rodízio não tiver WhatsApp cadastrado abaixo)

/* WhatsApp de cada vendedor do rodízio (mesmos nomes usados em RODIZIO_VENDEDORES
   abaixo e em rtcar-modulos.html) — usado pra encaminhar direto pro
   vendedor da vez (lead.captador) em vez de sempre avisar só o Rubens. */
const WHATSAPP_VENDEDORES = {
  Janderson: '554796732227@s.whatsapp.net', // sem o "9" — número real dele, confirmado (18/08/2026) por bater com o que onWhatsApp já resolvia
  Maicon: '554791800978@s.whatsapp.net', // sem o "9" — número real dele, confirmado 18/08/2026
  Milena: '5547999938679@s.whatsapp.net', // recebe 100% dos leads de "Compra" (avaliação/venda do veículo do cliente), fora do rodízio
};

/* Até 20/08/2026, o vendedor da vez era sorteado no momento em que o Autoconf
   criava o lead (dentro de webhook-autoconf/index.js) — mesmo que o cliente
   nunca respondesse, o que desequilibrava o rodízio (lead sem resposta
   "gastava" a vez de um vendedor do mesmo jeito que um cliente engajado). A
   pedido do Rubens, o sorteio agora só acontece em encaminharParaConsultor,
   no momento de um encaminhamento de verdade pra atendimento humano — um
   lead nunca respondido não consome vez de ninguém. O webhook-autoconf não
   assina mais vendedor nenhum pra leads que não sejam de "Compra" (deixa
   captador vazio até aqui). */
const RODIZIO_VENDEDORES = ['Janderson', 'Maicon'];
let filaRodizio = Promise.resolve(); // serializa leitura+escrita do contador — evita dois clientes respondendo quase juntos "empatarem" no mesmo vendedor
function atribuirVendedorRodizio() {
  const proxima = filaRodizio.then(async () => {
    const doc = await fbGet('leads_config', 'rodizio').catch(() => null);
    const idx = ((doc && doc.idx) || 0) % RODIZIO_VENDEDORES.length;
    await fbUpdate('leads_config', 'rodizio', { idx: idx + 1 });
    return RODIZIO_VENDEDORES[idx];
  });
  filaRodizio = proxima.catch(() => {}); // erro num sorteio não pode travar a fila pros próximos
  return proxima;
}

/* Retomada automática de contato (a pedido do Rubens, 19/08/2026) quando o
   cliente não responde depois da última mensagem da Eva. "horas" é o total
   acumulado desde a última mensagem (não incremental) — bate com o plano:
   Step 1 em 4h, Step 2 em +4h (8h), Step 3 em +6h (14h), Step 4 em +10h (24h).
   Parado no Step 4 de propósito: um Step 5 (48h+) exigiria um template
   pré-aprovado na API oficial do WhatsApp Business — a Eva usa o Baileys
   (não é a API oficial), então mandar mensagem livre depois de 24h sem
   resposta é puro risco de a Meta marcar o número como spam, sem o
   benefício de compliance que o template daria. */
const FOLLOWUP_STEPS = [
  {
    horas: 4,
    instrucao: 'Retome o contato de forma leve, como continuação natural da conversa, sem parecer cobrança. Pergunte se o cliente conseguiu pensar sobre o veículo ou se ficou alguma dúvida. Mantenha tom tranquilo e disponível.',
  },
  {
    horas: 8,
    instrucao: 'Reforce de forma breve os diferenciais do veículo e da RT Car (vitrificação, revisão completa, garantia), sem repetir tudo que já foi dito antes. Pergunte se há algo específico travando a decisão (preço, condições, dúvida técnica).',
  },
  {
    horas: 14,
    instrucao: 'Aproxime-se de forma mais pessoal, perguntando diretamente se o cliente ainda tem interesse no veículo ou se prefere que você sugira outra opção do estoque. Mostre disponibilidade total para ajudar, sem soar insistente.',
  },
  {
    horas: 24,
    instrucao: 'Envie uma mensagem com tom gentil, reconhecendo que talvez o cliente esteja ocupado ou ainda decidindo. Reforce que você está à disposição sem pressão. Inclua uma pergunta curta e fácil de responder.',
  },
];
const INTERVALO_FOLLOWUP_MS = 15 * 60 * 1000; // checa a cada 15min — steps são em horas, não precisa de granularidade fina

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
  // "Golf GTi", ou "ora"/"208" em vez de "Ora 03 Skin"/"208 Griffe") — sem isso, uma menção real e
  // específica ao veículo não era reconhecida. Mínimo de 3 (não 4) pra cobrir esses dois casos reais.
  ESTOQUE_RTCAR.forEach((item) => {
    const primeira = normalizarTxt(item.m).split(' ')[0];
    if (primeira.length >= 3 && alvo.includes(primeira) && primeira.length > melhorLen) { melhor = item; melhorLen = primeira.length; }
  });
  return melhor;
}
/* Acha o veículo do assunto atual olhando a mensagem mais recente primeiro e,
   se ela não citar nenhum (ex: "sim", "manda foto", "me conta mais"), volta
   no histórico até achar a última vez que o cliente citou um veículo — sem
   isso, o assunto "esquecia" o veículo assim que o cliente parava de repetir
   o nome dele a cada mensagem, e a busca caía de volta pro veículo original
   do lead no meio da conversa (incidente real: cliente pediu fotos do GWM
   Ora, mas como a mensagem "Sim" não citava o nome, vieram fotos do BYD Song
   Plus — o veículo original — em vez do Ora). */
function buscarVeiculoNoHistorico(mensagemAtual, conversa) {
  if (mensagemAtual) {
    const item = buscarVeiculoNoTexto(mensagemAtual);
    if (item) return item;
  }
  for (let i = conversa.length - 1; i >= 0; i--) {
    if (conversa[i].role !== 'user') continue;
    const item = buscarVeiculoNoTexto(conversa[i].texto);
    if (item) return item;
  }
  return null;
}
async function buscarDadosCompletos(lead, mensagemAtual, conversa = []) {
  const item = buscarVeiculoNoHistorico(mensagemAtual, conversa) || buscarVeiculoEstoque(lead.veiculo);
  if (!item) return null;
  const reais = await buscarDadosReais(item.pagina);
  return { ...item, ...reais, fotos: reais?.fotos?.length ? reais.fotos : (item.foto ? [item.foto] : []) };
}

function hoje() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
// Igual a hoje(), mas com horário — usado só no "dt" de cada evento do
// historico (a pedido do Rubens, 21/08/2026, pra dar pra ver o horário exato
// de cada etapa no painel de acompanhamento, não só o dia).
function agoraDt() {
  const d = new Date();
  return `${hoje()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

/* Retorna true se o lead ficou "resolvido" (cumprimentado OU descartado por
   motivo permanente, ex.: número inválido) e false se falhou por motivo
   transitório (deve ser tentado de novo no próximo ciclo). cicloPoll usa
   esse retorno pra decidir até onde pode avançar o checkpoint. */
async function cumprimentarLead(lead) {
  const jidTentativa = paraJid(lead.clienteTel);
  if (!jidTentativa) return true; // telefone sem dígitos: não adianta tentar de novo
  let jid = jidTentativa;
  try {
    const numero = jidTentativa.split('@')[0];
    const check = await sock.onWhatsApp(numero);
    if (check?.[0]?.exists) jid = check[0].jid;
    else {
      console.log(`⚠️ Número de ${lead.clienteNome} (${lead.clienteTel}) não encontrado no WhatsApp — pulando.`);
      await fbUpdate('leads', lead.id, { eloaEnviadoEm: 'NUMERO_INVALIDO' });
      return true;
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
    return false; // não manda nada fixo — melhor tentar de novo no próximo ciclo do que mandar mensagem genérica
  }

  const { mensagens } = garantirSemPreco(resultado.mensagens);

  try {
    await enviarMensagens(jid, mensagens);
    let fotosEnviadas = false;
    if (resultado.enviarFotos) {
      await new Promise((r) => setTimeout(r, 1200));
      await enviarFotoVeiculo(jid, dadosVeiculo);
      fotosEnviadas = true;
    }

    telParaLeadId.set(chaveTel(jid.split('@')[0]), lead.id);
    telParaLeadId.set(chaveTel(lead.clienteTel), lead.id);

    const respostaCompleta = mensagens.join(' ');
    const conversaEloa = [{ role: 'model', texto: respostaCompleta }];
    const historico = [...(lead.historico || []), { dt: agoraDt(), icone: 'purple', acao: '🤖 Primeiro contato (Eloá)', obs: respostaCompleta, by: 'Eloá' }];
    const agoraISO = new Date().toISOString();
    await fbUpdate('leads', lead.id, { eloaEnviadoEm: agoraISO, ultimaMensagemEm: agoraISO, followUpStep: 0, conversaEloa, historico });
    console.log(`✅ Eloá cumprimentou ${lead.clienteNome} (${lead.id}).`);

    // MVP temporário — ver comentário de MODO_SIMPLES_ATIVO no topo do arquivo.
    if (MODO_SIMPLES_ATIVO && fotosEnviadas) {
      await encaminharParaConsultor(
        { ...lead, conversaEloa, historico },
        'Modo simplificado ativo — encaminha direto pro vendedor assim que manda a foto do veículo, sem continuar a conversa.',
      );
    }
    return true;
  } catch (e) {
    console.error(`Erro ao cumprimentar ${lead.clienteNome}:`, e.message);
    return false;
  }
}

async function encaminharParaConsultor(lead, motivoResumo) {
  if (!lead.captador) {
    // Lead ainda não passou pelo rodízio (cliente "não qualificado" até este
    // momento) — sorteia agora, na hora do encaminhamento de verdade.
    lead = { ...lead, captador: await atribuirVendedorRodizio() };
  }
  const historico = [...(lead.historico || []), { dt: agoraDt(), icone: 'green', acao: '✅ Encaminhado para esteira (Eloá)', obs: motivoResumo, by: 'Eloá' }];
  await fbUpdate('leads', lead.id, { st: 'atendimento', atendimento_at: new Date().toISOString(), historico, captador: lead.captador });
  console.log(`✅ Lead ${lead.id} movido de "I.A." para "Atendimento" — vendedor ${lead.captador} — ${motivoResumo}`);

  // Encaminha pro vendedor da vez (lead.captador, atribuído pelo rodízio no
  // Autoconf ou na tela manual do CRM). Resolve o JID de verdade via
  // onWhatsApp — mesma validação que cumprimentarLead já faz — em vez de
  // mandar direto pro JID construído a partir do número puro: mandar sem
  // validar pode "funcionar" sem erro e mesmo assim não entregar nada, se
  // esse número tiver variação do "9" (comum em número brasileiro antigo)
  // (incidente real: notificação pro Janderson não chegou, 18/08/2026).
  // Se o vendedor não tiver WhatsApp cadastrado, ou o número não existir no
  // WhatsApp, cai de volta pro Rubens — nunca deixa um lead sem ninguém avisado.
  const numeroVendedorCru = WHATSAPP_VENDEDORES[lead.captador];
  let vendedorJid = null;
  if (numeroVendedorCru) {
    try {
      const check = await sock.onWhatsApp(numeroVendedorCru.split('@')[0]);
      if (check?.[0]?.exists) vendedorJid = check[0].jid;
      else console.error(`Número de ${lead.captador} (${numeroVendedorCru}) não encontrado no WhatsApp — encaminhando pro Rubens.`);
    } catch (e) {
      console.error(`Erro ao validar número de ${lead.captador}, encaminhando pro Rubens:`, e.message);
    }
  }

  const destino = vendedorJid || NOTIFICACAO_PESSOAL;
  const texto = vendedorJid
    ? `🔔 Novo atendimento pra você! A Eva encaminhou ${lead.clienteNome || lead.id} pra você assumir.\nOrigem: ${lead.origem || '-'}\nMotivo: ${motivoResumo}\nVeículo: ${lead.veiculo || '-'}\nTelefone do cliente: ${lead.clienteTel || '-'}`
    : `🔔 A Eloá encaminhou ${lead.clienteNome || lead.id} pra atendimento humano (vendedor "${lead.captador || 'não definido'}" sem WhatsApp válido cadastrado — confira o número dele).\nOrigem: ${lead.origem || '-'}\nMotivo: ${motivoResumo}\nVeículo: ${lead.veiculo || '-'}`;

  try {
    await sock.sendMessage(destino, { text: texto });
    // Evento separado do "Encaminhado para esteira" acima — aqui é a confirmação
    // real de que o WhatsApp foi enviado (não é confirmação de entrega/leitura,
    // o Baileys não expõe isso de forma confiável, só que o envio não deu erro).
    const historicoNotif = [
      ...historico,
      {
        dt: agoraDt(),
        icone: 'purple',
        acao: vendedorJid ? `📲 Notificação enviada a ${lead.captador}` : '📲 Notificação enviada (fallback pro Rubens)',
        obs: vendedorJid ? '' : `Vendedor "${lead.captador || 'não definido'}" sem WhatsApp válido cadastrado — confira o número dele.`,
        by: 'Eloá',
      },
    ];
    await fbUpdate('leads', lead.id, { historico: historicoNotif, notificacaoVendedorEm: new Date().toISOString() });
  } catch (e) {
    console.error(`Erro ao notificar ${vendedorJid ? lead.captador : 'Rubens'} sobre encaminhamento:`, e.message);
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
  // 22/08/2026: antes checava "conversa.length === 1" (só a saudação existia
  // antes desta troca) - mas isso só cobria quem responde ANTES de qualquer
  // follow-up. Um cliente que só responde depois de 1+ follow-ups (a
  // conversa já tinha mais de 1 mensagem, todas da Eva) escapava do modo
  // simplificado e caía no fluxo completo de IA, voltando a "negociar"
  // como vendedora (caso real: Cláudio/Mateus perguntando por Porsche 911,
  // 22/08/2026). Checar se NENHUMA mensagem anterior é do cliente cobre os
  // dois casos.
  const primeiraRespostaDoCliente = !conversa.some((m) => m.role === 'user');
  const dadosVeiculo = await buscarDadosCompletos(lead, mensagemCliente, conversa);

  /* MVP temporário (18/08/2026, ajustado 19/08/2026 a pedido da Aline): na
     primeira resposta do cliente, a Eva NÃO gera mais uma resposta completa
     via IA — isso fazia ela "trabalhar de vendedora" (comparar modelos,
     perguntar preferência, etc.) mesmo já estando prestes a transferir, o
     oposto do objetivo do modo simplificado (incidente real: Mislene,
     LEAD-009, 19/08/2026 — a Eva comparou Creta x HR-V e perguntou qual ela
     preferia antes de encaminhar). Em vez disso: manda uma mensagem curta e
     neutra, a foto do veículo se já der pra identificar, e já transfere. O
     fluxo completo do persona.md (gerarResposta) continua intacto logo
     abaixo pra quando quisermos reativar — só mudar MODO_SIMPLES_ATIVO pra
     false. */
  if (MODO_SIMPLES_ATIVO && primeiraRespostaDoCliente) {
    const primeiroNome = (lead.clienteNome || '').trim().split(' ')[0];
    const mensagens = [`Entendi${primeiroNome ? ', ' + primeiroNome : ''}! Vou te conectar agora com um consultor da nossa equipe, que já te passa todos os detalhes 😊`];

    let completou;
    let fotosEnviadas = false;
    try {
      completou = await enviarMensagens(jid, mensagens, aindaValido);
      if (completou && dadosVeiculo?.fotos?.length) {
        await enviarFotoVeiculo(jid, dadosVeiculo);
        fotosEnviadas = true;
      }
    } catch (e) {
      console.error(`Erro ao enviar resposta (modo simples) para ${leadId}:`, e.message);
      return;
    }

    if (!completou) { console.log(`[cancelado] lead ${leadId}: parou de mandar a resposta (modo simples) a "${mensagemCliente}" no meio — mensagem nova chegou.`); return; }

    const respostaCompleta = mensagens.join(' ');
    const novaConversa = [...conversa, { role: 'user', texto: mensagemCliente }, { role: 'model', texto: respostaCompleta }];
    const historico = [...(lead.historico || []), { dt: agoraDt(), icone: 'blue', acao: '💬 Conversa Eloá', obs: `Cliente: "${mensagemCliente}" · Eloá: "${respostaCompleta}"`, by: 'Eloá' }];
    await fbUpdate('leads', leadId, { conversaEloa: novaConversa, historico, ultimaMensagemEm: new Date().toISOString(), followUpStep: 0 });

    const leadAtualizado = { ...lead, conversaEloa: novaConversa, historico };
    await encaminharParaConsultor(leadAtualizado, `Modo simplificado ativo — encaminha assim que o cliente responde qualquer coisa, sem continuar a conversa${fotosEnviadas ? ' (foto do veículo já enviada)' : ''}.`);
    return;
  }

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

  let completou;
  let fotosEnviadas = false;
  try {
    completou = await enviarMensagens(jid, mensagens, aindaValido);
    if (completou && resultado.enviarFotos) {
      await enviarFotoVeiculo(jid, dadosVeiculo);
      fotosEnviadas = true;
    }
  } catch (e) {
    console.error(`Erro ao enviar resposta da IA para ${leadId}:`, e.message);
    return;
  }

  if (!completou) { console.log(`[cancelado] lead ${leadId}: parou de mandar a resposta a "${mensagemCliente}" no meio — mensagem nova chegou.`); return; }

  const respostaCompleta = mensagens.join(' ');
  const novaConversa = [...conversa, { role: 'user', texto: mensagemCliente }, { role: 'model', texto: respostaCompleta }];
  const historico = [...(lead.historico || []), { dt: agoraDt(), icone: 'blue', acao: '💬 Conversa Eloá', obs: `Cliente: "${mensagemCliente}" · Eloá: "${respostaCompleta}"`, by: 'Eloá' }];
  // Cliente respondeu de verdade agora — reseta o relógio do follow-up (zera o
  // step, senão ele retomaria do meio da escada da próxima vez que ficar quieto).
  await fbUpdate('leads', leadId, { conversaEloa: novaConversa, historico, ultimaMensagemEm: new Date().toISOString(), followUpStep: 0 });

  let motivoEncaminhar = null;
  if (resultado.encaminharConsultor || seguro.forcarEncaminhar) {
    motivoEncaminhar = 'Assunto exigia consultor humano (preço/financiamento/pedido do cliente) ou conversa já madura.';
  } else if (MODO_SIMPLES_ATIVO && fotosEnviadas) {
    motivoEncaminhar = 'Modo simplificado ativo — encaminha assim que manda a foto do veículo, sem continuar a conversa.';
  }

  if (motivoEncaminhar) {
    const leadAtualizado = { ...lead, conversaEloa: novaConversa, historico };
    await encaminharParaConsultor(leadAtualizado, motivoEncaminhar);
  }
}

/* 20/08/2026 (a pedido da Aline): qualquer lead que fique em "atendimento"
   JÁ COM VENDEDOR DEFINIDO precisa gerar aviso por WhatsApp pra esse
   vendedor — não importa se é um lead de "Compra" (webhook já cria direto
   em atendimento/Milena) ou se foi cadastrado manualmente por alguém direto
   no CRM, escolhendo o vendedor na hora (esses nunca passam pela Eva, então
   sem este ciclo aqui ninguém nunca avisaria o vendedor). Não conflita com
   getLeadsCadastroManualParaNotificar (que trata o caso contrário: lead em
   atendimento SEM vendedor ainda) — os dois filtros são mutuamente
   exclusivos pelo campo captador. */
async function getLeadsParaNotificarVendedor() {
  const leads = await fbList('leads');
  return leads.filter((l) => l.st === 'atendimento' && l.captador && !l.notificacaoVendedorEm && l.clienteTel);
}

async function notificarVendedorAtribuido(lead) {
  const numeroVendedorCru = WHATSAPP_VENDEDORES[lead.captador];
  let vendedorJid = null;
  if (numeroVendedorCru) {
    try {
      const check = await sock.onWhatsApp(numeroVendedorCru.split('@')[0]);
      if (check?.[0]?.exists) vendedorJid = check[0].jid;
    } catch (e) {
      console.error(`Erro ao validar número de ${lead.captador} pra notificar lead ${lead.id}:`, e.message);
    }
  }
  const destino = vendedorJid || NOTIFICACAO_PESSOAL;
  const primeiraLinhaObs = (lead.obs || '').split('\n')[0];
  const ehCompra = lead.origem === 'Compra';
  const texto = vendedorJid
    ? (ehCompra
      ? `🔔 Novo lead de COMPRA (avaliação/venda de veículo) pra você!\nCliente: ${lead.clienteNome || lead.id}\nTelefone: ${lead.clienteTel || '-'}${primeiraLinhaObs ? '\n' + primeiraLinhaObs : ''}`
      : `🔔 Novo lead atribuído pra você!\nCliente: ${lead.clienteNome || lead.id}\nOrigem: ${lead.origem || '-'}\nVeículo: ${lead.veiculo || '-'}\nTelefone: ${lead.clienteTel || '-'}${primeiraLinhaObs ? '\n' + primeiraLinhaObs : ''}`)
    : `🔔 Lead (${lead.clienteNome || lead.id}) sem WhatsApp válido cadastrado pro vendedor "${lead.captador || 'não definido'}" — confira o número dele.\nTelefone do cliente: ${lead.clienteTel || '-'}`;

  try {
    await sock.sendMessage(destino, { text: texto });
    const historico = [
      ...(lead.historico || []),
      {
        dt: agoraDt(),
        icone: 'purple',
        acao: vendedorJid ? `📲 Notificação enviada a ${lead.captador}` : '📲 Notificação enviada (fallback pro Rubens)',
        obs: vendedorJid ? '' : `Vendedor "${lead.captador || 'não definido'}" sem WhatsApp válido cadastrado — confira o número dele.`,
        by: 'Eloá',
      },
    ];
    await fbUpdate('leads', lead.id, { notificacaoVendedorEm: new Date().toISOString(), historico });
    console.log(`✅ Notificação enviada pra ${lead.captador || 'Rubens'} (${lead.id}).`);
  } catch (e) {
    console.error(`Erro ao notificar ${lead.captador || 'Rubens'} sobre lead ${lead.id}:`, e.message);
  }
}

/* Leads de cadastro manual (Loja/Carteira de clientes/Passante, a pedido do
   Rubens, 21/08/2026): o webhook-autoconf já cria eles direto em
   st:'atendimento', mas sem vendedor definido (não dá pra saber ainda, pelo
   payload do Autoconf, qual vendedor especificamente cadastrou). Em vez de
   ficar sem ninguém avisado, segue a mesma lógica de qualquer outro
   encaminhamento: sorteia pelo rodízio (mesmo atribuirVendedorRodizio usado
   quando o cliente responde à Eva) e notifica por WhatsApp. */
async function getLeadsCadastroManualParaNotificar() {
  const leads = await fbList('leads');
  return leads.filter((l) => l.st === 'atendimento' && !l.captador && !l.notificacaoVendedorEm && l.clienteTel);
}

async function notificarCadastroManual(lead) {
  const captador = await atribuirVendedorRodizio();
  const numeroVendedorCru = WHATSAPP_VENDEDORES[captador];
  let vendedorJid = null;
  if (numeroVendedorCru) {
    try {
      const check = await sock.onWhatsApp(numeroVendedorCru.split('@')[0]);
      if (check?.[0]?.exists) vendedorJid = check[0].jid;
    } catch (e) {
      console.error(`Erro ao validar número de ${captador} pra notificar cadastro manual ${lead.id}:`, e.message);
    }
  }
  const destino = vendedorJid || NOTIFICACAO_PESSOAL;
  const texto = vendedorJid
    ? `🔔 Novo lead (${lead.origem || 'cadastro manual'}) pra você!\nCliente: ${lead.clienteNome || lead.id}\nTelefone: ${lead.clienteTel || '-'}\nVeículo: ${lead.veiculo || '-'}`
    : `🔔 Lead de cadastro manual (${lead.clienteNome || lead.id}) sem WhatsApp válido cadastrado pro vendedor "${captador}" — confira o número dele.\nTelefone do cliente: ${lead.clienteTel || '-'}`;

  try {
    await sock.sendMessage(destino, { text: texto });
    const historico = [
      ...(lead.historico || []),
      { dt: agoraDt(), icone: 'green', acao: `✅ Vendedor sorteado (${captador})`, obs: `Cadastro manual via Autoconf (${lead.origem || '-'}) — sorteado pelo rodízio, mesma lógica do encaminhamento da Eva.`, by: 'Eloá' },
      { dt: agoraDt(), icone: 'purple', acao: vendedorJid ? `📲 Notificação enviada a ${captador}` : '📲 Notificação enviada (fallback pro Rubens)', obs: vendedorJid ? '' : `Vendedor "${captador}" sem WhatsApp válido cadastrado — confira o número dele.`, by: 'Eloá' },
    ];
    await fbUpdate('leads', lead.id, { captador, notificacaoVendedorEm: new Date().toISOString(), historico });
    console.log(`✅ Notificação de cadastro manual enviada pra ${captador} (${lead.id}).`);
  } catch (e) {
    console.error(`Erro ao notificar ${captador} sobre cadastro manual ${lead.id}:`, e.message);
  }
}

/* Se o webhook-autoconf falhar de verdade (mesmo com a transação atômica
   que agora protege a criação do lead — 22/08/2026), ele grava um registro
   em erros_webhook em vez de deixar o lead sumir silenciosamente. Aqui a
   Eva fica de olho nesses erros e avisa o Rubens por WhatsApp assim que
   encontrar um novo, pra dar pra recuperar manualmente rápido, sem depender
   de alguém notar por acaso dias depois (foi assim que perdemos o Maycon). */
async function getErrosWebhookParaNotificar() {
  const erros = await fbList('erros_webhook');
  return erros.filter((e) => !e.notificadoEm);
}

async function notificarErroWebhook(erro) {
  const nome = (erro.body && erro.body.name) || 'desconhecido';
  const tel = (erro.body && (erro.body.mobile_phone || erro.body.phone)) || 'desconhecido';
  const texto = `⚠️ Falha ao criar um lead vindo do Autoconf!\nCliente: ${nome}\nTelefone: ${tel}\nErro: ${erro.erro}\nVerifique e recupere manualmente se for um lead real.`;
  const docId = (erro._docName || '').split('/').pop();
  try {
    await sock.sendMessage(NOTIFICACAO_PESSOAL, { text: texto });
    if (docId) await fbUpdate('erros_webhook', docId, { notificadoEm: new Date().toISOString() });
    console.log(`⚠️ Notificação de erro do webhook enviada — cliente ${nome}.`);
  } catch (e) {
    console.error('Erro ao notificar falha do webhook:', e.message);
  }
}

/* Mecanismo simples pra mandar um aviso avulso (não automático) pra um
   vendedor, reaproveitando a conexão do WhatsApp que já está ativa — sem
   isso, não tem como mandar mensagem manual sem arriscar derrubar a sessão
   rodando (Baileys não permite duas conexões na mesma pasta ./auth). Usado
   pela primeira vez em 22/08/2026 pra avisar Janderson/Maicon/Milena sobre
   o efeito colateral das notificações de leads antigos. Documentos são
   criados manualmente na coleção mensagens_avulsas: campo "destino" (nome
   do vendedor, chave de WHATSAPP_VENDEDORES) e "texto" (a mensagem). */
async function getMensagensAvulsasParaEnviar() {
  const msgs = await fbList('mensagens_avulsas');
  return msgs.filter((m) => !m.enviadaEm && m.destino && m.texto);
}

async function enviarMensagemAvulsa(msg) {
  const docId = (msg._docName || '').split('/').pop();
  const numeroVendedorCru = WHATSAPP_VENDEDORES[msg.destino];
  if (!numeroVendedorCru) {
    console.error(`Destino desconhecido pra mensagem avulsa: ${msg.destino}`);
    return;
  }
  let jid = numeroVendedorCru;
  try {
    const check = await sock.onWhatsApp(numeroVendedorCru.split('@')[0]);
    if (check?.[0]?.exists) jid = check[0].jid;
  } catch (e) {
    console.error(`Erro ao validar número de ${msg.destino} pra mensagem avulsa:`, e.message);
  }
  try {
    await sock.sendMessage(jid, { text: msg.texto });
    if (docId) await fbUpdate('mensagens_avulsas', docId, { enviadaEm: new Date().toISOString() });
    console.log(`✅ Mensagem avulsa enviada pra ${msg.destino}.`);
  } catch (e) {
    console.error(`Erro ao enviar mensagem avulsa pra ${msg.destino}:`, e.message);
  }
}

async function cicloPoll() {
  const inicioDoCiclo = new Date().toISOString();
  let novos = [];
  let ultimoOk = null;
  let todosOk = true;
  try {
    const mensagensAvulsas = await getMensagensAvulsasParaEnviar();
    for (const msg of mensagensAvulsas) await enviarMensagemAvulsa(msg);
  } catch (e) {
    console.error('Erro ao enviar mensagens avulsas:', e.message);
  }
  try {
    const errosParaNotificar = await getErrosWebhookParaNotificar();
    for (const erro of errosParaNotificar) await notificarErroWebhook(erro);
  } catch (e) {
    console.error('Erro ao notificar falhas do webhook:', e.message);
  }
  try {
    const parasNotificar = await getLeadsParaNotificarVendedor();
    for (const lead of parasNotificar) await notificarVendedorAtribuido(lead);
  } catch (e) {
    console.error('Erro ao notificar vendedores sobre leads atribuídos:', e.message);
  }
  try {
    const cadastrosManuaisParaNotificar = await getLeadsCadastroManualParaNotificar();
    for (const lead of cadastrosManuaisParaNotificar) await notificarCadastroManual(lead);
  } catch (e) {
    console.error('Erro ao notificar leads de cadastro manual:', e.message);
  }
  try {
    novos = await getLeadsNovos();
    if (novos.length) console.log(`${novos.length} lead(s) novo(s) — cumprimentando (máx. ${MAX_SAUDACOES_POR_CICLO} por ciclo).`);
    for (const lead of novos) {
      const ok = await cumprimentarLead(lead);
      if (ok) {
        ultimoOk = lead;
      } else {
        todosOk = false;
        break; // não pula pros próximos — mantém a ordem e tenta este de novo no próximo ciclo
      }
    }
  } catch (e) {
    console.error('Erro no ciclo de checagem de leads novos:', e.message);
    todosOk = false;
  }
  /* Avança o checkpoint só depois de processar, e só até onde deu pra
     confirmar sucesso. Se algum lead falhou por motivo transitório (ex.:
     erro 529 "overloaded" da IA — incidente real: lead PATRICK, 18/08/2026),
     o checkpoint NÃO pode passar da hora de criação dele, senão getLeadsNovos
     (_criadoEm > checkpoint) nunca mais o encontra e ele fica abandonado pra
     sempre mesmo sem eloaEnviadoEm. Se todos os leads do lote foram
     resolvidos e o lote bateu no limite de MAX_SAUDACOES_POR_CICLO, pode
     haver mais represados atrás — avança só até o último processado (em vez
     de pular pra "agora"). Sem represamento, avança até o início deste ciclo
     normalmente, nunca além de "agora". */
  if (todosOk) {
    checkpoint = novos.length === MAX_SAUDACOES_POR_CICLO ? novos[novos.length - 1]._criadoEm : inicioDoCiclo;
    salvarCheckpoint(checkpoint);
  } else if (ultimoOk) {
    checkpoint = ultimoOk._criadoEm;
    salvarCheckpoint(checkpoint);
  } // se nem o primeiro lead do lote foi resolvido, o checkpoint fica parado onde estava
  setTimeout(cicloPoll, INTERVALO_POLL_MS);
}

/* Acha leads que a Eva já cumprimentou (ou já conversou) mas que o cliente
   parou de responder — a última mensagem da conversa é da Eva, não dele.
   Não mexe em leads onde o cliente respondeu por último (o fluxo normal via
   responderComIA já cuida desses) nem em quem já recebeu os 4 steps. */
async function getLeadsParaFollowUp() {
  const leads = await fbList('leads');
  const agora = Date.now();
  return leads.filter((l) => {
    if (l.st !== 'ia' || !l.eloaEnviadoEm || l.eloaEnviadoEm === 'NUMERO_INVALIDO') return false;
    if (l.origem === 'Teste') return false;
    const conversa = l.conversaEloa || [];
    if (!conversa.length || conversa[conversa.length - 1].role !== 'model') return false;
    const step = l.followUpStep || 0;
    if (step >= FOLLOWUP_STEPS.length) return false;
    const desde = l.ultimaMensagemEm || l.eloaEnviadoEm;
    const horasPassadas = (agora - new Date(desde).getTime()) / 3600000;
    return horasPassadas >= FOLLOWUP_STEPS[step].horas;
  });
}

async function enviarFollowUp(lead) {
  const jidTentativa = paraJid(lead.clienteTel);
  if (!jidTentativa) return;
  let jid = jidTentativa;
  try {
    const check = await sock.onWhatsApp(jidTentativa.split('@')[0]);
    if (check?.[0]?.exists) jid = check[0].jid;
  } catch (e) {
    console.error(`Erro ao validar número pro follow-up de ${lead.clienteNome}, tentando mesmo assim:`, e.message);
  }

  const conversa = lead.conversaEloa || [];
  const step = lead.followUpStep || 0;
  const { instrucao } = FOLLOWUP_STEPS[step];

  let resultado;
  try {
    resultado = await gerarFollowUp(lead, conversa, instrucao);
  } catch (e) {
    console.error(`Erro ao gerar follow-up (step ${step + 1}) para ${lead.clienteNome}:`, e.message);
    return;
  }

  const { mensagens } = garantirSemPreco(resultado.mensagens);
  try {
    const completou = await enviarMensagens(jid, mensagens);
    if (!completou) return;
    const respostaCompleta = mensagens.join(' ');
    const novaConversa = [...conversa, { role: 'model', texto: respostaCompleta }];
    const historico = [...(lead.historico || []), { dt: agoraDt(), icone: 'purple', acao: `🔁 Follow-up automático (step ${step + 1}/${FOLLOWUP_STEPS.length})`, obs: respostaCompleta, by: 'Eloá' }];
    await fbUpdate('leads', lead.id, { conversaEloa: novaConversa, historico, followUpStep: step + 1, ultimaMensagemEm: new Date().toISOString() });
    console.log(`✅ Follow-up (step ${step + 1}/${FOLLOWUP_STEPS.length}) enviado pra ${lead.clienteNome} (${lead.id}).`);
    if (resultado.encaminharConsultor) {
      await encaminharParaConsultor({ ...lead, conversaEloa: novaConversa, historico }, 'Follow-up automático indicou necessidade de consultor.');
    }
  } catch (e) {
    console.error(`Erro ao enviar follow-up pra ${lead.clienteNome}:`, e.message);
  }
}

async function cicloFollowUp() {
  try {
    const pendentes = await getLeadsParaFollowUp();
    for (const lead of pendentes) await enviarFollowUp(lead);
  } catch (e) {
    console.error('Erro no ciclo de follow-up:', e.message);
  }
  setTimeout(cicloFollowUp, INTERVALO_FOLLOWUP_MS);
}

let pollJaIniciado = false;
function iniciarPollUmaVez() {
  if (pollJaIniciado) return;
  pollJaIniciado = true;
  cicloPoll();
  cicloFollowUp();
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
