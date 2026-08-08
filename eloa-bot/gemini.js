const fs = require('fs');
const path = require('path');

const MODELO = 'gemini-2.5-flash';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

function carregarTexto(nome) {
  try { return fs.readFileSync(path.join(__dirname, nome), 'utf8'); } catch { return ''; }
}

function montarInstrucaoSistema(lead) {
  const persona = carregarTexto('persona.md');
  const conhecimento = carregarTexto('base-conhecimento.md');
  return `${persona}

## Base de conhecimento da RT Car

${conhecimento}

## Contexto deste atendimento

Cliente: ${lead.clienteNome || 'não informado'}
Veículo de interesse: ${lead.veiculo || 'não informado'}
Plataforma de origem: ${lead.origem || 'não informada'}
Canal desta conversa: ${(process.env.ELOA_MODO_VOZ || '').toLowerCase() === 'true' ? 'voz (nota de áudio) — adapte a pronúncia de nomes pra soar natural quando falado' : 'texto (WhatsApp) — escreva os nomes com a grafia correta'}
${lead._primeiroContato ? 'Este é o PRIMEIRO contato — o cliente ainda não respondeu nada. Inicie pelo passo 1 do fluxo de atendimento (primeiro contato), conduzindo direto para o agendamento de visita.' : ''}

## Formato da resposta

Responda SEMPRE em JSON válido, sem markdown, no formato:
{"mensagens": ["primeira mensagem curta", "segunda mensagem curta"], "encaminharConsultor": true ou false}

"mensagens" é uma lista de 1 a 3 mensagens curtas, cada uma como uma bolha separada de WhatsApp/nota de voz — nunca uma só mensagem longa com tudo junto. Cada item deve ser curto (1-2 frases), do jeito que uma pessoa falaria em turnos separados.

"encaminharConsultor" deve ser true quando: uma visita ficar agendada (dia e período confirmados), o cliente perguntar preço/financiamento/condição comercial, pedir explicitamente para falar com um consultor, ou o veículo estiver indisponível e for encaminhado pra ver alternativas. Nesses casos, "mensagens" ainda deve conter a mensagem natural correspondente (confirmando o agendamento, ou avisando que vai chamar alguém) — nunca deixe "mensagens" vazia.`;
}

/* historico: array de {role: 'user'|'model', texto: string}, mais antigo primeiro.
   mensagemCliente: o texto que o cliente acabou de mandar (ainda não incluído no historico). */
async function gerarResposta(lead, historico, mensagemCliente) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY não configurada (ver README.md)');

  const contents = [
    ...historico.map((h) => ({ role: h.role, parts: [{ text: h.texto }] })),
    { role: 'user', parts: [{ text: mensagemCliente }] },
  ];

  const body = {
    systemInstruction: { parts: [{ text: montarInstrucaoSistema(lead) }] },
    contents,
    generationConfig: { responseMimeType: 'application/json' },
  };

  const r = await fetch(`${URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gemini respondeu ${r.status}: ${await r.text()}`);

  const json = await r.json();
  const texto = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error('Gemini não retornou texto na resposta: ' + JSON.stringify(json));

  const parsed = JSON.parse(texto);
  const mensagens = Array.isArray(parsed.mensagens) ? parsed.mensagens.filter(Boolean) : [];
  if (!mensagens.length) throw new Error('Resposta do Gemini sem "mensagens": ' + texto);
  return { mensagens, encaminharConsultor: !!parsed.encaminharConsultor };
}

module.exports = { gerarResposta };
