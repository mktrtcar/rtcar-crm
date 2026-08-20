const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

/* Mesma fila e mesmo documento de controle usados pelo rodizio manual do CRM
   (rtcar-modulos.html), para que as duas origens de lead dividam a mesma
   sequencia de forma justa. Se a lista de vendedores do rodizio mudar no CRM,
   atualize aqui tambem. */
const RODIZIO_VENDEDORES=['Janderson','Maicon'];

function pad3(n){return String(n).padStart(3,'0');}
function hojeBR(){const d=new Date();return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;}
function hojeISO(){return new Date().toISOString().slice(0,10);}

function montarVeiculo(lead){
  const v=(lead.interested_in_vehicle||[])[0];
  if(!v)return '';
  return [v.brand,v.model,v.version].filter(Boolean).join(' ');
}

function montarObs(lead){
  const partes=[];
  if(lead.message)partes.push(lead.message);
  if(lead.negotiation_type)partes.push(`Tipo: ${lead.negotiation_type}`);
  const av=(lead.evaluated_vehicles||[])[0];
  if(av)partes.push(`Avaliação: ${[av.brand,av.model,av.year].filter(Boolean).join(' ')}${av.plate?' - placa '+av.plate:''}`);
  partes.push(`Autoconf lead #${lead.lead_id}${lead.store?' · '+lead.store:''}`);
  return partes.join('\n');
}

exports.autoconfWebhook = onRequest({region:'southamerica-east1'}, async (req,res)=>{
  if(req.method!=='POST'){res.status(405).send('Method not allowed');return;}
  const body=req.body||{};
  if(!body.lead_id){res.status(400).send('lead_id ausente');return;}

  try{
    const dup=await db.collection('leads').where('autoconfLeadId','==',body.lead_id).limit(1).get();
    if(!dup.empty){res.status(200).send('duplicado, ignorado');return;}

    /* Intencao de compra (negotiation_type "Compra") vai 100% pra Milena,
       pula a triagem da I.A. e nao entra no rodizio Janderson/Maicon. */
    const intencaoCompra=(body.negotiation_type_slug||body.negotiation_type||'').toLowerCase()==='compra';
    const origem=intencaoCompra?'Compra':((body.origins&&body.origins[0]&&body.origins[0].nome)||'Outra');

    const {novoId,captador}=await db.runTransaction(async tx=>{
      const refSeq=db.collection('leads_config').doc('mk');
      const snapSeq=await tx.get(refSeq);
      const seq=((snapSeq.exists&&snapSeq.data().leadSeq)||0)+1;
      tx.set(refSeq,{leadSeq:seq},{merge:true});

      if(intencaoCompra)return{novoId:`LEAD-${pad3(seq)}`,captador:'Milena'};

      const refRodizio=db.collection('leads_config').doc('rodizio');
      const snapRodizio=await tx.get(refRodizio);
      const idx=((snapRodizio.exists&&snapRodizio.data().idx)||0)%RODIZIO_VENDEDORES.length;
      tx.set(refRodizio,{idx:idx+1},{merge:true});

      return {novoId:`LEAD-${pad3(seq)}`,captador:RODIZIO_VENDEDORES[idx]};
    });

    const lead={
      id:novoId,
      dt:hojeBR(),
      dtISO:hojeISO(),
      st:intencaoCompra?'atendimento':'ia',
      by:'',
      captador,
      uid:'',
      origem,
      clienteNome:body.name||'',
      clienteTel:body.mobile_phone||body.phone||'',
      clienteEmail:body.email||'',
      veiculo:montarVeiculo(body),
      valor:'',
      obs:montarObs(body),
      convertido:false,
      dtVenda:'',
      motivoPerda:'',
      historico:[{dt:hojeBR(),icone:'blue',acao:'Lead criado',obs:intencaoCompra?'Via Autoconf — intenção de compra, atribuído direto à Milena':`Via Autoconf (${origem}) — atribuído a ${captador} pelo rodízio`,by:'Autoconf'}],
      pendente_at:'',
      pendente_end:'',
      atendimento_at:intencaoCompra?new Date().toISOString():'',
      atendimento_end:'',
      notificacaoVendedorEm:'',
      autoconfLeadId:body.lead_id,
    };

    await db.collection('leads').doc(novoId).set(lead);
    res.status(200).send('ok');
  }catch(e){
    console.error(e);
    res.status(500).send('erro interno');
  }
});
