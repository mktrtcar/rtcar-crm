const FB = { projectId: 'rtcarprograma', apiKey: 'AIzaSyAHswK1g0CnOJYiN3smElfDL1XQFrOR-Y8' };
const FB_URL = `https://firestore.googleapis.com/v1/projects/${FB.projectId}/databases/(default)/documents`;

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
  const r = await fetch(`${FB_URL}/${col}?key=${FB.apiKey}&pageSize=300`);
  if (!r.ok) throw new Error(await r.text());
  return ((await r.json()).documents || []).map((d) => ({ ...fromFF(d.fields), _docName: d.name, _criadoEm: d.createTime }));
}
async function fbGet(col, id) {
  const r = await fetch(`${FB_URL}/${col}/${id}?key=${FB.apiKey}`);
  if (!r.ok) throw new Error(await r.text());
  return fromFF((await r.json()).fields);
}
async function fbUpdate(col, id, data) {
  const q = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const r = await fetch(`${FB_URL}/${col}/${id}?${q}&key=${FB.apiKey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFF(data) }),
  });
  if (!r.ok) throw new Error(await r.text());
}

module.exports = { fbList, fbGet, fbUpdate, FB, FB_URL };
