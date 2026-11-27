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
    await gravarTokensML({accessToken:dados.access_token,refreshToken:dados.refresh_token,expiraEm:Date.now()+(dados.expires_in||21600)*1000});
    await refConfig().set({userId:dados.user_id,autorizadoEm:new Date().toISOString()},{merge:true});
    res.send('<h2>✅ Mercado Livre autorizado!</h2><p>Pode fechar esta aba e voltar pro chat.</p>');
  }catch(e){console.error(e);res.status(500).send(`<h2>Erro inesperado</h2><pre>${e.message}</pre>`);}
});

/* Tokens do ML (03/11/2026): saíram de leads_config/ml_oauth - o Firestore deixa
   qualquer usuario logado do CRM ler, e com o token da' pra mexer nos anuncios.
   Agora ficam num arquivo do Storage fora de qualquer regra (so' as functions
   leem), igual ao token do Instagram. Na 1a execucao migra do doc e apaga de la'. */
const ARQ_TOKENS_ML='privado/mercadolivre-oauth.json';
async function lerTokensML(){
  try{const [b]=await admin.storage().bucket().file(ARQ_TOKENS_ML).download();return JSON.parse(b.toString());}
  catch(e){if(e.code===404)return null;throw e;}
}
async function gravarTokensML(t){
  await admin.storage().bucket().file(ARQ_TOKENS_ML).save(JSON.stringify(t),{contentType:'application/json',resumable:false});
}
// O refresh_token do ML e' de uso unico - cada renovacao devolve um novo, que
// precisa ser gravado (senao a proxima renovacao falha).
async function obterToken(){
  const ref=refConfig();
  const snap=await ref.get();
  const c=snap.exists?snap.data():{};
  let t=await lerTokensML();
  if(!t&&c.refreshToken){
    t={accessToken:c.accessToken,refreshToken:c.refreshToken,expiraEm:c.expiraEm};
    await gravarTokensML(t);
  }
  if(c.refreshToken||c.accessToken){
    const del=admin.firestore.FieldValue.delete();
    await ref.update({accessToken:del,refreshToken:del,expiraEm:del});
  }
  if(!t||!t.refreshToken)throw new Error('Mercado Livre ainda não foi autorizado');
  if(t.accessToken&&t.expiraEm-Date.now()>5*60*1000)return{...c,...t};
  const resp=await fetch(API+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'refresh_token',client_id:process.env.ML_CLIENT_ID,client_secret:process.env.ML_CLIENT_SECRET,refresh_token:t.refreshToken}).toString()});
  const dados=await resp.json();
  if(!resp.ok||!dados.access_token)throw new Error('Erro ao renovar token ML: '+JSON.stringify(dados));
  const novo={accessToken:dados.access_token,refreshToken:dados.refresh_token||t.refreshToken,expiraEm:Date.now()+(dados.expires_in||21600)*1000};
  await gravarTokensML(novo);
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
async function criarLeadML(r,lead,veiculo,opts={}){
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
  // 25/11/2026 (Aline): com leads_config/ml_oauth.creditoAtivo ligado, so' o lead
  // com CREDITO APROVADO vai direto pro vendedor (rodizio); o resto passa pela
  // Eva (coluna I.A.), como os outros portais. Desligado = regra de 05/10/2026
  // (todo lead do ML direto pro rodizio).
  const paraEva=!!opts.paraEva;
  let novoId='';
  await db.runTransaction(async tx=>{
    const refSeq=db.collection('leads_config').doc('mk');
    const refRodizio=db.collection('leads_config').doc('rodizio');
    const snapSeq=await tx.get(refSeq);const snapRod=paraEva?null:await tx.get(refRodizio);
    const seq=((snapSeq.exists&&snapSeq.data().leadSeq)||0)+1;
    novoId='LEAD-'+pad3(seq);
    let captador='';
    if(!paraEva){
      const dr=snapRod.exists?snapRod.data():{};
      const ativos=RODIZIO.filter(n=>dr.ativos?.[n]!==false);const lista=ativos.length?ativos:RODIZIO;
      const idx=dr.idx||0;captador=lista[idx%lista.length];
      tx.set(refRodizio,{idx:idx+1},{merge:true});
    }
    tx.set(refSeq,{leadSeq:seq},{merge:true});
    tx.set(db.collection('leads').doc(novoId),{
      id:novoId,dt:hojeBR(),dtISO:isoSP(),_criadoEm:new Date().toISOString(),
      st:paraEva?'ia':'atendimento',by:'',captador,uid:'',origem:'Mercado Livre',
      clienteNome:r.name||'',clienteTel:telBR(r.phone),clienteTelNorm:telNorm,clienteEmail:r.email||'',
      veiculo,valor:'',obs,convertido:false,dtVenda:'',motivoPerda:'',
      historico:[{dt:agoraBR(),icone:'blue',acao:'Lead criado',obs:paraEva?`Via API do Mercado Livre (cliente ${tipo}) — sem crédito aprovado, vai pra Eva`:`Via API do Mercado Livre (cliente ${tipo}) — direto pro rodízio — vendedor: ${captador}`,by:'Mercado Livre'}],
      pendente_at:'',pendente_end:'',atendimento_at:paraEva?'':new Date().toISOString(),atendimento_end:'',notificacaoVendedorEm:opts.semAvisoPadrao?new Date().toISOString():'',
      mlLeadId:lead.id,mlItemId:lead.item_id||'',mlCompradorId:String(r.id||''),
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
        const doc={bruto:JSON.stringify({...r,leads:[lead]}).slice(0,8000),recebidoEm:new Date().toISOString(),criadoNoML:lead.created_at||'',tipo:lead.contact_type||lead.channel||'',itemId:lead.item_id||r.item_id||'',veiculo,nome:r.name||'',telefone:r.phone||'',email:r.email||'',compradorId:r.id||'',modoTeste:!criar};
        let paraEva=c.creditoAtivo===true;
        // Lead de simulacao com credito APROVADO nao vai pra Eva (o credito ja' cai no vendedor pelo sincronizarCreditosML)
        if(paraEva&&lead.external_id&&(lead.contact_type||lead.channel)==='credit'){try{const s=await apiML(`/vis/loans/search?seller_id=${c.userId}&item_id=${lead.item_id||r.item_id}&date_from=${dataML(-2)}&date_to=${dataML(0.01)}&status=approved`,token);if((s.results||[]).some(x=>String(x.id)===String(lead.external_id)&&!x.expired))paraEva=false;}catch(e){console.error('ml credito do lead',e.message);}}
        if(criar){try{doc.leadCRM=await criarLeadML(r,lead,veiculo,{paraEva});}catch(e){doc.erro=String(e.message||e);}}
        await ref.set(doc);novos++;res.push(doc.leadCRM||doc.nome);
      }
    }
    offset+=50;
  }while(offset<total&&offset<500);
  await refConfig().set({ultimaSincronizacao:new Date().toISOString(),ultimoResultado:`${novos} novo(s)`},{merge:true});
  return{novos,res};
}

/* CREDITO PRE-APROVADO do Mercado Livre (25/11/2026, pedido da Aline): o
   cliente que simula financiamento no anuncio e tem o credito APROVADO pelo
   banco compra em outra loja em minutos se ninguem ligar. GET /vis/loans/search
   (so' veiculos no Brasil) traz banco, entrada, parcelas e status
   (approved/in_analysis/rejected); /vis/loans/{id} traz nome/telefone.
   Com leads_config/ml_oauth.creditoAtivo=true:
   - APROVADO (e nao expirado): o lead vai pro vendedor (rodizio) - se estava
     com a Eva (I.A.) ou perdido, sai de la' na hora -, ganha creditoML (etiqueta
     grande no card) e o vendedor recebe "LIGUE AGORA" pelo WhatsApp da Eva
     (mensagens_avulsas), com copia pra Aline. A Eva nao fala com o cliente.
   - Em analise/reprovado: so' grava creditoML no lead (etiqueta discreta).
   Desligado: so' registra em ml_creditos (pra conferir antes de ligar). */
const BANCOS_ML={MERCADO_CREDITO:'Mercado Crédito',VOTORANTIM:'Banco BV (Votorantim)',SANTANDER:'Santander',SCOTIA:'Scotiabank'};
const STATUS_CRED={approved:'aprovado',in_analysis:'em análise',rejected:'reprovado'};
const brl=v=>'R$ '+Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:2});
// O ML le date_from/date_to em UTC (25/11/2026: em horario de Brasilia os creditos das ultimas 3h ficavam de fora)
function dataML(offsetDias){return new Date(Date.now()+offsetDias*864e5).toISOString().slice(0,19);}
async function buscarCreditosML(token,userId,diasAtras){
  const res=[];let offset=0,total=0;
  do{
    const j=await apiML(`/vis/loans/search?seller_id=${userId}&date_from=${dataML(-diasAtras)}&date_to=${dataML(0)}&status=all&offset=${offset}&limit=100`,token);
    total=(j.paging&&j.paging.total)||0;res.push(...(j.results||[]));offset+=100;
  }while(offset<total&&offset<1000);
  return res;
}
async function leadDoComprador(buyerId,telNorm){
  if(buyerId){
    const ids=[...new Set([String(buyerId),Number(buyerId)])].filter(x=>x!==''&&!Number.isNaN(x));
    const q=await db.collection('ml_leads_recebidos').where('compradorId','in',ids).get();
    for(const d of q.docs){const id=String(d.data().leadCRM||'').replace(/ \(mesclado\)$/,'');if(id){const l=await db.collection('leads').doc(id).get();if(l.exists)return{_id:id,...l.data()};}}
    const q2=await db.collection('leads').where('mlCompradorId','==',String(buyerId)).get();
    if(!q2.empty)return{_id:q2.docs[0].id,...q2.docs[0].data()};
  }
  if(telNorm){
    const cand=(await db.collection('leads').where('clienteTelNorm','==',telNorm).get()).docs.map(d=>({_id:d.id,...d.data()}));
    return cand.find(l=>!['vendido','perdido'].includes(l.st))||cand.sort((a,b)=>String(b._criadoEm||'').localeCompare(String(a._criadoEm||'')))[0]||null;
  }
  return null;
}
function textoCreditoAprovado(lead,cr){
  return `🚨🚨🚨 CLIENTE COM CRÉDITO APROVADO 🚨🚨🚨\n\n📞 LIGUE AGORA! PARE O QUE ESTÁ FAZENDO E LIGUE!\nEsse cliente acabou de ter o financiamento APROVADO pelo banco no Mercado Livre. Se ninguém ligar em minutos, ele compra em outra loja.\n\n👤 Cliente: ${lead.clienteNome||'-'}\n📱 Telefone: ${lead.clienteTel||'-'}\n🚗 Carro: ${cr.veiculo||lead.veiculo||'-'}\n🏦 Banco: ${cr.banco}\n💰 Entrada: ${brl(cr.entrada)}\n📆 Parcelas: ${cr.parcelas}x de ${brl(cr.valorParcela)}\n\n${lead.id||lead._id} — já está no seu Atendimento no CRM.`;
}
async function sincronizarCreditosML(){
  const c=await obterToken();
  const ativo=c.creditoAtivo===true;
  const lista=await buscarCreditosML(c.accessToken,c.userId,3);
  const feitos=[];
  for(const x of lista){
    const ref=db.collection('ml_creditos').doc(String(x.id));
    const ant=(await ref.get()).data()||{};
    const status=String(x.status||'approved');
    const cr={creditoId:String(x.id),status,statusPt:STATUS_CRED[status]||status,banco:BANCOS_ML[x.financial_entity_id]||x.financial_entity_id||'-',
      entrada:x.down_payment_amount||0,parcelas:x.installments_number||0,valorParcela:x.installments_amount||0,
      itemId:x.item_id||'',compradorId:String(x.buyer_id||''),criadoNoML:x.date_created||'',expirado:!!x.expired,propostaId:x.proposal_id||''};
    if(ant.status===status&&(ant.tratadoEm||!ativo))continue; // nada novo
    cr.veiculo=await tituloItem(cr.itemId,c.accessToken);
    await ref.set({...cr,vistoEm:new Date().toISOString()},{merge:true});
    if(!ativo)continue;
    let det={};
    try{det=await apiML(`/vis/loans/${x.id}?seller_id=${c.userId}`,c.accessToken);}catch(e){console.error('ml credito detalhe',x.id,e.message);}
    const b=det.buyer||{};
    let lead=await leadDoComprador(cr.compradorId,normalizarTel(b.phone));
    const aprovado=status==='approved'&&!cr.expirado;
    if(!lead&&!aprovado){await ref.set({tratadoEm:new Date().toISOString(),resultado:'sem lead (não aprovado)'},{merge:true});continue;}
    if(!lead){
      const id=await criarLeadML({name:b.full_name||'',phone:b.phone||'',email:b.email||'',id:cr.compradorId},{id:'credito-'+cr.creditoId,item_id:cr.itemId,contact_type:'credit'},cr.veiculo,{semAvisoPadrao:true});
      const l=await db.collection('leads').doc(id.replace(/ \(mesclado\)$/,'')).get();lead={_id:l.id,...l.data()};
    }
    const lref=db.collection('leads').doc(lead._id);
    const campos={creditoML:{...cr,atualizadoEm:new Date().toISOString()}};
    const hist=[...(lead.historico||[])];
    if(aprovado){
      // Sai da Eva / do Perdido e vai pro vendedor do rodizio (quem ja' tem vendedor fica com ele)
      if(['ia','perdido','resgate'].includes(lead.st)||!lead.captador){
        let captador=lead.captador||'';
        if(!captador){
          await db.runTransaction(async tx=>{const rr=db.collection('leads_config').doc('rodizio');const s=await tx.get(rr);const dr=s.exists?s.data():{};
            const ativos=RODIZIO.filter(n=>dr.ativos?.[n]!==false);const ls=ativos.length?ativos:RODIZIO;const idx=dr.idx||0;captador=ls[idx%ls.length];tx.set(rr,{idx:idx+1},{merge:true});});
        }
        Object.assign(campos,{st:'atendimento',captador,atendimento_at:new Date().toISOString(),atendimento_end:'',motivoPerda:''});
        lead.captador=captador;
      }
      campos.notificacaoVendedorEm=new Date().toISOString(); // o aviso padrao nao vai: vai o de credito
      hist.push({dt:agoraBR(),icone:'green',acao:'💳 CRÉDITO APROVADO no Mercado Livre',obs:`${cr.banco} — entrada ${brl(cr.entrada)} + ${cr.parcelas}x de ${brl(cr.valorParcela)}${cr.veiculo?' — '+cr.veiculo:''}. Enviado pro vendedor ${lead.captador} com aviso de LIGAR AGORA.`,by:'Mercado Livre'});
      campos.historico=hist;
      await lref.update(campos);
      const texto=textoCreditoAprovado({...lead,id:lead._id},cr);
      await db.collection('mensagens_avulsas').add({destino:lead.captador,texto,enviadaEm:'',criadaEm:new Date().toISOString(),origem:'creditoML',leadId:lead._id});
      await db.collection('mensagens_avulsas').add({destino:'Aline',texto:`(cópia) Enviado pro ${lead.captador}:\n\n`+texto,enviadaEm:'',criadaEm:new Date().toISOString(),origem:'creditoML',leadId:lead._id});
    }else{
      hist.push({dt:agoraBR(),icone:'gold',acao:`💳 Crédito ${cr.statusPt} no Mercado Livre`,obs:`${cr.banco} — entrada ${brl(cr.entrada)} + ${cr.parcelas}x de ${brl(cr.valorParcela)}`,by:'Mercado Livre'});
      campos.historico=hist;
      await lref.update(campos);
    }
    await ref.set({tratadoEm:new Date().toISOString(),leadCRM:lead._id,resultado:aprovado?'aprovado → vendedor '+lead.captador:'etiqueta '+cr.statusPt},{merge:true});
    feitos.push(lead._id+' '+status);
  }
  return{total:lista.length,feitos};
}

// Diagnostico (gestor): mostra os creditos do ML dos ultimos N dias (max 89), sem mexer em nada.
exports.mercadoLivreCreditosVer=onRequest({region:'southamerica-east1',timeoutSeconds:120,cors:true},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const c=await obterToken();
    const dias=Math.min(89,Math.max(1,Number(req.query.dias)||30));
    const lista=await buscarCreditosML(c.accessToken,c.userId,dias);
    res.json({ativo:c.creditoAtivo===true,dias,total:lista.length,creditos:lista.map(x=>({id:x.id,status:x.status||'approved',banco:BANCOS_ML[x.financial_entity_id]||x.financial_entity_id,entrada:x.down_payment_amount,parcelas:x.installments_number,valorParcela:x.installments_amount,itemId:x.item_id,compradorId:x.buyer_id,criadoEm:x.date_created,expirado:x.expired}))});
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});


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
const EMAILS_GESTOR=['contato@rtcar.com.br','marcela@rtcar.com.br','rafael@rtcar.com.br','tiago@rtcar.com.br','milena@rtcar.com.br','rubens@rtcar.com.br','samuelrtcar@gmail.com']; // Samuel (assistente de marketing, 27/11/2026): publica anuncios e mexe no site
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
  try{const snap=await refConfig().get();if(!snap.exists||!(snap.data().autorizadoEm||snap.data().refreshToken))return;
    // credito antes dos leads: o aprovado ja' cai no vendedor antes da Eva pegar
    try{await sincronizarCreditosML();}catch(e){console.error('ML creditos:',e);await refConfig().set({ultimoErroCredito:String(e.message||e),ultimoErroCreditoEm:new Date().toISOString()},{merge:true});}
    await sincronizarML();}
  catch(e){console.error('ML sync:',e);await refConfig().set({ultimoErro:String(e.message||e),ultimoErroEm:new Date().toISOString()},{merge:true});}
});

/* Fase 2 - publicar carros do NOSSO estoque no ML (03/11/2026, pedido da
   Aline). Passo 1: so' LEITURA - descobre o plano de anuncios de veiculos da
   RT Car (pacotes/cota), quais tipos de anuncio o app pode usar e quais
   atributos o ML exige na categoria de carros. Nao cria nem altera anuncio. */
const CATEGORIA_CARROS='MLB1744'; // Carros e Caminhonetes
exports.mercadoLivreDiagnosticoAnuncios=onRequest({region:'southamerica-east1',timeoutSeconds:120,cors:true},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const c=await obterToken();const token=c.accessToken;
    const tenta=async(caminho)=>{try{return await apiML(caminho,token);}catch(e){return{erro:String(e.message).slice(0,400)};}};
    const usuario=await tenta(`/users/${c.userId}`);
    const attrs=await tenta(`/categories/${CATEGORIA_CARROS}/attributes`);
    res.json({
      usuario:usuario.erro?usuario:{id:usuario.id,nickname:usuario.nickname,tipo:usuario.user_type,site:usuario.site_id,tags:usuario.tags,reputacao:usuario.seller_reputation&&usuario.seller_reputation.level_id},
      pacotes:await tenta(`/users/${c.userId}/classifieds_promotion_packs`),
      tiposDisponiveis:await tenta(`/users/${c.userId}/available_listing_types?category_id=${CATEGORIA_CARROS}`),
      categoria:await tenta(`/categories/${CATEGORIA_CARROS}`).then(x=>x.erro?x:{id:x.id,nome:x.name,settings:x.settings&&{listing_allowed:x.settings.listing_allowed,max_pictures:x.settings.max_pictures_per_item,price:x.settings.price,currencies:x.settings.currencies}}),
      atributosObrigatorios:Array.isArray(attrs)?attrs.filter(a=>a.tags&&(a.tags.required||a.tags.catalog_required||a.tags.conditional_required)).map(a=>({id:a.id,nome:a.name,tipo:a.value_type,tags:Object.keys(a.tags).filter(k=>a.tags[k])})):attrs,
      anunciosAtivos:await tenta(`/users/${c.userId}/items/search?status=active&limit=1`).then(x=>x.erro?x:{total:x.paging&&x.paging.total}),
    });
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});

/* Fase 2 (03/11/2026): consulta SO' LEITURA (GET) na API do ML, pra estudar
   como o anuncio de carro e' montado (anuncios atuais do Autoconf, catalogo de
   marca/modelo/versao) antes de publicar pelo nosso integrador. Gestor-only;
   so' caminhos de consulta, nunca devolve token. */
// 25/11/2026: + /vis (so' leitura) pra diagnosticar o credito aprovado dos interessados
const CAMINHOS_CONSULTA=/^\/(items|categories|catalog_domains|sites\/MLB\/(search|domain_discovery)|users\/me$|users\/\d+$|vis\/users\/\d+\/leads\/buyers|vis\/leads\/|vis\/loans)/;
exports.mercadoLivreConsultar=onRequest({region:'southamerica-east1',timeoutSeconds:60,cors:true},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const caminho=String(req.query.caminho||'');
    if(!CAMINHOS_CONSULTA.test(caminho)){res.status(400).json({erro:'Caminho não permitido'});return;}
    const c=await obterToken();
    const r=await fetch(API+caminho,{headers:{Authorization:'Bearer '+c.accessToken}});
    res.status(r.status).json(await r.json().catch(()=>({})));
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});

/* Fase 2 - PREVIA do anuncio (05/11/2026, pedido da Aline). Monta o anuncio
   de carro como o NOSSO integrador mandaria pro ML e pede pro proprio ML
   conferir (POST /items/validate: nao publica, nao gasta cota). Nada e'
   gravado. ?placa=XXX = 1 carro (devolve o anuncio montado); sem placa = todo
   o estoque disponivel/em preparacao (so' o resumo de quem passa/falha).
   Fontes: feed do sistema (marca/modelo/versao/ano/km/cor/preco), site
   (fotos, descricao, preco editado, combustivel/cambio/portas da Avaliacao) e,
   quando o carro ja tem anuncio do Autoconf no ML, os atributos desse anuncio
   (combustivel, portas, opcionais) como reserva. Plano da RT Car: pacote
   "Todo o seu estoque" (PUS30, ilimitado, listing silver). */
// Placa Mercosul x antiga: o sistema guarda "QIP4167" e o Autoconf "QIP4B67"
// (5o caractere: A=0 ... J=9) - mesma placa.
const placaChaveML=p=>{
  const s=String(p||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  return s.length===7&&/[A-J]/.test(s[4])?s.slice(0,4)+(s.charCodeAt(4)-65)+s.slice(5):s;
};
const normML=s=>String(s||'').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^A-Z0-9]/g,'');
// Nomes da lista FUEL_TYPE do ML (1o que existir na lista vence). Flex no ML
// e' "Gasolina e álcool" (igual aos anuncios do Autoconf); hibrido tenta
// manter a palavra "Híbrido" (pedido da Aline) e cai em "Gasolina e elétrico".
const COMB_ML={'Flex':['Gasolina e álcool'],'Gasolina':['Gasolina'],'Diesel':['Diesel'],'Elétrico':['Elétrico'],'Híbrido':['Híbrido/Gasolina','Híbrido','Gasolina e elétrico'],'Gasolina e Elétrico':['Híbrido/Gasolina','Híbrido','Gasolina e elétrico']};
const MOTO_ML=/^(HARLEY|DUCATI|TRIUMPH|KAWASAKI|YAMAHA|KTM|ROYAL ENFIELD)/i;
const MARCA_ALIAS={'MERCEDES':'Mercedes-Benz','MERCEDESBENZ':'Mercedes-Benz','KIAMOTORS':'Kia','HARLEY':'Harley-Davidson','HARLEYDAVIDSON':'Harley-Davidson','CAOACHERYCHERY':'Chery','CAOACHERY':'Chery','GM':'Chevrolet','GMCHEVROLET':'Chevrolet','VWVOLKSWAGEN':'Volkswagen','CAOACHERYCHERY':'Chery','VW':'Volkswagen','LANDROVER':'Land Rover','GAC':'GAC Trumpchi','GACMOTOR':'GAC Trumpchi'};
const titulo60=s=>{s=String(s||'').replace(/\s+/g,' ').trim();if(s.length<=60)return s;const c=s.slice(0,60);const i=c.lastIndexOf(' ');return (i>30?c.slice(0,i):c).trim();};
const capitaliza=s=>String(s||'').toLowerCase().replace(/(^|[\s\-\/(])([a-zà-ú])/g,(m,a,b)=>a+b.toUpperCase());
let _attrsCarros=null;
async function atributosCarros(token){
  if(!_attrsCarros)_attrsCarros=await apiML(`/categories/${CATEGORIA_CARROS}/attributes`,token);
  return _attrsCarros;
}
async function anunciosAutoconfPorPlaca(token){
  const cfg=(await refConfig().get()).data()||{};
  const mapa={};let modelo=null;
  for(const id of cfg.idsAnuncios||[]){
    try{
      const it=await apiML('/items/'+id,token);
      if(!['active','paused'].includes(it.status))continue;
      const pl=(it.attributes||[]).find(a=>a.id==='LICENSE_PLATE');
      if(pl&&pl.value_name)mapa[placaChaveML(pl.value_name)]=it;
      if(!modelo&&it.status==='active'&&it.location&&it.seller_contact)modelo=it;
    }catch(e){}
  }
  return{mapa,modelo};
}
function montarAnuncioML(carro,site,ac,attrsCat,modelo){
  const avisos=[];
  const val=(id,nome)=>{const a=attrsCat.find(x=>x.id===id);const v=a&&(a.values||[]).find(x=>normML(x.name)===normML(nome));return v?{id,value_id:v.id,value_name:v.name}:(nome?{id,value_name:String(nome)}:null);};
  const doAc=id=>{const a=ac&&(ac.attributes||[]).find(x=>x.id===id);return a&&(a.value_id||a.value_name)?{id,value_id:a.value_id||undefined,value_name:a.value_name}:null;};
  const marcaTxt=MARCA_ALIAS[normML(carro.marca)]||carro.marca;
  let brand=val('BRAND',marcaTxt);
  if(!brand||!brand.value_id){const b=doAc('BRAND');if(b)brand=b;else avisos.push(`Marca "${carro.marca}" não existe na lista do ML`);}
  const modeloTxt=String(carro.modelo||'').trim();
  let model=val('MODEL',modeloTxt);
  if(!model||!model.value_id){
    const m=modeloTxt.split(/\s+/)[0];const vm=val('MODEL',m);
    if(vm&&vm.value_id)model=vm;else{const b=doAc('MODEL');if(b)model=b;else{
      // Modelo novo que ainda nao esta' na lista do ML (ex.: GAC Aion V, 11/11/2026):
      // vai como texto ("Aion V") e quem decide e' a validacao do proprio ML.
      const w=modeloTxt.replace(/\(.*?\)/g,' ').trim().split(/\s+/).filter(Boolean);
      const txt=(w[1]&&w[1].length<=2?w.slice(0,2):w.slice(0,1)).join(' ').toLowerCase().replace(/(^|\s)\S/g,c=>c.toUpperCase());
      if(txt){model={id:'MODEL',value_name:txt};avisos.push(`Modelo "${txt}" fora da lista do ML (enviado como texto)`);}
      else avisos.push(`Modelo "${modeloTxt}" não existe na lista do ML`);}}
  }
  const anoMod=Number(carro.anoModelo)||Number(String(site&&site.ano||'').split('/')[1])||'';
  const km=Number(String(carro.km!=null?carro.km:(site&&site.km)||'').replace(/\D/g,''));
  const zeroKm=km===0;
  const cands=COMB_ML[site&&site.combustivel]||[];
  let fuel=null;
  for(const n of cands){const v=val('FUEL_TYPE',n);if(v&&v.value_id){fuel=v;break;}}
  if(!fuel)fuel=doAc('FUEL_TYPE');
  if(!fuel)avisos.push('Sem combustível (nem na Avaliação nem no anúncio do Autoconf)');
  const portas=(site&&site.portas)||(doAc('DOORS')||{}).value_name||'';
  if(!portas)avisos.push('Sem número de portas');
  const camb=site&&site.cambio==='Automático'?'Automática':site&&site.cambio==='Manual'?'Manual':'';
  // Titulo sempre completo (pedido da Aline, 05/11/2026): usa a versao MAIS
  // COMPLETA entre o sistema e o site (ex.: sistema "ENDURANCE", site "1.3
  // FIREFLY FLEX ENDURANCE MANUAL"), sem repetir marca/modelo no comeco nem
  // palavras que ja estao no nome do modelo.
  const palavrasModelo=new Set(modeloTxt.split(/\s+/).map(normML).filter(Boolean));
  const limpaVs=vs=>{let w=String(vs||'').trim().split(/\s+/).filter(Boolean);
    while(w.length&&(normML(w[0])===normML(marcaTxt)||normML(w[0])===normML(carro.marca)||palavrasModelo.has(normML(w[0]))))w=w.slice(1);
    return w.join(' ');};
  const versao=[carro.versao,site&&site.versao].map(limpaVs).filter(Boolean).sort((a,b)=>b.length-a.length)[0]||'';
  const precoSite=Number(site&&site.preco)||0, precoSis=Number(carro.preco)||0;
  const preco=precoSite>1?precoSite:precoSis;
  if(!(preco>=3000))avisos.push('Sem preço (o ML não aceita "Consulte o preço")');
  if(MOTO_ML.test(String(carro.marca||'')))avisos.push('Moto: vai na categoria de motos do ML (ainda não feita)');
  const fotos=((site&&site.fotos)||[]).map(u=>typeof u==='string'?u:u&&u.url).filter(Boolean).slice(0,25);
  if(!fotos.length)avisos.push('Sem fotos no site');
  const cor=(site&&site.cor)||carro.cor||'';
  const attrs=[
    brand,model,
    {id:'VEHICLE_YEAR',value_name:String(anoMod)},
    {id:'TRIM',value_name:versao||modeloTxt},
    {id:'KILOMETERS',value_name:`${km||0} km`},
    zeroKm?null:{id:'LICENSE_PLATE',value_name:String(carro.placa||'').toUpperCase().replace(/[^A-Z0-9]/g,'')},
    val('VEHICLE_TYPE','Carros e caminhonetes'),
    fuel,
    portas?{id:'DOORS',value_name:String(portas)}:null,
    camb?val('TRANSMISSION',camb):doAc('TRANSMISSION'),
    cor?val('COLOR',capitaliza(cor)):doAc('COLOR'),
    val('ITEM_CONDITION',zeroKm?'Novo':'Usado'),
  ].filter(Boolean);
  // Opcionais e medidas que so' o anuncio do Autoconf tem (ar, direcao...):
  // aproveita o que nao montamos acima.
  const ja=new Set(attrs.map(a=>a.id));
  const editavel=new Set(attrsCat.filter(a=>!(a.tags&&(a.tags.read_only||a.tags.fixed||a.tags.inferred))).map(a=>a.id));
  for(const a of (ac&&ac.attributes)||[]){
    if(ja.has(a.id)||!(a.value_id||a.value_name)||!editavel.has(a.id))continue;
    if(/^(IS_OFFERED_BY_BRAND|VERIFIED_VEHICLES|HAS_HISTORIC_INFORMATION|HAS_VEHICLE_INSPECTION|INSURANCE_DEREGISTRATION_NUMBER|MARKET|PREVIOUS_PRICE)$/.test(a.id))continue;
    if(/^(FIPE_|CURRENCY|SELLER_SKU|GTIN|ITEM_CONDITION)/.test(a.id))continue;
    attrs.push({id:a.id,value_id:a.value_id||undefined,value_name:a.value_name});
  }
  const ano=(site&&site.ano)||`${carro.anoFabricacao||''}/${carro.anoModelo||''}`;
  const anuncio={
    title:titulo60(`${capitaliza(marcaTxt)} ${capitaliza(modeloTxt)} ${capitaliza(versao)} ${anoMod||ano}`),
    category_id:CATEGORIA_CARROS,
    price:preco,currency_id:'BRL',available_quantity:1,
    buying_mode:'classified',listing_type_id:'silver',
    condition:zeroKm?'new':'used',
    pictures:fotos.map(source=>({source})),
    attributes:attrs,
    description:{plain_text:String((site&&site.descricao)||`${capitaliza(marcaTxt)} ${capitaliza(modeloTxt)} ${capitaliza(versao)} ${ano}. Venha conhecer na RT Car!`).slice(0,5000)},
  };
  if(modelo){anuncio.location=modelo.location;anuncio.seller_contact=modelo.seller_contact;}
  else avisos.push('Sem anúncio modelo para copiar endereço/contato');
  return{anuncio,avisos};
}
/* 0 km fora do estoque (06/11/2026, pedido da Aline): carro que so' existe no
   site (site_veiculos com zeroKm:true), nunca no estoque do sistema. A tela
   Anuncios usa a chave "ZK<id do site>" no lugar da placa. */
async function zeroKmDoSite(pedida){
  const m=String(pedida||'').match(/^ZK(\d+)$/);if(!m)return null;
  const d=await db.collection('site_veiculos').doc(m[1]).get();
  if(!d.exists||!d.data().zeroKm)return null;
  const s=d.data();const anos=String(s.ano||'').split('/');
  return{carro:{_id:pedida,placa:'',marca:s.marca,modelo:s.modelo,versao:'',anoFabricacao:anos[0]||'',anoModelo:anos[1]||anos[0]||'',km:0,preco:s.preco,cor:s.cor},site:{...s}};
}
// Anuncio de 0 km ja' existente (nao tem placa): mesma marca, mesmo modelo e mesmo ano no titulo
function mesmoZeroKm(a,site){
  const n=x=>String(x||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z0-9]/g,'');
  const t=n(a.titulo),marca=n(MARCA_ALIAS[normML(site.marca)]||site.marca),mod=n(String(site.modelo||'').split(/\s+/)[0]);
  const ano=String(site.ano||'').split('/').pop();
  return !!marca&&!!mod&&(n(a.marca)===marca||t.startsWith(marca))&&(n(a.modelo).startsWith(mod)||t.includes(mod))&&(!ano||t.includes(ano)||/\.\.\.$/.test(String(a.titulo||'')));
}
async function validarML(anuncio,token){
  const {description,...corpo}=anuncio; // descricao vai em chamada separada ao publicar
  const r=await fetch(API+'/items/validate',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(corpo)});
  if(r.status===204)return{ok:true,erros:[]};
  const j=await r.json().catch(()=>({}));
  const causas=(j.cause||[]).filter(c=>c.type!=='warning').map(c=>c.message||c.code);
  const alertas=(j.cause||[]).filter(c=>c.type==='warning').map(c=>c.message||c.code);
  return{ok:false,status:r.status,erros:causas.length?causas:[j.message||JSON.stringify(j).slice(0,300)],alertas,bruto:JSON.stringify(j).slice(0,1500)};
}
exports.mercadoLivrePrevia=onRequest({region:'southamerica-east1',timeoutSeconds:300,memory:'512MiB',cors:true},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const c=await obterToken();const token=c.accessToken;
    const attrsCat=await atributosCarros(token);
    const {mapa:acPorPlaca,modelo}=await anunciosAutoconfPorPlaca(token);
    const feed=(await db.collection('rtcar_estoque_publico').get()).docs.map(d=>({_id:d.id,...d.data()}))
      .filter(f=>['disponivel','em_preparacao'].includes(f.status));
    const pedida=req.query.placa?placaChaveML(req.query.placa):'';
    const zk=await zeroKmDoSite(pedida);
    const alvo=zk?[{...zk.carro,_zkSite:zk.site}]:pedida?feed.filter(f=>placaChaveML(f.placa)===pedida||placaChaveML(f._id)===pedida):feed;
    if(!alvo.length){res.status(404).json({erro:'Placa não encontrada no estoque disponível'});return;}
    const saida=[];
    for(const carro of alvo){
      if(carro._zkSite){const {anuncio,avisos}=montarAnuncioML(carro,carro._zkSite,null,attrsCat,modelo);const v=await validarML(anuncio,token);
        saida.push({placa:pedida,carro:anuncio.title,preco:anuncio.price,fotos:anuncio.pictures.length,jaNoMLpeloAutoconf:null,avisos,validacaoML:v,anuncio});continue;}
      const docs=[];
      const s0=await db.collection('site_veiculos').doc(carro._id).get();
      if(s0.exists)docs.push(s0.data());
      (await db.collection('site_veiculos').where('placaSistema','==',carro._id).get()).docs.forEach(d=>docs.push(d.data()));
      // Site: o visivel com mais fotos manda; combustivel/portas/cambio de qualquer um
      docs.sort((a,b)=>((a.oculto?1:0)-(b.oculto?1:0))||(((b.fotos||[]).length)-((a.fotos||[]).length)));
      const site=docs[0]?{...docs[0]}:null;
      if(site)for(const k of ['combustivel','portas','cambio','descricao','cor'])if(!site[k])site[k]=(docs.find(d=>d[k])||{})[k];
      const ac=acPorPlaca[placaChaveML(carro.placa)]||acPorPlaca[placaChaveML(carro._id)]||null;
      const {anuncio,avisos}=montarAnuncioML(carro,site,ac,attrsCat,modelo);
      const v=await validarML(anuncio,token);
      saida.push({placa:carro.placa,carro:anuncio.title,preco:anuncio.price,fotos:anuncio.pictures.length,
        jaNoMLpeloAutoconf:ac?ac.id:null,avisos,validacaoML:v,
        ...(pedida?{anuncio}:{})});
    }
    res.json({total:saida.length,passam:saida.filter(s=>s.validacaoML.ok).length,carros:saida});
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});

/* Tela "Anuncios" do CRM (05/11/2026, pedido da Aline): quais carros ja' estao
   no ML (anuncios ativos/pausados da conta, hoje feitos pelo Autoconf) e a
   versao (TRIM) usada la' - serve de sugestao de versao na LitoralCar, ja' que
   o sistema muitas vezes nao tem a versao cadastrada. So' leitura. */
// Todos os anuncios ativos/pausados da conta (Autoconf + nossos), com a placa.
async function listarAnunciosML(token,userId){
  const ids=[];
  for(const st of ['active','paused']){
    for(let off=0;off<1000;off+=50){
      const r=await apiML(`/users/${userId}/items/search?status=${st}&limit=50&offset=${off}`,token);
      ids.push(...(r.results||[]));
      if(!r.results||r.results.length<50)break;
    }
  }
  const anuncios=[];
  for(let i=0;i<ids.length;i+=20){
    const lote=await apiML(`/items?ids=${ids.slice(i,i+20).join(',')}&attributes=id,status,title,price,permalink,category_id,attributes,listing_type_id`,token);
    for(const x of lote||[]){
      const b=x&&x.body;if(!b||!b.id)continue;
      const at=id=>((b.attributes||[]).find(a=>a.id===id)||{}).value_name||'';
      const placa=at('LICENSE_PLATE');
      anuncios.push({id:b.id,status:b.status,titulo:b.title,preco:b.price,link:b.permalink,categoria:b.category_id,
        placa,chave:placa?placaChaveML(placa):'',versao:at('TRIM'),marca:at('BRAND'),modelo:at('MODEL'),tipo:b.listing_type_id||''});
    }
  }
  return anuncios;
}
exports.mercadoLivreAnunciosStatus=onRequest({region:'southamerica-east1',timeoutSeconds:120,cors:true},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const c=await obterToken();
    const anuncios=await listarAnunciosML(c.accessToken,c.userId);
    res.json({total:anuncios.length,anuncios});
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});

/* Escolha de marca/modelo/versao/titulo feita na tela (18/11/2026, pedido da
   Aline: "a LitoralCar deixa trocar, o ML nao"). Vem no corpo do POST como
   {escolha:{marca:{id,name},modelo:{id,name},versao,titulo}} e substitui o
   que o montarAnuncioML adivinhou. */
function aplicarEscolhaML(anuncio,esc){
  if(!anuncio||!esc)return;
  const set=(id,v)=>{if(!v||!(v.id||v.name))return;const o={id,value_id:v.id||undefined,value_name:v.name||undefined};const i=anuncio.attributes.findIndex(a=>a.id===id);if(i>=0)anuncio.attributes[i]=o;else anuncio.attributes.push(o);};
  set('BRAND',esc.marca);set('MODEL',esc.modelo);
  if(esc.versao)set('TRIM',{name:String(esc.versao).slice(0,120)});
  if(esc.titulo)anuncio.title=titulo60(String(esc.titulo));
  if(['silver','gold_premium','gold','gold_special'].includes(esc.tipo))anuncio.listing_type_id=esc.tipo;
}
// Marcas da categoria e modelos de uma marca (lista oficial do ML) para a tela de escolha.
exports.mercadoLivreModelos=onRequest({region:'southamerica-east1',timeoutSeconds:60,cors:true},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const c=await obterToken();const token=c.accessToken;
    const attrs=await atributosCarros(token);
    const marcas=((attrs.find(a=>a.id==='BRAND')||{}).values||[]).map(v=>({id:v.id,name:v.name}));
    let modelos=[];
    const marcaId=String(req.query.marcaId||'');
    if(marcaId){
      try{
        const r=await fetch(API+'/catalog_domains/MLB-CARS_AND_VANS/attributes/MODEL/top_values',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({known_attributes:[{id:'BRAND',value_id:marcaId}]})});
        const j=await r.json().catch(()=>[]);
        if(Array.isArray(j))modelos=j.map(v=>({id:v.id,name:v.name})).filter(v=>v.id&&v.name);
        else console.error('ml top_values',r.status,JSON.stringify(j).slice(0,300));
      }catch(e){console.error('ml top_values',e);}
    }
    // Tipos de anuncio com saldo (18/11/2026): o Autoconf chama gold_premium de "Diamante".
    const tipos=[];
    try{const t=await apiML('/users/'+c.userId+'/available_listing_types?category_id='+CATEGORIA_CARROS,token);(t.available||[]).forEach(x=>tipos.push({id:x.id,name:x.name,restantes:x.remaining_listings}));}catch(e){}
    if(!tipos.some(x=>x.id==='gold_premium')){
      try{const g=await apiML('/users/'+c.userId+'/available_listing_type/gold_premium?category_id='+CATEGORIA_CARROS,token);if(g&&(g.available||g.remaining_listings))tipos.push({id:'gold_premium',name:'Diamante',restantes:g.remaining_listings});}catch(e){}
    }
    if(!tipos.some(x=>x.id==='silver'))tipos.unshift({id:'silver',name:'Prata'});
    res.json({marcas,modelos,tipos});
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});

/* Destacar (trocar o tipo) de um anuncio JA publicado - 18/11/2026, pedido da
   Aline: usar o Diamante (gold_premium) do pacote no carro que ela escolher.
   POST {itemId, tipo:'gold_premium'|'silver'}. So' anuncio da conta RT Car. */
exports.mercadoLivreDestacar=onRequest({region:'southamerica-east1',timeoutSeconds:60,cors:true},async(req,res)=>{
  try{
    if(req.method!=='POST'){res.status(405).json({erro:'Use POST'});return;}
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const itemId=String((req.body&&req.body.itemId)||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const tipo=String((req.body&&req.body.tipo)||'gold_premium');
    if(!/^MLB\d+$/.test(itemId)||!['silver','gold_premium','gold','gold_special'].includes(tipo)){res.status(400).json({erro:'Dados inválidos'});return;}
    const c=await obterToken();
    const it=await apiML('/items/'+itemId+'?attributes=id,seller_id,listing_type_id,title',c.accessToken);
    if(String(it.seller_id)!==String(c.userId)){res.status(403).json({erro:'Anúncio não é da conta RT Car'});return;}
    const r=await fetch(API+'/items/'+itemId+'/listing_type',{method:'POST',headers:{Authorization:'Bearer '+c.accessToken,'Content-Type':'application/json'},body:JSON.stringify({id:tipo})});
    const j=await r.json().catch(()=>({}));
    console.log('ml destacar',itemId,tipo,r.status,JSON.stringify(j).slice(0,300));
    if(!r.ok){res.status(502).json({erro:'O Mercado Livre recusou: '+(j.message||j.error||r.status),ml:j});return;}
    await db.collection('ml_destaques').add({itemId,de:it.listing_type_id||'',para:tipo,titulo:it.title||'',por:dec.email||'',em:new Date().toISOString()});
    res.json({ok:true,itemId,tipo});
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});

/* PUBLICAR 1 carro no ML pelo nosso integrador (fase 2 - teste, 05/11/2026).
   POST ?placa=XXX (gestor). Trava: nao publica se a placa ja tem anuncio
   ativo/pausado na conta (evita duplicar com o Autoconf), se faltar preco/
   fotos/marca/modelo, ou se o proprio ML recusar na validacao. Grava o
   resultado em ml_anuncios/{placa} (origem rtcar). Descricao vai depois, em
   chamada separada (regra do ML). */
exports.mercadoLivrePublicar=onRequest({region:'southamerica-east1',timeoutSeconds:300,memory:'512MiB',cors:true},async(req,res)=>{
  try{
    if(req.method!=='POST'){res.status(405).json({erro:'Use POST'});return;}
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const pedida=placaChaveML(req.query.placa||(req.body&&req.body.placa));
    if(!pedida){res.status(400).json({erro:'Informe a placa'});return;}
    const c=await obterToken();const token=c.accessToken;
    const zk=await zeroKmDoSite(pedida);
    // 18/11/2026: anuncio recem-publicado fica "not_yet_active"/"under_review" e nao
    // aparece na lista active/paused - sem esta trava dava pra publicar 2 vezes.
    const jaNosso=await db.collection('ml_anuncios').doc(pedida).get();
    if(jaNosso.exists&&jaNosso.data().itemId){
      try{const it=await apiML('/items/'+jaNosso.data().itemId+'?attributes=id,status,permalink',token);
        if(it&&it.status&&!['closed','inactive'].includes(it.status)){res.status(409).json({erro:'Esse carro já tem anúncio no Mercado Livre',anuncios:[{id:it.id,status:it.status,link:it.permalink||jaNosso.data().link||''}]});return;}
      }catch(e){console.error('ml checar anuncio nosso',e.message);}
    }
    const existentes=(await listarAnunciosML(token,c.userId)).filter(a=>zk?mesmoZeroKm(a,zk.site):a.chave===pedida);
    if(existentes.length){res.status(409).json({erro:'Esse carro já tem anúncio no Mercado Livre',anuncios:existentes.map(a=>({id:a.id,status:a.status,link:a.link}))});return;}
    if(zk){
      const attrsZ=await atributosCarros(token);const {modelo:modZ}=await anunciosAutoconfPorPlaca(token);
      const {anuncio,avisos}=montarAnuncioML(zk.carro,zk.site,null,attrsZ,modZ);
      aplicarEscolhaML(anuncio,req.body&&req.body.escolha);
      const bq=avisos.filter(a=>/Sem preço|Sem fotos|não existe na lista|Sem combustível|Sem número de portas|moto/i.test(a));
      if(bq.length){res.status(422).json({erro:'Faltam dados',avisos:bq});return;}
      const vz=await validarML(anuncio,token);if(!vz.ok){res.status(422).json({erro:'O Mercado Livre recusou na validação',validacaoML:vz});return;}
      const {description,...corpo}=anuncio;
      const r=await fetch(API+'/items',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(corpo)});
      const item=await r.json().catch(()=>({}));
      if(!r.ok||!item.id){res.status(502).json({erro:'Falha ao publicar',status:r.status,ml:item});return;}
      let descricaoOk=false;try{const d=await fetch(API+'/items/'+item.id+'/description',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(description)});descricaoOk=d.ok;}catch(e){console.error(e);}
      await db.collection('ml_anuncios').doc(pedida).set({itemId:item.id,link:item.permalink||'',status:item.status||'',origem:'rtcar',zeroKm:true,siteId:pedida.slice(2),titulo:anuncio.title,preco:anuncio.price,publicadoEm:new Date().toISOString(),publicadoPor:dec.email||''},{merge:true});
      res.json({ok:true,itemId:item.id,link:item.permalink,status:item.status,descricaoOk,titulo:anuncio.title,preco:anuncio.price,avisos});return;
    }
    const feed=(await db.collection('rtcar_estoque_publico').get()).docs.map(d=>({_id:d.id,...d.data()}))
      .filter(f=>['disponivel','em_preparacao'].includes(f.status));
    const carro=feed.find(f=>placaChaveML(f.placa)===pedida||placaChaveML(f._id)===pedida);
    if(!carro){res.status(404).json({erro:'Placa não encontrada no estoque disponível'});return;}
    const docs=[];
    const s0=await db.collection('site_veiculos').doc(carro._id).get();
    if(s0.exists)docs.push(s0.data());
    (await db.collection('site_veiculos').where('placaSistema','==',carro._id).get()).docs.forEach(d=>docs.push(d.data()));
    docs.sort((a,b)=>((a.oculto?1:0)-(b.oculto?1:0))||(((b.fotos||[]).length)-((a.fotos||[]).length)));
    const site=docs[0]?{...docs[0]}:null;
    if(site)for(const k of ['combustivel','portas','cambio','descricao','cor'])if(!site[k])site[k]=(docs.find(d=>d[k])||{})[k];
    const attrsCat=await atributosCarros(token);
    const {modelo}=await anunciosAutoconfPorPlaca(token);
    const {anuncio,avisos}=montarAnuncioML(carro,site,null,attrsCat,modelo);
    aplicarEscolhaML(anuncio,req.body&&req.body.escolha);
    const bloqueio=avisos.filter(a=>/Sem preço|Sem fotos|não existe na lista|Sem combustível|Sem número de portas|moto/i.test(a));
    if(bloqueio.length){res.status(422).json({erro:'Faltam dados',avisos:bloqueio});return;}
    const v=await validarML(anuncio,token);
    if(!v.ok){res.status(422).json({erro:'O Mercado Livre recusou na validação',validacaoML:v});return;}
    const {description,...corpo}=anuncio;
    const r=await fetch(API+'/items',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(corpo)});
    const item=await r.json().catch(()=>({}));
    if(!r.ok||!item.id){res.status(502).json({erro:'Falha ao publicar',status:r.status,ml:item});return;}
    let descricaoOk=false;
    try{const d=await fetch(API+`/items/${item.id}/description`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(description)});descricaoOk=d.ok;}catch(e){console.error(e);}
    await db.collection('ml_anuncios').doc(pedida).set({itemId:item.id,link:item.permalink||'',status:item.status||'',origem:'rtcar',
      placa:carro.placa,titulo:anuncio.title,preco:anuncio.price,publicadoEm:new Date().toISOString(),publicadoPor:dec.email||''},{merge:true});
    res.json({ok:true,itemId:item.id,link:item.permalink,status:item.status,descricaoOk,titulo:anuncio.title,preco:anuncio.price,avisos});
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});

/* Encerrar (ou pausar) um anuncio do ML da conta - inclusive os feitos pelo
   Autoconf (mesma conta). 05/11/2026, limpeza pedida pela Aline: "deixa apenas
   os anuncios ativos no nosso site". POST {itemId, acao:'closed'|'paused'}.
   Encerrado nao volta (o ML nao reativa) - o CRM so' chama apos confirmacao. */
exports.mercadoLivreEncerrar=onRequest({region:'southamerica-east1',timeoutSeconds:120,cors:true},async(req,res)=>{
  try{
    if(req.method!=='POST'){res.status(405).json({erro:'Use POST'});return;}
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const itemId=String((req.body&&req.body.itemId)||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const acao=(req.body&&req.body.acao)==='paused'?'paused':'closed';
    if(!/^MLB\d+$/.test(itemId)){res.status(400).json({erro:'itemId inválido'});return;}
    const c=await obterToken();
    const it=await apiML('/items/'+itemId,c.accessToken);
    if(String(it.seller_id)!==String(c.userId)){res.status(403).json({erro:'Anúncio não é da conta RT Car'});return;}
    const r=await fetch(API+'/items/'+itemId,{method:'PUT',headers:{Authorization:'Bearer '+c.accessToken,'Content-Type':'application/json'},body:JSON.stringify({status:acao})});
    const j=await r.json().catch(()=>({}));
    console.log('ml encerrar',itemId,acao,r.status,JSON.stringify(j).slice(0,300));
    if(!r.ok){res.status(502).json({erro:'O ML recusou',status:r.status,ml:j});return;}
    await db.collection('ml_encerrados').add({itemId,acao,titulo:it.title||'',placa:((it.attributes||[]).find(a=>a.id==='LICENSE_PLATE')||{}).value_name||'',por:dec.email||'',em:new Date().toISOString()});
    res.json({ok:true,itemId,status:j.status,titulo:it.title});
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});

/* Alerta de carro SEM ANUNCIO (05/11/2026, pedido da Aline): todo dia as 9h
   confere os carros disponiveis (ou em preparacao ja com foto), com preco e visiveis no site, e
   manda pra Aline pelo WhatsApp da Eva (mensagens_avulsas, destino "Aline")
   a lista dos que nao estao na LitoralCar e/ou no Mercado Livre - ela
   publica manual pela tela Anuncios. Sem pendencia, nao manda nada.
   alertaSemAnuncioVer (gestor) mostra a mesma lista sem mandar WhatsApp. */
async function carrosSemAnuncio(){
  const feed=(await db.collection('rtcar_estoque_publico').get()).docs.map(d=>({_id:d.id,...d.data()}))
    .filter(f=>['disponivel','em_preparacao'].includes(f.status));
  const site={};
  (await db.collection('site_veiculos').get()).docs.forEach(d=>{const s=d.data();
    for(const k of [d.id,s.placaSistema].filter(Boolean)){const c=placaChaveML(k);if(!site[c]||(site[c].oculto&&!s.oculto))site[c]=s;}});
  const c=await obterToken();
  const ml=new Set((await listarAnunciosML(c.accessToken,c.userId)).filter(a=>a.status==='active').map(a=>a.chave));
  const {litoralFetch}=require('./litoralcar')._interno;
  const r=await litoralFetch('buscar','estoque');
  let vs=(r.body&&r.body.veiculos)||[];if(!Array.isArray(vs))vs=Object.values(vs||{});
  if(!vs.length)throw new Error('LitoralCar nao respondeu a lista de anuncios');
  const lc=new Set(vs.map(x=>placaChaveML(x&&x.placa)).filter(Boolean));
  const faltando=[];
  for(const f of feed){
    const k=placaChaveML(f.placa||f._id);const s=site[k]||site[placaChaveML(f._id)];
    if(!s||s.oculto)continue;
    const preco=Number(s.preco)>1?Number(s.preco):Number(f.preco)||0;
    if(!(preco>1))continue;
    // Em preparacao: so' entra se ja' tem foto no site (Aline publica igual, 05/11)
    if(f.status!=='disponivel'&&!((s.fotos||[]).length))continue;
    const falta=[];if(!lc.has(k))falta.push('LitoralCar');if(!ml.has(k))falta.push('Mercado Livre');
    if(falta.length)faltando.push({placa:String(f.placa||f._id).toUpperCase(),carro:[f.marca,f.modelo].filter(Boolean).join(' '),falta});
  }
  return faltando;
}
function textoSemAnuncio(l){
  return `📢 Carros SEM ANÚNCIO (${l.length}) - publicar na tela Anúncios:\n`+
    l.map(x=>`• ${x.carro} ${x.placa} - falta ${x.falta.join(' e ')}`).join('\n');
}
exports.alertaSemAnuncio=onSchedule({region:'southamerica-east1',schedule:'0 9 * * *',timeZone:'America/Sao_Paulo',timeoutSeconds:300},async()=>{
  const l=await carrosSemAnuncio();
  if(!l.length)return;
  await db.collection('mensagens_avulsas').add({destino:'Aline',texto:textoSemAnuncio(l),enviadaEm:'',criadaEm:new Date().toISOString(),origem:'alertaSemAnuncio'});
});
exports.alertaSemAnuncioVer=onRequest({region:'southamerica-east1',cors:true,timeoutSeconds:300},async(req,res)=>{
  try{
    const dec=await admin.auth().verifyIdToken(String(req.headers.authorization||'').replace(/^Bearer /,''));
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const l=await carrosSemAnuncio();
    res.json({total:l.length,carros:l,texto:textoSemAnuncio(l)});
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});

/* Atualiza as FOTOS dos anuncios que o NOSSO sistema publicou no ML
   (ml_anuncios origem rtcar) com as fotos atuais do site (16/11/2026, pedido
   da Aline: a Mercedes GLC UMJ-8G44 foi com 1 foto - era o dia em que a
   rotina de fotos do site tinha caido pra 1 foto por carro). Os anuncios do
   Autoconf nao sao mexidos (o Autoconf manda as fotos dele). Roda sozinho a
   cada 2 horas e tambem por POST (gestor), opcional {placa}. So' troca quando
   a lista de fotos do site mudou desde o ultimo envio (fotosEnviadas). */
async function mlAtualizarFotosNossos(soPlaca){
  const c=await obterToken();
  const snap=await db.collection('ml_anuncios').get();
  const out=[];
  for(const d of snap.docs){
    const m=d.data();
    if(m.origem!=='rtcar'||!m.itemId)continue;
    if(soPlaca&&d.id!==placaChaveML(soPlaca))continue;
    const docs=[];
    const sid=m.siteId||d.id;
    const s0=await db.collection('site_veiculos').doc(sid).get();if(s0.exists)docs.push(s0.data());
    (await db.collection('site_veiculos').where('placaSistema','==',d.id).get()).docs.forEach(x=>docs.push(x.data()));
    docs.sort((a,b)=>((a.oculto?1:0)-(b.oculto?1:0))||(((b.fotos||[]).length)-((a.fotos||[]).length)));
    const fotos=((docs[0]&&docs[0].fotos)||[]).map(u=>typeof u==='string'?u:u&&u.url).filter(Boolean).slice(0,25);
    if(!fotos.length){out.push({placa:d.id,itemId:m.itemId,ok:false,erro:'site sem fotos'});continue;}
    if(JSON.stringify(fotos)===JSON.stringify(m.fotosEnviadas||[])){out.push({placa:d.id,itemId:m.itemId,ok:true,igual:true,fotos:fotos.length});continue;}
    let it;try{it=await apiML('/items/'+m.itemId+'?attributes=id,status,seller_id',c.accessToken);}catch(e){out.push({placa:d.id,itemId:m.itemId,ok:false,erro:'item: '+e.message});continue;}
    if(String(it.seller_id)!==String(c.userId)||!['active','paused'].includes(it.status)){out.push({placa:d.id,itemId:m.itemId,ok:false,erro:'anúncio '+(it.status||'?')});continue;}
    const r=await fetch(API+'/items/'+m.itemId,{method:'PUT',headers:{Authorization:'Bearer '+c.accessToken,'Content-Type':'application/json'},body:JSON.stringify({pictures:fotos.map(source=>({source}))})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){console.error('ml fotos',m.itemId,r.status,JSON.stringify(j).slice(0,300));out.push({placa:d.id,itemId:m.itemId,ok:false,erro:'ML recusou ('+r.status+'): '+(j.message||'')});continue;}
    await d.ref.set({fotosEnviadas:fotos,fotosAtualizadasEm:new Date().toISOString()},{merge:true});
    out.push({placa:d.id,itemId:m.itemId,ok:true,fotos:fotos.length});
  }
  return out;
}
exports.mercadoLivreAtualizarFotos=onRequest({region:'southamerica-east1',timeoutSeconds:300,cors:true},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    res.json({resultados:await mlAtualizarFotosNossos((req.body&&req.body.placa)||req.query.placa||'')});
  }catch(e){console.error(e);res.status(500).json({erro:String(e.message||e)});}
});
exports.mercadoLivreAtualizarFotosAuto=onSchedule({region:'southamerica-east1',schedule:'every 2 hours',timeZone:'America/Sao_Paulo',timeoutSeconds:300},async()=>{
  const r=await mlAtualizarFotosNossos('');
  console.log('mercadoLivreAtualizarFotosAuto',JSON.stringify(r.filter(x=>!x.igual)));
});

// Uso interno (despublicar-vendidos.js, 25/11/2026) - nao e' function exportada
Object.defineProperty(exports,'_interno',{enumerable:false,value:{obterToken,API}});
