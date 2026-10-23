/* Atualiza eloa-bot/estoque.json automaticamente, buscando direto do
   catálogo público do site (rtcar.com.br/estoque) — sem precisar de
   nenhuma chave/API nova, e sem depender de alguém exportar isso
   manualmente (11/09/2026, a pedido do Rubens: "preciso que tu mesmo se
   atualize").

   Roda tanto como script avulso (node atualizar-estoque.js, pra rodar na
   mão quando quiser) quanto automaticamente todo dia via
   cicloAtualizarEstoque no index.js.

   Extração por regex (mesmo estilo já usado em dadosVeiculo.js, sem
   biblioteca de parsing de HTML) — se o site mudar de estrutura, a busca
   simplesmente não encontra nada e a atualização é abortada SEM sobrescrever
   o estoque.json atual (proteção: nunca fica com o estoque vazio por causa
   de uma mudança de layout do site). */
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://rtcar.com.br/estoque';
const POR_PAGINA = 18;
const MAX_PAGINAS = 20; // trava de seguranca, nunca deveria chegar aqui

function extrairVeiculosDoHtml(html) {
  const veiculos = [];
  const regexCard = /<div class="card card-car\s*">[\s\S]*?<a href="(https:\/\/rtcar\.com\.br\/carros\/[^"]+)"[^>]*>[\s\S]*?<img[^>]*\ssrc="([^"]+)"[\s\S]*?<h3[^>]*>([^<]+)<span[^>]*>([^<]+)<\/span><\/h3>/g;
  let m;
  while ((m = regexCard.exec(html))) {
    veiculos.push({
      pagina: m[1],
      foto: m[2],
      b: m[3].trim(),
      m: m[4].trim(),
    });
  }
  return veiculos;
}

async function buscarPagina(numero) {
  const url = `${BASE_URL}?registros_por_pagina=${POR_PAGINA}&pagina=${numero}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} na página ${numero}`);
    return await r.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function buscarEstoqueCompleto() {
  const todos = [];
  const vistos = new Set();
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const html = await buscarPagina(pagina);
    const veiculos = extrairVeiculosDoHtml(html);
    if (!veiculos.length) break; // pagina vazia - chegou ao fim do catalogo
    let novos = 0;
    for (const v of veiculos) {
      if (vistos.has(v.pagina)) continue;
      vistos.add(v.pagina);
      todos.push(v);
      novos++;
    }
    if (novos === 0) break; // pagina so repetiu o que ja tinha - protecao contra loop infinito
  }
  return todos;
}

/* 23/10/2026 (pedido da Aline): a Eva passa a ler o estoque do PROPRIO sistema
   (colecao site_veiculos - o mesmo catalogo do site novo, ligado sozinho ao
   estoque do sistema principal: carro novo entra, vendido/repasse sai) em vez
   do site do Autoconf. Isso deixa o estoque dela atualizado em minutos (nao
   mais 1x por dia) e tira a dependencia do Autoconf, que vai ser cancelado.
   Cada item ja traz fotos e ficha (ano, km, cambio, cor, opcionais), entao a
   Eva nao precisa mais abrir a pagina do carro pra buscar isso. Preco NUNCA
   entra aqui (a Eva nao passa preco). O site do Autoconf continua so' como
   reserva, se a leitura do sistema falhar. */
const { fbList } = require('./firestore');
const SITE_BASE = (process.env.SITE_URL || 'https://rtcar-site.web.app').replace(/\/$/, '');
async function buscarEstoqueSistema() {
  // So' os carros ATIVOS do estoque do sistema (disponivel / em preparacao) -
  // o catalogo do site ainda tem as copias antigas do Autoconf (vendidos e
  // duplicados). Carro do sistema sem foto pega as fotos da copia do Autoconf
  // do MESMO carro (mesma marca + modelo + ano, km parecido).
  const [docs, estoque] = await Promise.all([fbList('site_veiculos'), fbList('rtcar_estoque_publico')]);
  const idDe = (d) => String(d._docName || '').split('/').pop() || d.id;
  const ativos = new Set(estoque.filter((e) => ['disponivel', 'em_preparacao'].includes(e.status)).map(idDe));
  const visiveis = docs.filter((v) => !v.oculto);
  const ligado = (v) => (v.origemEstoquePrincipal && ativos.has(idDe(v))) || (v.placaSistema && ativos.has(String(v.placaSistema)));
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const kmNum = (k) => Number(String(k || '').replace(/\D/g, '')) || 0;
  const copias = visiveis.filter((v) => !ligado(v) && Array.isArray(v.fotos) && v.fotos.length);
  const vistos = new Set();
  return visiveis.filter(ligado).map((v) => {
    const id = idDe(v);
    let fotos = Array.isArray(v.fotos) ? v.fotos.filter(Boolean) : [];
    if (!fotos.length) {
      const par = copias.find((c) => norm(c.marca) === norm(v.marca) && norm(c.modelo).startsWith(norm(v.modelo).slice(0, 4)) && (!v.ano || !c.ano || String(c.ano).slice(-4) === String(v.ano).slice(-4)) && (!kmNum(v.km) || !kmNum(c.km) || Math.abs(kmNum(c.km) - kmNum(v.km)) <= 6000));
      if (par) fotos = par.fotos.filter(Boolean);
    }
    return {
      pagina: `${SITE_BASE}/#/carro/${id}`,
      foto: fotos[0] || '',
      fotos,
      b: String(v.marca || '').trim(),
      m: String(v.modelo || '').trim(),
      versao: v.versao || '',
      ano: v.ano || null,
      km: v.km || null,
      cambio: v.cambio || null,
      cor: v.cor || null,
      potencia: v.potencia || null,
      opcionais: Array.isArray(v.opcionais) ? v.opcionais : [],
      fonte: 'sistema',
    };
  }).filter((x) => { if (vistos.has(x.pagina)) return false; vistos.add(x.pagina); return true; });
}

async function atualizarEstoque() {
  let veiculos = [];
  try { veiculos = await buscarEstoqueSistema(); } catch (e) { console.error('Estoque do sistema indisponível, usando o site do Autoconf como reserva:', e.message); }
  if (veiculos.length < 5) veiculos = await buscarEstoqueCompleto();
  // Protecao: nunca sobrescreve com um resultado vazio ou suspeito pequeno
  // demais (ex: site fora do ar, ou mudou de estrutura e a regex parou de
  // casar) - mantem o estoque.json anterior intacto nesses casos.
  if (veiculos.length < 5) {
    throw new Error(`Só encontrei ${veiculos.length} veículo(s) no catálogo — parece errado (site fora do ar ou mudou de estrutura). Mantendo estoque.json atual, sem sobrescrever.`);
  }
  const caminho = path.join(__dirname, 'estoque.json');
  fs.writeFileSync(caminho, JSON.stringify(veiculos, null, 2));
  return veiculos.length;
}

module.exports = { atualizarEstoque, buscarEstoqueCompleto, buscarEstoqueSistema };

if (require.main === module) {
  atualizarEstoque()
    .then((n) => console.log(`✅ Estoque atualizado: ${n} veículos.`))
    .catch((e) => {
      console.error('Erro ao atualizar estoque:', e.message);
      process.exit(1);
    });
}
