const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* OLX - integracao propria (06/11/2026, pedido da Aline: sair do Autoconf).
   Feito a partir da documentacao oficial (developers.olx.com.br), ANTES de a
   OLX liberar o client_id/client_secret (chamado aberto pelo Ricardo, OLX).
   Quando chegarem, a Aline coloca no .env (OLX_CLIENT_ID, OLX_CLIENT_SECRET,
   OLX_TELEFONE, OLX_CEP), faz o deploy e clica "Conectar OLX" uma vez.

   - OAuth: auth.olx.com.br/oauth -> /oauth/token (sem refresh token documentado).
     Token guardado no Storage (privado/olx-oauth.json), nunca no Firestore.
   - Leads: apos conectar, registramos o webhook (autoservice/v1/lead) com um
     token secreto; a OLX manda cada lead UMA vez, sem reenvio, e espera 2xx
     em ate 5 s -> grava rapido e responde.
   - Anuncios: autoupload/import (PUT, insert/delete), catalogo car_info,
     autoupload/v1/published. Plano Premium Empresa permite integracao.
   Nada aqui publica sozinho: publicar e' sempre pela tela Anuncios (regra da
   Aline, 05/11/2026). */

const AUTH='https://auth.olx.com.br';
const APPS='https://apps.olx.com.br';
const FN_BASE='https://southamerica-east1-rtcarprograma.cloudfunctions.net';
const REDIRECT_URI=FN_BASE+'/olxOAuthCallback';
const ARQ='privado/olx-oauth.json';
const EMAILS_GESTOR=['contato@rtcar.com.br','marcela@rtcar.com.br','rafael@rtcar.com.br','tiago@rtcar.com.br','milena@rtcar.com.br','rubens@rtcar.com.br'];

async function lerPrivado(){
  try{const [b]=await admin.storage().bucket().file(ARQ).download();return JSON.parse(b.toString());}
  catch(e){if(e.code===404)return{};throw e;}
}
async function gravarPrivado(dados){
  const atual=await lerPrivado();
  await admin.storage().bucket().file(ARQ).save(JSON.stringify({...atual,...dados}),{contentType:'application/json',resumable:false});
}
async function exigirGestor(req){
  const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
  const dec=await admin.auth().verifyIdToken(tk);
  if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){const e=new Error('Sem permissão');e.status=403;throw e;}
  return dec;
}
async function tokenOLX(){
  const p=await lerPrivado();
  if(!p.accessToken){const e=new Error('OLX ainda não conectada (clique em Conectar OLX)');e.status=409;throw e;}
  return p.accessToken;
}
async function olxPost(caminho,corpo,metodo='POST'){
  const r=await fetch(APPS+caminho,{method:metodo,headers:{'Content-Type':'application/json;charset=UTF-8'},body:JSON.stringify(corpo)});
  const t=await r.text();let j;try{j=JSON.parse(t);}catch{j={raw:t.slice(0,2000)};}
  return{status:r.status,body:j};
}

/* 1) Conectar: o CRM chama (gestor logado), recebe o link de autorizacao da OLX
   com um "state" de uso unico; a Aline entra na conta da loja e autoriza. */
exports.olxConectar=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  try{
    const dec=await exigirGestor(req);
    if(!process.env.OLX_CLIENT_ID){res.status(409).json({erro:'Falta o OLX_CLIENT_ID no .env (a OLX ainda não liberou a chave)'});return;}
    const state=crypto.randomBytes(16).toString('hex');
    await db.collection('olx_config').doc('oauth').set({state,stateEm:new Date().toISOString(),pedidoPor:dec.email||''},{merge:true});
    const url=AUTH+'/oauth?'+new URLSearchParams({response_type:'code',client_id:process.env.OLX_CLIENT_ID,redirect_uri:REDIRECT_URI,scope:'autoupload autoservice basic_user_info',state}).toString();
    res.json({url});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

exports.olxOAuthCallback=onRequest({region:'southamerica-east1'},async(req,res)=>{
  try{
    if(req.query.error){res.status(400).send(`<h2>Autorização recusada</h2><p>${String(req.query.error).replace(/</g,'')}</p>`);return;}
    const code=String(req.query.code||''),state=String(req.query.state||'');
    const cfg=(await db.collection('olx_config').doc('oauth').get()).data()||{};
    if(!code||!state||state!==cfg.state){res.status(400).send('<h2>Link de autorização inválido ou já usado</h2><p>Volte ao CRM e clique em "Conectar OLX" de novo.</p>');return;}
    const r=await fetch(AUTH+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({code,client_id:process.env.OLX_CLIENT_ID,client_secret:process.env.OLX_CLIENT_SECRET,redirect_uri:REDIRECT_URI,grant_type:'authorization_code'}).toString()});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.access_token){console.error('OLX token',d);res.status(500).send(`<h2>Erro ao autorizar na OLX</h2><pre>${JSON.stringify(d.error||d).slice(0,300)}</pre>`);return;}
    // Segredo que a OLX devolve em cada lead (Authorization) - so' quem tem ele cria lead
    const segredoLead=(await lerPrivado()).segredoLead||crypto.randomBytes(24).toString('hex');
    await gravarPrivado({accessToken:d.access_token,conectadoEm:new Date().toISOString(),segredoLead});
    let usuario='';
    try{const u=await olxPost('/oauth_api/basic_user_info',{access_token:d.access_token});usuario=(u.body&&(u.body.user_email||u.body.user_name))||'';}catch(e){}
    // Registra o webhook de leads
    let webhook='';
    try{
      const w=await fetch(APPS+'/autoservice/v1/lead',{method:'POST',headers:{Authorization:'Bearer '+d.access_token,'Content-Type':'application/json'},body:JSON.stringify({url:FN_BASE+'/olxLead',token:segredoLead})});
      const wj=await w.json().catch(()=>({}));webhook=w.ok?('ok '+(wj.id||'')):('erro '+w.status+' '+JSON.stringify(wj).slice(0,200));
    }catch(e){webhook='erro '+e.message;}
    await db.collection('olx_config').doc('oauth').set({state:admin.firestore.FieldValue.delete(),conectadoEm:new Date().toISOString(),contaOLX:usuario,webhookLeads:webhook},{merge:true});
    res.send(`<h2>✅ OLX conectada!</h2><p>Conta: ${usuario.replace(/</g,'')||'(sem nome)'}<br>Recebimento de leads: ${webhook.replace(/</g,'')}</p><p>Pode fechar esta aba e voltar pro CRM.</p>`);
  }catch(e){console.error(e);res.status(500).send('<h2>Erro inesperado</h2>');}
});

/* 2) Leads: a OLX chama este endereco a cada lead (uma vez so', sem reenvio,
   prazo 5 s). Confere o segredo, guarda o bruto e cria/mescla o lead no CRM
   (mesmo padrao da LitoralCar: novo vai pra I.A./Eva; mesmo telefone com lead
   aberto -> so' entra no historico). */
function normTel(t){let d=String(t||'').replace(/\D/g,'');if(d.startsWith('55')&&d.length>=12)d=d.slice(2);return d;}
const pad3=n=>String(n).padStart(3,'0');
const dataBR=d=>d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
const horaBR=d=>d.toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
const FONTE={whatsapp:'WhatsApp',telefone:'telefone',chat:'chat',financing:'simulação de financiamento',olx:'formulário'};

async function criarLeadOLX(l,rawId){
  const agora=new Date();
  const tel=String(l.phone||'').trim(),telNorm=normTel(tel);
  const carro=(l.adsInfo&&l.adsInfo.subject)||'';
  const obs=`Lead OLX (${FONTE[l.source]||l.source||'?'})${carro?' · '+carro:''}${l.message?' · "'+String(l.message).slice(0,500)+'"':''}${l.linkAd?' · anúncio: '+l.linkAd:''}`;
  if(telNorm){
    const cand=await db.collection('leads').where('clienteTelNorm','==',telNorm).get();
    const ativo=cand.docs.map(d=>({_id:d.id,...d.data()})).find(x=>!['vendido','perdido'].includes(x.st));
    if(ativo){
      await db.collection('leads').doc(ativo._id).update({historico:[...(ativo.historico||[]),{dt:dataBR(agora)+' '+horaBR(agora),icone:'gold',acao:'🔗 Contato duplicado (outra plataforma)',obs:'Cliente também chamou pela OLX. '+obs,by:'OLX'}]});
      return ativo._id+' (mesclado)';
    }
  }
  let novoId='';
  await db.runTransaction(async tx=>{
    const refSeq=db.collection('leads_config').doc('mk');
    const snap=await tx.get(refSeq);
    const seq=((snap.exists&&snap.data().leadSeq)||0)+1;
    novoId='LEAD-'+pad3(seq);
    tx.set(refSeq,{leadSeq:seq},{merge:true});
    tx.set(db.collection('leads').doc(novoId),{
      id:novoId,dt:dataBR(agora),dtISO:agora.toISOString().slice(0,10),_criadoEm:agora.toISOString(),
      st:'ia',by:'',captador:'',uid:'',origem:'OLX',
      clienteNome:String(l.name||'').trim(),clienteTel:tel,clienteTelNorm:telNorm,clienteEmail:String(l.email||'').trim(),
      veiculo:carro,valor:(l.adsInfo&&l.adsInfo.price)||'',obs,convertido:false,dtVenda:'',motivoPerda:'',
      historico:[{dt:dataBR(agora)+' '+horaBR(agora),icone:'blue',acao:'Lead criado',obs:'Via API da OLX ('+(FONTE[l.source]||l.source||'?')+')',by:'OLX'}],
      pendente_at:'',pendente_end:'',atendimento_at:'',atendimento_end:'',notificacaoVendedorEm:'',
      olxLeadId:rawId,olxListId:String(l.listId||''),
    });
  });
  return novoId;
}

exports.olxLead=onRequest({region:'southamerica-east1',timeoutSeconds:30},async(req,res)=>{
  try{
    if(req.method!=='POST'){res.status(405).json({erro:'Use POST'});return;}
    const p=await lerPrivado();
    const auth=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
    if(!p.segredoLead||auth!==p.segredoLead){res.status(401).json({erro:'não autorizado'});return;}
    const l=req.body||{};
    const ref=await db.collection('olx_leads_recebidos').add({recebidoEm:new Date().toISOString(),bruto:JSON.stringify(l).slice(0,20000),processadoEm:'',resultado:''});
    let resultado='';
    if(!l.name&&!l.phone&&!l.email)resultado='sem nome/telefone/e-mail';
    else resultado=await criarLeadOLX(l,ref.id);
    await ref.update({processadoEm:new Date().toISOString(),resultado});
    res.status(200).json({ok:true,responseId:ref.id});
  }catch(e){
    console.error('olxLead',e);
    res.status(200).json({ok:false}); // a OLX nao reenvia: o bruto (se gravou) fica pra reprocessar
  }
});

/* 3) Catalogo de marca/modelo/versao (os codigos mudam - a OLX "reequalizou"
   em 25/09/2025): o CRM pede marcas, depois modelos, depois versoes. */
exports.olxCatalogo=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  try{
    await exigirGestor(req);
    const token=await tokenOLX();
    const tipo=req.query.tipo==='moto'?'moto_info':'car_info';
    const partes=[req.query.marca,req.query.modelo].filter(Boolean).map(x=>encodeURIComponent(String(x)));
    const r=await olxPost('/autoupload/'+tipo+(partes.length?'/'+partes.join('/'):''),{access_token:token});
    if(r.status!==200||!r.body||r.body.status!=='ok'){res.status(502).json({erro:'OLX não respondeu o catálogo',detalhe:r.body});return;}
    res.json({itens:Object.entries(r.body.data||{}).map(([nome,id])=>({nome,id:String(id)}))});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

/* 4) Publicar / atualizar (insert) e despublicar (delete). O CRM manda os
   dados ja' escolhidos (codigos do catalogo); fotos e descricao vem do site. */
const COMB={'flex':'3','gasolina':'1','alcool':'2','etanol':'2','diesel':'5','hibrido':'6','gasolina e eletrico':'6','eletrico':'7'};
const CAMBIO={'manual':'1','automatico':'2','automatica':'2','semi-automatico':'3','automatizado':'4'};
const COR={'preto':'1','preta':'1','branco':'2','branca':'2','prata':'3','prateado':'3','vermelho':'4','vermelha':'4','cinza':'5','grafite':'5','azul':'6','amarelo':'7','amarela':'7','verde':'8','laranja':'9'};
const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
const idOLX=chave=>String(chave||'').toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,19);

async function siteDoCarro(v){
  const col=db.collection('site_veiculos');const docs=[];
  if(v.zeroKmSiteId){const d=await col.doc(String(v.zeroKmSiteId)).get();if(d.exists)docs.push(d.data());}
  else{
    const ids=[...new Set([v.placa,v.placaFeed].filter(Boolean).map(x=>String(x).toUpperCase().replace(/[^A-Z0-9]/g,'')))];
    for(const id of ids){const d=await col.doc(id).get();if(d.exists)docs.push(d.data());(await col.where('placaSistema','==',id).get()).docs.forEach(x=>docs.push(x.data()));}
  }
  docs.sort((a,b)=>((a.oculto?1:0)-(b.oculto?1:0))||(((b.fotos||[]).length)-((a.fotos||[]).length)));
  return docs[0]||null;
}

exports.olxPublicar=onRequest({region:'southamerica-east1',cors:true,timeoutSeconds:120},async(req,res)=>{
  try{
    if(req.method!=='POST'){res.status(405).json({erro:'Use POST'});return;}
    const dec=await exigirGestor(req);
    const token=await tokenOLX();
    const telefone=String(process.env.OLX_TELEFONE||'').replace(/\D/g,''),cep=String(process.env.OLX_CEP||'').replace(/\D/g,'');
    if(!telefone||!cep){res.status(409).json({erro:'Falta OLX_TELEFONE ou OLX_CEP no .env'});return;}
    const v=req.body||{};
    const chave=idOLX(v.zeroKmSiteId?'ZK'+v.zeroKmSiteId:v.placa);
    if(!chave){res.status(400).json({erro:'Placa não informada'});return;}
    const site=await siteDoCarro(v);
    const preco=Math.round(Number(String(v.preco||(site&&site.preco)||'').replace(/[^\d.]/g,''))||0);
    const fotos=((site&&site.fotos)||[]).map(u=>typeof u==='string'?u:u&&u.url).filter(Boolean);
    const falta=[];
    if(!(preco>1))falta.push('preço');
    if(!fotos.length)falta.push('fotos no site');
    if(!v.marcaId||!v.modeloId||!v.versaoId)falta.push('marca/modelo/versão do catálogo da OLX');
    const anoModelo=String(v.anoModelo||String((site&&site.ano)||'').split('/').pop()||'').replace(/\D/g,'');
    if(!anoModelo)falta.push('ano');
    const zero=!!v.zeroKmSiteId;
    const placa=String(v.placa||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(!zero&&placa.length!==7)falta.push('placa');
    if(falta.length){res.status(422).json({erro:'Faltam dados: '+falta.join(', ')});return;}
    const params={vehicle_brand:String(v.marcaId),vehicle_model:String(v.modeloId),vehicle_version:String(v.versaoId),regdate:anoModelo,
      mileage:zero?0:(parseInt(String(v.km||(site&&site.km)||'0').replace(/\D/g,''),10)||0)};
    if(zero)params.zero_km=1;else params.vehicle_tag=placa;
    const f=COMB[norm(v.combustivel||(site&&site.combustivel))];if(f)params.fuel=f;
    const c=CAMBIO[norm(v.cambio||(site&&site.cambio))];if(c)params.gearbox=c;
    const cor=COR[norm(v.cor||(site&&site.cor)).split(/\s+/)[0]];if(cor)params.carcolor=cor;
    const portas=String(v.portas||(site&&site.portas)||'');if(portas==='2')params.doors='1';else if(portas==='3')params.doors='3';else if(portas==='4'||portas==='5')params.doors='2';
    const titulo=[v.marca,v.modelo,v.versao].filter(Boolean).join(' ').slice(0,90)||'Veículo RT Car';
    const corpo=String((site&&site.descricao)||`${titulo} ${anoModelo}. Venha conhecer na RT Car, em Brusque/SC!`).slice(0,6000);
    const anuncio={id:chave,operation:'insert',category:2020,subject:titulo.length>=2?titulo:'Veículo RT Car',body:corpo.length>=2?corpo:'Veículo RT Car',
      phone:Number(telefone),type:'s',price:preco,zipcode:cep,images:[...new Set(fotos)].slice(0,20),params};
    const r=await olxPost('/autoupload/import',{access_token:token,ad_list:[anuncio]},'PUT');
    const ok=r.body&&r.body.statusCode===0;
    await db.collection('olx_anuncios').doc(chave).set({id:chave,placa:v.placa||'',zeroKmSiteId:v.zeroKmSiteId||'',titulo,preco,ultimoEnvio:new Date().toISOString(),enviadoPor:dec.email||'',
      importToken:(r.body&&r.body.token)||'',status:ok?'enviado':'erro',erro:ok?'':JSON.stringify(r.body).slice(0,1000),
      escolhidos:{marcaId:String(v.marcaId),modeloId:String(v.modeloId),versaoId:String(v.versaoId)}},{merge:true});
    if(!ok){res.status(422).json({erro:'A OLX recusou: '+((r.body&&r.body.statusMessage)||'erro'),detalhe:r.body&&r.body.errors});return;}
    res.json({ok:true,id:chave,status:'enviado - a OLX revisa antes de publicar'});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

exports.olxDespublicar=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  try{
    if(req.method!=='POST'){res.status(405).json({erro:'Use POST'});return;}
    const dec=await exigirGestor(req);
    const token=await tokenOLX();
    const chave=idOLX((req.body||{}).id);
    const doc=await db.collection('olx_anuncios').doc(chave).get();
    if(!chave||!doc.exists){res.status(404).json({erro:'Esse anúncio não foi publicado pelo nosso sistema'});return;}
    const r=await olxPost('/autoupload/import',{access_token:token,ad_list:[{id:chave,operation:'delete'}]},'PUT');
    const ok=r.body&&r.body.statusCode===0;
    await doc.ref.set({status:ok?'removido':'erro ao remover',removidoEm:ok?new Date().toISOString():'',removidoPor:dec.email||''},{merge:true});
    res.status(ok?200:422).json(ok?{ok:true}:{erro:(r.body&&r.body.statusMessage)||'erro',detalhe:r.body});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

// 5) O que esta' na OLX pelo nosso sistema (id, list_id, status) - tela Anuncios
exports.olxAnunciosStatus=onRequest({region:'southamerica-east1',cors:true,timeoutSeconds:60},async(req,res)=>{
  try{
    await exigirGestor(req);
    const cfg=(await db.collection('olx_config').doc('oauth').get()).data()||{};
    const p=await lerPrivado();
    if(!p.accessToken){res.json({conectado:false,anuncios:[]});return;}
    const anuncios=[];let page='';
    for(let i=0;i<10;i++){
      const r=await fetch(APPS+'/autoupload/v1/published?'+new URLSearchParams({fetch_size:'200',...(page?{page_token:page}:{})}).toString(),{headers:{Authorization:'Bearer '+p.accessToken}});
      const j=await r.json().catch(()=>({}));
      if(!r.ok){res.status(502).json({erro:'OLX não respondeu a lista de anúncios',status:r.status,detalhe:j});return;}
      (j.data||[]).forEach(a=>anuncios.push({id:a.id,listId:a.list_id||'',status:a.status,link:a.list_id?'https://www.olx.com.br/vi/'+a.list_id:''}));
      page=j.next_token;if(!page)break;
    }
    res.json({conectado:true,conta:cfg.contaOLX||'',anuncios});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});
