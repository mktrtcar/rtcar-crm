const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Diagnostico pontual (17/09/2026, pedido da Aline: "fazem 5 dias que os
   vendedores estao recebendo poucos leads"). So LEITURA - conta leads por
   dia de criacao e por dia em que efetivamente saiu da I.A. pra Atendimento,
   pra separar duas causas bem diferentes: (a) chegou menos lead (problema
   de marketing/anuncio) ou (b) chegou normal mas ficou preso na I.A. sem a
   Eva processar (problema no bot). Tambem lista os leads presos hoje (na
   IA ha mais de 2h, sem nenhuma mensagem registrada) - mesmo padrao do
   caso real do Rangel (LEAD-414, 19h+ parado sem conversaEloa). */
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

exports.diagnosticoLeadsIA=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  try{
    await exigirGestor(req);
    const dias=Number(req.query.dias)||7;
    const corte=new Date();corte.setDate(corte.getDate()-dias);
    const corteISO=corte.toISOString().slice(0,10);

    const snap=await db.collection('leads').where('dtISO','>=',corteISO).get();
    const leads=snap.docs.map(d=>({id:d.id,...d.data()}));

    const porDiaCriados={};
    const porDiaAtendimento={};
    leads.forEach(l=>{
      porDiaCriados[l.dtISO]=(porDiaCriados[l.dtISO]||0)+1;
      if(l.atendimento_at){
        const dia=l.atendimento_at.slice(0,10);
        porDiaAtendimento[dia]=(porDiaAtendimento[dia]||0)+1;
      }
    });

    const agora=Date.now();
    const presos=leads.filter(l=>{
      if(l.st!=='ia')return false;
      const temConversa=l.eloaEnviadoEm||(l.conversaEloa&&l.conversaEloa.length);
      if(temConversa)return false;
      if(!l._criadoEm)return false;
      const horasParado=(agora-new Date(l._criadoEm).getTime())/3600000;
      return horasParado>=2;
    }).map(l=>({id:l.id,nome:l.clienteNome,origem:l.origem,criadoEm:l._criadoEm,horasParado:Math.round((agora-new Date(l._criadoEm).getTime())/3600000*10)/10}))
      .sort((a,b)=>b.horasParado-a.horasParado);

    // Achado 20/09/2026 (Aline, caso "Champion Exports"): lead com
    // eloaEnviadoEm==='NUMERO_INVALIDO' fica de fora do "presos" acima (o
    // filtro so pega quem NUNCA foi tentado - esse ja foi tentado e falhou
    // na checagem do WhatsApp). Separado aqui pra nao ficar escondido -
    // cada um desses e' um cliente real que a Eva desistiu de chamar.
    const numeroInvalido=leads.filter(l=>l.eloaEnviadoEm==='NUMERO_INVALIDO')
      .map(l=>({id:l.id,nome:l.clienteNome,tel:l.clienteTel,origem:l.origem,criadoEm:l._criadoEm}))
      .sort((a,b)=>(b.criadoEm||'').localeCompare(a.criadoEm||''));

    res.json({
      periodoDias:dias,
      totalLeads:leads.length,
      porDiaCriados,
      porDiaAtendimento,
      totalPresosNaIA:presos.length,
      presosNaIA:presos.slice(0,30),
      totalNumeroInvalido:numeroInvalido.length,
      numeroInvalido:numeroInvalido.slice(0,50),
    });
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});
