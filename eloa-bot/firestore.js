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
async function fbList(col) {
  const r = await fbFetch(`${FB_URL}/${col}?pageSize=300`);
  if (!r.ok) throw new Error(await r.text());
  return ((await r.json()).documents || []).map((d) => ({ ...fromFF(d.fields), _docName: d.name, _criadoEm: d.createTime }));
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

module.exports = { fbList, fbGet, fbUpdate, FB, FB_URL };
