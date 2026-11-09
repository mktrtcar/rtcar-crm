const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Captura de leads da LitoralCar por e-mail (20/09/2026, pedido da Aline -
   ficou urgente depois dos anuncios entrarem no ar). A LitoralCar nao tem
   API/webhook de leads (ja confirmado antes) - o contato do cliente cai
   como e-mail normal em contato@rtcar.com.br. Plano: encaminhar esses
   e-mails tambem pra uma caixa Gmail dedicada (leads.rtcar@gmail.com,
   criada so pra isso) e ler essa caixa via Gmail API, sem senha nenhuma -
   autorizacao OAuth feita 1x pela Aline no navegador dela.
   Este arquivo cuida so da autorizacao (pegar e guardar o refresh_token).
   A leitura/parse dos e-mails de verdade fica pra depois, quando tivermos
   um e-mail real de exemplo da LitoralCar pra saber o formato certo. */
const REDIRECT_URI='https://southamerica-east1-rtcarprograma.cloudfunctions.net/litoralcarEmailOAuthCallback';

exports.litoralcarEmailOAuthCallback=onRequest({region:'southamerica-east1'},async(req,res)=>{
  try{
    const code=req.query.code;
    const erro=req.query.error;
    if(erro){res.status(400).send(`<h2>Autorização recusada</h2><p>${erro}</p>`);return;}
    if(!code){res.status(400).send('<h2>Código não recebido</h2>');return;}

    const params=new URLSearchParams({
      code,
      client_id:process.env.GMAIL_LEADS_CLIENT_ID,
      client_secret:process.env.GMAIL_LEADS_CLIENT_SECRET,
      redirect_uri:REDIRECT_URI,
      grant_type:'authorization_code',
    });
    const resp=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params.toString()});
    const dados=await resp.json();
    if(!resp.ok||!dados.refresh_token){
      console.error('Erro na troca do code por token:',dados);
      res.status(500).send(`<h2>Erro ao autorizar</h2><pre>${JSON.stringify(dados,null,2)}</pre><p>Se o erro for sobre "refresh_token" ausente, provavelmente essa conta já autorizou antes - peça pro Claude revogar o acesso anterior em myaccount.google.com/permissions e tente de novo.</p>`);
      return;
    }
    await gravarTokenGmail(dados.refresh_token);
    await db.collection('leads_config').doc('gmail_oauth').set({
      autorizadoEm:new Date().toISOString(),
      email:process.env.GMAIL_LEADS_EMAIL||'',
    },{merge:true});
    res.send('<h2>✅ Autorizado com sucesso!</h2><p>Pode fechar esta aba e voltar pro chat.</p>');
  }catch(e){
    console.error(e);
    res.status(500).send(`<h2>Erro inesperado</h2><pre>${e.message}</pre>`);
  }
});

/* 03/11/2026: o refreshToken saiu de leads_config/gmail_oauth (qualquer usuario
   logado do CRM le o Firestore) pra um arquivo privado do Storage, so' das
   functions. Na 1a execucao migra do doc e apaga de la'. */
const ARQ_TOKEN_GMAIL='privado/gmail-leads-token.txt';
async function gravarTokenGmail(t){
  await admin.storage().bucket().file(ARQ_TOKEN_GMAIL).save(t,{contentType:'text/plain',resumable:false});
}
async function lerTokenGmail(){
  try{const [b]=await admin.storage().bucket().file(ARQ_TOKEN_GMAIL).download();return b.toString().trim();}
  catch(e){if(e.code!==404)throw e;}
  const ref=db.collection('leads_config').doc('gmail_oauth');
  const doc=await ref.get();
  const t=doc.exists&&doc.data().refreshToken;
  if(!t)return '';
  await gravarTokenGmail(t);
  await ref.update({refreshToken:admin.firestore.FieldValue.delete()});
  return t;
}
async function obterAccessToken(){
  const refreshToken=await lerTokenGmail();
  if(!refreshToken)throw new Error('Gmail ainda não foi autorizado (sem refreshToken salvo)');
  const params=new URLSearchParams({
    client_id:process.env.GMAIL_LEADS_CLIENT_ID,
    client_secret:process.env.GMAIL_LEADS_CLIENT_SECRET,
    refresh_token:refreshToken,
    grant_type:'refresh_token',
  });
  const resp=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params.toString()});
  const dados=await resp.json();
  if(!resp.ok||!dados.access_token)throw new Error('Erro ao renovar access token: '+JSON.stringify(dados));
  return dados.access_token;
}
function decodificarBase64Url(s){
  return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
}
/* Parser do e-mail "Proposta de Negocio - LitoralCar" (19/10/2026, formato
   real visto no e-mail da Grazieli dos Santos de 10/10, remetente
   notificacao@sigveiculos.com.br). O corpo traz so' "Nome:", "Email:",
   "Telefone:" e "Cidade/UF:" - o veiculo NAO vem no e-mail (so' no link
   "Clique aqui para visualizar", que abre a proposta no portal). */
function textoPlano(t){
  return String(t||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|tr|li|h\d)>/gi,'\n').replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#64;/g,'@').replace(/[ \t]+/g,' ');
}
function parsePropostaLitoral(corpoBruto){
  const t=textoPlano(corpoBruto);
  const campo=(rot)=>{const m=t.match(new RegExp(rot+'\\s*:\\s*([^\\n]*)','i'));return m?m[1].trim():'';};
  const nome=campo('Nome');
  const email=(campo('E-?mail').match(/[^\s<>]+@[^\s<>]+/)||[''])[0];
  const telefone=campo('Telefone').replace(/[^\d()\s+-]/g,'').trim();
  const cidade=campo('Cidade\\/UF').replace(/^\s*\/\s*$/,'').trim();
  const link=(String(corpoBruto||'').match(/href=["']([^"']+)["'][^>]*>\s*Clique aqui para visualizar/i)||[])[1]||'';
  return{nome,email,telefone,cidade,link};
}
/* Parser do e-mail "Novo contato interessado em um anúncio" (09/11/2026,
   formato real visto nos e-mails do João Victor de 08/11 e da Grazieli de
   10/10). Chega sempre junto com a "Proposta de Negocio" da mesma pessoa,
   mas traz o VEICULO e o valor (a proposta nao traz). Dois jeitos:
   - botao WhatsApp: "Nome:", "Telefone:"
   - botao Financiar: "Nome:", "E-mail:", "Celular:", "Valor entrada:",
     "Número de parcelas:" (tambem vem CPF/nascimento - NAO guardamos). */
function parseNovoContatoLitoral(corpoBruto){
  const t=textoPlano(corpoBruto);
  const campo=(rot)=>{const m=t.match(new RegExp('(?:^|[\\n\\s>])'+rot+'\\s*:\\s*([^\\n]*)','i'));
    // se o HTML juntar dois campos na mesma linha, corta no proximo rotulo
    return m?m[1].split(/\s(?=(?:Nome|E-?mail|Telefone|Celular|CPF|Data de nascimento|Valor|N[úu]mero de parcelas|Mensagem|Whatsapp|Informa[çc][õo]es|Categoria|Marca|Modelo|Vers[ãa]o FIPE|Ano|Cor|km)\b)/i)[0].trim():'';};
  const nome=campo('Nome');
  const email=(campo('E-?mail').match(/[^\s<>]+@[^\s<>]+/)||[''])[0];
  const telefone=(campo('Telefone')||campo('Celular')).replace(/[^\d()\s+-]/g,'').trim();
  const marca=campo('Marca'),modelo=campo('Modelo'),versao=campo('Vers[ãa]o FIPE'),ano=campo('Ano');
  const veiculo=[marca,modelo,versao].filter(Boolean).join(' ')+(ano?' '+ano:'');
  const vm=t.match(/Valor\s*-\s*(R\$\s*[\d.,]+)/i);const valor=vm?vm[1].replace(/\s+/g,' ').trim():'';
  const kmm=t.match(/km\s*-\s*([\d.]+)\s*km/i);const km=kmm?kmm[1]+' km':'';
  const financiar=/bot[ãa]o de Financiar/i.test(t)||/quer financiar/i.test(t);
  const entrada=campo('Valor entrada'),parcelas=campo('N[úu]mero de parcelas');
  const link=(String(corpoBruto||'').match(/href=["']([^"']+)["'][^>]*>\s*Ver An[úu]ncio/i)||[])[1]||'';
  return{nome,email,telefone,veiculo:veiculo.trim(),valor,km,financiar,entrada,parcelas,link};
}
function normTel(tel){
  let d=String(tel||'').replace(/\D/g,'');
  if(d.startsWith('55')&&d.length>=12)d=d.slice(2);
  return d;
}
function pad3(n){return String(n).padStart(3,'0');}
function dataBR(d){return d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});}
function horaBR(d){return d.toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});}
// Cria o lead (ou mescla, se o mesmo telefone ja tem lead em andamento) -
// mesmo padrao do webhook do Autoconf (index.js): lead novo vai pra I.A. (Eva).
async function criarLeadLitoral(p,emailId){
  const agora=new Date();
  const telNorm=normTel(p.telefone);
  const obs='Proposta recebida pelo portal LitoralCar (e-mail). O veículo não vem no e-mail'+(p.link?' — ver proposta: '+p.link:' — ver a proposta no painel da LitoralCar')+(p.cidade?' · Cidade/UF: '+p.cidade:'');
  if(telNorm){
    const cand=await db.collection('leads').where('clienteTelNorm','==',telNorm).get();
    const ativo=cand.docs.map(d=>({_id:d.id,...d.data()})).find(l=>!['vendido','perdido'].includes(l.st));
    if(ativo){
      // Par "Novo contato" + "Proposta" da LitoralCar (chegam no mesmo minuto):
      // o lead ja' foi criado pelo outro e-mail - so' guarda o link da proposta.
      const parLitoral=ativo.origem==='Litoral Car'&&(agora-new Date(ativo._criadoEm||0))<6*3600e3;
      if(parLitoral){
        if(p.link&&!String(ativo.obs||'').includes(p.link))await db.collection('leads').doc(ativo._id).update({obs:(ativo.obs?ativo.obs+' · ':'')+'Proposta: '+p.link});
        return ativo._id+' (mesmo contato do e-mail Novo contato)';
      }
      await db.collection('leads').doc(ativo._id).update({historico:[...(ativo.historico||[]),{dt:dataBR(agora)+' '+horaBR(agora),icone:'gold',acao:'🔗 Contato duplicado (outra plataforma)',obs:'Cliente também mandou proposta pela LitoralCar. '+obs,by:'LitoralCar'}]});
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
      st:'ia',by:'',captador:'',uid:'',origem:'Litoral Car',
      clienteNome:p.nome,clienteTel:p.telefone,clienteTelNorm:telNorm,clienteEmail:p.email,
      veiculo:'',valor:'',obs,convertido:false,dtVenda:'',motivoPerda:'',
      historico:[{dt:dataBR(agora)+' '+horaBR(agora),icone:'blue',acao:'Lead criado',obs:'Via LitoralCar (e-mail de proposta)',by:'LitoralCar'}],
      pendente_at:'',pendente_end:'',atendimento_at:'',atendimento_end:'',notificacaoVendedorEm:'',
      litoralEmailId:emailId,
    });
  });
  return novoId;
}
// "Novo contato interessado em um anúncio": cria o lead ja' com o veiculo, ou
// completa o lead do mesmo telefone (a Proposta pode ter chegado antes).
async function leadNovoContatoLitoral(p,emailId){
  const agora=new Date();
  const telNorm=normTel(p.telefone);
  const det=[p.veiculo&&('Veículo: '+p.veiculo),p.km,p.valor&&('Anúncio '+p.valor),
    p.financiar?('Quer FINANCIAR'+(p.entrada?' · entrada '+p.entrada:'')+(p.parcelas?' · '+p.parcelas+'x':'')):'Clicou no WhatsApp do anúncio',
    p.link&&('Anúncio: '+p.link)].filter(Boolean).join(' · ');
  if(telNorm){
    const cand=await db.collection('leads').where('clienteTelNorm','==',telNorm).get();
    const ativo=cand.docs.map(d=>({_id:d.id,...d.data()})).find(l=>!['vendido','perdido'].includes(l.st));
    if(ativo){
      const upd={historico:[...(ativo.historico||[]),{dt:dataBR(agora)+' '+horaBR(agora),icone:'gold',acao:ativo.origem==='Litoral Car'?'🚗 Veículo de interesse (LitoralCar)':'🔗 Contato duplicado (outra plataforma)',obs:(ativo.origem==='Litoral Car'?'':'Cliente também chamou pela LitoralCar. ')+det,by:'LitoralCar'}]};
      if(!ativo.veiculo&&p.veiculo)upd.veiculo=p.veiculo;
      if(!ativo.valor&&p.valor)upd.valor=p.valor;
      if(!ativo.clienteEmail&&p.email)upd.clienteEmail=p.email;
      await db.collection('leads').doc(ativo._id).update(upd);
      return ativo._id+' (completado com o veículo)';
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
      st:'ia',by:'',captador:'',uid:'',origem:'Litoral Car',
      clienteNome:p.nome,clienteTel:p.telefone,clienteTelNorm:telNorm,clienteEmail:p.email,
      veiculo:p.veiculo,valor:p.valor,obs:'Contato pelo portal LitoralCar (e-mail). '+det,convertido:false,dtVenda:'',motivoPerda:'',
      historico:[{dt:dataBR(agora)+' '+horaBR(agora),icone:'blue',acao:'Lead criado',obs:'Via LitoralCar (e-mail Novo contato'+(p.financiar?' — financiamento':'')+')',by:'LitoralCar'}],
      pendente_at:'',pendente_end:'',atendimento_at:'',atendimento_end:'',notificacaoVendedorEm:'',
      litoralEmailId:emailId,
    });
  });
  return novoId;
}
// Processa um e-mail ja' salvo em litoralcar_emails_recebidos (so' uma vez).
async function processarEmailSalvo(ref,dados){
  if(!dados||dados.processadoEm)return;
  if(/novo contato interessado/i.test(dados.assunto||'')&&/sigveiculos|litoral/i.test(dados.de||'')){
    const n=parseNovoContatoLitoral(dados.corpoHtml||dados.corpo||dados.snippet);
    if(!n.nome&&!n.telefone){await ref.update({processadoEm:new Date().toISOString(),resultado:'sem nome/telefone no e-mail'});return;}
    const r=await leadNovoContatoLitoral(n,ref.id);
    await ref.update({processadoEm:new Date().toISOString(),resultado:r});
    console.log('LitoralCar (novo contato): e-mail '+ref.id+' -> '+r);
    return;
  }
  const ehProposta=/proposta/i.test(dados.assunto||'')&&/sigveiculos|litoral/i.test(dados.de||'');
  if(!ehProposta){await ref.update({processadoEm:new Date().toISOString(),resultado:'ignorado (não é proposta)'});return;}
  const p=parsePropostaLitoral(dados.corpoHtml||dados.corpo||dados.snippet);
  if(!p.nome&&!p.telefone){await ref.update({processadoEm:new Date().toISOString(),resultado:'sem nome/telefone no e-mail'});return;}
  const r=await criarLeadLitoral(p,ref.id);
  await ref.update({processadoEm:new Date().toISOString(),resultado:r});
  console.log('LitoralCar: e-mail '+ref.id+' -> '+r);
}
function extrairHtml(payload){
  if(payload.mimeType==='text/html'&&payload.body&&payload.body.data)return decodificarBase64Url(payload.body.data);
  for(const p of (payload.parts||[])){const h=extrairHtml(p);if(h)return h;}
  return '';
}
function extrairCorpoTexto(payload){
  if(payload.body&&payload.body.data)return decodificarBase64Url(payload.body.data);
  if(payload.parts){
    const textPart=payload.parts.find(p=>p.mimeType==='text/plain')||payload.parts.find(p=>p.mimeType==='text/html');
    if(textPart)return extrairCorpoTexto(textPart);
  }
  return '';
}

/* Fase de "so' guardar e ver o que chega" (20/09/2026) - ainda nao sabemos
   o formato real de um e-mail da LitoralCar, entao essa function so' salva
   o conteudo bruto (de, assunto, corpo) em litoralcar_emails_recebidos,
   sem tentar criar lead nenhum ainda. Quando o primeiro e-mail real
   chegar, a Aline mostra o conteudo e ai sim escrevo o parser certo (nome/
   telefone/veiculo) que cria o lead direto em Atendimento + rodizio, sem
   chutar o formato agora. So processa e-mails NAO LIDOS na caixa dedicada
   (leads.rtcar@gmail.com) - so tem coisa da LitoralCar la, por causa do
   filtro configurado no webmail. Marca como lido no final pra nao
   reprocessar no proximo ciclo. */
exports.litoralcarEmailPoll=onSchedule({region:'southamerica-east1',schedule:'every 10 minutes'},async()=>{
  let token;
  try{token=await obterAccessToken();}catch(e){console.error('Erro ao obter access token do Gmail:',e.message);return;}
  const headers={Authorization:`Bearer ${token}`};
  // E-mails guardados antes do parser existir (desde 20/09) - processa uma vez.
  try{
    const pend=await db.collection('litoralcar_emails_recebidos').orderBy('recebidoEm').limit(200).get();
    const limite=new Date(Date.now()-15*864e5).toISOString(); // mais antigo que 15 dias: nao vira lead (ja' passou da hora da Eva cumprimentar)
    for(const d of pend.docs){if(!d.data().processadoEm&&(d.data().recebidoEm||'')<limite){await d.ref.update({processadoEm:new Date().toISOString(),resultado:'antigo (mais de 15 dias) - não importado'});continue;}if(!d.data().processadoEm){try{await processarEmailSalvo(d.ref,d.data());}catch(e){console.error('LitoralCar pendente '+d.id,e);}}}
  }catch(e){console.error('LitoralCar: erro ao processar guardados',e);}
  const listResp=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=20',{headers});
  const listDados=await listResp.json();
  const mensagens=listDados.messages||[];
  if(!mensagens.length)return;
  console.log(`${mensagens.length} e-mail(s) novo(s) na caixa da LitoralCar.`);
  for(const m of mensagens){
    try{
      const msgResp=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,{headers});
      const msg=await msgResp.json();
      const cabecalhos={};
      (msg.payload.headers||[]).forEach(h=>{cabecalhos[h.name.toLowerCase()]=h.value;});
      await db.collection('litoralcar_emails_recebidos').doc(m.id).set({
        de:cabecalhos.from||'',
        assunto:cabecalhos.subject||'',
        corpo:extrairCorpoTexto(msg.payload),
        corpoHtml:extrairHtml(msg.payload),
        snippet:msg.snippet||'',
        recebidoEm:new Date().toISOString(),
      });
      await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/modify`,{
        method:'POST',headers:{...headers,'Content-Type':'application/json'},
        body:JSON.stringify({removeLabelIds:['UNREAD']}),
      });
      console.log(`E-mail ${m.id} salvo em litoralcar_emails_recebidos.`);
      const refNovo=db.collection('litoralcar_emails_recebidos').doc(m.id);
      await processarEmailSalvo(refNovo,(await refNovo.get()).data());
    }catch(e){
      console.error(`Erro processando e-mail ${m.id}:`,e);
    }
  }
});
