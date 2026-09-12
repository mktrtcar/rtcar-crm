const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

const LITORAL_BASE='http://www.litoralcar.com.br/webserver';
const COD_LOJA=process.env.LITORALCAR_COD_LOJA;
function headersLitoral(){
  return{
    Username:process.env.LITORALCAR_USERNAME,
    Password:process.env.LITORALCAR_PASSWORD,
    Accept:'application/json',
    'Accept-Charset':'UTF-8',
    'Content-Type':'application/json',
    /* Sem um User-Agent de navegador, o WAF da LitoralCar (GoCache) responde
       com uma pagina de desafio/recaptcha em vez da API - descoberto testando
       a integracao em 11/09/2026. */
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };
}

/* Emails com papel de gestor no CRM (mesmo criterio de isManager() no
   frontend: master/coordenadora/dev) - unica validacao de quem pode acionar
   a publicacao de estoque/consulta de referencias na LitoralCar. */
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

async function litoralFetch(acao,metodo,parametro,body){
  const partes=[LITORAL_BASE,acao,metodo];
  if(parametro!==undefined&&parametro!==null)partes.push(parametro);
  partes.push(COD_LOJA);
  const tipo={buscar:'GET',salvar:'POST',alterar:'PUT',excluir:'DELETE'}[acao];
  const resp=await fetch(partes.join('/'),{method:tipo,headers:headersLitoral(),body:body?JSON.stringify(body):undefined});
  const texto=await resp.text();
  let json;try{json=JSON.parse(texto);}catch{json={raw:texto};}
  return{status:resp.status,body:json};
}

/* Cores da nossa base vem no feminino (Branca, Preta, Vermelha...) mas a
   LitoralCar so aceita a lista fixa deles, toda no masculino (Branco,
   Preto, Vermelho...) - sem isso a cor nunca bate e o veiculo e' recusado. */
const COR_FEMININO_PARA_LITORAL={branca:'Branco',preta:'Preto',vermelha:'Vermelho',amarela:'Amarelo',dourada:'Dourado',roxa:'Roxo',prateada:'Prata'};
function normalizarCor(cor,listaValida){
  if(!cor)return null;
  const alvo=cor.trim().toLowerCase();
  const direta=listaValida.find(v=>v.toLowerCase()===alvo);
  if(direta)return direta;
  const viaMapa=COR_FEMININO_PARA_LITORAL[alvo];
  if(viaMapa){const m=listaValida.find(v=>v.toLowerCase()===viaMapa.toLowerCase());if(m)return m;}
  return null;
}
function parseValorBR(s){
  if(s===undefined||s===null||s==='')return null;
  const n=parseFloat(String(s).replace(/\./g,'').replace(',','.'));
  return isNaN(n)?null:n;
}
function parseKm(s){
  const n=parseInt(String(s||'').replace(/\D/g,''),10);
  return isNaN(n)?0:n;
}
function limparPlaca(p){
  return String(p||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
}

/* Referências (categorias/cores/combustíveis) pra tela de revisão no CRM
   sugerir/validar os campos que a LitoralCar exige mas nossa base não tem. */
exports.litoralcarReferencias=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  try{
    await exigirGestor(req);
    const[categorias,cores,combustiveis]=await Promise.all([
      litoralFetch('buscar','categorias'),
      litoralFetch('buscar','cores'),
      litoralFetch('buscar','combustiveis'),
    ]);
    res.json({
      categorias:categorias.body.categorias||[],
      cores:cores.body.cores||[],
      combustiveis:combustiveis.body.combustiveis||[],
    });
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});

/* Publica/atualiza o estoque na LitoralCar. Recebe do CRM a lista de
   veículos "disponível" já revisados (categoria e combustível confirmados
   pelo usuário, já que rtcar_estoque_publico não tem esses dois campos).
   cod_importacao é gerado e mantido aqui (coleção litoralcar_veiculos,
   indexada pela placa) pra saber se cada veículo é novo (salvar) ou já
   publicado antes (alterar). */
exports.litoralcarPublicarEstoque=onRequest({region:'southamerica-east1',cors:true},async(req,res)=>{
  if(req.method!=='POST'){res.status(405).send('Method not allowed');return;}
  try{
    await exigirGestor(req);
    const veiculos=req.body.veiculos||[];
    if(!veiculos.length){res.status(400).json({erro:'Nenhum veículo enviado'});return;}

    const refs=await Promise.all([litoralFetch('buscar','cores')]);
    const coresValidas=refs[0].body.cores||[];

    const resultados=[];
    const novos=[];
    const alterados=[];
    const porPlaca={};

    for(const v of veiculos){
      const placa=limparPlaca(v.placa);
      const cor=normalizarCor(v.cor,coresValidas);
      const ano=parseInt(v.anoModelo,10)||parseInt(v.anoFabricacao,10)||null;
      const valor=parseValorBR(v.preco);
      if(!cor){resultados.push({placa:v.placa,ok:false,erro:`Cor "${v.cor}" não reconhecida pela LitoralCar`});continue;}
      if(!ano){resultados.push({placa:v.placa,ok:false,erro:'Ano ausente/inválido'});continue;}
      if(!valor){resultados.push({placa:v.placa,ok:false,erro:'Preço ausente/inválido'});continue;}
      if(!v.categoria||!v.combustivel){resultados.push({placa:v.placa,ok:false,erro:'Categoria ou combustível não informado'});continue;}

      const payload={
        categoria:v.categoria,marca:v.marca,modelo:v.modelo,versao:v.versao||'',
        combustivel:v.combustivel,cor,ano,km:parseKm(v.km),placa,
        valor,situacao:'exibir',
      };
      porPlaca[placa]=v.placa;

      const mapRef=db.collection('litoralcar_veiculos').doc(placa);
      const mapSnap=await mapRef.get();
      if(mapSnap.exists&&mapSnap.data().codVeiculo){
        alterados.push({...payload,cod_importacao:mapSnap.data().codImportacao,cod_veiculo:mapSnap.data().codVeiculo});
      }else{
        const seqRef=db.collection('litoralcar_config').doc('seq');
        const codImportacao=await db.runTransaction(async tx=>{
          const s=await tx.get(seqRef);
          const proximo=((s.exists&&s.data().veiculoSeq)||0)+1;
          tx.set(seqRef,{veiculoSeq:proximo},{merge:true});
          return proximo;
        });
        novos.push({...payload,cod_importacao:codImportacao});
      }
    }

    async function processarLote(acao,lote){
      if(!lote.length)return;
      const r=await litoralFetch(acao,'estoque',undefined,{veiculos:lote});
      const itens=(r.body&&r.body.veiculos)||[];
      for(const item of itens){
        const vlt=item.veiculo||{};
        const placa=limparPlaca(vlt.placa);
        const ok=/sucesso/i.test(vlt.status||'');
        resultados.push({placa:porPlaca[placa]||placa,ok,status:vlt.status,alertas:vlt.alertas||[]});
        if(ok&&vlt.cod_veiculo){
          await db.collection('litoralcar_veiculos').doc(placa).set({
            codImportacao:Number(vlt.cod_importacao),
            codVeiculo:Number(vlt.cod_veiculo),
            ultimoEnvio:new Date().toISOString(),
          },{merge:true});
        }
      }
      if(r.status>=400&&!itens.length){
        lote.forEach(x=>resultados.push({placa:porPlaca[x.placa]||x.placa,ok:false,erro:JSON.stringify(r.body)}));
      }
    }

    await processarLote('salvar',novos);
    await processarLote('alterar',alterados);

    res.json({resultados});
  }catch(e){
    console.error(e);
    res.status(e.status||500).json({erro:e.message||String(e)});
  }
});
