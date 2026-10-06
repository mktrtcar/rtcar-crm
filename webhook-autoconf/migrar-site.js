const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

/* Sincronizacao do estoque do site publico (29/09/2026, pedido da Aline).
   Saiu do arquivo fixo site-publico/dados/estoque.json (sem edicao possivel)
   pra uma colecao no Firestore (site_veiculos) editavel por um admin de
   verdade. Mas isso cria um problema: se a Aline editar um campo (ex:
   descricao) e depois pedir uma nova extracao do Autoconf, a extracao NAO
   PODE apagar a edicao dela. Solucao: cada doc guarda "camposBloqueados"
   (lista de nomes de campo que ela editou manualmente pelo admin) - essa
   function so' atualiza um campo se ele NAO estiver bloqueado. Fotos tem a
   mesma logica via "fotosBloqueadas" (true assim que ela anexar/excluir
   manualmente qualquer foto). "oculto" nunca e' tocado por aqui, so' pelo
   admin. Veiculo que sumiu da fonte NAO e' apagado - so' marca
   desapareceuDaFonte:true e oculta automaticamente (reversivel).
   Busca do proprio rtcar-site.web.app ja publicado (nao precisa do arquivo
   local nem bater no Autoconf de novo aqui). Gestor-only. */
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
async function baixar(url){
  const r=await fetch(url);
  if(!r.ok)return null;
  return Buffer.from(await r.arrayBuffer());
}
// Lista atualizada 01/10/2026 pro formato real que o scraper atual gera
// (site-publico/dados/estoque.json) - os nomes antigos (precoDe/precoPor/
// categoria/combustivel/portas) eram da extracao de 07/09 e nao existem
// mais nesse arquivo, causavam "undefined" nesses campos.
const CAMPOS_DA_FONTE=['url','marca','modelo','versao','preco','ano','km','potencia','cambio','cor','opcionais','garantia','descricao'];

exports.sincronizarVeiculosSitePublico=onRequest({region:'southamerica-east1',timeoutSeconds:540,memory:'512MiB',cors:true},async(req,res)=>{
  try{
    await exigirGestor(req);
    const estoqueResp=await fetch('https://rtcar-site.web.app/dados/estoque.json');
    const estoque=await estoqueResp.json();
    const idsNaFonte=new Set(estoque.veiculos.map(v=>String(v.id)));
    const resultado=[];

    // Modo "so' um carro" (05/10/2026, pedido da Aline - Range Rover 437611
    // tinha sumido do site): com "id" (codigo do anuncio no Autoconf, o numero
    // no fim do link), traz SO' esse veiculo e nao mexe em nenhum outro - nem
    // roda a parte de "sumiu da fonte". "placaSistema" opcional ja' vincula ao
    // carro do sistema principal, igual ao botao de vinculo do admin.
    const corpo=(req.body&&typeof req.body==='object')?req.body:{};
    const soId=String(req.query.id||corpo.id||'').trim();
    const placaVinculo=String(req.query.placaSistema||corpo.placaSistema||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
    const veiculosAlvo=soId?estoque.veiculos.filter(v=>String(v.id)===soId):estoque.veiculos;
    if(soId&&!veiculosAlvo.length){res.status(404).json({erro:`Código ${soId} não encontrado no catálogo do site (extraído em ${estoque.extraidoEm}).`});return;}

    for(const v of veiculosAlvo){
      const id=String(v.id);
      const ref=db.collection('site_veiculos').doc(id);
      const snap=await ref.get();
      const existente=snap.exists?snap.data():null;
      const camposBloqueados=existente?.camposBloqueados||[];
      const fotosBloqueadas=!!existente?.fotosBloqueadas;

      const dados={};
      CAMPOS_DA_FONTE.forEach(campo=>{
        // Firestore recusa gravar "undefined" (campo que nao existe nesse
        // veiculo especifico, tipo potencia/cor ausente) - so' grava se o
        // campo realmente existir na fonte, senao pula (nao escreve nada,
        // em vez de escrever undefined e dar erro 500 em todo o lote).
        if(!camposBloqueados.includes(campo)&&v[campo]!==undefined)dados[campo]=v[campo];
      });
      dados.desapareceuDaFonte=false;
      dados.sincronizadoEm=new Date().toISOString();

      if(!fotosBloqueadas){
        const qtdFotosOriginal=(v.fotos||[]).length;
        const fotosUrls=[];
        for(let n=1;n<=qtdFotosOriginal;n++){
          const urlOriginal=`https://rtcar-site.web.app/fotos/${v.id}/${n}.jpg`;
          const buf=await baixar(urlOriginal);
          if(!buf)break;
          const caminho=`veiculos/${id}/${n}.jpg`;
          const file=bucket.file(caminho);
          await file.save(buf,{metadata:{contentType:'image/jpeg'},public:true});
          fotosUrls.push(`https://storage.googleapis.com/${bucket.name}/${caminho}`);
        }
        dados.fotos=fotosUrls;
      }

      if(!existente){
        dados.oculto=false;
        dados.camposBloqueados=[];
        dados.fotosBloqueadas=false;
      }
      await ref.set(dados,{merge:true});
      resultado.push({id,novo:!existente,fotosAtualizadas:!fotosBloqueadas});
    }

    if(soId){
      let vinculo=null;
      if(placaVinculo){
        // Mesmo efeito do vincularLinha() do admin: grava o vinculo e esconde
        // o carro "duplicado" sem foto que o estoque do sistema criou sozinho.
        const estSnap=await db.collection('rtcar_estoque_publico').doc(placaVinculo).get();
        const placaReal=estSnap.exists?(estSnap.data().placaReal||''):'';
        await db.collection('site_veiculos').doc(soId).set({placaSistema:placaVinculo,placaReal},{merge:true});
        const dupSnap=await db.collection('site_veiculos').doc(placaVinculo).get();
        const dup=dupSnap.exists?dupSnap.data():null;
        const duplicadoOculto=!!(dup&&placaVinculo!==soId&&dup.origemEstoquePrincipal&&!(dup.fotos||[]).length);
        if(duplicadoOculto)await dupSnap.ref.set({oculto:true,ocultoPorVinculo:soId},{merge:true});
        vinculo={placaSistema:placaVinculo,estoqueSistemaExiste:estSnap.exists,duplicadoOculto};
      }
      res.json({ok:true,soUm:true,resultado,vinculo});
      return;
    }

    // Veiculo que existia antes mas sumiu da fonte agora (provavelmente
    // vendido) - nao apaga, so marca e oculta automaticamente. Reversivel
    // pelo admin (desmarcar "oculto" a mao se for engano).
    const todosSnap=await db.collection('site_veiculos').get();
    const desaparecidos=[];
    for(const doc of todosSnap.docs){
      // Carro cadastrado manualmente (manual:true) nunca esteve na fonte -
      // nao se aplica essa regra de "sumiu", senao ele seria ocultado
      // sozinho na primeira sincronizacao depois de criado.
      if(doc.data().manual)continue;
      if(!idsNaFonte.has(doc.id)&&!doc.data().desapareceuDaFonte){
        await doc.ref.set({desapareceuDaFonte:true,oculto:true},{merge:true});
        desaparecidos.push(doc.id);
      }
    }

    res.json({ok:true,total:resultado.length,resultado,desaparecidos});
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});
