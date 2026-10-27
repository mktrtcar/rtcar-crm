const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onDocumentCreated} = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Leads do Mercado Livre direto pela API oficial (26/10/2026, pedido da Aline -
   tirar a dependencia do Autoconf, que vai ser cancelado). Recurso "Pessoas
   interessadas": GET /vis/users/$USER_ID/leads/buyers devolve nome, telefone,
   e-mail e o anuncio (item_id) de quem clicou em WhatsApp/ligar/perguntou/
   simulou credito. O ML tambem avisa na hora (topico "VIS Leads") - o aviso so'
   dispara a mesma sincronizacao, entao nao dependemos do formato do aviso.
   Autorizacao OAuth feita 1x pela Aline no navegador (conta ML da RT Car);
   client id/secret ficam no .env (nunca no GitHub).

   MODO TESTE (padrao): so' grava o que chegou em ml_leads_recebidos, sem criar
   lead no CRM - pra comparar alguns dias com o que o Autoconf entrega. Quando
   conferido, ligar leads_config/ml_oauth.criarLeads=true e desligar o ML no
   Autoconf. */
const REDIRECT_URI='https://southamerica-east1-rtcarprograma.cloudfunctions.net/mercadolivreoauth';
const API='https://api.mercadolibre.com';
const RODIZIO=['Janderson','Maicon','Victor'];
const refConfig=()=>db.collection('leads_config').doc('ml_oauth');

function pad3(n){return String(n).padStart(3,'0');}
function agoraBR(){
  const p=Object.fromEntries(new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date()).map(x=>[x.type,x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour==='24'?'00':p.hour}:${p.minute}`;
}
function hojeBR(){return agoraBR().slice(0,10);}
function isoSP(offsetDias=0){const d=new Date(Date.now()+offsetDias*864e5);return d.toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'});}
// Ultimos 8 digitos - mesmo criterio do webhook do Autoconf (clienteTelNorm),
// pra o mesmo cliente vindo pelos dois caminhos cair no mesmo lead.
function normalizarTel(tel){return String(tel||'').replace(/\D/g,'').slice(-8)||'';}
// "+55 47 99999-9999" -> "(47) 99999-9999"
function telBR(tel){
  let d=String(tel||'').replace(/\D/g,'');
  if(d.startsWith('55')&&d.length>=12)d=d.slice(2);
  if(d.length===11)return`(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if(d.length===10)return`(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return String(tel||'');
}
const TIPO_CONTATO={whatsapp:'clicou no WhatsApp',call:'clicou em ligar',question:'fez uma pergunta',credit:'simulou crédito',contact_request:'pediu contato',visit_request:'pediu visita',reservation:'fez uma reserva'};

exports.mercadolivreoauth=onRequest({region:'southamerica-east1'},async(req,res)=>{
  try{
    if(req.query.error){res.status(400).send(`<h2>Autorização recusada</h2><p>${String(req.query.error)}</p>`);return;}
    const code=req.query.code;
    if(!code){res.status(400).send('<h2>Código não recebido</h2>');return;}
    const resp=await fetch(API+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'authorization_code',client_id:process.env.ML_CLIENT_ID,client_secret:process.env.ML_CLIENT_SECRET,code,redirect_uri:REDIRECT_URI}).toString()});
    const dados=await resp.json();
    if(!resp.ok||!dados.refresh_token){console.error('ML token:',dados);res.status(500).send(`<h2>Erro ao autorizar</h2><pre>${JSON.stringify(dados,null,2)}</pre>`);return;}
    await refConfig().set({accessToken:dados.access_token,refreshToken:dados.refresh_token,expiraEm:Date.now()+(dados.expires_in||21600)*1000,userId:dados.user_id,autorizadoEm:new Date().toISOString()},{merge:true});
    res.send('<h2>✅ Mercado Livre autorizado!</h2><p>Pode fechar esta aba e voltar pro chat.</p>');
  }catch(e){console.error(e);res.status(500).send(`<h2>Erro inesperado</h2><pre>${e.message}</pre>`);}
});

// O refresh_token do ML e' de uso unico - cada renovacao devolve um novo, que
// precisa ser gravado (senao a proxima renovacao falha).
async function obterToken(){
  const ref=refConfig();
  const snap=await ref.get();
  const c=snap.exists?snap.data():{};
  if(!c.refreshToken)throw new Error('Mercado Livre ainda não foi autorizado');
  if(c.accessToken&&c.expiraEm-Date.now()>5*60*1000)return c;
  const resp=await fetch(API+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'refresh_token',client_id:process.env.ML_CLIENT_ID,client_secret:process.env.ML_CLIENT_SECRET,refresh_token:c.refreshToken}).toString()});
  const dados=await resp.json();
  if(!resp.ok||!dados.access_token)throw new Error('Erro ao renovar token ML: '+JSON.stringify(dados));
  const novo={accessToken:dados.access_token,refreshToken:dados.refresh_token||c.refreshToken,expiraEm:Date.now()+(dados.expires_in||21600)*1000};
  await ref.set(novo,{merge:true});
  return{...c,...novo};
}
async function apiML(caminho,token){
  const r=await fetch(API+caminho,{headers:{Authorization:'Bearer '+token}});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(`ML ${r.status} ${caminho}: ${JSON.stringify(j).slice(0,300)}`);
  return j;
}
const _titulos={};
async function tituloItem(itemId,token){
  if(!itemId)return'';
  if(_titulos[itemId]!==undefined)return _titulos[itemId];
  try{const it=await apiML('/items/'+itemId,token);_titulos[itemId]=it.title||'';}catch(e){_titulos[itemId]='';}
  return _titulos[itemId];
}

// Cria o lead no CRM (ou mescla se o mesmo telefone ja tem lead em andamento).
// Igual ao Mercado Livre via Autoconf: sem Eva, direto pro rodizio.
async function criarLeadML(r,lead,veiculo){
  const telNorm=normalizarTel(r.phone);
  const tipo=TIPO_CONTATO[lead.contact_type]||lead.contact_type||'contato';
  const obs=`Mercado Livre — cliente ${tipo}${veiculo?` no anúncio ${veiculo}`:''} (${lead.item_id||''}) · lead ML ${lead.id}`;
  if(telNorm){
    const cand=await db.collection('leads').where('clienteTelNorm','==',telNorm).get();
    const ativo=cand.docs.map(d=>({_id:d.id,...d.data()})).find(l=>!['vendido','perdido'].includes(l.st));
    if(ativo){
      await db.collection('leads').doc(ativo._id).update({historico:[...(ativo.historico||[]),{dt:agoraBR(),icone:'gold',acao:'🔗 Contato duplicado (outra plataforma)',obs,by:'Mercado Livre'}],...(!ativo.veiculo&&veiculo?{veiculo}:{})});
      return ativo._id+' (mesclado)';
    }
  }
  let novoId='';
  await db.runTransaction(async tx=>{
    const refSeq=db.collection('leads_config').doc('mk');
    const refRodizio=db.collection('leads_config').doc('rodizio');
    const snapSeq=await tx.get(refSeq);const snapRod=await tx.get(refRodizio);
    const seq=((snapSeq.exists&&snapSeq.data().leadSeq)||0)+1;
    novoId='LEAD-'+pad3(seq);
    const dr=snapRod.exists?snapRod.data():{};
    const ativos=RODIZIO.filter(n=>dr.ativos?.[n]!==false);const lista=ativos.length?ativos:RODIZIO;
    const idx=dr.idx||0;const captador=lista[idx%lista.length];
    tx.set(refSeq,{leadSeq:seq},{merge:true});
    tx.set(refRodizio,{idx:idx+1},{merge:true});
    tx.set(db.collection('leads').doc(novoId),{
      id:novoId,dt:hojeBR(),dtISO:isoSP(),_criadoEm:new Date().toISOString(),
      st:'atendimento',by:'',captador,uid:'',origem:'Mercado Livre',
      clienteNome:r.name||'',clienteTel:telBR(r.phone),clienteTelNorm:telNorm,clienteEmail:r.email||'',
      veiculo,valor:'',obs,convertido:false,dtVenda:'',motivoPerda:'',
      historico:[{dt:agoraBR(),icone:'blue',acao:'Lead criado',obs:`Via API do Mercado Livre (cliente ${tipo}) — direto pro rodízio — vendedor: ${captador}`,by:'Mercado Livre'}],
      pendente_at:'',pendente_end:'',atendimento_at:new Date().toISOString(),atendimento_end:'',notificacaoVendedorEm:'',
      mlLeadId:lead.id,mlItemId:lead.item_id||'',
    });
  });
  return novoId;
}

// Busca os interessados de ontem e hoje e processa cada lead novo uma unica vez
// (ml_leads_recebidos/{id do lead ML} guarda o que ja' foi visto).
async function sincronizarML(){
  const c=await obterToken();
  const token=c.accessToken;const criar=c.criarLeads===true;
  let offset=0,total=0,novos=0;const res=[];
  do{
    const j=await apiML(`/vis/users/${c.userId}/leads/buyers?offset=${offset}&limit=50&date_from=${isoSP(-1)}&date_to=${isoSP()}`,token);
    total=(j.paging&&j.paging.total)||0;
    for(const r of (j.results||[])){
      for(const lead of (r.leads||[])){
        const ref=db.collection('ml_leads_recebidos').doc(String(lead.id));
        if((await ref.get()).exists)continue;
        const veiculo=await tituloItem(lead.item_id||r.item_id,token);
        const doc={recebidoEm:new Date().toISOString(),criadoNoML:lead.created_at||'',tipo:lead.contact_type||lead.channel||'',itemId:lead.item_id||r.item_id||'',veiculo,nome:r.name||'',telefone:r.phone||'',email:r.email||'',compradorId:r.id||'',modoTeste:!criar};
        if(criar){try{doc.leadCRM=await criarLeadML(r,lead,veiculo);}catch(e){doc.erro=String(e.message||e);}}
        await ref.set(doc);novos++;res.push(doc.leadCRM||doc.nome);
      }
    }
    offset+=50;
  }while(offset<total&&offset<500);
  await refConfig().set({ultimaSincronizacao:new Date().toISOString(),ultimoResultado:`${novos} novo(s)`},{merge:true});
  return{novos,res};
}

/* WhatsApp dos anuncios (27/10/2026, pedido da Aline): os anuncios publicados
   pelo Autoconf saiam com o WhatsApp da Milena (47 99993-8679) - o cliente que
   clicava em WhatsApp no ML caia no celular dela. Troca pelo da Eva em todos os
   anuncios ativos. So' mexe no campo de telefone que tem o numero antigo (o
   seller_contact tem phone e phone2 - nao dependemos de saber qual e' o do
   WhatsApp). Roda sob demanda (gestor) e todo dia como vigia. */
const WHATS_ANTIGO='99938679';
const EVA={area_code:'47',phone:'992812847'};
// A busca /users/$ID/items/search devolve 403 pro nosso app (27/10/2026) - os
// codigos dos anuncios podem vir prontos (idsInformados) ou salvos do ultimo
// envio (leads_config/ml_oauth.idsAnuncios), que o vigia diario reaproveita.
async function corrigirContatoAnuncios(simular,idsInformados){
  const c=await obterToken();const token=c.accessToken;
  let ids=(idsInformados&&idsInformados.length)?idsInformados:(c.idsAnuncios||[]);
  if(!ids.length){
    let offset=0,total=0;
    do{const j=await apiML(`/users/${c.userId}/items/search?status=active&offset=${offset}&limit=50`,token);total=(j.paging&&j.paging.total)||0;ids.push(...(j.results||[]));offset+=50;}while(offset<total&&offset<1000);
  }
  ids=[...new Set(ids.map(x=>String(x).replace(/[^A-Z0-9]/gi,'').toUpperCase()).filter(x=>/^MLB\d+$/.test(x)))];
  if(idsInformados&&idsInformados.length&&!simular)await refConfig().set({idsAnuncios:ids},{merge:true});
  const res=[];
  for(const id of ids){
    let it;
    try{it=await apiML(`/items/${id}?attributes=id,title,seller_contact,status`,token);}catch(e){res.push({id,erro:String(e.message).slice(0,200)});continue;}
    if(it.status&&it.status!=='active'){res.push({id,ok:'não está ativo ('+it.status+')'});continue;}
    const sc={...(it.seller_contact||{})};let mudou=false;
    for(const [ac,ph] of [['area_code','phone'],['area_code2','phone2']]){
      const num=String(sc[ac]||'')+String(sc[ph]||'');
      if(num.replace(/\D/g,'').endsWith(WHATS_ANTIGO)){sc[ac]=EVA.area_code;sc[ph]=EVA.phone;mudou=true;}
    }
    if(!mudou){res.push({id,ok:'já estava certo'});continue;}
    if(simular){res.push({id,titulo:it.title,antes:it.seller_contact,depois:sc});continue;}
    const r=await fetch(`${API}/items/${id}`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({seller_contact:sc})});
    const j=await r.json().catch(()=>({}));
    res.push({id,titulo:it.title,trocado:r.ok,erro:r.ok?undefined:JSON.stringify(j).slice(0,300)});
  }
  await refConfig().set({contatoCorrigidoEm:new Date().toISOString(),contatoResultado:`${res.filter(x=>x.trocado).length} trocado(s) de ${ids.length}`},{merge:true});
  return{total:ids.length,res};
}
const EMAILS_GESTOR=['contato@rtcar.com.br','marcela@rtcar.com.br','rafael@rtcar.com.br','tiago@rtcar.com.br','milena@rtcar.com.br','rubens@rtcar.com.br'];
exports.mercadoLivreCorrigirContato=onRequest({region:'southamerica-east1',timeoutSeconds:540,cors:true},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const corpo=(req.body&&typeof req.body==='object')?req.body:{};
    res.json(await corrigirContatoAnuncios(req.query.simular==='1'||corpo.simular===true,Array.isArray(corpo.ids)?corpo.ids:[]));
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});
exports.mercadoLivreVigiaContato=onSchedule({region:'southamerica-east1',schedule:'0 7 * * *',timeZone:'America/Sao_Paulo',timeoutSeconds:540},async()=>{
  try{await corrigirContatoAnuncios(false);}catch(e){console.error('ML vigia contato:',e);}
});

// Aviso do ML (topico VIS Leads): o ML exige resposta em menos de 500 ms, entao
// so' grava o aviso e responde; a sincronizacao roda no gatilho abaixo.
exports.mercadolivrenotificacao=onRequest({region:'southamerica-east1'},async(req,res)=>{
  try{await db.collection('ml_notificacoes').add({recebidaEm:new Date().toISOString(),corpo:req.body||{}});}
  catch(e){console.error('ML notificacao:',e);}
  res.status(200).send('ok');
});
exports.mercadoLivreProcessarAviso=onDocumentCreated({region:'southamerica-east1',document:'ml_notificacoes/{id}'},async()=>{
  try{await sincronizarML();}catch(e){console.error('ML aviso:',e);}
});

// Reserva: se algum aviso se perder, a cada 10 min busca de novo.
exports.mercadoLivreSync=onSchedule({region:'southamerica-east1',schedule:'every 10 minutes',timeZone:'America/Sao_Paulo'},async()=>{
  try{const snap=await refConfig().get();if(!snap.exists||!snap.data().refreshToken)return;await sincronizarML();}
  catch(e){console.error('ML sync:',e);await refConfig().set({ultimoErro:String(e.message||e),ultimoErroEm:new Date().toISOString()},{merge:true});}
});
