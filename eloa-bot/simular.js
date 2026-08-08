/* Simula uma conversa contínua com a Eloá sem precisar de WhatsApp/celular.
   Uso:
     node simular.js "mensagem do cliente"
     node simular.js --reset            (começa uma conversa nova)
     node simular.js --veiculo "BYD Song Plus" "mensagem do cliente"  (define o veículo do lead simulado)

   O histórico fica salvo em simulacao.json (nesta pasta) entre chamadas, então
   cada execução continua a mesma conversa até você rodar --reset. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { gerarResposta } = require('./gemini');

const ARQ = path.join(__dirname, 'simulacao.json');
const PADRAO_PRECO = /r\$\s?\d|\b\d{1,3}(\.\d{3})+\s*reais\b|\bfinanciamento\b|\bparcela(s)?\b|\bentrada de\b/i;

function carregar() {
  try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { return { lead: { clienteNome: 'Cliente Simulado', veiculo: 'BYD Song Plus' }, historico: [] }; }
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
    args.splice(iVeiculo, 2);
  }

  const mensagemCliente = args.join(' ').trim();
  if (!mensagemCliente) {
    console.log('Uso: node simular.js "mensagem do cliente"  (ou --reset pra começar de novo)');
    console.log(`Conversa atual: ${estado.historico.length} mensagem(ns) — veículo simulado: ${estado.lead.veiculo}`);
    return;
  }

  let resultado;
  try {
    resultado = await gerarResposta(estado.lead, estado.historico, mensagemCliente);
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

  console.log(`\nCliente: ${mensagemCliente}`);
  mensagens.forEach((m) => console.log(`Eloá: ${m}`));
  if (encaminharConsultor) console.log('\n🔔 [encaminharia para consultor humano agora]');

  estado.historico.push({ role: 'user', texto: mensagemCliente }, { role: 'model', texto: mensagens.join(' ') });
  salvar(estado);
}

main();
