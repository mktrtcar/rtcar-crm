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
    await db.collection('leads_config').doc('gmail_oauth').set({
      refreshToken:dados.refresh_token,
      autorizadoEm:new Date().toISOString(),
      email:process.env.GMAIL_LEADS_EMAIL||'',
    },{merge:true});
    res.send('<h2>✅ Autorizado com sucesso!</h2><p>Pode fechar esta aba e voltar pro chat.</p>');
  }catch(e){
    console.error(e);
    res.status(500).send(`<h2>Erro inesperado</h2><pre>${e.message}</pre>`);
  }
});

async function obterAccessToken(){
  const doc=await db.collection('leads_config').doc('gmail_oauth').get();
  if(!doc.exists||!doc.data().refreshToken)throw new Error('Gmail ainda não foi autorizado (sem refreshToken salvo)');
  const params=new URLSearchParams({
    client_id:process.env.GMAIL_LEADS_CLIENT_ID,
    client_secret:process.env.GMAIL_LEADS_CLIENT_SECRET,
    refresh_token:doc.data().refreshToken,
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
        snippet:msg.snippet||'',
        recebidoEm:new Date().toISOString(),
      });
      await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/modify`,{
        method:'POST',headers:{...headers,'Content-Type':'application/json'},
        body:JSON.stringify({removeLabelIds:['UNREAD']}),
      });
      console.log(`E-mail ${m.id} salvo em litoralcar_emails_recebidos.`);
    }catch(e){
      console.error(`Erro processando e-mail ${m.id}:`,e);
    }
  }
});
