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

/* Diagnostico (03/11/2026) - so' LEITURA. Combustivel/portas/cambio/carroceria
   nao estao no feed; ficam no sistema principal: combustivel no veiculo do
   Estoque (rtcar/dados.EV[].combustiveis) e os 4 na Avaliacao
   (colecao avaliacoes, ou rtcar/dados.AV no modo antigo). Mede quantos carros
   do estoque ativo ja tem esses dados, antes de ligar no site/LitoralCar/ML. */
const PROPULSAO_LEGADO={flex:['flex'],gasolina:['gasolina'],etanol:['flex'],diesel:['diesel'],gnv:['gnv'],hibrido:['hibrido'],hibrido_flex:['hibrido','flex'],eletrico:['eletrico']};
const placaCanon=p=>String(p||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
function tecnicoDaAvaliacao(a){
  const v=(a&&a.veiculo)||{};
  const comb=Array.isArray(v.combustiveis)?v.combustiveis:(PROPULSAO_LEGADO[v.propulsao]||[]);
  return {avId:a.id||'',combustiveis:comb,portas:v.portas||'',cambio:v.cambio||'',carroceria:v.carroceria||''};
}
exports.diagDadosTecnicos=onRequest({region:'southamerica-east1',cors:true,memory:'512MiB'},async(req,res)=>{
  try{
    await exigirGestor(req);
    const [cfg,dados,feed]=await Promise.all([
      db.collection('rtcar').doc('config').get(),
      db.collection('rtcar').doc('dados').get(),
      db.collection('rtcar_estoque_publico').where('status','in',['disponivel','em_preparacao']).get()
    ]);
    const avModo=(cfg.exists&&cfg.data().avModo)||'dados';
    const d=dados.exists?dados.data():{};
    let avs;
    if(avModo==='colecao'){
      const s=await db.collection('avaliacoes').select('id','veiculo.pl','veiculo.combustiveis','veiculo.propulsao','veiculo.portas','veiculo.cambio','veiculo.carroceria').get();
      avs=s.docs.map(x=>({id:x.id,...x.data()}));
    }else avs=d.AV||[];
    const avPorPlaca={};
    avs.forEach(a=>{const p=placaCanon(a.veiculo&&a.veiculo.pl);if(p)avPorPlaca[p]=a;});
    const evPorId={};
    (d.EV||[]).forEach(e=>{if(e&&e.id)evPorId[e.id]={combustiveis:e.combustiveis||null,tidRef:e.tidRefEntrada||e.tidRef||''};});
    const carros=feed.docs.map(doc=>{
      const f=doc.data(),ev=evPorId[f.evId]||{},av=avPorPlaca[placaCanon(f.placa)];
      const t=av?tecnicoDaAvaliacao(av):{};
      const comb=(ev.combustiveis&&ev.combustiveis.length)?ev.combustiveis:(t.combustiveis||[]);
      return {placa:f.placa,carro:`${f.marca} ${f.modelo} ${f.versao||''}`.trim(),status:f.status,
        combEstoque:ev.combustiveis||null,temAvaliacao:!!av,combustiveis:comb,portas:t.portas||'',cambio:t.cambio||'',carroceria:t.carroceria||''};
    });
    const n=c=>carros.filter(c).length;
    res.json({avModo,totalAvaliacoes:avs.length,carrosAtivos:carros.length,
      comCombustivel:n(c=>c.combustiveis.length),combNoEstoque:n(c=>c.combEstoque&&c.combEstoque.length),
      comAvaliacao:n(c=>c.temAvaliacao),comPortas:n(c=>c.portas),comCambio:n(c=>c.cambio),carros});
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});
