const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();

/* Utilitario pontual (29/09/2026, pedido da Aline: cadastro do vendedor
   Ezequiel) - cria a conta de login (Firebase Auth) de um vendedor novo e
   devolve um link de "definir senha" (o mesmo mecanismo de "esqueci minha
   senha"), pra quem cadastrou repassar pro vendedor. Ninguem (nem esta
   function, nem quem chama) fica sabendo a senha real - ela e' definida
   pelo proprio vendedor ao abrir o link. Gestor-only. */
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

exports.criarLoginVendedor=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  if(req.method!=='POST'){res.status(405).send('Method not allowed');return;}
  try{
    await exigirGestor(req);
    const email=String(req.body.email||'').trim().toLowerCase();
    const nome=String(req.body.nome||'').trim();
    if(!email||!nome){res.status(400).json({erro:'email e nome sao obrigatorios'});return;}
    let uid;
    try{
      const crypto=require('crypto');
      const senhaDescartavel=crypto.randomBytes(24).toString('base64');
      const user=await admin.auth().createUser({email,password:senhaDescartavel,displayName:nome});
      uid=user.uid;
    }catch(e){
      if(e.code==='auth/email-already-exists'){
        const existente=await admin.auth().getUserByEmail(email);
        uid=existente.uid;
      }else{throw e;}
    }
    const link=await admin.auth().generatePasswordResetLink(email);
    res.json({ok:true,uid,link});
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});
