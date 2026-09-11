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

async function atualizarEstoque() {
  const veiculos = await buscarEstoqueCompleto();
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

module.exports = { atualizarEstoque, buscarEstoqueCompleto };

if (require.main === module) {
  atualizarEstoque()
    .then((n) => console.log(`✅ Estoque atualizado: ${n} veículos.`))
    .catch((e) => {
      console.error('Erro ao atualizar estoque:', e.message);
      process.exit(1);
    });
}
