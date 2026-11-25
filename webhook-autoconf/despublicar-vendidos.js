const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Tira do ar carro VENDIDO (25/11/2026, pedido da Aline - "pode ajustar").
   Na varredura de 25/11 achamos 13 carros vendidos ainda anunciados pelo
   NOSSO integrador (10 na LitoralCar, 1 no ML, 3 tirados antes), porque nada
   despublicava sozinho quando o carro era vendido no sistema da Marcela.
   A cada 30 min: le' o feed (rtcar_estoque_publico) e, para cada anuncio
   feito pelo nosso sistema (litoralcar_veiculos / ml_anuncios / olx_anuncios),
   se o carro esta' com status vendido ou repasse, tira do ar e avisa a Aline
   pelo WhatsApp da Eva.
   Regras de seguranca:
   - So' mexe em anuncio NOSSO (nunca nos do Autoconf).
   - Carro que sumiu do feed NAO conta como vendido (delete no feed pode ser
     troca de placa - contrato 1.2); so' status vendido/repasse.
   - 0 km sob encomenda (ZK..., sem placa) nunca e' tocado.
   - Feed com menos de 30 carros = leitura suspeita: nao faz nada.
   - No maximo 20 remocoes por rodada. */
const STATUS_SAIU=['vendido','repasse'];
const MAX_POR_RODADA=20;

// Placa Mercosul -> formato antigo (5o caractere A-J = 0-9), igual ao feed
function chave(p){
  let x=String(p||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(x.length===7&&/[A-J]/.test(x[4]))x=x.slice(0,4)+('ABCDEFGHIJ'.indexOf(x[4]))+x.slice(5);
  return x;
}

async function carrosQueSairam(){
  const snap=await db.collection('rtcar_estoque_publico').get();
  if(snap.size<30)throw new Error('Feed com só '+snap.size+' carros - leitura suspeita, nada feito');
  const st={};
  snap.docs.forEach(d=>{const f=d.data();const k=chave(f.placa||d.id);if(!k)return;
    // mesma placa com 2 docs: se algum estiver ativo, vale o ativo
    if(st[k]&&!STATUS_SAIU.includes(st[k].status))return;
    st[k]={status:String(f.status||''),nome:[f.marca,f.modelo].filter(Boolean).join(' ').trim()};});
  return st;
}

async function verificar(executar){
  const st=await carrosQueSairam();
  const saiu=k=>k&&!/^ZK/.test(k)&&st[k]&&STATUS_SAIU.includes(st[k].status);
  const acoes=[];

  // LitoralCar
  (await db.collection('litoralcar_veiculos').get()).docs.forEach(d=>{const x=d.data();
    if(x.codVeiculo&&saiu(chave(d.id)))acoes.push({portal:'LitoralCar',ref:d.ref,placa:d.id,k:chave(d.id),codVeiculo:x.codVeiculo,codImportacao:x.codImportacao});});
  // Mercado Livre (so' os nossos: ml_anuncios)
  (await db.collection('ml_anuncios').get()).docs.forEach(d=>{const x=d.data();
    if(x.itemId&&!['closed','encerrado'].includes(String(x.status||''))&&saiu(chave(x.placa||d.id)))acoes.push({portal:'Mercado Livre',ref:d.ref,placa:d.id,k:chave(x.placa||d.id),itemId:x.itemId});});
  // OLX (so' os nossos: olx_anuncios)
  (await db.collection('olx_anuncios').get()).docs.forEach(d=>{const x=d.data();
    if(!/removido/.test(String(x.status||''))&&!x.zeroKmSiteId&&saiu(chave(x.placa||d.id)))acoes.push({portal:'OLX',ref:d.ref,placa:d.id,k:chave(x.placa||d.id),id:d.id});});

  if(!executar)return acoes.map(a=>({portal:a.portal,placa:a.placa,status:st[a.k].status,carro:st[a.k].nome}));

  const feitos=[],falhas=[];
  let mlTk=null,olxTk=null;
  for(const a of acoes.slice(0,MAX_POR_RODADA)){
    const info={portal:a.portal,placa:a.placa,status:st[a.k].status,carro:st[a.k].nome};
    try{
      if(a.portal==='LitoralCar'){
        const {litoralFetch}=require('./litoralcar')._interno;
        const r=await litoralFetch('excluir','estoque',undefined,{veiculos:[{cod_importacao:Number(a.codImportacao),cod_veiculo:Number(a.codVeiculo)}]});
        let itens=(r.body&&r.body.veiculos)||[];if(!Array.isArray(itens))itens=(itens&&typeof itens==='object')?Object.values(itens):[itens];
        const vlt=(itens[0]&&itens[0].veiculo)||{};
        // "Nenhum veiculo encontrado" = o anuncio ja' nao existe la' (tirado a mao): so' acerta o registro
        const jaSaiu=/nenhum ve[ií]culo encontrado/i.test(JSON.stringify(r.body||''));
        if(!jaSaiu&&!/excluido|excluído/i.test(vlt.status||''))throw new Error('LitoralCar respondeu: '+(vlt.status||JSON.stringify(r.body).slice(0,200)));
        await a.ref.set({codVeiculo:admin.firestore.FieldValue.delete(),ultimaRemocao:new Date().toISOString(),removidoPorVenda:true},{merge:true});
      }else if(a.portal==='Mercado Livre'){
        const ml=require('./mercadolivre')._interno;
        if(!mlTk)mlTk=(await ml.obterToken()).accessToken;
        // ja' encerrado (ex.: tirado a mao)? so' acerta o registro
        const atual=await fetch(ml.API+'/items/'+a.itemId+'?attributes=id,status',{headers:{Authorization:'Bearer '+mlTk}}).then(x=>x.json()).catch(()=>({}));
        if(atual.status==='closed'){await a.ref.set({status:'closed',encerradoEm:new Date().toISOString()},{merge:true});feitos.push(info);continue;}
        const r=await fetch(ml.API+'/items/'+a.itemId,{method:'PUT',headers:{Authorization:'Bearer '+mlTk,'Content-Type':'application/json'},body:JSON.stringify({status:'closed'})});
        const j=await r.json().catch(()=>({}));
        if(!r.ok)throw new Error('ML recusou ('+r.status+'): '+(j.message||''));
        await a.ref.set({status:'closed',encerradoEm:new Date().toISOString(),encerradoPorVenda:true},{merge:true});
        await db.collection('ml_encerrados').add({itemId:a.itemId,acao:'closed',placa:a.placa,por:'despublicarVendidos',em:new Date().toISOString()});
      }else if(a.portal==='OLX'){
        const olx=require('./olx')._interno;
        if(!olxTk)olxTk=await olx.tokenOLX();
        const r=await olx.olxPost('/autoupload/import',{access_token:olxTk,ad_list:[{id:a.id,operation:'delete'}]},'PUT');
        if(!(r.body&&r.body.statusCode===0))throw new Error('OLX recusou: '+((r.body&&r.body.statusMessage)||r.status));
        await a.ref.set({status:'removido',removidoEm:new Date().toISOString(),removidoPor:'despublicarVendidos'},{merge:true});
      }
      feitos.push(info);
    }catch(e){console.error('despublicarVendidos',a.portal,a.placa,e);falhas.push({...info,erro:String(e.message||e)});}
  }
  if(feitos.length||falhas.length){
    await db.collection('despublicados_auto').add({em:new Date().toISOString(),feitos,falhas,pendentes:Math.max(0,acoes.length-MAX_POR_RODADA)});
    const linhas=feitos.map(f=>'• '+(f.carro||f.placa)+' ('+f.placa+') - '+f.portal);
    const linhasF=falhas.map(f=>'• '+(f.carro||f.placa)+' ('+f.placa+') - '+f.portal+': '+f.erro.slice(0,80));
    const texto='🚗 Carros que saíram do estoque e foram tirados dos anúncios:\n'+(linhas.join('\n')||'-')+
      (linhasF.length?'\n\n⚠️ Não consegui tirar (tirar à mão):\n'+linhasF.join('\n'):'');
    await db.collection('mensagens_avulsas').add({destino:'Aline',texto,enviadaEm:'',criadaEm:new Date().toISOString(),origem:'despublicarVendidos'});
  }
  return {feitos,falhas,pendentes:Math.max(0,acoes.length-MAX_POR_RODADA)};
}

exports.despublicarVendidos=onSchedule({region:'southamerica-east1',schedule:'every 30 minutes',timeZone:'America/Sao_Paulo',timeoutSeconds:300},async()=>{
  const r=await verificar(true);
  console.log('despublicarVendidos',JSON.stringify(r));
});

// Previa (gestor logado): mostra o que seria tirado, sem tirar nada.
exports.despublicarVendidosVer=onRequest({region:'southamerica-east1',cors:true,timeoutSeconds:120},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    await admin.auth().verifyIdToken(tk);
    res.json({seriamTirados:await verificar(false)});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:String(e.message||e)});}
});
