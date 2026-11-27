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

/* 27/11/2026 - PUBLICAR ESTOQUE (Manual Integracao Revendedor, SOAP .NET):
   login wsLoginSistemaRevendedor.asmx autenticar(cnpj,email,senha) -> HashAutenticacao
   (vale ~1000 min); estoque wsEstoqueRevendedorWebMotors.asmx (ObterEstoqueAtual,
   IncluirCarro, AlterarCarro, ExcluirCarro, IncluirFotoUrl...). Usuario = o "Integrador
   de API" que a Aline criou no Cockpit em 19/11 (leads.rtcar@gmail.com); a senha fica
   so' no secret WEBMOTORS_INTEGRADOR_SENHA (nunca no codigo nem no chat).
   webmotorsTestarAcesso: SO' LEITURA - autentica e lista o que esta' no ar. */
const {defineSecret}=require('firebase-functions/params');
const WM_SENHA=defineSecret('WEBMOTORS_INTEGRADOR_SENHA');
const WM_CNPJ='43510524000135';
const WM_EMAIL='leads.rtcar@gmail.com';
const WM_LOGIN='https://integracao.webmotors.com.br/wsLoginSistemaRevendedor.asmx';
const WM_ESTOQUE='https://integracao.webmotors.com.br/wsEstoqueRevendedorWebMotors.asmx';
const EMAILS_GESTOR_WM=['contato@rtcar.com.br','marcela@rtcar.com.br','rafael@rtcar.com.br','tiago@rtcar.com.br','milena@rtcar.com.br','rubens@rtcar.com.br','samuelrtcar@gmail.com'];
const xmlEsc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function soapWM(url,ns,acao,corpoXml){
  const env=`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${acao} xmlns="${ns}">${corpoXml}</${acao}></soap:Body></soap:Envelope>`;
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${ns}/${acao}"`},body:env});
  return{status:r.status,xml:await r.text()};
}
const tagWM=(xml,t)=>{const m=String(xml).match(new RegExp(`<${t}>([\s\S]*?)</${t}>`));return m?m[1]:'';};
async function autenticarWM(){
  const r=await soapWM(WM_LOGIN,'www.webmotors.com.br/wsLoginSistemaRevendedor','autenticar',
    `<cnpj>${WM_CNPJ}</cnpj><email>${xmlEsc(WM_EMAIL)}</email><senha>${xmlEsc(WM_SENHA.value())}</senha>`);
  return{http:r.status,hash:tagWM(r.xml,'HashAutenticacao'),codigoRetorno:tagWM(r.xml,'CodigoRetorno'),erro:r.status!==200?tagWM(r.xml,'faultstring')||r.xml.slice(0,300):''};
}
exports.webmotorsTestarAcesso=onRequest({region:'southamerica-east1',cors:true,secrets:[WM_SENHA],timeoutSeconds:120},async(req,res)=>{
  try{
    const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const dec=await admin.auth().verifyIdToken(tk);
    if(!EMAILS_GESTOR_WM.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'Sem permissão'});return;}
    const a=await autenticarWM();
    if(!a.hash){res.json({autenticou:false,http:a.http,codigoRetorno:a.codigoRetorno,erro:a.erro});return;}
    const e=await soapWM(WM_ESTOQUE,'www.webmotors.com.br/wsEstoqueRevendedorWebMotors','ObterEstoqueAtual',`<pHashAutenticacao>${xmlEsc(a.hash)}</pHashAutenticacao>`);
    const anuncios=(e.xml.match(/<Anuncio>[\s\S]*?<\/Anuncio>/g)||[]).map(x=>({codigo:tagWM(x,'CodigoAnuncio'),placa:tagWM(x,'Placa'),marca:tagWM(x,'Marca'),modelo:tagWM(x,'Modelo'),versao:tagWM(x,'Versao'),ano:tagWM(x,'AnoModelo'),preco:tagWM(x,'Preco'),modalidade:tagWM(x,'Modalidade')}));
    res.json({autenticou:true,codigoRetorno:a.codigoRetorno,estoqueHttp:e.status,total:anuncios.length,anuncios,amostraXml:anuncios.length?'':e.xml.slice(0,1500)});
  }catch(err){console.error('webmotorsTestarAcesso',err);res.status(500).json({erro:err.message});}
});
