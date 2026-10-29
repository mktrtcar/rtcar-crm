const FB = { projectId: 'rtcarprograma', apiKey: 'AIzaSyAHswK1g0CnOJYiN3smElfDL1XQFrOR-Y8' };
const FB_URL = `https://firestore.googleapis.com/v1/projects/${FB.projectId}/databases/(default)/documents`;

/* 24/08/2026: a regra de seguranca do Firestore passou a exigir login
   (request.auth != null) — sem isso, todo fetch aqui embaixo passou a
   voltar 403. A Eloa e um processo automatico, sem pessoa nenhuma
   digitando login, entao em vez de usar a conta de uma pessoa ela loga
   como uma conta so dela (eva-bot@rtcar.com.br, sem nenhum acesso ao CRM)
   e manda o token dessa conta em toda chamada. O token expira em 1h, por
   isso guarda tambem quando foi buscado e renova sozinho quando precisar. */
const BOT_EMAIL = process.env.FIREBASE_BOT_EMAIL || 'eva-bot@rtcar.com.br';
const BOT_PASSWORD = process.env.FIREBASE_BOT_PASSWORD;
// Chave separada da usada no CRM: a do CRM e' restrita a navegador (bloqueia
// requisicao sem "referer" de site, que e' sempre o caso aqui, rodando num
// processo Node comum) - essa aqui e' a chave "padrao" do proprio Firebase
// Auth do projeto, sem essa restricao.
const AUTH_API_KEY = 'AIzaSyAjeoMj-JohzYutBm84iG-1JHrTWZB9hoY';
let _idToken = null;
let _idTokenExpiraEm = 0;
async function getIdToken() {
  if (_idToken && Date.now() < _idTokenExpiraEm) return _idToken;
  if (!BOT_PASSWORD) throw new Error('FIREBASE_BOT_PASSWORD nao configurada no .env — necessaria pra Eloa autenticar no Firestore.');
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${AUTH_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BOT_EMAIL, password: BOT_PASSWORD, returnSecureToken: true }),
  });
  if (!r.ok) throw new Error('Falha ao autenticar a Eloa no Firebase: ' + (await r.text()));
  const j = await r.json();
  _idToken = j.idToken;
  _idTokenExpiraEm = Date.now() + (Number(j.expiresIn || 3600) - 120) * 1000; // renova 2min antes de expirar
  return _idToken;
}
async function fbFetch(url, opts = {}) {
  const token = await getIdToken();
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
}

function toFV(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFV) } };
  if (typeof v === 'object') return { mapValue: { fields: toFF(v) } };
  return { stringValue: String(v) };
}
function toFF(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) f[k] = toFV(v);
  return f;
}
function fromFV(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFV);
  if ('mapValue' in v) return fromFF(v.mapValue.fields || {});
  return null;
}
function fromFF(fields) {
  if (!fields) return {};
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromFV(v)]));
}
// 27/08/2026: antes buscava so os primeiros 300 documentos, sem nenhum
// jeito de buscar o resto - com a colecao "leads" passando de 300, a Eloa
// ia parar de enxergar leads novos silenciosamente (sem erro nenhum, so
// parava de responder). Agora segue as paginas (nextPageToken) ate acabar,
// nao importa quantos documentos a colecao tenha.
async function fbList(col) {
  let documentos = [];
  let pageToken;
  do {
    const url = `${FB_URL}/${col}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const r = await fbFetch(url);
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    documentos = documentos.concat(j.documents || []);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return documentos.map((d) => ({ ...fromFF(d.fields), _docName: d.name, _criadoEm: d.createTime }));
}
/* 29/10/2026: le' so' os documentos com um campo dentro de uma lista de
   valores (ex.: status in ['disponivel','em_preparacao']) - pedido do
   contrato do feed 1.2 (custo): a vitrine guarda ~220 carros, inclusive
   vendidos, e so' uns 60 interessam. */
async function fbListWhereIn(col, campo, valores) {
  const r = await fbFetch(`${FB_URL}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: col }],
      where: { fieldFilter: { field: { fieldPath: campo }, op: 'IN', value: { arrayValue: { values: valores.map(toFV) } } } },
    } }),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).filter((x) => x.document)
    .map(({ document: d }) => ({ ...fromFF(d.fields), _docName: d.name, _criadoEm: d.createTime }));
}
async function fbGet(col, id) {
  const r = await fbFetch(`${FB_URL}/${col}/${id}`);
  if (!r.ok) throw new Error(await r.text());
  return fromFF((await r.json()).fields);
}
async function fbUpdate(col, id, data) {
  const q = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const r = await fbFetch(`${FB_URL}/${col}/${id}?${q}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFF(data) }),
  });
  if (!r.ok) throw new Error(await r.text());
}

/* Cria um documento novo reservando o proximo numero de uma sequencia, tudo
   num commit so (19/10/2026 - lead que chama primeiro no WhatsApp da Eva).
   Usa a updateTime do doc da sequencia como trava: se outro processo (ex: o
   webhook do Autoconf) pegou o mesmo numero no meio, o commit falha e tenta
   de novo com o numero seguinte - nunca dois leads com o mesmo ID. */
async function criarComSequencia(colSeq, idSeq, campoSeq, colDoc, montar, tentativas = 5) {
  const base = `projects/${FB.projectId}/databases/(default)/documents`;
  for (let i = 0; i < tentativas; i++) {
    const r = await fbFetch(`${FB_URL}/${colSeq}/${idSeq}`);
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    const atual = fromFF(j.fields)[campoSeq] || 0;
    const seq = atual + 1;
    const { id, dados } = montar(seq);
    const body = { writes: [
      { update: { name: `${base}/${colSeq}/${idSeq}`, fields: toFF({ [campoSeq]: seq }) }, updateMask: { fieldPaths: [campoSeq] }, currentDocument: { updateTime: j.updateTime } },
      { update: { name: `${base}/${colDoc}/${id}`, fields: toFF(dados) }, currentDocument: { exists: false } },
    ] };
    const c = await fbFetch(`https://firestore.googleapis.com/v1/${base}:commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (c.ok) return id;
    const erro = await c.text();
    if (!/FAILED_PRECONDITION|ALREADY_EXISTS|ABORTED/.test(erro)) throw new Error(erro);
    await new Promise((res) => setTimeout(res, 300 + Math.random() * 700));
  }
  throw new Error("Nao consegui reservar o numero do lead depois de varias tentativas.");
}

module.exports = { fbList, fbListWhereIn, fbGet, fbUpdate, criarComSequencia, FB, FB_URL };
