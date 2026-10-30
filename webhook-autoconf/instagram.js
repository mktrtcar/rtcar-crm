const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

/* Instagram no site (30/10/2026, pedido da Aline): os 3 posts mais recentes
   do @rtcar.brusque aparecem no fim da pagina inicial, onde antes ficavam os
   depoimentos. Usa a API oficial da Meta (Instagram Graph API) com o token de
   um "usuario do sistema" do Business da RT Car - esse token nao expira.
   INSTAGRAM_TOKEN fica no .env (quem gera e cola e' a Aline). Sem token a
   rotina so' sai, entao pode ser publicada antes.
   As imagens sao copiadas pro nosso Storage porque o link da Meta expira
   em poucos dias. O site le site_config/instagram.
   Roda de hora em hora (pedido da Aline, 30/10/2026). */
const db = admin.firestore();
const GRAPH = 'https://graph.facebook.com/v21.0';
const QTD = 3;
const USUARIO = process.env.INSTAGRAM_USUARIO || 'rtcar.brusque';

async function graph(caminho, params){
  const qs = new URLSearchParams({...params, access_token: process.env.INSTAGRAM_TOKEN});
  const r = await fetch(`${GRAPH}/${caminho}?${qs}`);
  const body = await r.json().catch(()=>({}));
  if(!r.ok || body.error) throw new Error(`Graph ${caminho}: ${(body.error&&body.error.message)||r.status}`);
  return body;
}

// conta do Instagram ligada 'a pagina do Facebook que o token enxerga
// (ou a fixada em INSTAGRAM_USER_ID, se um dia tiver mais de uma)
async function contaInstagram(){
  if(process.env.INSTAGRAM_USER_ID) return {id: process.env.INSTAGRAM_USER_ID};
  // Token de PAGINA (gerado pelo Explorador da Graph API, 30/10/2026: o token
  // do usuario do sistema pediu aprovacao de um 2o admin que a BM nao tem) -
  // aqui "me" e' a propria pagina RT CAR.
  const pagina = await graph('me', {fields: 'instagram_business_account{id,username}'}).catch(()=>null);
  if(pagina && pagina.instagram_business_account && pagina.instagram_business_account.username===USUARIO) return pagina.instagram_business_account;
  // Token de usuario enxerga mais de uma pagina (RT CAR e RT Cred, cada uma
  // com seu Instagram) - escolhe sempre o @rtcar.brusque (30/10/2026: a
  // primeira rodada pegou o Instagram da RT Cred).
  const r = await graph('me/accounts', {fields: 'name,instagram_business_account{id,username}'});
  const contas = (r.data||[]).map(p=>p.instagram_business_account).filter(Boolean);
  const conta = contas.find(c=>c.username===USUARIO);
  if(!conta) throw new Error(`Instagram @${USUARIO} nao aparece nesse token (achei: ${contas.map(c=>c.username).join(', ')||'nenhum'})`);
  return conta;
}

exports.siteAtualizarInstagram = onSchedule({region:'southamerica-east1',schedule:'every 60 minutes',timeZone:'America/Sao_Paulo',timeoutSeconds:120},async()=>{
  if(!process.env.INSTAGRAM_TOKEN){ console.log('siteAtualizarInstagram: sem INSTAGRAM_TOKEN no .env'); return; }
  const ref = db.collection('site_config').doc('instagram');
  const atual = (await ref.get()).data() || {};
  try{
    const conta = await contaInstagram();
    const r = await graph(`${conta.id}/media`, {fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp', limit: QTD});
    const bucket = admin.storage().bucket();
    const jaTem = Object.fromEntries((atual.posts||[]).map(p=>[p.id,p]));
    const posts = [];
    for(const m of (r.data||[]).slice(0,QTD)){
      if(jaTem[m.id]){ posts.push({...jaTem[m.id], legenda:(m.caption||'').slice(0,300)}); continue; }
      const origem = m.media_type==='VIDEO' ? m.thumbnail_url : m.media_url;
      if(!origem) continue;
      const img = await fetch(origem);
      if(!img.ok){ console.error(`siteAtualizarInstagram: falha baixando ${m.id} (${img.status})`); continue; }
      const caminho = `site/instagram/${m.id}.jpg`;
      await bucket.file(caminho).save(Buffer.from(await img.arrayBuffer()), {metadata:{contentType:'image/jpeg',cacheControl:'public, max-age=86400'}, public:true});
      posts.push({id:m.id, link:m.permalink, imagem:`https://storage.googleapis.com/${bucket.name}/${caminho}`, legenda:(m.caption||'').slice(0,300), video:m.media_type==='VIDEO', data:m.timestamp});
    }
    if(!posts.length) return;
    const ids = posts.map(p=>p.id);
    const mudou = JSON.stringify(posts) !== JSON.stringify(atual.posts||[]);
    if(mudou || atual.erro){
      await ref.set({posts, usuario: conta.username||atual.usuario||'', atualizadoEm: new Date().toISOString(), erro: admin.firestore.FieldValue.delete()}, {merge:true});
    }
    for(const p of atual.posts||[]){
      if(!ids.includes(p.id)) await bucket.file(`site/instagram/${p.id}.jpg`).delete().catch(()=>{});
    }
    if(mudou) console.log(`siteAtualizarInstagram: ${posts.length} post(s) - ${ids.join(', ')}`);
  }catch(e){
    // mantem os posts antigos no site; o erro fica registrado pra diagnostico
    console.error('siteAtualizarInstagram:', e.message);
    // ...a nao ser que os posts guardados sejam de outro Instagram: ai' tira do site
    const outraConta = atual.usuario && atual.usuario!==USUARIO;
    await ref.set({erro: e.message, erroEm: new Date().toISOString(), ...(outraConta?{posts:[]}:{})}, {merge:true});
  }
});
