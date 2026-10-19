const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Webmotors - "Integracao de leads com CRM terceiro" (19/10/2026, pedido da
   Aline: tirar a Webmotors do Autoconf e receber os leads direto no CRM).
   A API da Webmotors e' passiva: quando chega um lead de qualquer loja que
   ativou o nosso CRM, ela chama esta "URL de CallBack Notification" so' pra
   avisar; depois o CRM e' que vai buscar o lead no endpoint deles, com o
   usuario "Integrador de API" que a loja cria no Cockpit.

   Fase 1 (esta): so' guarda o aviso bruto em webmotors_callbacks e responde
   200 - ainda nao sabemos o formato real do aviso nem temos credencial de
   homologacao (depende do chamado aberto pela Aline no portal deles). Quando
   a Webmotors liberar o ambiente de teste, a Fase 2 le esses avisos, busca o
   lead na API e cria em leads (mesmo padrao do webhook do Autoconf). Nao
   cria lead nenhum agora. */
exports.webmotorsCallback=onRequest({region:'southamerica-east1'},async(req,res)=>{
  try{
    await db.collection('webmotors_callbacks').add({
      recebidoEm:new Date().toISOString(),
      metodo:req.method,
      query:req.query||{},
      // texto bruto limitado a 20 KB (endereco publico - evita lixo grande no banco)
      corpo:String(req.rawBody||JSON.stringify(req.body||'')).slice(0,20000),
      contentType:req.get('content-type')||'',
      processadoEm:'',
    });
    res.status(200).json({ok:true});
  }catch(e){
    console.error('webmotorsCallback',e);
    res.status(200).json({ok:true}); // nunca devolve erro pra Webmotors - o aviso fica no log
  }
});
