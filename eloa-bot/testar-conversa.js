/* Escuta as respostas de UM número de teste e responde de verdade como a
   Eva (persona.md), via WhatsApp real, usando a sessão já vinculada em
   ./auth. Só pra teste manual — não usa Firestore, não é a Eloá de
   produção (index.js). Fica rodando até você parar (Ctrl+C).

   Uso:
     node testar-conversa.js <telefone> [veiculo] [origem]
*/
require('dotenv').config();
// Testes usam uma chave Gemini separada (cota grátis própria), pra não gastar a cota da produção.
if (process.env.GOOGLE_AI_API_KEY_TESTE) process.env.GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY_TESTE;
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const P = require('pino')({ level: 'silent' });
const { gerarResposta } = require('./gemini');
const { gerarNotaDeVoz } = require('./voz');
const { buscarDadosReais } = require('./dadosVeiculo');
const ESTOQUE_RTCAR = require('./estoque.json');

const [, , TEL, VEICULO = 'BYD Song Plus', ORIGEM = 'Webmotors'] = process.argv;
const MODO_VOZ = (process.env.ELOA_MODO_VOZ || '').toLowerCase() === 'true';
const PADRAO_PRECO = /r\$\s?\d|\b\d{1,3}(\.\d{3})+\s*reais\b|\bfinanciamento\b|\bparcela(s)?\b|\bentrada de\b/i;
const HIST_PATH = path.join(__dirname, 'testar-conversa-historico.json');
const MAX_FOTOS_ENVIADAS = 3;

/* Mesma lógica de busca de dados reais do simular.js/index.js — sem isso, a
   Eva não tem specs/fotos confirmadas e corretamente se recusa a inventar. */
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
async function montarDados(item) {
  if (!item) return null;
  const reais = await buscarDadosReais(item.pagina);
  return { ...item, ...reais, fotos: reais?.fotos?.length ? reais.fotos : (item.foto ? [item.foto] : []) };
}

async function enviarFotoVeiculo(sock, jid, dados) {
  if (!dados?.fotos?.length) { console.log('(enviarFotos pedido, mas nenhuma foto encontrada)'); return; }
  const specs = [dados.cor, dados.ano, dados.km ? `${dados.km} km` : null, dados.cambio, dados.potencia ? `${dados.potencia}cv` : null].filter(Boolean).join(' · ');
  const legenda = `${dados.b} ${dados.m}${specs ? ' — ' + specs : ''}`;
  const fotos = dados.fotos.slice(0, MAX_FOTOS_ENVIADAS);
  for (let i = 0; i < fotos.length; i++) {
    await sock.sendMessage(jid, i === 0 ? { image: { url: fotos[i] }, caption: legenda } : { image: { url: fotos[i] } });
    console.log(`Eva (foto ${i + 1}/${fotos.length}): ${fotos[i]}`);
    if (i < fotos.length - 1) await new Promise((r) => setTimeout(r, 1000));
  }
}

function garantirSemPreco(mensagens) {
  if (!mensagens.some((m) => PADRAO_PRECO.test(m))) return { mensagens, forcarEncaminhar: false };
  console.warn('⚠️ Resposta continha preço/financiamento — bloqueada. Texto original:', JSON.stringify(mensagens));
  return {
    mensagens: ['Isso eu prefiro confirmar certinho com um consultor — já vou te conectar com alguém.'],
    forcarEncaminhar: true,
  };
}

function carregarHistorico() {
  try { return JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); } catch { return []; }
}
function salvarHistorico(h) {
  fs.writeFileSync(HIST_PATH, JSON.stringify(h, null, 2));
}

async function main() {
  if (!TEL) {
    console.log('Uso: node testar-conversa.js <telefone> [veiculo] [origem]');
    process.exit(1);
  }

  let historico = carregarHistorico();
  const lead = { clienteNome: 'teste', veiculo: VEICULO, origem: ORIGEM };
  /* "Veículo atual da conversa" — começa como o do lead, e muda pro que o
     cliente mencionar. Fica "grudado" nesse veículo entre turnos (não só na
     mensagem mais recente), senão uma pergunta de acompanhamento sem repetir
     o nome do modelo ("como está o de vocês aí?") perdia o contexto e voltava
     pro veículo original do lead. */
  let itemAtual = buscarVeiculoEstoque(lead.veiculo);

  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') console.log(`\n✅ Escutando respostas de ${TEL} — mande uma mensagem de lá.\n`);
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      console.log('Conexão fechada:', code, update.lastDisconnect?.error?.message);
      if (code !== 401) {
        console.log('Reconectando...');
        main().catch((e) => console.error('ERRO ao reconectar:', e.message));
      } else {
        console.log('Sessão desconectada (401) — precisa de um QR novo.');
      }
    }
  });

  /* Cancelamento cooperativo: cada mensagem nova incrementa turnoAtual. Antes
     de cada passo que pode demorar (gerar resposta, mandar cada bolha/foto),
     o turno em andamento confere se ainda é o mais recente — se não for,
     para na hora, sem terminar de mandar uma resposta que já ficou velha.
     Não cancela a requisição de rede em si (o fetch do TTS/Gemini já em voo
     continua rodando até acabar, só o resultado é descartado) — cancelar a
     chamada de fato exigiria passar um AbortSignal até dentro de voz.js/
     gemini.js, não feito nesta primeira versão. */
  let turnoAtual = 0;

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      console.log(`(recebido de ${msg.key.remoteJid})`); // diagnóstico — sessão de teste único, sem filtro de número

      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!texto) { console.log('(mensagem recebida sem texto — ignorada, ex: áudio/figurinha)'); continue; }

      turnoAtual += 1;
      const meuTurno = turnoAtual;

      console.log(`\nCliente: ${texto}`);
      let resultado;
      let dadosVeiculoUsado;
      try {
        const mudouPara = buscarVeiculoNoTexto(texto);
        if (mudouPara) itemAtual = mudouPara;
        dadosVeiculoUsado = await montarDados(itemAtual);
        resultado = await gerarResposta({ ...lead, _dadosVeiculo: dadosVeiculoUsado }, historico, texto);
      } catch (e) {
        console.error('Erro ao gerar resposta (1ª tentativa):', e.message);
        try {
          resultado = await gerarResposta({ ...lead, _dadosVeiculo: dadosVeiculoUsado }, historico, texto);
        } catch (e2) {
          console.error('Erro ao gerar resposta (2ª tentativa) — encaminhando pra não deixar o cliente sem retorno:', e2.message);
          resultado = { mensagens: ['Desculpa a demora — tive um problema aqui. Já vou te conectar com um consultor pra te ajudar.'], encaminharConsultor: true, enviarFotos: false };
        }
      }

      if (meuTurno !== turnoAtual) { console.log(`[cancelado] chegou mensagem nova antes da resposta a "${texto}" ficar pronta — descartando.`); continue; }

      const seguro = garantirSemPreco(resultado.mensagens);
      const mensagens = seguro.mensagens;
      const encaminharConsultor = resultado.encaminharConsultor || seguro.forcarEncaminhar;

      const jid = msg.key.remoteJid;
      let cancelado = false;
      for (let i = 0; i < mensagens.length; i++) {
        if (meuTurno !== turnoAtual) { cancelado = true; break; }
        if (i > 0) await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
        if (MODO_VOZ) {
          try {
            await sock.sendPresenceUpdate('recording', jid); // "gravando áudio..." enquanto gera de verdade
            const audio = await gerarNotaDeVoz(mensagens[i]);
            if (meuTurno !== turnoAtual) { cancelado = true; break; } // já era antiga quando a voz ficou pronta
            await sock.sendMessage(jid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
            console.log(`Eva (voz): ${mensagens[i]}`);
            continue;
          } catch (e) {
            console.error('Nota de voz falhou, mandando texto:', e.message);
          }
        }
        await sock.sendPresenceUpdate('composing', jid); // "digitando..."
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 700)); // tempo mínimo pra o indicador aparecer de verdade
        if (meuTurno !== turnoAtual) { cancelado = true; break; }
        await sock.sendMessage(jid, { text: mensagens[i] });
        console.log(`Eva: ${mensagens[i]}`);
      }

      if (cancelado) { console.log(`[cancelado] parou de mandar a resposta a "${texto}" no meio — mensagem nova chegou.`); continue; }

      if (resultado.enviarFotos) await enviarFotoVeiculo(sock, jid, dadosVeiculoUsado);

      historico = [...historico, { role: 'user', texto }, { role: 'model', texto: mensagens.join(' ') }];
      salvarHistorico(historico);

      if (encaminharConsultor) console.log('\n🔔 [encaminharia para consultor humano agora]');
    }
  });
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
