const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Aviso de "carro pronto pra FOTO" (15/10/2026, pedido urgente da Aline):
   quando um veiculo entra na coluna "Fotos" da Preparacao Show Room do
   sistema principal, manda um WhatsApp pra Aline - sem ela precisar ficar
   olhando a tela.

   Mesma regra do quadro do sistema principal (avEstagioPipeline, index.html
   da Marcela): esta' em "Fotos" quem tem preEstoque, nao e' semNegocio, ja'
   concluiu a Lavacao Detalhada e ainda nao concluiu as Fotos.

   Nao manda WhatsApp daqui: grava em mensagens_avulsas e a Eva (servidor
   eva-whatsapp) entrega no proximo ciclo, igual aos outros avisos. O
   destino "Aline" precisa existir no WHATSAPP_VENDEDORES do .env da Eva.
   So' avisa na ENTRADA na etapa (antes nao estava em Fotos, agora esta') -
   editar a avaliacao enquanto ela ja esta' em Fotos nao repete o aviso. */
function emFotos(av){
  if(!av||av.semNegocio||!av.preEstoque)return false;
  const pe=av.preEstoque;
  return pe.lavacao?.status==='concluida'&&pe.fotos?.status!=='concluida';
}

exports.avisoCarroParaFoto=onDocumentWritten({region:'southamerica-east1',document:'avaliacoes/{avId}'},async(event)=>{
  const antes=event.data?.before?.exists?event.data.before.data():null;
  const depois=event.data?.after?.exists?event.data.after.data():null;
  if(!emFotos(depois)||emFotos(antes))return;
  const v=depois.veiculo||{};
  const carro=[v.mk,v.mo].filter(Boolean).join(' ')||'Veículo';
  const placa=v.pl?` — placa ${String(v.pl).toUpperCase()}`:'';
  const quem=depois.preEstoque?.lavacao?.responsavel?` (lavação por ${depois.preEstoque.lavacao.responsavel})`:'';
  await db.collection('mensagens_avulsas').add({
    destino:'Aline',
    texto:`📷 Carro pronto para FOTO: ${carro}${placa}${quem}. Já está na coluna "Fotos" da Preparação Show Room.`,
    enviadaEm:'',
    criadaEm:new Date().toISOString(),
    origem:'avisoCarroParaFoto',
    avId:event.params.avId,
  });
});
