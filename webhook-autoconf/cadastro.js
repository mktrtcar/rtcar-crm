const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Cadastro de clientes (PF/PJ) mora no sistema principal da Marcela, nos
   docs rtcar/cadastroPF e rtcar/cadastroPJ (mesmo Firestore, mesmo padrao
   de "documento unico com array dentro" que ela usa em tudo, por causa do
   limite de 1MB do plano Spark). Diferente do estoque (rtcar_estoque_publico),
   isso NAO e' de leitura publica (testado em 17/09/2026: 403 sem auth) -
   faz sentido, e' dado pessoal de cliente (CPF, telefone, endereco) - por
   isso precisa passar por uma function com Admin SDK. So LEITURA, nunca
   escreve nada aqui: a curadoria do cadastro continua 100% do lado dela
   (mesma regra que ela ja aplica pros termos - texto livre nunca grava
   direto no cadastro).
   Pedido da Aline, 17/09/2026: sugerir automaticamente os dados de um
   cliente ao criar um lead, se ele ja existir no cadastro dela - "assim
   como puxamos os veiculos da base de estoque". */
async function exigirAutenticado(req){
  const auth=req.headers.authorization||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):null;
  if(!token){const e=new Error('Não autenticado');e.status=401;throw e;}
  return admin.auth().verifyIdToken(token);
}

function soDigitos(s){return String(s||'').replace(/\D/g,'');}

/* Cache curto (cadastro muda com mais frequencia que o estoque de carros,
   mas isso aqui e' so uma sugestao de preenchimento - alguns minutos de
   atraso nao tem problema nenhum e economiza muito em function calls,
   já que a busca dispara a cada pausa de digitação). */
const CACHE_TTL_MS=3*60*1000;
let _cacheCadastro=null,_cacheQuando=0;
async function carregarCadastro(){
  if(_cacheCadastro&&(Date.now()-_cacheQuando)<CACHE_TTL_MS){
    console.log('[cadastro] cache HIT, sem leitura no Firestore');
    return _cacheCadastro;
  }
  const t0=Date.now();
  const[pfSnap,pjSnap]=await Promise.all([
    db.collection('rtcar').doc('cadastroPF').get(),
    db.collection('rtcar').doc('cadastroPJ').get(),
  ]);
  const t1=Date.now();
  const pf=(pfSnap.exists&&pfSnap.data().CADPF)||[];
  const pj=(pjSnap.exists&&pjSnap.data().CADPJ)||[];
  _cacheCadastro={CADPF:pf,CADPJ:pj};
  _cacheQuando=Date.now();
  // Instrumentacao pedida pelo Claude do sistema principal, 22/09/2026
  // (Marcela relatou busca lenta) - pra saber se o tempo esta indo na
  // leitura do Firestore (cache MISS, doc grande) ou em outro lugar.
  console.log(`[cadastro] cache MISS - leitura Firestore levou ${t1-t0}ms - CADPF:${pf.length} registros - CADPJ:${pj.length} registros`);
  return _cacheCadastro;
}

/* Mesma logica de busca do cadBuscar() do sistema dela (dev.html): nome/
   razao por substring, cpf/cnpj/telefones por digitos - assim o resultado
   bate com o que ela mesma ve buscando por lá. */
exports.buscarClienteCadastro=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  const tInicio=Date.now();
  try{
    await exigirAutenticado(req);
    const tAuth=Date.now();
    const q=String(req.query.q||'').trim().toUpperCase();
    const qd=soDigitos(q);
    if(q.length<3&&qd.length<6){res.json({resultados:[]});return;}
    const{CADPF,CADPJ}=await carregarCadastro();
    const tCadastro=Date.now();
    const resultados=[];
    CADPF.forEach(c=>{
      const bateNome=q.length>=3&&(c.nome||'').toUpperCase().includes(q);
      const bateDoc=qd.length>=6&&soDigitos(c.cpf).includes(qd);
      const bateTel=qd.length>=6&&[c.telCel,c.telCom,c.telRes].some(t=>soDigitos(t).includes(qd));
      if(bateNome||bateDoc||bateTel){
        resultados.push({id:c.id,tipo:'PF',nome:c.nome||'',tel:c.telCel||c.telCom||c.telRes||'',email:c.email||'',cidade:(c.end&&c.end.cid)||'',uf:(c.end&&c.end.uf)||''});
      }
    });
    CADPJ.forEach(c=>{
      const bateNome=q.length>=3&&[(c.razao||''),(c.fantasia||'')].some(n=>n.toUpperCase().includes(q));
      const bateDoc=qd.length>=6&&soDigitos(c.cnpj).includes(qd);
      const bateTel=qd.length>=6&&[c.telCel,c.telCom,c.telRes].some(t=>soDigitos(t).includes(qd));
      if(bateNome||bateDoc||bateTel){
        resultados.push({id:c.id,tipo:'PJ',nome:c.razao||c.fantasia||'',tel:c.telCom||c.telCel||c.telRes||'',email:c.email||'',cidade:(c.end&&c.end.cid)||'',uf:(c.end&&c.end.uf)||''});
      }
    });
    const tFiltro=Date.now();
    console.log(`[cadastro] tempos(ms) - auth:${tAuth-tInicio} carregarCadastro:${tCadastro-tAuth} filtro:${tFiltro-tCadastro} TOTAL:${tFiltro-tInicio}`);
    res.json({resultados:resultados.slice(0,6)});
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});
