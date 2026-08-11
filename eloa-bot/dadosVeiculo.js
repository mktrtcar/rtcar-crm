/* Busca dados reais (fotos múltiplas + specs) direto da página do veículo
   no rtcar.com.br — o estoque.json só tem marca/modelo/1 foto, isso aqui
   enriquece com o que o site real mostra. NUNCA extrai preço (a página não
   mostra preço no HTML estático hoje, e mesmo que mostrasse, os campos
   abaixo não capturam isso — só specs técnicas + fotos).

   Cache em memória por processo, TTL de algumas horas, pra não buscar a
   página de novo a cada mensagem do mesmo veículo. Se a busca falhar (site
   fora do ar, mudou de estrutura), retorna null — quem chamar deve cair de
   volta pro estoque.json (marca/modelo/1 foto), nunca travar a conversa. */
const TTL_MS = 4 * 60 * 60 * 1000; // 4h
const cache = new Map(); // pagina -> { dados, quando }

function extrairIdDaPagina(pagina) {
  const m = pagina.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

function extrairFotos(html, id) {
  const regex = new RegExp(`veiculos/fotos/${id}/([a-f0-9-]+)\\.jpg`, 'g');
  const hashes = new Set();
  let m;
  while ((m = regex.exec(html))) hashes.add(m[1]);
  return [...hashes].map((h) => `https://resized-images.autoconf.com.br/810x608/filters:format(jpg)/veiculos/fotos/${id}/${h}.jpg`);
}

function extrairSpecs(html) {
  const ano = html.match(/Ano:\s*([\d/]+)/)?.[1] || null;
  const km = html.match(/KM:\s*([\d.,]+)\s*km/i)?.[1] || null;
  const potencia = html.match(/Potência:\s*(\d+)\s*cv/i)?.[1] || null;
  const cambio = html.match(/Câmbio:\s*(\S+)/i)?.[1] || null;
  const cor = html.match(/-\s*(\S+)\s*-\s*\d{4}\s*seminovo/i)?.[1] || null;

  const opcionais = [];
  const regexOp = /class="acessorios">[\s\S]*?<\/svg>\s*([^<]+?)\s*<\/p>/g;
  let m;
  while ((m = regexOp.exec(html))) opcionais.push(m[1].trim());

  return { ano, km, potencia, cambio, cor, opcionais: [...new Set(opcionais)] };
}

async function buscarDadosReais(pagina) {
  if (!pagina) return null;

  const emCache = cache.get(pagina);
  if (emCache && Date.now() - emCache.quando < TTL_MS) return emCache.dados;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(pagina, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();

    const id = extrairIdDaPagina(pagina);
    const dados = {
      fotos: id ? extrairFotos(html, id) : [],
      ...extrairSpecs(html),
    };
    cache.set(pagina, { dados, quando: Date.now() });
    return dados;
  } catch (e) {
    console.error(`Erro ao buscar dados reais de ${pagina}:`, e.message);
    return null;
  }
}

module.exports = { buscarDadosReais };
