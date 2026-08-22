const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

function pad3(n){return String(n).padStart(3,'0');}
function hojeBR(){const d=new Date();return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;}
function hojeISO(){return new Date().toISOString().slice(0,10);}
// Igual a hojeBR(), mas com horario - usado so no "dt" do evento de historico
// (21/08/2026, a pedido do Rubens, pra dar pra ver o horario exato de cada
// etapa no painel de acompanhamento, nao so o dia).
function agoraBR(){const d=new Date();return `${hojeBR()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}

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
    const origemBruta=(body.origins&&body.origins[0]&&body.origins[0].nome)||'Outra';

    /* 20/08/2026: leads com essas origens sao, na pratica, clientes que o
       vendedor ja atende pessoalmente e cadastrou manualmente no CRM — o
       Autoconf so foi usado por engano/costume pra registrar o contato.
       Nao devem ir pra Eva (ela nao sabe que ja existe atendimento humano
       rolando) nem entrar no rodizio (nao sao leads novos de verdade). Ficam
       em "atendimento" sem vendedor, pra alguem confirmar manualmente. */
    const ORIGENS_CADASTRO_MANUAL=['Loja','Carteira de clientes','Passante'];
    const cadastroManual=!intencaoCompra&&ORIGENS_CADASTRO_MANUAL.includes(origemBruta);

    const origem=intencaoCompra?'Compra':origemBruta;
    const vaiDiretoAtendimento=intencaoCompra||cadastroManual;

    // 22/08/2026: a criacao do lead inteiro agora acontece DENTRO da mesma
    // transacao que reserva o numero de sequencia. Antes eram duas operacoes
    // separadas (reservar o numero, depois gravar o lead) - qualquer falha
    // entre uma e outra "gastava" o numero sem nunca criar o lead de
    // verdade, de forma silenciosa (bug real: 13 numeros de sequencia
    // perdidos entre 18-22/08/2026, incluindo um cliente real - Maycon -
    // que so foi notado por acaso dias depois). Agora ou as duas coisas
    // acontecem juntas, ou nenhuma acontece - o Firestore desfaz tudo
    // sozinho se der erro no meio.
    await db.runTransaction(async tx=>{
      const refSeq=db.collection('leads_config').doc('mk');
      const snapSeq=await tx.get(refSeq);

      const seq=((snapSeq.exists&&snapSeq.data().leadSeq)||0)+1;
      const novoId=`LEAD-${pad3(seq)}`;
      const captador=intencaoCompra?'Milena':'';

      const lead={
        id:novoId,
        dt:hojeBR(),
        dtISO:hojeISO(),
        st:vaiDiretoAtendimento?'atendimento':'ia',
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
        historico:[{dt:agoraBR(),icone:'blue',acao:'Lead criado',obs:intencaoCompra?'Via Autoconf — intenção de compra, atribuído direto à Milena':(cadastroManual?`Via Autoconf (${origem}) — provável cadastro manual de vendedor, não encaminhado à Eva; verificar e atribuir manualmente`:`Via Autoconf (${origem}) — aguardando resposta do cliente pra entrar no rodízio`),by:'Autoconf'}],
        pendente_at:'',
        pendente_end:'',
        atendimento_at:vaiDiretoAtendimento?new Date().toISOString():'',
        atendimento_end:'',
        notificacaoVendedorEm:'',
        autoconfLeadId:body.lead_id,
      };

      tx.set(refSeq,{leadSeq:seq},{merge:true});
      tx.set(db.collection('leads').doc(novoId),lead);
    });

    res.status(200).send('ok');
  }catch(e){
    console.error(e);
    // 22/08/2026: antes, um erro aqui so ficava no log do Cloud Functions
    // (que ninguem olha no dia a dia) - o lead sumia sem ninguem saber.
    // Agora grava o corpo bruto recebido numa colecao separada, pra nunca
    // perder o dado de verdade, e o eloa-bot avisa por WhatsApp assim que
    // encontrar um erro novo aqui (ver getErrosWebhookParaNotificar).
    try{
      await db.collection('erros_webhook').add({
        criadoEm:new Date().toISOString(),
        erro:String((e&&e.message)||e),
        body,
        notificadoEm:'',
      });
    }catch(e2){
      console.error('Falha ao registrar erro do webhook:',e2);
    }
    res.status(500).send('erro interno');
  }
});
