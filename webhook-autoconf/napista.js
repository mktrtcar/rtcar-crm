const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Na Pista - leads direto pelo "Copiloto NaPista" (19/11/2026, pedido da Aline).
   A Na Pista nao tem API publica, mas oferece um servidor MCP oficial para
   assistentes de IA (Area do lojista -> Integracoes -> Copiloto NaPista):
     MCP:   https://api.napista.com.br/seller-mcp/mcp  (JSON-RPC por HTTP)
     Login: Keycloak auth.napista.com.br/realms/marketplace-dealer, OAuth 2.0
            com PKCE e cadastro automatico do aplicativo (registration_endpoint).
   O nosso servidor faz o papel do "assistente": a Aline clica em Conectar,
   entra com o login da loja NA PROPRIA Na Pista (a senha nunca passa por nos)
   e autoriza. Guardamos so' o token (Storage privado/napista-oauth.json).

   Etapa 1 (este arquivo): conectar + listar/chamar as ferramentas do MCP para
   descobrir o formato real dos leads. Nada vira lead ainda - a busca automatica
   (napistaLeadsPoll) so' liga depois de vermos o formato, para nao chutar campo.
   Nunca mexer na "Credencial de integracao de estoque" da Na Pista: e' a que o
   Autoconf usa para publicar. */

const ISSUER='https://auth.napista.com.br/realms/marketplace-dealer';
const AUTH_URL=ISSUER+'/protocol/openid-connect/auth';
const TOKEN_URL=ISSUER+'/protocol/openid-connect/token';
const REG_URL=ISSUER+'/clients-registrations/openid-connect';
const MCP_URL='https://api.napista.com.br/seller-mcp/mcp';
const FN_BASE='https://southamerica-east1-rtcarprograma.cloudfunctions.net';
const REDIRECT_URI=FN_BASE+'/napistaOAuthCallback';
const ESCOPO='openid offline_access napista-mcp-audience';
const ARQ='privado/napista-oauth.json';
const EMAILS_GESTOR=['contato@rtcar.com.br','marcela@rtcar.com.br','rafael@rtcar.com.br','tiago@rtcar.com.br','milena@rtcar.com.br','rubens@rtcar.com.br'];

async function lerPrivado(){
  try{const [b]=await admin.storage().bucket().file(ARQ).download();return JSON.parse(b.toString());}
  catch(e){if(e.code===404)return{};throw e;}
}
async function gravarPrivado(dados){
  const atual=await lerPrivado();
  await admin.storage().bucket().file(ARQ).save(JSON.stringify({...atual,...dados}),{contentType:'application/json',resumable:false});
}
async function exigirGestor(req){
  const tk=String(req.headers.authorization||'').replace(/^Bearer /,'');
  const dec=await admin.auth().verifyIdToken(tk);
  if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){const e=new Error('Sem permissão');e.status=403;throw e;}
  return dec;
}
const b64url=b=>b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

// Cadastro automatico do nosso aplicativo no login da Na Pista (uma vez so').
async function clienteOAuth(){
  const p=await lerPrivado();
  if(p.clientId)return p.clientId;
  const r=await fetch(REG_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'RT Car CRM',redirect_uris:[REDIRECT_URI],grant_types:['authorization_code','refresh_token'],
    response_types:['code'],token_endpoint_auth_method:'none',scope:ESCOPO})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.client_id){const e=new Error('A Na Pista recusou o cadastro do aplicativo: '+r.status+' '+JSON.stringify(j).slice(0,300));e.status=502;throw e;}
  await gravarPrivado({clientId:j.client_id,registradoEm:new Date().toISOString(),registrationAccessToken:j.registration_access_token||''});
  return j.client_id;
}

// 1) Conectar: gestor logado no CRM pede o link; a Aline entra na Na Pista e autoriza.
exports.napistaConectar=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  try{
    const dec=await exigirGestor(req);
    const clientId=await clienteOAuth();
    const state=b64url(crypto.randomBytes(16)),verifier=b64url(crypto.randomBytes(48));
    const challenge=b64url(crypto.createHash('sha256').update(verifier).digest());
    await gravarPrivado({pkceVerifier:verifier,pkceState:state});
    await db.collection('napista_config').doc('oauth').set({pedidoEm:new Date().toISOString(),pedidoPor:dec.email||''},{merge:true});
    const url=AUTH_URL+'?'+new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:REDIRECT_URI,scope:ESCOPO,state,
      code_challenge:challenge,code_challenge_method:'S256',resource:MCP_URL}).toString();
    res.json({url});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});

exports.napistaOAuthCallback=onRequest({region:'southamerica-east1'},async(req,res)=>{
  try{
    if(req.query.error){res.status(400).send(`<h2>Autorização recusada</h2><p>${String(req.query.error_description||req.query.error).replace(/</g,'')}</p>`);return;}
    const code=String(req.query.code||''),state=String(req.query.state||'');
    const p=await lerPrivado();
    if(!code||!state||state!==p.pkceState||!p.clientId){res.status(400).send('<h2>Link de autorização inválido ou já usado</h2><p>Volte e peça um novo link de conexão da Na Pista.</p>');return;}
    const r=await fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:REDIRECT_URI,client_id:p.clientId,code_verifier:p.pkceVerifier}).toString()});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.access_token){console.error('Na Pista token',d);res.status(500).send(`<h2>Erro ao autorizar na Na Pista</h2><pre>${String(d.error_description||d.error||r.status).replace(/</g,'')}</pre>`);return;}
    await gravarPrivado({accessToken:d.access_token,refreshToken:d.refresh_token||'',expiraEm:Date.now()+((d.expires_in||300)-30)*1000,conectadoEm:new Date().toISOString(),pkceVerifier:'',pkceState:''});
    await db.collection('napista_config').doc('oauth').set({conectadoEm:new Date().toISOString(),temRefresh:!!d.refresh_token},{merge:true});
    res.send('<h2>✅ Na Pista conectada!</h2><p>Pode fechar esta aba e voltar pro CRM.</p>');
  }catch(e){console.error(e);res.status(500).send('<h2>Erro inesperado</h2>');}
});

async function tokenNapista(){
  const p=await lerPrivado();
  if(!p.accessToken){const e=new Error('Na Pista ainda não conectada');e.status=409;throw e;}
  if(p.expiraEm>Date.now())return p.accessToken;
  if(!p.refreshToken){const e=new Error('Conexão da Na Pista expirou - conecte de novo');e.status=409;throw e;}
  const r=await fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',refresh_token:p.refreshToken,client_id:p.clientId}).toString()});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.access_token){
    await db.collection('napista_config').doc('oauth').set({erroRenovacao:String(d.error_description||d.error||r.status),erroEm:new Date().toISOString()},{merge:true});
    const e=new Error('Não deu para renovar a conexão da Na Pista ('+(d.error||r.status)+') - conecte de novo');e.status=409;throw e;
  }
  await gravarPrivado({accessToken:d.access_token,refreshToken:d.refresh_token||p.refreshToken,expiraEm:Date.now()+((d.expires_in||300)-30)*1000});
  return d.access_token;
}

/* Cliente MCP minimo (Streamable HTTP): initialize -> initialized -> chamada.
   A resposta pode vir como JSON ou como SSE (linhas "data: {...}"). */
function lerResposta(txt,tipo,id){
  if(/text\/event-stream/.test(tipo||'')){
    const msgs=txt.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>{try{return JSON.parse(l.slice(5).trim());}catch{return null;}}).filter(Boolean);
    return msgs.find(m=>m.id===id)||msgs[msgs.length-1]||{};
  }
  try{return JSON.parse(txt);}catch{return{raw:txt.slice(0,2000)};}
}
async function mcpSessao(){
  const token=await tokenNapista();
  let sessao='',seq=0;
  const enviar=async(method,params,notificacao)=>{
    const corpo={jsonrpc:'2.0',method,...(params?{params}:{}),...(notificacao?{}:{id:++seq})};
    const r=await fetch(MCP_URL,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',
      'MCP-Protocol-Version':'2025-06-18',...(sessao?{'Mcp-Session-Id':sessao}:{})},body:JSON.stringify(corpo)});
    if(r.headers.get('mcp-session-id'))sessao=r.headers.get('mcp-session-id');
    const txt=await r.text();
    if(notificacao)return null;
    if(!r.ok){const e=new Error('MCP Na Pista '+r.status+': '+txt.slice(0,300));e.status=502;throw e;}
    const j=lerResposta(txt,r.headers.get('content-type'),corpo.id);
    if(j.error){const e=new Error('MCP Na Pista: '+(j.error.message||JSON.stringify(j.error)));e.status=502;throw e;}
    return j.result;
  };
  const ini=await enviar('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'RT Car CRM',version:'1.0'}});
  await enviar('notifications/initialized',null,true);
  return{servidor:ini&&ini.serverInfo,chamar:(nome,args)=>enviar('tools/call',{name:nome,arguments:args||{}}),ferramentas:()=>enviar('tools/list',{})};
}

/* 2) Diagnostico (so' gestor): sem "ferramenta" lista as ferramentas do MCP
   com os parametros; com ?ferramenta=X&args={json} chama uma delas (so' leitura).
   Serve para montarmos a busca de leads em cima do formato real. */
exports.napistaFerramentas=onRequest({region:'southamerica-east1',cors:true,timeoutSeconds:60},async(req,res)=>{
  try{
    await exigirGestor(req);
    const s=await mcpSessao();
    const nome=String(req.query.ferramenta||'');
    if(!nome){const t=await s.ferramentas();res.json({servidor:s.servidor,ferramentas:(t&&t.tools)||[]});return;}
    let args={};try{args=req.query.args?JSON.parse(String(req.query.args)):{};}catch{res.status(400).json({erro:'args não é JSON'});return;}
    const r=await s.chamar(nome,args);
    res.json({ferramenta:nome,resultado:r});
  }catch(e){console.error(e);res.status(e.status||500).json({erro:e.message||String(e)});}
});
