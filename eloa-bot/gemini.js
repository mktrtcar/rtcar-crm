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

## Formato da resposta

Responda SEMPRE em JSON válido, sem markdown, no formato:
{"resposta": "texto que a Eloá vai mandar no WhatsApp", "encaminharConsultor": true ou false}

"encaminharConsultor" deve ser true quando: o cliente perguntar preço/financiamento/condições de pagamento, pedir para falar com um vendedor/consultor, ou a conversa já estiver madura o suficiente pra um humano assumir. Nesses casos, a "resposta" ainda deve ser uma mensagem natural avisando que vai chamar alguém — nunca deixe "resposta" vazia.`;
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
  if (!parsed.resposta) throw new Error('Resposta do Gemini sem campo "resposta": ' + texto);
  return { resposta: parsed.resposta, encaminharConsultor: !!parsed.encaminharConsultor };
}

module.exports = { gerarResposta };
