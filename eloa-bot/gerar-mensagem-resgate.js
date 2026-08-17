/* Gera (sem enviar) a mensagem de abertura do fluxo Resgate v2 — pra Rubens
   copiar e mandar manualmente pelo próprio celular, enquanto a sessão
   automática do WhatsApp estiver desvinculada.

   Uso:
     node gerar-mensagem-resgate.js <nome> <veiculo> <origem> "<mensagem original do cliente>"
*/
require('dotenv').config();
const { gerarResposta } = require('./gemini');

const [, , NOME_CLIENTE, VEICULO, ORIGEM, MENSAGEM_ORIGINAL] = process.argv;

async function main() {
  if (!NOME_CLIENTE) {
    console.log('Uso: node gerar-mensagem-resgate.js <nome> <veiculo> <origem> "<mensagem original>"');
    process.exit(1);
  }
  const lead = { clienteNome: NOME_CLIENTE, veiculo: VEICULO, origem: ORIGEM, _persona: 'persona-resgate.md', _mensagemOriginal: MENSAGEM_ORIGINAL };
  const { mensagens } = await gerarResposta(lead, [], '(sem resposta ainda — inicie a mensagem de reconexão)');
  console.log('\n=== Mensagens pra copiar e enviar ===\n');
  mensagens.forEach((m, i) => console.log(`(${i + 1}/${mensagens.length}) ${m}\n`));
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
