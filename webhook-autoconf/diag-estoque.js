const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Diagnostico pontual (29/09/2026) - so' LEITURA, pra confirmar de verdade
   quais campos a colecao rtcar_estoque_publico tem (mantida pelo sistema
   principal), antes de desenhar a integracao ao vivo do site publico.
   Apagar depois de confirmado. Gestor-only. */
const EMAILS_GESTOR=['contato@rtcar.com.br','marcela@rtcar.com.br','rafael@rtcar.com.br','tiago@rtcar.com.br','milena@rtcar.com.br','rubens@rtcar.com.br'];
async function exigirGestor(req){
  const auth=req.headers.authorization||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):null;
  if(!token){const e=new Error('Não autenticado');e.status=401;throw e;}
  const decoded=await admin.auth().verifyIdToken(token);
  if(!decoded.email||!EMAILS_GESTOR.includes(decoded.email.toLowerCase())){
    const e=new Error('Sem permissão');e.status=403;throw e;
  }
}
exports.diagEstoquePublico=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  try{
    await exigirGestor(req);
    const snap=await db.collection('rtcar_estoque_publico').limit(5).get();
    const docs=snap.docs.map(d=>({id:d.id,campos:Object.keys(d.data()),amostra:d.data()}));
    res.json({total:snap.size,docs});
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});
