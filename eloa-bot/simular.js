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
const fs = require('fs');
const path = require('path');
const { gerarResposta } = require('./gemini');

const ARQ = path.join(__dirname, 'simulacao.json');
const PADRAO_PRECO = /r\$\s?\d|\b\d{1,3}(\.\d{3})+\s*reais\b|\bfinanciamento\b|\bparcela(s)?\b|\bentrada de\b/i;

function carregar() {
  try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { return { lead: { clienteNome: 'Cliente Simulado', veiculo: 'BYD Song Plus', origem: 'Webmotors' }, historico: [] }; }
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
  const iOrigem = args.indexOf('--origem');
  if (iOrigem !== -1) {
    estado.lead.origem = args[iOrigem + 1];
    args.splice(iOrigem, 2);
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
  try {
    const lead = primeiroContato ? { ...estado.lead, _primeiroContato: true } : estado.lead;
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
  if (resultado.enviarFotos) console.log('📷 [enviaria a foto do veículo agora]');
  if (encaminharConsultor) console.log('\n🔔 [encaminharia para consultor humano agora]');

  if (primeiroContato) estado.historico.push({ role: 'model', texto: mensagens.join(' ') });
  else estado.historico.push({ role: 'user', texto: mensagemCliente }, { role: 'model', texto: mensagens.join(' ') });
  salvar(estado);
}

main();
