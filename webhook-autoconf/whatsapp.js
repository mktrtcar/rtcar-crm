const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* API oficial do WhatsApp (WhatsApp Business Platform / Cloud API) - 31/10/2026,
   pedido da Aline: (1) mandar convite de workshop pra muitos contatos de uma
   vez, pelo CRM; (2) depois acompanhar as conversas (dos vendedores) com
   resumo da IA. App da Meta "RT Car Mensagens" (1167912462338436), no RT Car
   Business. Tudo no .env (a Aline cola):
     WA_TOKEN         token com whatsapp_business_messaging/management
     WA_WABA_ID       conta do WhatsApp (onde ficam os modelos)
     WA_PHONE_ID      numero que envia
     WA_VERIFY_TOKEN  palavra combinada com a Meta na hora de cadastrar o webhook
     WA_APP_SECRET    (opcional) chave secreta do app - confere a assinatura
   Sem WA_TOKEN tudo responde "nao configurado", entao pode ser publicado antes.

   O numero de marketing (47 99123-8422) so' entra depois da aprovacao como
   Provedor de Tecnologia (coexistencia: continua no celular). NUNCA registrar
   numero que esta em celular so' pela API - ele sai do aparelho. */
const GRAPH = 'https://graph.facebook.com/v21.0';
const env = k => process.env[k] || '';

// Mesmos e-mails de gestor da LitoralCar (isManager() no CRM).
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

async function graph(caminho, metodo='GET', corpo){
  const r = await fetch(`${GRAPH}/${caminho}`, {
    method: metodo,
    headers: {Authorization: `Bearer ${env('WA_TOKEN')}`, ...(corpo?{'Content-Type':'application/json'}:{})},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const body = await r.json().catch(()=>({}));
  if(!r.ok || body.error){
    const er = body.error || {};
    const e = new Error(er.error_user_msg || er.message || `Erro ${r.status} na Meta`);
    e.status = 400; e.meta = er; throw e;
  }
  return body;
}

// Celular brasileiro como o CRM guarda ("(47) 99999-1111") -> 5547999991111.
function numeroWhats(tel){
  let d = String(tel||'').replace(/\D/g,'');
  if(d.length===10 || d.length===11) d = '55'+d;
  return d.length>=12 ? d : '';
}

// Texto do modelo com as variaveis trocadas - so' pra mostrar a mensagem
// enviada na conversa do CRM (a Meta monta a mensagem de verdade).
function textoDoModelo(modelo, params){
  const corpo = (modelo.components||[]).find(c=>c.type==='BODY');
  return String(corpo?.text||'').replace(/\{\{(\d+)\}\}/g,(m,n)=>params[+n-1]??m);
}

async function registrarConversa(numero, dados){
  await db.collection('wa_conversas').doc(numero).set({numero, atualizadoEm:new Date().toISOString(), ...dados},{merge:true});
}

/* Resposta pelo botao do convite: payload "WS|SIM|CV-012" / "WS|NAO|CV-012"
   (montado no envio: 1o botao do modelo = SIM, os outros = NAO) -> move o
   convidado no kanban do Workshop. */
async function aplicarRespostaConvite(payload){
  const [tipo, resp, cvId] = String(payload||'').split('|');
  if(tipo!=='WS' || !cvId) return;
  const ref = db.collection('convidados_ws').doc(cvId);
  const snap = await ref.get();
  if(!snap.exists) return;
  const st = snap.data().st;
  const dados = {respostaConvite: resp==='SIM'?'sim':'nao', respostaConviteEm: new Date().toISOString()};
  // so' anda pra frente: quem ja' esta' como presente/feedback nao volta
  if(resp==='SIM' && ['convidado','contato_feito'].includes(st)) dados.st = 'confirmado';
  await ref.set(dados,{merge:true});
}

/* Endereco que a Meta chama (cadastrado no app como "URL de callback"):
   GET = verificacao do cadastro; POST = mensagem recebida / status de envio. */
exports.whatsappWebhook = onRequest({region:'southamerica-east1'}, async(req,res)=>{
  if(req.method==='GET'){
    if(req.query['hub.mode']==='subscribe' && env('WA_VERIFY_TOKEN') && req.query['hub.verify_token']===env('WA_VERIFY_TOKEN')){
      res.status(200).send(String(req.query['hub.challenge']||''));
    }else res.status(403).send('forbidden');
    return;
  }
  if(req.method!=='POST'){res.status(405).send('Method not allowed');return;}
  if(env('WA_APP_SECRET')){
    const esperado = 'sha256='+crypto.createHmac('sha256',env('WA_APP_SECRET')).update(req.rawBody||'').digest('hex');
    const veio = req.get('x-hub-signature-256')||'';
    if(veio.length!==esperado.length || !crypto.timingSafeEqual(Buffer.from(veio),Buffer.from(esperado))){res.status(401).send('assinatura invalida');return;}
  }
  try{
    for(const entry of req.body?.entry||[]){
      for(const ch of entry.changes||[]){
        const v = ch.value||{};
        const nomes = Object.fromEntries((v.contacts||[]).map(c=>[c.wa_id, c.profile?.name||'']));
        for(const m of v.messages||[]){
          const texto = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title
            || (m[m.type]?.caption) || `[${m.type}]`;
          const em = new Date((+m.timestamp||Date.now()/1000)*1000).toISOString();
          await db.collection('wa_mensagens').doc(m.id).set({
            id:m.id, numero:m.from, nome:nomes[m.from]||'', direcao:'entrada', tipo:m.type, texto,
            em, phoneId:v.metadata?.phone_number_id||'', contexto:m.context?.id||'',
          });
          await registrarConversa(m.from, {nome:nomes[m.from]||'', ultimaMsg:texto, ultimaEm:em, ultimaEntradaEm:em, naoLidas:admin.firestore.FieldValue.increment(1)});
          if(m.type==='button') await aplicarRespostaConvite(m.button?.payload);
          if(m.type==='interactive') await aplicarRespostaConvite(m.interactive?.button_reply?.id);
        }
        // status do que NOS enviamos: sent / delivered / read / failed
        for(const s of v.statuses||[]){
          const ref = db.collection('wa_mensagens').doc(s.id);
          const dados = {status:s.status, [`status_${s.status}Em`]:new Date((+s.timestamp||Date.now()/1000)*1000).toISOString()};
          if(s.errors?.length) dados.erro = s.errors.map(e=>`${e.code} ${e.title}${e.error_data?.details?' - '+e.error_data.details:''}`).join('; ');
          await ref.set(dados,{merge:true});
        }
      }
    }
  }catch(e){ console.error('whatsappWebhook', e); }
  res.status(200).send('ok'); // sempre 200: senao a Meta repete o aviso
});

/* Chamadas do CRM (so' gestor): ?acao=modelos | criarModelo | enviarModelo | responder */
exports.whatsappApi = onRequest({region:'southamerica-east1', cors:true, timeoutSeconds:300}, async(req,res)=>{
  try{
    const quem = await exigirGestor(req);
    if(!env('WA_TOKEN') || !env('WA_WABA_ID') || !env('WA_PHONE_ID')){res.status(400).json({erro:'WhatsApp ainda não configurado (falta WA_TOKEN / WA_WABA_ID / WA_PHONE_ID no .env).'});return;}
    const acao = req.query.acao;
    const b = req.body||{};

    if(acao==='modelos'){
      const r = await graph(`${env('WA_WABA_ID')}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=100`);
      res.json({modelos:r.data||[]}); return;
    }

    if(acao==='criarModelo'){
      // nome: so' minusculas, numeros e _ (regra da Meta)
      const nome = String(b.nome||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
      const texto = String(b.texto||'').trim();
      if(!nome || !texto){res.status(400).json({erro:'Informe o nome e o texto do modelo.'});return;}
      const vars = [...texto.matchAll(/\{\{(\d+)\}\}/g)].map(x=>+x[1]);
      const qtd = vars.length ? Math.max(...vars) : 0;
      const exemplos = (b.exemplos||[]).slice(0,qtd);
      if(exemplos.length<qtd || exemplos.some(x=>!String(x).trim())){res.status(400).json({erro:`Preencha um exemplo para cada variável ({{1}} a {{${qtd}}}) - a Meta exige.`});return;}
      const components = [{type:'BODY', text:texto, ...(qtd?{example:{body_text:[exemplos.map(String)]}}:{})}];
      if(b.rodape) components.push({type:'FOOTER', text:String(b.rodape).slice(0,60)});
      const botoes = (b.botoes||[]).map(t=>String(t).trim()).filter(Boolean).slice(0,3);
      if(botoes.length) components.push({type:'BUTTONS', buttons:botoes.map(t=>({type:'QUICK_REPLY', text:t.slice(0,25)}))});
      const r = await graph(`${env('WA_WABA_ID')}/message_templates`, 'POST', {name:nome, language:'pt_BR', category:b.categoria==='UTILITY'?'UTILITY':'MARKETING', components});
      await db.collection('wa_log').add({acao, nome, por:quem.email, em:new Date().toISOString(), resposta:r});
      res.json({ok:true, id:r.id, status:r.status, nome}); return;
    }

    if(acao==='enviarModelo'){
      // destinatarios: [{numero, nome, params:[...], convidadoId?}]
      const modelo = b.modelo||{};
      const dest = (b.destinatarios||[]).slice(0,300);
      const temBotoes = (modelo.components||[]).some(c=>c.type==='BUTTONS');
      const resultado = [];
      for(const d of dest){
        const para = numeroWhats(d.numero);
        if(!para){resultado.push({numero:d.numero, nome:d.nome, ok:false, erro:'número inválido'});continue;}
        const params = (d.params||[]).map(String);
        const components = [];
        if(params.length) components.push({type:'body', parameters:params.map(t=>({type:'text', text:t}))});
        if(temBotoes && d.convidadoId){
          const btns = (modelo.components.find(c=>c.type==='BUTTONS').buttons||[]);
          btns.forEach((bt,i)=>{ if(bt.type==='QUICK_REPLY') components.push({type:'button', sub_type:'quick_reply', index:String(i), parameters:[{type:'payload', payload:`WS|${i===0?'SIM':'NAO'}|${d.convidadoId}`}]}); });
        }
        try{
          const r = await graph(`${env('WA_PHONE_ID')}/messages`, 'POST', {messaging_product:'whatsapp', to:para, type:'template', template:{name:modelo.name, language:{code:modelo.language||'pt_BR'}, ...(components.length?{components}:{})}});
          const id = r.messages?.[0]?.id;
          const texto = textoDoModelo(modelo, params);
          const em = new Date().toISOString();
          await db.collection('wa_mensagens').doc(id).set({id, numero:r.contacts?.[0]?.wa_id||para, nome:d.nome||'', direcao:'saida', tipo:'modelo', modelo:modelo.name, texto, em, status:'enviado', por:quem.email, eventoId:b.eventoId||'', convidadoId:d.convidadoId||''});
          await registrarConversa(r.contacts?.[0]?.wa_id||para, {nome:d.nome||'', ultimaMsg:texto, ultimaEm:em});
          // convite saiu: "Convidado" -> "Contato Feito" no kanban do Workshop
          if(d.convidadoId){
            const ref = db.collection('convidados_ws').doc(d.convidadoId);
            const cv = await ref.get();
            if(cv.exists && cv.data().st==='convidado') await ref.set({st:'contato_feito'},{merge:true});
            await ref.set({conviteWhatsEm:em},{merge:true});
          }
          resultado.push({numero:d.numero, nome:d.nome, ok:true, id});
        }catch(e){ resultado.push({numero:d.numero, nome:d.nome, ok:false, erro:e.message}); }
        await new Promise(r=>setTimeout(r,120));
      }
      res.json({resultado}); return;
    }

    if(acao==='responder'){
      // texto livre so' funciona ate' 24h depois da ultima mensagem do cliente (regra da Meta)
      const para = numeroWhats(b.numero) || String(b.numero||'').replace(/\D/g,'');
      const texto = String(b.texto||'').trim();
      if(!para || !texto){res.status(400).json({erro:'Informe o número e o texto.'});return;}
      const r = await graph(`${env('WA_PHONE_ID')}/messages`, 'POST', {messaging_product:'whatsapp', to:para, type:'text', text:{body:texto}});
      const id = r.messages?.[0]?.id;
      const em = new Date().toISOString();
      await db.collection('wa_mensagens').doc(id).set({id, numero:para, direcao:'saida', tipo:'texto', texto, em, status:'enviado', por:quem.email});
      await registrarConversa(para, {ultimaMsg:texto, ultimaEm:em, naoLidas:0});
      res.json({ok:true, id}); return;
    }

    res.status(400).json({erro:'ação desconhecida'});
  }catch(e){
    if(!e.status) console.error('whatsappApi', e);
    res.status(e.status||500).json({erro:e.message});
  }
});
