const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const MODELO = 'claude-opus-5';
const client = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente

function carregarTexto(nome) {
  try { return fs.readFileSync(path.join(__dirname, nome), 'utf8'); } catch { return ''; }
}

function agora() {
  // Override só pra teste (simular.js --agora "..."), nunca usado em produção.
  if (process.env.ELOA_AGORA_TESTE) return process.env.ELOA_AGORA_TESTE;
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

let ESTOQUE_RTCAR;
function montarListaEstoque() {
  try {
    if (!ESTOQUE_RTCAR) ESTOQUE_RTCAR = require('./estoque.json');
    const lista = ESTOQUE_RTCAR.map((v) => `${v.b} ${v.m}`).join(', ');
    return `Estoque atual da RT Car (retrato, marca e modelo — não é consulta em tempo real, pode ter mudado): ${lista}. Se o cliente perguntar por uma marca/modelo que NÃO está nessa lista, diga que no momento não temos esse específico, sem inventar um substituto — pode oferecer encaminhar pra um consultor confirmar alternativas. Se estiver na lista mas não for o veículo original desta conversa: olhe a linha "Dados específicos confirmados do veículo" acima — se ela trouxer dados reais desse outro modelo, use-os normalmente (specs, fotos via enviarFotos, tudo) como faria com o veículo original; só diga que não tem os dados dessa unidade e ofereça encaminhar se essa linha vier vazia/sem dados.`;
  } catch {
    return '';
  }
}

function montarLinhaDadosVeiculo(dados) {
  if (!dados) return 'Dados específicos confirmados do veículo desta conversa: NENHUM encontrado — trate qualquer pergunta específica (km, ano, cor, opcionais) como não confirmada.';
  const partes = [
    dados.ano ? `ano ${dados.ano}` : null,
    dados.km ? `${dados.km} km` : null,
    dados.cor ? `cor ${dados.cor}` : null,
    dados.cambio ? `câmbio ${dados.cambio}` : null,
    dados.potencia ? `${dados.potencia} cv` : null,
    dados.opcionais?.length ? `opcionais: ${dados.opcionais.join(', ')}` : null,
  ].filter(Boolean);
  if (!partes.length) return 'Dados específicos confirmados do veículo desta conversa: NENHUM encontrado — trate qualquer pergunta específica (km, ano, cor, opcionais) como não confirmada.';
  return `Dados específicos confirmados do veículo QUE ESTÁ SENDO DISCUTIDO AGORA nesta conversa (já é a unidade certa, mesmo que o cliente tenha mudado de assunto de veículo antes — NUNCA diga que não tem a ficha/dados dessa unidade, você TEM, use exatamente estes; pode usar pra responder pergunta direta, NUNCA cite preço mesmo que soubesse): ${partes.join(', ')}.`;
}

function montarInstrucaoSistema(lead, historico) {
  const arquivoPersona = lead._persona || 'persona.md';
  const ehResgate = arquivoPersona === 'persona-resgate.md';
  const persona = carregarTexto(arquivoPersona);
  const conhecimento = carregarTexto('base-conhecimento.md');

  const contextoEloa = ehResgate ? '' : `
Agora é: ${agora()} (horário de Brusque-SC) — compare com o horário de funcionamento da loja (base de conhecimento) antes de sugerir "hoje" como opção de visita. Se a loja já estiver fechada ou for tarde demais pra dar tempo de vir hoje, não ofereça "hoje" — pule direto pra "amanhã" ou pergunte o melhor dia.
${montarLinhaDadosVeiculo(lead._dadosVeiculo)}
${montarListaEstoque()}
${lead._primeiroContato ? 'Este é o PRIMEIRO contato — o cliente ainda não respondeu nada. Inicie pelo passo 1 do fluxo de atendimento (primeiro contato).' : ''}`;

  const jaMandouFotos = !ehResgate && historico?.some((h) => h.role === 'model' && /vou te (mandar|enviar) (uma |algumas )?foto/i.test(h.texto || ''));
  const formatoFotos = ehResgate ? '' : `

"enviarFotos" deve ser true SÓ quando a mensagem MAIS RECENTE do cliente (a que você está respondendo agora) pedir foto(s) do veículo ou "mais detalhes"/"mais informações" dele de forma genérica — não pelo clima geral da conversa, nem porque ele disse "sim"/demonstrou interesse em algo que não é foto. ${jaMandouFotos ? 'Você JÁ mandou foto(s) nesta conversa (veja o histórico) — só marque true de novo se o cliente pedir foto explicitamente outra vez; não repita por conta própria.' : ''} Quando true, uma das "mensagens" deve mencionar que você vai mandar a foto agora (o envio da imagem em si é feito pelo sistema, não por você) — não descreva a foto como se ela já tivesse sido enviada antes dessa mensagem.`;

  return `${persona}

## Base de conhecimento da RT Car

${conhecimento}

## Contexto deste atendimento

Cliente: ${lead.clienteNome || 'não informado'}
Veículo de interesse: ${lead.veiculo || 'não informado'}
Plataforma de origem: ${lead.origem || 'não informada'}
Canal desta conversa: ${(process.env.ELOA_MODO_VOZ || '').toLowerCase() === 'true' ? 'voz (nota de áudio) — adapte a pronúncia de nomes pra soar natural quando falado' : 'texto (WhatsApp) — escreva os nomes com a grafia correta'}
${lead._mensagemOriginal ? `Mensagem original do cliente ao demonstrar interesse: "${lead._mensagemOriginal}"` : ''}${contextoEloa}${formatoFotos}`;
}

const SCHEMA_PADRAO = {
  type: 'object',
  properties: {
    mensagens: { type: 'array', items: { type: 'string' }, minItems: 1 },
    encaminharConsultor: { type: 'boolean' },
    enviarFotos: { type: 'boolean' },
  },
  required: ['mensagens', 'encaminharConsultor', 'enviarFotos'],
  additionalProperties: false,
};

const SCHEMA_RESGATE = {
  type: 'object',
  properties: {
    mensagens: { type: 'array', items: { type: 'string' }, minItems: 1 },
    encaminharConsultor: { type: 'boolean' },
  },
  required: ['mensagens', 'encaminharConsultor'],
  additionalProperties: false,
};

function interpretarJson(texto, origem) {
  const parsed = JSON.parse(texto);
  const mensagens = Array.isArray(parsed.mensagens) ? parsed.mensagens.filter(Boolean) : [];
  if (!mensagens.length) throw new Error(`Resposta do ${origem} sem "mensagens": ${texto}`);
  return { mensagens, encaminharConsultor: !!parsed.encaminharConsultor, enviarFotos: !!parsed.enviarFotos };
}

/* historico: array de {role: 'user'|'model', texto: string}, mais antigo primeiro.
   mensagemCliente: o texto que o cliente acabou de mandar (ainda não incluído no historico).
   Claude é o único motor de texto da Eva (decisão do Rubens, 15/08/2026) — sem fallback
   pra outro provedor. Saída forçada via output_config.format (json_schema), então o
   parsing sempre recebe JSON já validado contra o schema. */
async function gerarResposta(lead, historico, mensagemCliente) {
  const ehResgate = (lead._persona || 'persona.md') === 'persona-resgate.md';
  const messages = [
    ...historico.map((h) => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.texto })),
    { role: 'user', content: mensagemCliente },
  ];

  const response = await client.messages.create(
    {
      model: MODELO,
      max_tokens: 1024,
      system: montarInstrucaoSistema(lead, historico),
      messages,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: ehResgate ? SCHEMA_RESGATE : SCHEMA_PADRAO },
      },
    },
    { timeout: 20000 },
  );

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude recusou a resposta (stop_reason: refusal): ' + JSON.stringify(response.stop_details));
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude não retornou texto na resposta: ' + JSON.stringify(response));
  return interpretarJson(textBlock.text, 'Claude');
}

module.exports = { gerarResposta };
