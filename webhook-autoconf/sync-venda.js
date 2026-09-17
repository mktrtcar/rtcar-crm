const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Fase 5 da integração com o sistema da Marcela (17/09/2026, pedido da
   Aline): os dois painéis (o nosso, baseado no funil de "leads", e o dela,
   baseado nos Termos de Venda de verdade) não se conversavam - cada um só
   enxergava a própria metade. A Fase 3 já manda o leadId junto quando abre
   o Termo pré-preenchido (abrirTermoDoCRM), mas isso era só ida - nada
   voltava pro nosso lado depois que o Termo era salvo de verdade.
   Essa function fecha o ciclo: quando o Termo é salvo no sistema dela, ela
   chama isso aqui com o leadId de origem + os dados finais da venda, e a
   gente atualiza o lead - assim os dois painéis batem o mesmo número.
   Mesma conta/Firebase Auth compartilhada entre os dois sistemas
   (confirmado no código dela - tentarAutoLogin), entao qualquer usuário
   autenticado ja e' suficiente, sem lista de emails. */
async function exigirAutenticado(req){
  const auth=req.headers.authorization||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):null;
  if(!token){const e=new Error('Não autenticado');e.status=401;throw e;}
  return admin.auth().verifyIdToken(token);
}

exports.sincronizarVendaDoTermo=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  if(req.method!=='POST'){res.status(405).send('Method not allowed');return;}
  try{
    await exigirAutenticado(req);
    const{leadId,valorFechado,formaPagamento,dtVendaReal,termoId}=req.body;
    if(!leadId){res.status(400).json({erro:'leadId não informado'});return;}
    const ref=db.collection('leads').doc(String(leadId));
    const snap=await ref.get();
    if(!snap.exists){res.status(404).json({erro:`Lead ${leadId} não encontrado`});return;}
    const dados={termoSincronizadoEm:new Date().toISOString()};
    if(valorFechado!==undefined&&valorFechado!==null)dados.valorFechado=valorFechado;
    if(formaPagamento)dados.formaPagamento=formaPagamento;
    if(dtVendaReal)dados.dtVendaReal=dtVendaReal;
    if(termoId)dados.termoId=termoId;
    await ref.set(dados,{merge:true});
    res.json({ok:true});
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});
