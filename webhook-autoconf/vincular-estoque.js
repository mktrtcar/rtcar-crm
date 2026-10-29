const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

/* Fase 2 da integracao site <-> estoque (01/10/2026, pedido da Aline): assim
   que um veiculo entra (ou muda) no estoque do sistema principal
   (rtcar_estoque_publico, mantido pela Marcela), aparece automaticamente no
   nosso site publico tambem - sem foto nenhuma no comeco (a tela "Em
   preparacao" do site ja cobre isso sozinha), ate alguem anexar a foto de
   verdade pelo admin.

   So' cria/atualiza campos que NUNCA foram editados a mao aqui (mesmo
   padrao de camposBloqueados ja usado em sincronizarVeiculosSitePublico) -
   uma vez que alguem mexeu num campo pelo admin do site, essa automacao
   para de sobrescrever ele. "status" vindo de la nunca mexe em "oculto" do
   nosso lado, pra nao esconder/mostrar um carro que o admin ja decidiu
   manualmente.

   So considera disponivel/em_preparacao (mesmo filtro que o CRM ja usa pra
   "veiculo de interesse") - repasse/vendido nao precisam aparecer aqui. */
const STATUS_RELEVANTES=['disponivel','em_preparacao'];
// Preco NAO e' copiado sozinho (02/10/2026, pedido da Aline): preco so' aparece
// no site quando ela puxa/aplica pelo admin (aba "Preco e KM").
const MAPA_CAMPOS={marca:'marca',modelo:'modelo',versao:'versao'};
// 23/10/2026 (pedido da Aline): o site passa a mostrar o preco de todos (com
// opcao "Ocultar preço" no admin) - entao o carro do sistema ja chega com ano,
// km, cor e preco. Campo editado a mao no admin (camposBloqueados) nao e' tocado.
const MARCAS_FIX={'GM - CHEVROLET':'Chevrolet','VW - VOLKSWAGEN':'Volkswagen','VW':'Volkswagen','GM':'Chevrolet','MERCEDES-BENZ':'Mercedes','MERCEDES':'Mercedes','CAOA CHERY/CHERY':'Chery','LAND ROVER':'Land Rover','HARLEY DAVISON':'Harley','HARLEY DAVIDSON':'Harley','KIA':'Kia Motors'};
function tituloMarca(m){const u=String(m||'').trim().toUpperCase();if(MARCAS_FIX[u])return MARCAS_FIX[u];return u.toLowerCase().replace(/(^|[\s\/-])([a-zà-ú])/g,(x,a,b)=>a+b.toUpperCase());}
function modeloLimpo(m){return String(m||'').replace(/^(VW|GM)\s*-\s*\S+\s*/i,'').trim();}

async function apagarDocSite(docSnap){
  const prefixo=`https://storage.googleapis.com/${bucket.name}/`;
  const fotos=docSnap.data().fotos||[];
  await Promise.all(fotos.filter(url=>url.startsWith(prefixo)).map(url=>bucket.file(url.slice(prefixo.length)).delete().catch(()=>{})));
  await docSnap.ref.delete();
}

exports.vincularEstoquePrincipalAoSite=onDocumentWritten({region:'southamerica-east1',document:'rtcar_estoque_publico/{placa}'},async(event)=>{
  const depois=event.data?.after?.exists?event.data.after.data():null;
  const placa=event.params.placa;
  const ref=db.collection('site_veiculos').doc(placa);
  // Contrato do feed 1.2 (29/10/2026): delete de documento NAO e' venda - e'
  // placa corrigida/preenchida (o app apaga o doc antigo e cria outro com o
  // mesmo evId). Nao mexe no site aqui: a criacao do doc novo migra o carro
  // (aplicarSistemaNoSite) e a passada de 30 min oculta o que sumiu de vez.
  if(!depois)return;
  if(!STATUS_RELEVANTES.includes(depois.status)){
    // Vendido/repasse - apaga de verdade do site (doc + fotos no Storage),
    // pedido da Aline, 01/10/2026: carro vendido nao deve continuar
    // aparecendo. So' apaga se o veiculo realmente veio dessa automacao
    // (origemEstoquePrincipal) ou foi vinculado a esse carro do sistema
    // (placaSistema, vinculo feito pela Aline no admin) - nunca mexe num carro
    // cadastrado manualmente sem vinculo.
    const snap=await ref.get();
    if(snap.exists&&snap.data().origemEstoquePrincipal)await apagarDocSite(snap);
    const vinculados=await db.collection('site_veiculos').where('placaSistema','==',placa).get();
    for(const d of vinculados.docs)await apagarDocSite(d);
    return;
  }
  await aplicarSistemaNoSite(placa,depois);
});

/* 29/10/2026 (pedido da Aline): preco R$ 1 (ou 0/vazio) no sistema = carro
   ainda sem preco final -> site mostra "Consulte o preço". Qualquer outro
   valor vai pro site como esta' no sistema. */
function precoDoSistema(p){
  if(typeof p==='number')return p>1?p:'';
  let s=String(p??'').replace(/[^\d.,]/g,'');
  if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');
  else if(/^\d{1,3}(\.\d{3})+$/.test(s))s=s.replace(/\./g,'');
  const n=parseFloat(s);
  return n>1?n:'';
}
function dadosDoSistema(depois,camposBloqueados,atual){
  const dados={};
  Object.entries(MAPA_CAMPOS).forEach(([origem,destino])=>{
    if(!camposBloqueados.includes(destino)&&depois[origem]!==undefined)dados[destino]=depois[origem];
  });
  if(dados.marca)dados.marca=tituloMarca(dados.marca);
  if(dados.modelo)dados.modelo=modeloLimpo(dados.modelo);
  // cor so' preenche quando o site ainda nao tem (nao troca "Branco" por "BRANCA").
  const extras={ano:[depois.anoFabricacao,depois.anoModelo].filter(Boolean).join('/'),km:String(depois.km||'').replace(/\D/g,''),cor:atual?.cor?'':String(depois.cor||'').trim()};
  Object.entries(extras).forEach(([k,v])=>{if(v&&!camposBloqueados.includes(k))dados[k]=v;});
  if(!camposBloqueados.includes('preco'))dados.preco=precoDoSistema(depois.preco);
  // Contrato 1.2: evId (identidade fixa do carro), status do sistema (etiqueta
  // "EM PREPARAÇÃO" no site) e alerta de preco <= FIPE (aviso no admin).
  if(depois.evId)dados.evId=depois.evId;
  dados.statusSistema=depois.status||'';
  if(depois.precoAbaixoFipe!==undefined)dados.precoAbaixoFipe=!!depois.precoAbaixoFipe;
  return dados;
}
const mudou=(atual,dados)=>Object.entries(dados).some(([k,v])=>String(atual?.[k]??'')!==String(v??''));

async function aplicarSistemaNoSite(placa,depois){
  const ref=db.collection('site_veiculos').doc(placa);
  const existenteSnap=await ref.get();
  let existente=existenteSnap.exists?existenteSnap.data():null;

  // Placa mudou no sistema (mesmo evId, doc com outra chave): leva o carro do
  // site inteiro (fotos, edicoes, oculto) pra chave nova em vez de criar um
  // carro novo sem foto, e aponta as copias do Autoconf pra placa nova.
  if(!existente&&depois.evId){
    const antigos=await db.collection('site_veiculos').where('evId','==',depois.evId).get();
    const antigo=antigos.docs.find(d=>d.id!==placa&&d.data().origemEstoquePrincipal);
    if(antigo){
      existente={...antigo.data()};
      if(existente.ocultoPorSaida){existente.oculto=false;existente.ocultoPorSaida=false;}
      existente.migradoDe=antigo.id;
      await ref.set(existente);
      const copias=await db.collection('site_veiculos').where('placaSistema','==',antigo.id).get();
      for(const c of copias.docs)await c.ref.set({placaSistema:placa},{merge:true});
      const escondidos=await db.collection('site_veiculos').where('ocultoPorVinculo','==',antigo.id).get();
      for(const c of escondidos.docs)if(c.id!==placa)await c.ref.set({ocultoPorVinculo:placa},{merge:true});
      await antigo.ref.delete(); // so' o doc - as fotos sao as mesmas URLs, agora no doc novo
    }
  }

  const dados=dadosDoSistema(depois,existente?.camposBloqueados||[],existente);
  dados.origemEstoquePrincipal=true;
  // Carro que a passada de 30 min tinha ocultado por ter sumido do sistema e voltou.
  if(existente?.ocultoPorSaida){dados.oculto=false;dados.ocultoPorSaida=false;}

  if(!existente){
    // Veiculo novo: comeca visivel, sem foto (site mostra "Em preparacao"
    // sozinho), nenhum campo travado ainda.
    dados.oculto=false;
    dados.fotos=[];
    dados.opcionais=[];
    dados.camposBloqueados=[];
    dados.fotosBloqueadas=false;
  }
  if(!existente||mudou(existente,dados)){
    dados.sincronizadoEstoqueEm=new Date().toISOString();
    await ref.set(dados,{merge:true});
  }

  // 29/10/2026: a copia que veio do Autoconf (placaSistema) e' a que aparece
  // no site no lugar desse doc - recebe o mesmo preco/km/ano/cor do sistema
  // (marca/modelo/versao e fotos dela continuam como estao).
  const vinculados=await db.collection('site_veiculos').where('placaSistema','==',placa).get();
  for(const d of vinculados.docs){
    const atual=d.data();
    const dc=dadosDoSistema(depois,atual.camposBloqueados||[],atual);
    delete dc.marca;delete dc.modelo;delete dc.versao;
    if(mudou(atual,dc)){dc.sincronizadoEstoqueEm=new Date().toISOString();await d.ref.set(dc,{merge:true});}
  }
}

// Passada geral a cada 30 min: acerta os carros que ja estavam no site antes
// dessa regra (o gatilho acima so' roda quando o carro muda no sistema).
exports.siteSincronizarComSistema=onSchedule({region:'southamerica-east1',schedule:'every 30 minutes',timeZone:'America/Sao_Paulo',timeoutSeconds:300},async()=>{
  const snap=await db.collection('rtcar_estoque_publico').where('status','in',STATUS_RELEVANTES).get();
  for(const d of snap.docs)await aplicarSistemaNoSite(d.id,d.data());

  // Carro do sistema que esta' no site mas nao existe mais no feed (nem com
  // outra placa, pelo evId) - foi excluido no sistema. Oculta (nao apaga):
  // se voltar, aparece de novo sozinho.
  const ativosId=new Set(snap.docs.map(d=>d.id));
  const ativosEv=new Set(snap.docs.map(d=>d.data().evId).filter(Boolean));
  const site=await db.collection('site_veiculos').where('origemEstoquePrincipal','==',true).get();
  for(const d of site.docs){
    const v=d.data();
    if(v.oculto||ativosId.has(d.id)||(v.evId&&ativosEv.has(v.evId)))continue;
    const noFeed=await db.collection('rtcar_estoque_publico').doc(d.id).get();
    if(noFeed.exists)continue; // vendido/repasse: o gatilho ja' cuida
    await d.ref.set({oculto:true,ocultoPorSaida:true,saiuDoSistemaEm:new Date().toISOString()},{merge:true});
  }
});
