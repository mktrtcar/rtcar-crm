/* Simula uma conversa contínua com a Eloá sem precisar de WhatsApp/celular.
   Uso:
     node simular.js --primeiro                                        (simula o primeiro contato, como se fosse um lead novo)
     node simular.js "mensagem do cliente"                             (continua a conversa)
     node simular.js --reset                                           (começa uma conversa nova)
     node simular.js --veiculo "BYD Song Plus" "mensagem do cliente"   (define o veículo do lead simulado)
     node simular.js --origem "Webmotors" --primeiro                   (define a plataforma de origem)

   O histórico fica salvo em simulacao.json (nesta pasta) entre chamadas, então
   cada execução continua a mesma conversa até você rodar --reset. */
require('dotenv').config();
// Testes usam uma chave Gemini separada (cota grátis própria), pra não gastar a cota da produção.
if (process.env.GOOGLE_AI_API_KEY_TESTE) process.env.GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY_TESTE;
const fs = require('fs');
const path = require('path');
const { gerarResposta } = require('./gemini');
const { buscarDadosReais } = require('./dadosVeiculo');
const ESTOQUE_RTCAR = require('./estoque.json');

const ARQ = path.join(__dirname, 'simulacao.json');
const PADRAO_PRECO = /r\$\s?\d|\b\d{1,3}(\.\d{3})+\s*reais\b|\bfinanciamento\b|\bparcela(s)?\b|\bentrada de\b/i;

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
   mensagem do cliente) — diferente de buscarVeiculoEstoque, que compara o
   texto inteiro contra marca+modelo. Usa pra detectar quando o cliente muda
   de assunto pra outro veículo no meio da conversa (ex: pediu o veículo do
   lead, depois perguntou de um Volvo XC40 — sem isso, o sistema só teria
   dados reais do veículo original do lead pra sempre). */
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

function carregar() {
  try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { return { lead: { clienteNome: 'Cliente Simulado', veiculo: 'BYD Song Plus', origem: 'Webmotors' }, historico: [], itemAtual: null }; }
}
function salvar(estado) {
  fs.writeFileSync(ARQ, JSON.stringify(estado, null, 2));
}

async function main() {
  const args = [...process.argv.slice(2)];

  if (args.includes('--reset')) {
    if (fs.existsSync(ARQ)) fs.unlinkSync(ARQ);
    console.log('Conversa simulada reiniciada.');
    return;
  }

  const estado = carregar();

  const iVeiculo = args.indexOf('--veiculo');
  if (iVeiculo !== -1) {
    estado.lead.veiculo = args[iVeiculo + 1];
    estado.itemAtual = buscarVeiculoEstoque(estado.lead.veiculo);
    args.splice(iVeiculo, 2);
  }
  if (estado.itemAtual === undefined) estado.itemAtual = buscarVeiculoEstoque(estado.lead.veiculo);
  const iOrigem = args.indexOf('--origem');
  if (iOrigem !== -1) {
    estado.lead.origem = args[iOrigem + 1];
    args.splice(iOrigem, 2);
  }
  const iAgora = args.indexOf('--agora');
  if (iAgora !== -1) {
    process.env.ELOA_AGORA_TESTE = args[iAgora + 1]; // ex: "domingo, 22:30"
    args.splice(iAgora, 2);
  }

  const primeiroContato = args.includes('--primeiro');
  if (primeiroContato) args.splice(args.indexOf('--primeiro'), 1);

  const mensagemCliente = primeiroContato
    ? '(sem mensagem do cliente ainda — inicie o primeiro contato, conduzindo para o agendamento de visita)'
    : args.join(' ').trim();
  if (!mensagemCliente) {
    console.log('Uso: node simular.js "mensagem do cliente"  (ou --primeiro / --reset)');
    console.log(`Conversa atual: ${estado.historico.length} mensagem(ns) — veículo: ${estado.lead.veiculo} — origem: ${estado.lead.origem}`);
    return;
  }

  let resultado;
  let dadosVeiculoUsado;
  try {
    if (!primeiroContato) {
      const mudouPara = buscarVeiculoNoTexto(mensagemCliente);
      if (mudouPara) estado.itemAtual = mudouPara;
    }
    dadosVeiculoUsado = await montarDados(estado.itemAtual);
    const lead = { ...estado.lead, _dadosVeiculo: dadosVeiculoUsado, ...(primeiroContato ? { _primeiroContato: true } : {}) };
    resultado = await gerarResposta(lead, estado.historico, mensagemCliente);
  } catch (e) {
    console.error('Erro ao gerar resposta:', e.message);
    return;
  }

  let { mensagens, encaminharConsultor } = resultado;
  if (mensagens.some((m) => PADRAO_PRECO.test(m))) {
    console.warn('⚠️ [trava de preço acionada — texto original da IA bloqueado]');
    mensagens = ['Essa parte de valores e condições eu prefiro confirmar com um consultor pra te passar certinho — já vou te conectar com alguém.'];
    encaminharConsultor = true;
  }

  console.log(primeiroContato ? '\n[Primeiro contato — lead novo, ainda sem resposta]' : `\nCliente: ${mensagemCliente}`);
  mensagens.forEach((m) => console.log(`Eloá: ${m}`));
  if (resultado.enviarFotos) console.log(`📷 [enviaria ${dadosVeiculoUsado?.fotos?.length || 0} foto(s) real(is) do veículo agora]`);
  if (encaminharConsultor) console.log('\n🔔 [encaminharia para consultor humano agora]');

  if (primeiroContato) estado.historico.push({ role: 'model', texto: mensagens.join(' ') });
  else estado.historico.push({ role: 'user', texto: mensagemCliente }, { role: 'model', texto: mensagens.join(' ') });
  salvar(estado);
}

main();
