const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

/* Fase 2 da integracao site <-> estoque (01/10/2026, pedido da Aline): assim
   que um veiculo entra (ou muda) no estoque do sistema principal
   (rtcar_estoque_publico, mantido pela Marcela), aparece automaticamente no
   nosso site publico tambem - sem foto nenhuma no comeco (a tela "Em
   preparacao" do site ja cobre isso sozinha), ate alguem anexar a foto de
   verdade pelo admin.

   So' cria/atualiza campos que NUNCA foram editados a mao aqui (mesmo
   padrao de camposBloqueados ja usado em sincronizarVeiculosSitePublico) -
   uma vez que alguem mexeu num campo pelo admin do site, essa automacao
   para de sobrescrever ele. "status" vindo de la nunca mexe em "oculto" do
   nosso lado, pra nao esconder/mostrar um carro que o admin ja decidiu
   manualmente.

   So considera disponivel/em_preparacao (mesmo filtro que o CRM ja usa pra
   "veiculo de interesse") - repasse/vendido nao precisam aparecer aqui. */
const STATUS_RELEVANTES=['disponivel','em_preparacao'];
const MAPA_CAMPOS={marca:'marca',modelo:'modelo',versao:'versao',preco:'preco'};

exports.vincularEstoquePrincipalAoSite=onDocumentWritten({region:'southamerica-east1',document:'rtcar_estoque_publico/{placa}'},async(event)=>{
  const depois=event.data?.after?.exists?event.data.after.data():null;
  const placa=event.params.placa;
  const ref=db.collection('site_veiculos').doc(placa);
  if(!depois||!STATUS_RELEVANTES.includes(depois.status)){
    // Veiculo excluido no sistema principal, ou vendido/repasse - apaga de
    // verdade do site (doc + fotos no Storage), pedido da Aline,
    // 01/10/2026: carro vendido nao deve continuar aparecendo. So' apaga se
    // o veiculo realmente veio dessa automacao (origemEstoquePrincipal) -
    // nunca mexe num carro cadastrado manualmente no admin.
    const snap=await ref.get();
    if(snap.exists&&snap.data().origemEstoquePrincipal){
      const prefixo=`https://storage.googleapis.com/${bucket.name}/`;
      const fotos=snap.data().fotos||[];
      await Promise.all(fotos.filter(url=>url.startsWith(prefixo)).map(url=>bucket.file(url.slice(prefixo.length)).delete().catch(()=>{})));
      await ref.delete();
    }
    return;
  }
  const existenteSnap=await ref.get();
  const existente=existenteSnap.exists?existenteSnap.data():null;
  const camposBloqueados=existente?.camposBloqueados||[];

  const dados={};
  Object.entries(MAPA_CAMPOS).forEach(([origem,destino])=>{
    if(!camposBloqueados.includes(destino)&&depois[origem]!==undefined)dados[destino]=depois[origem];
  });
  dados.origemEstoquePrincipal=true;
  dados.sincronizadoEstoqueEm=new Date().toISOString();

  if(!existente){
    // Veiculo novo: comeca visivel, sem foto (site mostra "Em preparacao"
    // sozinho), nenhum campo travado ainda.
    dados.oculto=false;
    dados.fotos=[];
    dados.opcionais=[];
    dados.camposBloqueados=[];
    dados.fotosBloqueadas=false;
  }
  await ref.set(dados,{merge:true});
});
