const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* 07/10/2026, pedido da Aline: medir quanto o vendedor demora pra responder
   depois que a Eva passa o lead. O CRM novo ja grava "dd/mm/aaaa HH:MM" em
   cada entrada do historico, mas vendedor com a aba aberta ha dias (ou o CRM
   embutido no sistema da Marcela, que so' atualiza quando ela troca o
   arquivo) ainda roda a versao antiga, que grava so' a data - e ai o
   cronometro "apos a anterior" some. Esta funcao carimba a hora no servidor,
   logo depois da gravacao, em toda entrada NOVA que chegar so' com data.

   Cuidados:
   - So' mexe em entrada nova (que nao estava no "antes"). Entradas antigas
     sem hora continuam sem hora: nao existe hora real pra elas.
   - So' carimba se a data da entrada for hoje (nunca inventa hora de
     lancamento retroativo).
   - Cliente antigo regrava o historico inteiro a partir da copia dele, que
     pode "desfazer" um carimbo ja feito; nesse caso a hora anterior e'
     restaurada (a mesma entrada, no mesmo indice, com a mesma data).
   - A gravacao e' numa transacao, aplicada sobre o documento ATUAL, pra nao
     apagar uma entrada que outro usuario gravou no meio tempo.
   - Depois de carimbada, nenhuma entrada precisa de nova alteracao, entao a
     propria gravacao desta funcao nao dispara outra rodada. */
const TEM_HORA = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/;

function agoraBR(){
  const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date()).map(x=>[x.type,x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour==='24'?'00':p.hour}:${p.minute}`;
}
const mesmaEntrada = (a,b) => !!a && !!b && a.acao === b.acao && (a.obs||'') === (b.obs||'') && a.by === b.by;

exports.carimbarHorarioHistorico = onDocumentWritten({region:'southamerica-east1',document:'leads/{leadId}'}, async (event) => {
  const depoisSnap = event.data && event.data.after;
  if(!depoisSnap || !depoisSnap.exists) return;
  const depois = depoisSnap.data();
  const hDepois = Array.isArray(depois.historico) ? depois.historico : [];
  if(!hDepois.length) return;
  const antesSnap = event.data.before;
  const hAntes = antesSnap && antesSnap.exists && Array.isArray(antesSnap.data().historico) ? antesSnap.data().historico : [];

  const agora = agoraBR();
  // indice -> nova data/hora, so' pro que precisa mudar
  const ajustes = {};
  hDepois.forEach((h,i) => {
    if(!h || typeof h.dt !== 'string' || TEM_HORA.test(h.dt)) return;
    const antes = hAntes[i];
    if(mesmaEntrada(antes, h)){
      // ja existia: so' restaura se o "antes" tinha hora do mesmo dia (carimbo desfeito por cliente antigo)
      if(typeof antes.dt === 'string' && TEM_HORA.test(antes.dt) && antes.dt.slice(0,10) === h.dt.slice(0,10)) ajustes[i] = antes.dt;
      return;
    }
    if(h.dt.slice(0,10) === agora.slice(0,10)) ajustes[i] = agora;
  });
  if(!Object.keys(ajustes).length) return;

  const ref = depoisSnap.ref;
  await db.runTransaction(async (t) => {
    const atual = await t.get(ref);
    if(!atual.exists) return;
    const hAtual = Array.isArray(atual.data().historico) ? atual.data().historico : [];
    let mudou = false;
    const novo = hAtual.map((h,i) => {
      const ref0 = hDepois[i];
      // so' mexe se a entrada atual ainda e' exatamente a que o evento viu
      if(ajustes[i] && h && ref0 && h.dt === ref0.dt && mesmaEntrada(h, ref0)){ mudou = true; return {...h, dt: ajustes[i]}; }
      return h;
    });
    if(mudou) t.update(ref, {historico: novo});
  });
});
