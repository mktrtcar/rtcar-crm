const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

const LITORAL_BASE='http://www.litoralcar.com.br/webserver';
const COD_LOJA=process.env.LITORALCAR_COD_LOJA;
function headersLitoral(){
  return{
    Username:process.env.LITORALCAR_USERNAME,
    Password:process.env.LITORALCAR_PASSWORD,
    Accept:'application/json',
    'Accept-Charset':'UTF-8',
    'Content-Type':'application/json',
    /* Sem um User-Agent de navegador, o WAF da LitoralCar (GoCache) responde
       com uma pagina de desafio/recaptcha em vez da API - descoberto testando
       a integracao em 11/09/2026. */
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };
}

/* Emails com papel de gestor no CRM (mesmo criterio de isManager() no
   frontend: master/coordenadora/dev) - unica validacao de quem pode acionar
   a publicacao de estoque/consulta de referencias na LitoralCar. */
const EMAILS_GESTOR=['contato@rtcar.com.br','marcela@rtcar.com.br','rafael@rtcar.com.br','tiago@rtcar.com.br','milena@rtcar.com.br','rubens@rtcar.com.br'];

async function exigirGestor(req){
  const auth=req.headers.authorization||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):null;
  if(!token){const e=new Error('Não autenticado');e.status=401;throw e;}
  const decoded=await admin.auth().verifyIdToken(token);
  if(!decoded.email||!EMAILS_GESTOR.includes(decoded.email.toLowerCase())){
    const e=new Error('Sem permissão');e.status=403;throw e;
  }
  return decoded;
}

async function litoralFetch(acao,metodo,parametro,body){
  const partes=[LITORAL_BASE,acao,metodo];
  if(parametro!==undefined&&parametro!==null)partes.push(parametro);
  partes.push(COD_LOJA);
  const tipo={buscar:'GET',salvar:'POST',alterar:'PUT',excluir:'DELETE'}[acao];
  const headers=headersLitoral();
  // A doc da LitoralCar chama isso de "(Header) Content" - nao e' o corpo
  // (body) da requisicao como toda API normal, e' literalmente um HEADER
  // HTTP chamado "Content" carregando o JSON. Mandar so no body (como
  // qualquer API REST comum faria) fazia a LitoralCar responder "Parametro
  // 'veiculos' invalido ou nao encontrado" - ela nunca olhava o body
  // (achado pela Aline, 16/09/2026, testando publicar de verdade).
  if(body)headers.Content=JSON.stringify(body);
  const resp=await fetch(partes.join('/'),{method:tipo,headers,body:body?JSON.stringify(body):undefined});
  const texto=await resp.text();
  let json;try{json=JSON.parse(texto);}catch{json={raw:texto};}
  return{status:resp.status,body:json};
}

/* Cores da nossa base vem no feminino (Branca, Preta, Vermelha...) mas a
   LitoralCar so aceita a lista fixa deles, toda no masculino (Branco,
   Preto, Vermelho...) - sem isso a cor nunca bate e o veiculo e' recusado. */
const COR_FEMININO_PARA_LITORAL={branca:'Branco',preta:'Preto',vermelha:'Vermelho',amarela:'Amarelo',dourada:'Dourado',roxa:'Roxo',prateada:'Prata'};
function normalizarCor(cor,listaValida){
  if(!cor)return null;
  const alvo=cor.trim().toLowerCase();
  const direta=listaValida.find(v=>v.toLowerCase()===alvo);
  if(direta)return direta;
  const viaMapa=COR_FEMININO_PARA_LITORAL[alvo];
  if(viaMapa){const m=listaValida.find(v=>v.toLowerCase()===viaMapa.toLowerCase());if(m)return m;}
  return null;
}
function parseValorBR(s){
  if(s===undefined||s===null||s==='')return null;
  const n=parseFloat(String(s).replace(/\./g,'').replace(',','.'));
  return isNaN(n)?null:n;
}
function parseKm(s){
  const n=parseInt(String(s||'').replace(/\D/g,''),10);
  return isNaN(n)?0:n;
}
function limparPlaca(p){
  return String(p||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
}

/* Fotos: hoje (16/09/2026) as fotos reais dos carros ficam cadastradas no
   Autoconf (inseridas manualmente por lá) - o site novo (site-publico) ja
   baixou copia real de cada uma pra hospedagem propria (nao depende mais
   do CDN do Autoconf, que para de funcionar quando a assinatura for
   cancelada). Por enquanto usamos esse catalogo (so 55 veiculos, extraidos
   uma vez em 07/09) pra achar por aproximacao (marca+modelo, desempate por
   km) o veiculo equivalente e pegar as fotos JA HOSPEDADAS NO NOSSO SITE -
   pedido da Aline: "por enquanto pode puxar do Autoconf [via esse
   catalogo], quando desabilitar vai puxar direto do nosso site proprio"
   (ja fica assim desde já, sem depender do Autoconf ao vivo). Quando o
   site tiver populacao automatica de verdade (Fase 2 do site-publico),
   so trocar SITE_ESTOQUE_URL. */
const SITE_ESTOQUE_URL='https://rtcar-site.web.app/dados/estoque.json';
const SITE_FOTOS_BASE='https://rtcar-site.web.app/fotos';
let _catalogoSiteCache=null;
async function catalogoSite(){
  if(_catalogoSiteCache)return _catalogoSiteCache;
  try{
    const resp=await fetch(SITE_ESTOQUE_URL);
    const json=await resp.json();
    _catalogoSiteCache=json.veiculos||[];
  }catch(e){
    console.error('Erro ao buscar catalogo do site para fotos:',e);
    _catalogoSiteCache=[];
  }
  return _catalogoSiteCache;
}
function normalizarTextoLitoral(s){return String(s||'').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();}

/* Fallback ao vivo: o catalogo estatico (catalogoSite) so tem 55 carros de
   uma extracao unica em 07/09 - muita coisa do estoque atual nao esta la
   (achado 16/09/2026: HB20 BEO-4H98 publicou sem foto por isso). Em vez de
   esperar o site ser recatalogado (tarefa grande, de outra sessao), busca
   direto na listagem publica do Autoconf ao vivo pra achar QUALQUER
   veiculo atual por marca+modelo, e usa o link de foto deles mesmo
   (pedido da Aline: "por enquanto pode puxar do Autoconf"). Cache de 15min
   em memoria por instancia, pra nao rescanear tudo a cada publicacao. */
const AUTOCONF_ESTOQUE_URL='https://rtcar.com.br/estoque';
const AUTOCONF_POR_PAGINA=18;
const AUTOCONF_MAX_PAGINAS=12;
const AUTOCONF_CACHE_TTL_MS=15*60*1000;
let _catalogoAoVivoCache=null,_catalogoAoVivoQuando=0;
function extrairCardsAutoconf(html){
  const veiculos=[];
  const regex=/<div class="card card-car\s*">[\s\S]*?<a href="(https:\/\/rtcar\.com\.br\/carros\/[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([^<]+)<span[^>]*>([^<]+)<\/span><\/h3>/g;
  let m;
  while((m=regex.exec(html)))veiculos.push({pagina:m[1],marca:m[2].trim(),modelo:m[3].trim()});
  return veiculos;
}
async function buscarCatalogoAoVivo(){
  if(_catalogoAoVivoCache&&(Date.now()-_catalogoAoVivoQuando)<AUTOCONF_CACHE_TTL_MS)return _catalogoAoVivoCache;
  const todos=[];
  try{
    for(let pagina=1;pagina<=AUTOCONF_MAX_PAGINAS;pagina++){
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),8000);
      let html;
      try{
        const r=await fetch(`${AUTOCONF_ESTOQUE_URL}?registros_por_pagina=${AUTOCONF_POR_PAGINA}&pagina=${pagina}`,{headers:{'User-Agent':'Mozilla/5.0'},signal:controller.signal});
        if(!r.ok)break;
        html=await r.text();
      }finally{clearTimeout(timeout);}
      const veiculos=extrairCardsAutoconf(html);
      if(!veiculos.length)break;
      todos.push(...veiculos);
    }
    _catalogoAoVivoCache=todos;_catalogoAoVivoQuando=Date.now();
  }catch(e){
    console.error('Erro ao buscar catalogo ao vivo do Autoconf:',e);
    if(!_catalogoAoVivoCache)_catalogoAoVivoCache=[];
  }
  return _catalogoAoVivoCache;
}
function extrairIdDaPaginaAutoconf(pagina){const m=String(pagina||'').match(/\/(\d+)\/?$/);return m?m[1]:null;}
async function fotosDaPaginaAutoconf(pagina){
  const id=extrairIdDaPaginaAutoconf(pagina);
  if(!id)return[];
  try{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),8000);
    let html;
    try{
      const r=await fetch(pagina,{headers:{'User-Agent':'Mozilla/5.0'},signal:controller.signal});
      if(!r.ok)return[];
      html=await r.text();
    }finally{clearTimeout(timeout);}
    const regex=new RegExp(`veiculos/fotos/${id}/([a-f0-9-]+)\\.jpg`,'g');
    const hashes=new Set();
    let m;while((m=regex.exec(html)))hashes.add(m[1]);
    /* SEM "filters:format(jpg)/" no path - a imagem carrega igual (testado,
       mesmo byte a byte), mas o WAF da LitoralCar (GoCache) bloqueia com
       403 "Acesso Bloqueado" qualquer foto cuja URL tenha ":" e "()" no
       caminho (achado pela Aline, 17/09/2026, republicando o HB20 depois
       do fix de fotos ao vivo - o proprio veiculo sem foto nenhuma
       publicava normal, com foto do Autoconf sempre dava erro). */
    return[...hashes].map(h=>`https://resized-images.autoconf.com.br/810x608/veiculos/fotos/${id}/${h}.jpg`);
  }catch(e){
    console.error('Erro ao buscar fotos da pagina do veiculo no Autoconf:',e);
    return[];
  }
}
async function fotosAoVivoAutoconf(v){
  const catalogo=await buscarCatalogoAoVivo();
  const marcaAlvo=normalizarTextoLitoral(v.marca),modeloAlvo=normalizarTextoLitoral(v.modelo);
  if(!marcaAlvo||!modeloAlvo)return[];
  const candidato=catalogo.find(c=>{
    const marcaC=normalizarTextoLitoral(c.marca),modeloC=normalizarTextoLitoral(c.modelo);
    return marcaC===marcaAlvo&&(modeloC.includes(modeloAlvo)||modeloAlvo.includes(modeloC));
  });
  if(!candidato)return[];
  return fotosDaPaginaAutoconf(candidato.pagina);
}

async function fotosParaVeiculo(v){
  const catalogo=await catalogoSite();
  const marcaAlvo=normalizarTextoLitoral(v.marca),modeloAlvo=normalizarTextoLitoral(v.modelo);
  if(!marcaAlvo||!modeloAlvo)return[];
  const candidatos=catalogo.filter(c=>{
    const marcaC=normalizarTextoLitoral(c.marca),modeloC=normalizarTextoLitoral(c.modelo);
    return marcaC===marcaAlvo&&(modeloC.includes(modeloAlvo)||modeloAlvo.includes(modeloC));
  });
  if(!candidatos.length)return fotosAoVivoAutoconf(v);
  const kmAlvo=parseKm(v.km);
  candidatos.sort((a,b)=>Math.abs(parseKm(a.km)-kmAlvo)-Math.abs(parseKm(b.km)-kmAlvo));
  const escolhido=candidatos[0];
  const qtdFotos=(escolhido.fotos||[]).length;
  if(!qtdFotos)return fotosAoVivoAutoconf(v);
  return Array.from({length:qtdFotos},(_,i)=>`${SITE_FOTOS_BASE}/${escolhido.id}/${i+1}.jpg`);
}

/* método marcas/modelos usa um "slug" de categoria diferente do valor
   gravado no veículo (ex: categoria "Carro/Camionetas" vira "carro" aqui). */
const CATEGORIA_PARA_SLUG={
  'Caminhão':'caminhao','Carreta':'carreta','Carro/Camionetas':'carro',
  'Implemento Rod.':'implemento-rodoviario','Moto':'moto','Motor home':'motorhome',
  'Náutica':'nautica','Ônibus':'onibus','Quadriciclo/Triciclo':'quadriciclo-triciclo',
  'Trator/Maquinas':'trator-maquina',
};

/* Referências (categorias/cores/combustíveis) pra tela de revisão no CRM
   sugerir/validar os campos que a LitoralCar exige mas nossa base não tem. */
exports.litoralcarReferencias=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  try{
    await exigirGestor(req);
    const[categorias,cores,combustiveis]=await Promise.all([
      litoralFetch('buscar','categorias'),
      litoralFetch('buscar','cores'),
      litoralFetch('buscar','combustiveis'),
    ]);
    res.json({
      categorias:categorias.body.categorias||[],
      cores:cores.body.cores||[],
      combustiveis:combustiveis.body.combustiveis||[],
    });
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});

/* Marcas/modelos aceitos pela LitoralCar para uma categoria - usado pra
   deixar o usuário corrigir a versão/modelo certinho antes de publicar
   (pedido da Aline, 14/09/2026: "eu preciso acertar a versão do carro,
   porque senão eu não posso colocar um carro com informação errada" -
   mesma experiência que ela já tem hoje publicando manualmente pelo
   Autoconf, que sugere e deixa corrigir). */
exports.litoralcarMarcasModelos=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  try{
    await exigirGestor(req);
    const categoria=req.query.categoria;
    const slug=CATEGORIA_PARA_SLUG[categoria];
    if(!slug){res.status(400).json({erro:`Categoria "${categoria}" desconhecida`});return;}
    const[marcasR,modelosR]=await Promise.all([
      litoralFetch('buscar','marcas',slug),
      litoralFetch('buscar','modelos',slug),
    ]);
    res.json({
      marcas:marcasR.body.marcas||[],
      modelos:modelosR.body.modelos||[],
    });
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});

/* Publica/atualiza o estoque na LitoralCar. Recebe do CRM a lista de
   veículos "disponível" já revisados (categoria e combustível confirmados
   pelo usuário, já que rtcar_estoque_publico não tem esses dois campos).
   cod_importacao é gerado e mantido aqui (coleção litoralcar_veiculos,
   indexada pela placa) pra saber se cada veículo é novo (salvar) ou já
   publicado antes (alterar). */
exports.litoralcarPublicarEstoque=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  if(req.method!=='POST'){res.status(405).send('Method not allowed');return;}
  try{
    await exigirGestor(req);
    const veiculos=req.body.veiculos||[];
    if(!veiculos.length){res.status(400).json({erro:'Nenhum veículo enviado'});return;}

    const refs=await Promise.all([litoralFetch('buscar','cores')]);
    const coresValidas=refs[0].body.cores||[];

    const resultados=[];
    const novos=[];
    const alterados=[];
    const porPlaca={};

    for(const v of veiculos){
      const placa=limparPlaca(v.placa);
      const cor=normalizarCor(v.cor,coresValidas);
      const ano=parseInt(v.anoModelo,10)||parseInt(v.anoFabricacao,10)||null;
      const valor=parseValorBR(v.preco);
      if(!cor){resultados.push({placa:v.placa,ok:false,erro:`Cor "${v.cor}" não reconhecida pela LitoralCar`});continue;}
      if(!ano){resultados.push({placa:v.placa,ok:false,erro:'Ano ausente/inválido'});continue;}
      if(!valor){resultados.push({placa:v.placa,ok:false,erro:'Preço ausente/inválido'});continue;}
      if(!v.categoria||!v.combustivel){resultados.push({placa:v.placa,ok:false,erro:'Categoria ou combustível não informado'});continue;}

      const fotos=await fotosParaVeiculo(v);
      const payload={
        categoria:v.categoria,marca:v.marca,modelo:v.modelo,versao:v.versao||'',
        combustivel:v.combustivel,cor,ano,km:parseKm(v.km),placa,
        valor,situacao:'exibir',
      };
      if(fotos.length)payload.fotos=fotos;
      porPlaca[placa]=v.placa;

      const mapRef=db.collection('litoralcar_veiculos').doc(placa);
      const mapSnap=await mapRef.get();
      if(mapSnap.exists&&mapSnap.data().codVeiculo){
        alterados.push({...payload,cod_importacao:mapSnap.data().codImportacao,cod_veiculo:mapSnap.data().codVeiculo});
      }else{
        const seqRef=db.collection('litoralcar_config').doc('seq');
        const codImportacao=await db.runTransaction(async tx=>{
          const s=await tx.get(seqRef);
          const proximo=((s.exists&&s.data().veiculoSeq)||0)+1;
          tx.set(seqRef,{veiculoSeq:proximo},{merge:true});
          return proximo;
        });
        novos.push({...payload,cod_importacao:codImportacao});
      }
    }

    async function processarLote(acao,lote){
      if(!lote.length)return;
      const r=await litoralFetch(acao,'estoque',undefined,{veiculos:lote});
      // Log de depuracao - a LitoralCar as vezes muda o formato da resposta
      // de um jeito que nao esperamos, e sem ver o corpo bruto e' impossivel
      // saber o motivo real de uma falha (achado pela Aline, 16/09/2026).
      console.log(`litoralcar ${acao} status=${r.status} body=`,JSON.stringify(r.body));
      /* Com so 1 veiculo no lote, a LitoralCar as vezes devolve "veiculos"
         como objeto solto em vez de array de 1 item (comum em APIs PHP que
         nao forcam array_values() na resposta) - sem isso, o for..of
         quebrava com "itens is not iterable" (achado pela Aline, 16/09/2026,
         publicando 1 carro por vez). */
      let itens=(r.body&&r.body.veiculos)||[];
      if(!Array.isArray(itens))itens=(itens&&typeof itens==='object')?Object.values(itens):[itens];
      for(const item of itens){
        const vlt=item.veiculo||{};
        const placa=limparPlaca(vlt.placa);
        const ok=/sucesso/i.test(vlt.status||'');
        resultados.push({placa:porPlaca[placa]||placa,ok,status:vlt.status,alertas:vlt.alertas||[],debug:ok?undefined:JSON.stringify(item)});
        if(ok&&vlt.cod_veiculo){
          await db.collection('litoralcar_veiculos').doc(placa).set({
            codImportacao:Number(vlt.cod_importacao),
            codVeiculo:Number(vlt.cod_veiculo),
            ultimoEnvio:new Date().toISOString(),
          },{merge:true});
        }
      }
      if(!itens.length){
        // Sem isso, uma resposta 200 num formato inesperado (sem "veiculos")
        // desaparecia sem deixar rastro nenhum pro usuario - virava "falha
        // desconhecida" no CRM sem nenhuma pista real (achado 16/09/2026).
        lote.forEach(x=>resultados.push({placa:porPlaca[x.placa]||x.placa,ok:false,erro:JSON.stringify(r.body)}));
      }
    }

    await processarLote('salvar',novos);
    await processarLote('alterar',alterados);

    res.json({resultados});
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});

/* Despublica (remove) um veiculo do estoque na LitoralCar - pedido da
   Aline, 16/09/2026: "depois que publica tem que aparecer despublicar,
   se a gente quiser fazer edicao ou nao publicar mais". Doc da LitoralCar
   (metodo estoque, acao excluir): DELETE .../excluir/estoque/cod_loja,
   Header Content = {veiculos:[{cod_importacao,cod_veiculo}]}. So precisa
   dos dois codigos que ja guardamos em litoralcar_veiculos/{placa} desde
   a primeira publicacao. */
exports.litoralcarDespublicarEstoque=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  if(req.method!=='POST'){res.status(405).send('Method not allowed');return;}
  try{
    await exigirGestor(req);
    const placa=limparPlaca(req.body.placa);
    if(!placa){res.status(400).json({erro:'Placa não informada'});return;}
    const mapRef=db.collection('litoralcar_veiculos').doc(placa);
    const mapSnap=await mapRef.get();
    if(!mapSnap.exists||!mapSnap.data().codVeiculo){res.status(400).json({erro:'Veículo não está publicado na LitoralCar'});return;}
    const{codImportacao,codVeiculo}=mapSnap.data();
    const r=await litoralFetch('excluir','estoque',undefined,{veiculos:[{cod_importacao:Number(codImportacao),cod_veiculo:Number(codVeiculo)}]});
    console.log(`litoralcar excluir status=${r.status} body=`,JSON.stringify(r.body));
    let itens=(r.body&&r.body.veiculos)||[];
    if(!Array.isArray(itens))itens=(itens&&typeof itens==='object')?Object.values(itens):[itens];
    const item=itens[0];
    const vlt=(item&&item.veiculo)||{};
    const ok=/excluido|excluído/i.test(vlt.status||'');
    if(ok){
      await mapRef.set({codVeiculo:admin.firestore.FieldValue.delete(),ultimaRemocao:new Date().toISOString()},{merge:true});
      res.json({ok:true,status:vlt.status});
    }else{
      res.json({ok:false,status:vlt.status,alertas:vlt.alertas||[],debug:JSON.stringify(item||r.body)});
    }
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});
