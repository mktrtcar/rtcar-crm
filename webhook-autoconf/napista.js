const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const crypto = require('crypto');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Na Pista - integracao oficial de INTEGRADOR (26/11/2026, pedido da Aline).
   Documentacao: developers.napista.com.br (protegida por senha; resumo na
   memoria "reference_napista_api_integrador"). Substitui a tentativa de 19/11
   pelo "Copiloto NaPista" (MCP), que foi barrada ("Trusted Hosts").

   - Login: Keycloak realm marketplace-dealer, OAuth 2.0 authorization_code.
     A Na Pista nos da' um client_id (Renan Queiroz, integrador@napista.com.br;
     redirect cadastrado = napistaOAuthCallback). A Aline guarda o client_id
     como Firebase secret NAPISTA_CLIENT_ID. A Aline entra com o login da loja
     NA PROPRIA Na Pista e autoriza - a senha nunca passa por nos. Token e
     refresh ficam no Storage (privado/napista-oauth.json), nunca no Firestore.
   - Ambiente: comeca no de DESENVOLVIMENTO (e' o que a Na Pista libera primeiro).
     Para producao: NAPISTA_AMBIENTE=producao no .env + client_id de producao.
   - Leads: GET /seller/{sellerId}/leads (napistaLeadsPoll, a cada 10 min).
     So' importa lead atualizado DEPOIS da conexao (os antigos ja vieram pelo
     Autoconf). Sem duplicar: pelo id da Na Pista e pelo telefone.
   - Anuncios: POST/PATCH/PUT status/DELETE em /seller/{sellerId}/offer, fotos
     por URL (as do nosso site). Publicar e' sempre manual, pela tela Anuncios
     (regra da Aline). Nunca mexer na "Credencial de integracao de estoque"
     da Na Pista: e' a que o Autoconf usa hoje. */

const PRODUCAO=String(process.env.NAPISTA_AMBIENTE||'').toLowerCase()==='producao';
const AUTH_HOST=PRODUCAO?'https://auth.napista.com.br':'https://auth.development.napista.com.br';
const API=PRODUCAO?'https://api.napista.com.br/seller-inventory-api':'https://api.development.napista.com.br/seller-inventory-api';
const OIDC=AUTH_HOST+'/realms/marketplace-dealer/protocol/openid-connect';
const FN_BASE='https://southamerica-east1-rtcarprograma.cloudfunctions.net';
const REDIRECT_URI=FN_BASE+'/napistaOAuthCallback';
const ARQ='privado/napista-oauth.json';
const SEGREDOS=['NAPISTA_CLIENT_ID'];
const EMAILS_GESTOR=['contato@rtcar.com.br','marcela@rtcar.com.br','rafael@rtcar.com.br','tiago@rtcar.com.br','milena@rtcar.com.br','rubens@rtcar.com.br','samuelrtcar@gmail.com']; // Samuel (assistente de marketing, 27/11/2026): publica anuncios e mexe no site
const OPC={region:'southamerica-east1',cors:true,secrets:SEGREDOS};

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
const b64url=b=>b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const clientId=()=>String(process.env.NAPISTA_CLIENT_ID||'').trim();
const erro=(msg,status)=>{const e=new Error(msg);e.status=status||500;return e;};

/* 1) Conectar: o gestor pede o link; a Aline entra na Na Pista e autoriza. */
exports.napistaConectar=onRequest(OPC,async(req,res)=>{
  try{
    const dec=await exigirGestor(req);
    if(!clientId()){res.status(409).json({erro:'Falta o segredo NAPISTA_CLIENT_ID (a Na Pista ainda não mandou o client_id)'});return;}
    const state=b64url(crypto.randomBytes(16)),verifier=b64url(crypto.randomBytes(48));
    const challenge=b64url(crypto.createHash('sha256').update(verifier).digest());
    await gravarPrivado({pkceVerifier:verifier,pkceState:state});
    await db.collection('napista_config').doc('oauth').set({pedidoEm:new Date().toISOString(),pedidoPor:dec.email||'',ambiente:PRODUCAO?'producao':'desenvolvimento'},{merge:true});
    const url=OIDC+'/auth?'+new URLSearchParams({response_type:'code',client_id:clientId(),redirect_uri:REDIRECT_URI,state,
      code_challenge:challenge,code_challenge_method:'S256'}).toString();
    res.json({url});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

exports.napistaOAuthCallback=onRequest({region:'southamerica-east1',secrets:SEGREDOS},async(req,res)=>{
  try{
    if(req.query.error){res.status(400).send(`<h2>Autorização recusada</h2><p>${String(req.query.error_description||req.query.error).replace(/</g,'')}</p>`);return;}
    const code=String(req.query.code||''),state=String(req.query.state||'');
    const p=await lerPrivado();
    if(!code||(state&&state!==p.pkceState)){res.status(400).send('<h2>Link de autorização inválido ou já usado</h2><p>Volte ao CRM e peça um novo link de conexão da Na Pista.</p>');return;}
    const corpo={grant_type:'authorization_code',code,redirect_uri:REDIRECT_URI,client_id:clientId()};
    if(state&&p.pkceVerifier)corpo.code_verifier=p.pkceVerifier;
    const r=await fetch(OIDC+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(corpo).toString()});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.access_token){console.error('Na Pista token',r.status,d);res.status(500).send(`<h2>Erro ao autorizar na Na Pista</h2><pre>${String(d.error_description||d.error||r.status).replace(/</g,'')}</pre>`);return;}
    const agora=new Date().toISOString();
    await gravarPrivado({accessToken:d.access_token,refreshToken:d.refresh_token||'',expiraEm:Date.now()+((d.expires_in||300)-30)*1000,
      refreshExpiraEm:d.refresh_expires_in?Date.now()+(d.refresh_expires_in-60)*1000:0,conectadoEm:agora,pkceVerifier:'',pkceState:''});
    // Loja(s) a que o login tem acesso: o sellerId e' usado em todas as chamadas
    let lojas=[],sellerId='';
    try{const a=await chamar('GET','/seller/access');lojas=(a&&a.sellers)||[];sellerId=(lojas.find(l=>/rt\s*car/i.test(l.name||''))||lojas[0]||{}).sellerId||'';}catch(e){console.error('Na Pista /seller/access',e.message);}
    await gravarPrivado({sellerId});
    await db.collection('napista_config').doc('oauth').set({conectadoEm:agora,ambiente:PRODUCAO?'producao':'desenvolvimento',temRefresh:!!d.refresh_token,
      sellerId,lojas:lojas.map(l=>({sellerId:l.sellerId||'',nome:l.name||'',documento:l.sellerDocument||''})),leadsDesde:agora},{merge:true});
    res.send(`<h2>✅ Na Pista conectada!</h2><p>Ambiente: ${PRODUCAO?'produção':'desenvolvimento (teste)'}<br>Loja: ${(lojas.find(l=>l.sellerId===sellerId)||{}).name||'(não encontrada)'}</p><p>Pode fechar esta aba e voltar pro CRM.</p>`);
  }catch(e){console.error(e);res.status(500).send('<h2>Erro inesperado</h2>');}
});

async function tokenNapista(){
  const p=await lerPrivado();
  if(!p.accessToken)throw erro('Na Pista ainda não conectada',409);
  if(p.expiraEm>Date.now())return p.accessToken;
  if(!p.refreshToken)throw erro('Conexão da Na Pista expirou - conecte de novo',409);
  const r=await fetch(OIDC+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',refresh_token:p.refreshToken,client_id:clientId()}).toString()});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.access_token){
    await db.collection('napista_config').doc('oauth').set({erroRenovacao:String(d.error_description||d.error||r.status),erroEm:new Date().toISOString()},{merge:true});
    throw erro('Não deu para renovar a conexão da Na Pista ('+(d.error||r.status)+') - conecte de novo',409);
  }
  await gravarPrivado({accessToken:d.access_token,refreshToken:d.refresh_token||p.refreshToken,expiraEm:Date.now()+((d.expires_in||300)-30)*1000,
    refreshExpiraEm:d.refresh_expires_in?Date.now()+(d.refresh_expires_in-60)*1000:(p.refreshExpiraEm||0)});
  return d.access_token;
}
async function chamar(metodo,caminho,corpo){
  const token=await tokenNapista();
  const r=await fetch(API+caminho,{method:metodo,headers:{Authorization:'Bearer '+token,Accept:'application/json',...(corpo?{'Content-Type':'application/json'}:{})},
    body:corpo?JSON.stringify(corpo):undefined});
  const txt=await r.text();let j;try{j=txt?JSON.parse(txt):{};}catch{j={raw:txt.slice(0,1000)};}
  if(!r.ok)throw erro('Na Pista '+r.status+' em '+caminho+': '+JSON.stringify(j).slice(0,400),r.status===401?409:502);
  return j;
}
async function sellerIdAtual(){
  const p=await lerPrivado();
  if(p.sellerId)return p.sellerId;
  const a=await chamar('GET','/seller/access');const s=((a&&a.sellers)||[])[0];
  if(!s)throw erro('O login da Na Pista não tem nenhuma loja',409);
  await gravarPrivado({sellerId:s.sellerId});return s.sellerId;
}

/* 2) Status (tela Anuncios): conectado? + anuncios publicados na Na Pista
   (por placa) + os que o NOSSO sistema mandou (napista_anuncios). */
exports.napistaStatus=onRequest({...OPC,timeoutSeconds:60},async(req,res)=>{
  try{
    await exigirGestor(req);
    const nossos={};(await db.collection('napista_anuncios').get()).docs.forEach(d=>{const x=d.data();nossos[d.id]={offerId:x.offerId||'',status:x.status||'',erro:x.erro||'',titulo:x.titulo||''};});
    const p=await lerPrivado();
    if(!p.accessToken){res.json({conectado:false,semChave:!clientId(),ambiente:PRODUCAO?'producao':'desenvolvimento',anuncios:[],nossos});return;}
    const sellerId=await sellerIdAtual();
    const anuncios=[];
    for(const st of ['PUBLISHED','UNPUBLISHED','DRAFT']){
      for(let page=0;page<20;page++){
        const j=await chamar('GET',`/seller/${sellerId}/offers?`+new URLSearchParams({status:st,page:String(page),limit:'50'}).toString());
        (j.pageData||[]).forEach(o=>anuncios.push({id:o.id,placa:String(o.plate||'').toUpperCase().replace(/[^A-Z0-9]/g,''),status:o.status||st,titulo:o.title||'',preco:o.price||0,fotos:(o.photos||[]).length}));
        if(!j.totalPages||page+1>=j.totalPages)break;
      }
    }
    res.json({conectado:true,ambiente:PRODUCAO?'producao':'desenvolvimento',sellerId,anuncios,nossos});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

/* 3) Catalogo: ?marca= -> modelos; ?modelo=&ano= -> versoes; sem nada -> marcas.
   &tipo=moto usa a categoria MOTORCYCLE. */
exports.napistaCatalogo=onRequest({...OPC,timeoutSeconds:30},async(req,res)=>{
  try{
    await exigirGestor(req);
    const cat=req.query.tipo==='moto'?'MOTORCYCLE':'CAR';
    const ano=String(req.query.ano||'').replace(/\D/g,'');
    let j;
    if(req.query.modelo)j=await chamar('GET',`/catalog/versions/${cat}?`+new URLSearchParams({modelId:String(req.query.modelo),...(ano?{modelYear:ano}:{})}).toString());
    else if(req.query.marca)j=await chamar('GET',`/catalog/${cat}/make/${encodeURIComponent(String(req.query.marca))}/models`+(ano?'?modelYear='+ano:''));
    else j=await chamar('GET',`/catalog/makes/${cat}`);
    res.json({itens:((j&&j.items)||[]).map(x=>({id:String(x.id),nome:x.name||x.alternateName||String(x.id)}))});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

/* 4) Publicar / despublicar. Dados do carro (preco, km, cor, combustivel,
   cambio, fotos, descricao) vem do nosso site; a tela manda a versao escolhida
   no catalogo da Na Pista. */
const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
function combustivelNP(c){const n=norm(c);
  if(/hibrid|gasolina e eletric/.test(n))return'HYBRID';if(/eletric/.test(n))return'ELECTRIC';if(/flex/.test(n))return'FLEX';
  if(/diesel/.test(n))return'DIESEL';if(/alcool|etanol/.test(n))return'ALCOHOL';if(/gasolina/.test(n))return'GASOLINE';return'';}
function corNP(c){const n=norm(c).split(/\s+/)[0];
  return({branco:'WHITE',branca:'WHITE',preto:'BLACK',preta:'BLACK',prata:'SILVER',prateado:'SILVER',cinza:'GRAY',grafite:'GRAY',chumbo:'GRAY',
    vermelho:'RED',vermelha:'RED',azul:'BLUE',amarelo:'YELLOW',amarela:'YELLOW',verde:'GREEN',laranja:'ORANGE',bege:'BEIGE',marrom:'BROWN',
    dourado:'GOLD',dourada:'GOLD',vinho:'BURGUNDY',bordo:'BURGUNDY',rosa:'PINK',roxo:'PURPLE',perolizado:'PEARLED'})[n]||'UNKNOWN';}
const cambioNP=c=>/manual/.test(norm(c))?'MANUAL':'AUTOMATIC';
const chaveNP=v=>String(v.zeroKmSiteId?'ZK'+v.zeroKmSiteId:v.placa||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
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

exports.napistaPublicar=onRequest({...OPC,timeoutSeconds:120},async(req,res)=>{
  try{
    if(req.method!=='POST'){res.status(405).json({erro:'Use POST'});return;}
    const dec=await exigirGestor(req);
    const v=req.body||{};
    const chave=chaveNP(v);if(!chave){res.status(400).json({erro:'Placa não informada'});return;}
    const site=await siteDoCarro(v);
    const preco=Math.round(Number(String(v.preco||(site&&site.preco)||'').replace(/[^\d.]/g,''))||0);
    const fotos=[...new Set(((site&&site.fotos)||[]).map(u=>typeof u==='string'?u:u&&u.url).filter(Boolean))].slice(0,30);
    const anos=String((site&&site.ano)||'').split('/');
    const anoModelo=parseInt(String(v.anoModelo||anos[1]||anos[0]||'').replace(/\D/g,''),10)||0;
    const anoFab=parseInt(String(v.anoFabricacao||anos[0]||anoModelo).replace(/\D/g,''),10)||anoModelo;
    const comb=v.fuelType||combustivelNP(v.combustivel||(site&&site.combustivel));
    const falta=[];
    if(!(preco>1))falta.push('preço');if(!fotos.length)falta.push('fotos no site');if(!v.versionId)falta.push('versão do catálogo da Na Pista');
    if(!anoModelo)falta.push('ano');if(!comb)falta.push('combustível');
    if(falta.length){res.status(422).json({erro:'Faltam dados: '+falta.join(', ')});return;}
    const sellerId=await sellerIdAtual();
    const placa=v.zeroKmSiteId?'':String(v.placa||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const portas=parseInt(String(v.portas||(site&&site.portas)||''),10)||undefined;
    const oferta={versionId:String(v.versionId),modelYear:anoModelo,manufacturedYear:anoFab,price:preco,
      mileage:v.zeroKmSiteId?0:(parseInt(String(v.km||(site&&site.km)||'0').replace(/\D/g,''),10)||0),
      fuelType:comb,color:v.color||corNP(v.cor||(site&&site.cor)),transmissionType:v.transmissionType||cambioNP(v.cambio||(site&&site.cambio)),
      armoured:false,status:'PUBLISHED',...(placa?{plate:placa}:{}),...(portas?{numberOfDoors:portas}:{}),
      ...(v.titulo?{title:String(v.titulo).slice(0,120)}:{}),description:String((site&&site.descricao)||`${v.titulo||'Veículo'} ${anoModelo}. Venha conhecer na RT Car, em Brusque/SC!`).slice(0,5000)};
    const ref=db.collection('napista_anuncios').doc(chave);
    const ja=(await ref.get()).data()||{};
    let offerId=ja.offerId||'';
    try{
      if(offerId){await chamar('PATCH',`/seller/${sellerId}/offer/${offerId}`,oferta);}
      else{const o=await chamar('POST',`/seller/${sellerId}/offer`,oferta);offerId=(o&&o.id)||'';}
      if(!offerId)throw erro('A Na Pista não devolveu o id do anúncio',502);
      // Fotos: troca todas pelas do site (na ordem)
      if(ja.offerId){try{await chamar('DELETE',`/seller/${sellerId}/offer/${offerId}/photos`);}catch(e){console.warn('apagar fotos',e.message);}}
      await chamar('POST',`/seller/${sellerId}/offer/${offerId}/photos/url`,{list:fotos.map((url,i)=>({url,order:i+1}))});
      await ref.set({chave,placa:v.placa||'',zeroKmSiteId:v.zeroKmSiteId||'',offerId,titulo:oferta.title||'',preco,status:'publicado',erro:'',
        ultimoEnvio:new Date().toISOString(),enviadoPor:dec.email||'',escolhidos:{versionId:String(v.versionId)}},{merge:true});
      res.json({ok:true,offerId,status:'publicado'});
    }catch(e){
      await ref.set({chave,placa:v.placa||'',offerId,status:'erro',erro:String(e.message).slice(0,1000),ultimoEnvio:new Date().toISOString()},{merge:true});
      throw e;
    }
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

// body {placa|zeroKmSiteId|offerId, vendido:true?} -> status SOLD (vendido) ou UNPUBLISHED
exports.napistaDespublicar=onRequest({...OPC,timeoutSeconds:60},async(req,res)=>{
  try{
    if(req.method!=='POST'){res.status(405).json({erro:'Use POST'});return;}
    await exigirGestor(req);
    const v=req.body||{};const chave=chaveNP(v);
    const ref=chave?db.collection('napista_anuncios').doc(chave):null;
    const offerId=v.offerId||(ref&&((await ref.get()).data()||{}).offerId)||'';
    if(!offerId){res.status(404).json({erro:'Anúncio da Na Pista não encontrado no nosso sistema'});return;}
    const sellerId=await sellerIdAtual();
    const st=v.vendido?'SOLD':'UNPUBLISHED';
    await chamar('PUT',`/seller/${sellerId}/offer/${offerId}/${st}`);
    if(ref)await ref.set({status:v.vendido?'vendido':'removido',removidoEm:new Date().toISOString()},{merge:true});
    res.json({ok:true,offerId,status:st});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

/* 5) Leads: a cada 10 min busca os leads dos ultimos 2 dias e cria no CRM os
   novos (origem "Na Pista", I.A./Eva). Bruto em napista_leads_recebidos/{id}. */
function normTel(t){let d=String(t||'').replace(/\D/g,'');if(d.startsWith('55')&&d.length>=12)d=d.slice(2);return d;}
const pad3=n=>String(n).padStart(3,'0');
const dataBR=d=>d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
const horaBR=d=>d.toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
const reais=n=>n?'R$ '+Number(n).toLocaleString('pt-BR',{minimumFractionDigits:0}):'';
const CREDITO={PRE_APPROVED:'pré-aprovado',HIGH_SCORE:'score alto',MIDDLE_SCORE:'score médio',LOW_SCORE:'score baixo',DENIED:'negado',CANNOT_OPERATE:'não pode operar',NEUTRAL:'neutro'};

async function criarLeadNapista(l){
  const agora=new Date();
  const tel=l.clientPhone?String(l.clientPhone.areaCode||'')+String(l.clientPhone.number||''):'';
  const telNorm=normTel(tel);
  const fin=l.upfrontValue||l.installments?` · Simulação: entrada ${reais(l.upfrontValue)}${l.installments?`, ${l.installments}x de ${reais(l.installmentValue)}`:''}`:'';
  const obs=`Lead Na Pista (API)${l.vehicleVersion?' · '+l.vehicleVersion:''}${l.vehiclePlate?' · placa '+l.vehiclePlate:''}${l.contactMessage?' · "'+String(l.contactMessage).slice(0,500)+'"':''}${fin}${l.clientCreditStatus?' · crédito: '+(CREDITO[l.clientCreditStatus]||l.clientCreditStatus):''}`;
  if(telNorm){
    const vars=[...new Set([telNorm,telNorm.slice(-8),telNorm.slice(-9),telNorm.slice(-10),telNorm.slice(-11)].filter(v=>v.length>=8))];
    const cand=await db.collection('leads').where('clienteTelNorm','in',vars).get();
    const ativo=cand.docs.map(d=>({_id:d.id,...d.data()})).find(x=>!['vendido','perdido'].includes(x.st));
    if(ativo){
      await db.collection('leads').doc(ativo._id).update({historico:[...(ativo.historico||[]),{dt:dataBR(agora)+' '+horaBR(agora),icone:'gold',acao:'🔗 Contato duplicado (outra plataforma)',obs:'Cliente também chamou pela Na Pista. '+obs,by:'Na Pista'}]});
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
      st:'ia',by:'',captador:'',uid:'',origem:'Na Pista',
      clienteNome:String(l.clientName||'').trim(),clienteTel:tel,clienteTelNorm:telNorm,clienteEmail:String(l.clientEmail||'').trim(),
      veiculo:String(l.vehicleVersion||''),valor:'',obs,convertido:false,dtVenda:'',motivoPerda:'',
      historico:[{dt:dataBR(agora)+' '+horaBR(agora),icone:'blue',acao:'Lead criado',obs:'Via API da Na Pista',by:'Na Pista'}],
      pendente_at:'',pendente_end:'',atendimento_at:'',atendimento_end:'',notificacaoVendedorEm:'',
      napistaLeadId:String(l.id||''),napistaCredito:l.clientCreditStatus||'',
    });
  });
  return novoId;
}

async function buscarLeadsNapista(){
  const p=await lerPrivado();
  if(!p.accessToken)return'não conectada';
  const cfg=(await db.collection('napista_config').doc('oauth').get()).data()||{};
  const desde=cfg.leadsDesde||cfg.conectadoEm||new Date().toISOString();
  const sellerId=await sellerIdAtual();
  const hoje=new Date(),ini=new Date(Date.now()-2*864e5);
  const dia=d=>d.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  let novos=0,vistos=0;
  for(let page=0;page<10;page++){
    const j=await chamar('GET',`/seller/${sellerId}/leads?`+new URLSearchParams({initialDate:dia(ini),endDate:dia(hoje),page:String(page),size:'50'}).toString());
    for(const l of (j.pageData||[])){
      vistos++;
      const ref=db.collection('napista_leads_recebidos').doc(String(l.id));
      if((await ref.get()).exists)continue;
      const antigo=String(l.updatedAt||'')<desde;
      let resultado='antigo (antes da conexão - já veio pelo Autoconf)';
      if(!antigo){
        if(!l.clientName&&!l.clientPhone&&!l.clientEmail)resultado='sem nome/telefone/e-mail';
        else{const ja=await db.collection('leads').where('napistaLeadId','==',String(l.id)).limit(1).get();resultado=ja.empty?await criarLeadNapista(l):ja.docs[0].id+' (já importado)';if(!/mesclado|já/.test(resultado))novos++;}
      }
      await ref.set({recebidoEm:new Date().toISOString(),bruto:JSON.stringify(l).slice(0,20000),resultado});
    }
    if(!j.totalPages||page+1>=j.totalPages)break;
  }
  await db.collection('napista_config').doc('oauth').set({ultimaBuscaLeads:new Date().toISOString(),ultimaBuscaResultado:`${vistos} vistos, ${novos} novos`},{merge:true});
  return `${vistos} vistos, ${novos} novos`;
}
exports.napistaLeadsPoll=onSchedule({region:'southamerica-east1',schedule:'every 10 minutes',timeZone:'America/Sao_Paulo',timeoutSeconds:120,secrets:SEGREDOS},async()=>{
  try{console.log('Na Pista leads:',await buscarLeadsNapista());}catch(e){console.error('Na Pista leads',e.message);}
});
// Gestor: roda a busca de leads na hora (teste)
exports.napistaLeadsAgora=onRequest({...OPC,timeoutSeconds:120},async(req,res)=>{
  try{await exigirGestor(req);res.json({resultado:await buscarLeadsNapista()});}
  catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});
