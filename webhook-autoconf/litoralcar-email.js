const {onRequest} = require('firebase-functions/v2/https');
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
