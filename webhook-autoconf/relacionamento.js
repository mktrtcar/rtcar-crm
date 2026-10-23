const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const db = admin.firestore();

/* Relacionamento automatico (23/10/2026, regras combinadas com a Aline):
   1) Termo de Venda APROVADO no sistema principal (rtcar/termos, T[].st ===
      'approved') -> cliente entra sozinho na coluna "7 dias" do Relacionamento
      (clientes_rel). Repasse nao entra; Compra nao entra (fica em outra lista,
      G.TC). A Milena e' quem arrasta pra "90 dias" depois - aqui nada mexe nela.
   2) Todo dia 1o do mes: quem comprou naquele mes 1 ano antes entra em "1 ano"
      e 2 anos antes em "2 anos". Fontes: historico do Sances (vendas_historico,
      importado uma vez pelo CRM) + termos aprovados do sistema principal.
   Regra de duplicado: telefone que ja existe no Relacionamento com o MESMO
   carro (placa) -> o card anda pra coluna nova (1 ano -> 2 anos), sem criar
   outro; telefone que ja existe com OUTRO carro (ou sem placa pra comparar) ->
   nao cria, entra na lista de "possiveis duplicados" que vai pra Aline no
   WhatsApp (pela Eva, mensagens_avulsas). */

const COLUNA_DE={um:'d1ano',dois:'d2anos'};
function tel8(t){return String(t||'').replace(/\D/g,'').slice(-8);}
function placaNorm(p){return String(p||'').toUpperCase().replace(/[^A-Z0-9]/g,'');}
function brParaISO(d){const m=String(d||'').match(/(\d{2})\/(\d{2})\/(\d{4})/);return m?`${m[3]}-${m[2]}-${m[1]}`:'';}
function primeiroNome(n){const p=String(n||'').trim().split(/\s+/)[0]||'';return p?p.charAt(0).toUpperCase()+p.slice(1).toLowerCase():'';}
function ehRepasse(t){return t.tp==='VENDA REPASSE'||t.flagVenda==='repasse';}
function agoraBR(){return new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).replace(',','');}
function nomeVendedor(t,usuarios){
  if(t.vndNome&&String(t.vndNome).trim())return primeiroNome(t.vndNome);
  const lg=(t.lg&&t.lg[0]&&t.lg[0].a)||'';const i=lg.indexOf('Vendedor: ');if(i>-1)return primeiroNome(lg.slice(i+10));
  const id=t.vndId||t.cr;const u=(usuarios||[]).find(x=>String(x.id)===String(id));return u?primeiroNome(u.n):'';
}
function veiculoDoTermo(t){
  const v=(t.sv||[])[0]||{};
  return{desc:[v.mk,v.mo].filter(Boolean).join(' ')||v.m||'',placa:placaNorm(v.pl)};
}
async function proximoRelId(){
  const ref=db.collection('rel_config').doc('seq');
  return db.runTransaction(async tx=>{const s=await tx.get(ref);const seq=((s.exists&&s.data().relSeq)||0)+1;tx.set(ref,{relSeq:seq},{merge:true});return`REL-${String(seq).padStart(3,'0')}`;});
}
async function criarCliente(dados){
  const id=await proximoRelId();
  await db.collection('clientes_rel').doc(id).set({id,historico:[{dt:agoraBR(),acao:'📋 Cliente cadastrado automaticamente',obs:dados._origemTexto||'',by:'Sistema',icone:'📋'}],...Object.fromEntries(Object.entries(dados).filter(([k])=>!k.startsWith('_')))});
  return id;
}
async function avisarAline(texto){
  await db.collection('mensagens_avulsas').add({destino:'Aline',texto,enviadaEm:'',criadaEm:new Date().toISOString(),origem:'relacionamento'});
}

/* 1) Termo aprovado -> "7 dias" */
exports.relacionamentoTermoAprovado=onDocumentWritten({region:'southamerica-east1',document:'rtcar/termos'},async(event)=>{
  const antes=event.data?.before?.exists?(event.data.before.data().T||[]):[];
  const depois=event.data?.after?.exists?(event.data.after.data().T||[]):[];
  const stAntes=new Map(antes.map(t=>[t.id,t.st]));
  const novos=depois.filter(t=>t&&t.st==='approved'&&stAntes.get(t.id)!=='approved'&&!ehRepasse(t));
  if(!novos.length)return;
  const dados=await db.collection('rtcar').doc('dados').get();const usuarios=dados.exists?(dados.data().U||[]):[];
  const clientes=(await db.collection('clientes_rel').get()).docs.map(d=>({_id:d.id,...d.data()}));
  for(const t of novos){
    if(clientes.some(c=>c.termoId===t.id))continue; // ja criado antes (trigger repetido)
    const v=veiculoDoTermo(t);const k=tel8(t.ph);
    const existente=k&&clientes.find(c=>tel8(c.clienteTel)===k&&c.st!=='perdido');
    if(existente){
      await avisarAline(`🔁 Relacionamento — possível duplicado: o termo ${t.id} (${t.by||'sem nome'}, ${v.desc}${v.placa?' '+v.placa:''}) foi aprovado, mas o telefone já é do cliente ${existente._id} (${existente.clienteNome||''}, na coluna ${existente.st}). Não criei outro card — confira se é o mesmo cliente com um carro novo.`);
      continue;
    }
    const vend=nomeVendedor(t,usuarios);
    const id=await criarCliente({clienteNome:t.by||'',clienteTel:t.ph||'',clienteEmail:t.em||'',dtNascimento:'',veiculo:[v.desc,v.placa].filter(Boolean).join(' - '),placa:v.placa,responsavel:vend,by:vend,dtCompra:brParaISO(t.dt)||new Date().toISOString().slice(0,10),st:'d7',obs:'',valor:'',termoId:t.id,origemAuto:'termo',_origemTexto:`Termo de Venda ${t.id} aprovado no sistema principal`});
    clientes.push({_id:id,clienteTel:t.ph,termoId:t.id,st:'d7'});
    console.log(`Relacionamento: ${t.id} -> ${id} (7 dias)`);
  }
});

/* 2) Todo dia 1o: 1 ano e 2 anos */
function mesAlvo(base,anosAtras){const d=new Date(Date.UTC(base.getUTCFullYear()-anosAtras,base.getUTCMonth(),1));return d.toISOString().slice(0,7);}
async function vendasDoMes(mes,termos,usuarios){
  const lista=[];
  const hist=await db.collection('vendas_historico').where('mes','==',mes).get();
  hist.forEach(d=>{const h=d.data();lista.push({fonte:'Sances',ref:d.id,nome:h.cliente,tel:h.telefone,veiculo:[h.modelo,h.placa].filter(Boolean).join(' - '),placa:placaNorm(h.placa),dtCompra:h.dataVenda,vendedor:primeiroNome(h.vendedor)});});
  termos.filter(t=>t.st==='approved'&&!ehRepasse(t)&&brParaISO(t.dt).startsWith(mes)).forEach(t=>{const v=veiculoDoTermo(t);lista.push({fonte:'Termo',ref:t.id,nome:t.by,tel:t.ph,veiculo:[v.desc,v.placa].filter(Boolean).join(' - '),placa:v.placa,dtCompra:brParaISO(t.dt),vendedor:nomeVendedor(t,usuarios)});});
  // mesma venda nas duas fontes (Sances e app rodaram juntos um tempo): fica uma so'
  const vistos=new Set();return lista.filter(x=>{const k=x.placa?('P'+x.placa):(tel8(x.tel)?'T'+tel8(x.tel)+x.dtCompra:'R'+x.ref);if(vistos.has(k))return false;vistos.add(k);return true;});
}
async function executarMensal(base,{simular=false}={}){
  const termosDoc=await db.collection('rtcar').doc('termos').get();const termos=termosDoc.exists?(termosDoc.data().T||[]):[];
  const dados=await db.collection('rtcar').doc('dados').get();const usuarios=dados.exists?(dados.data().U||[]):[];
  const clientes=(await db.collection('clientes_rel').get()).docs.map(d=>({_id:d.id,...d.data()}));
  const rel={criados:[],movidos:[],duplicados:[],semTelefone:[]};
  for(const [qual,anos] of [['um',1],['dois',2]]){
    const mes=mesAlvo(base,anos);const coluna=COLUNA_DE[qual];
    for(const v of await vendasDoMes(mes,termos,usuarios)){
      const k=tel8(v.tel);
      const doMesmoCarro=clientes.find(c=>(v.placa&&placaNorm(c.placa||c.veiculo).includes(v.placa))||(c.historicoRef&&c.historicoRef===v.ref)||(c.termoId&&c.termoId===v.ref));
      if(doMesmoCarro){
        if(doMesmoCarro.st===coluna||(coluna==='d1ano'&&['d1ano','avaliacao1ano'].includes(doMesmoCarro.st))||(coluna==='d2anos'&&['d2anos','avaliacao2anos','d2anos_agendado'].includes(doMesmoCarro.st)))continue;
        rel.movidos.push(`${doMesmoCarro._id} ${doMesmoCarro.clienteNome||v.nome} → ${anos} ano(s)`);
        if(!simular){const ref=db.collection('clientes_rel').doc(doMesmoCarro._id);const h=[...(doMesmoCarro.historico||[]),{dt:agoraBR(),acao:`📅 Completou ${anos} ano(s) da compra — movido para "${anos===1?'1 ano':'2 anos'}"`,obs:'',by:'Sistema',icone:'📅'}];await ref.update({st:coluna,historico:h});}
        doMesmoCarro.st=coluna;continue;
      }
      const mesmoTel=k&&clientes.find(c=>tel8(c.clienteTel)===k);
      if(mesmoTel){rel.duplicados.push(`${v.nome||'(sem nome)'} ${v.tel} — ${v.veiculo} (${v.fonte} ${v.ref}) × já existe ${mesmoTel._id} ${mesmoTel.clienteNome||''} (${mesmoTel.st})`);continue;}
      if(!k)rel.semTelefone.push(`${v.nome} — ${v.veiculo}`);
      rel.criados.push(`${v.nome} — ${v.veiculo} → ${anos} ano(s)`);
      if(!simular){
        const id=await criarCliente({clienteNome:v.nome||'',clienteTel:v.tel||'',clienteEmail:'',dtNascimento:'',veiculo:v.veiculo,placa:v.placa,responsavel:v.vendedor,by:v.vendedor,dtCompra:v.dtCompra,st:coluna,obs:k?'':'Sem telefone no cadastro original — procurar contato.',valor:'',historicoRef:v.ref,origemAuto:'mensal',_origemTexto:`Entrada automática de ${anos} ano(s) — compra de ${v.dtCompra} (${v.fonte})`});
        clientes.push({_id:id,clienteTel:v.tel,placa:v.placa,historicoRef:v.ref,st:coluna,clienteNome:v.nome});
      }else clientes.push({_id:'(novo)',clienteTel:v.tel,placa:v.placa,historicoRef:v.ref,st:coluna,clienteNome:v.nome});
    }
  }
  return rel;
}
exports.relacionamentoMensal=onSchedule({region:'southamerica-east1',schedule:'0 7 1 * *',timeZone:'America/Sao_Paulo',timeoutSeconds:540,memory:'512MiB'},async()=>{
  const base=new Date();const chave=base.toISOString().slice(0,7);
  const reg=db.collection('rel_config').doc('execucao_'+chave);
  if((await reg.get()).exists){console.log('Relacionamento mensal ja rodou em',chave);return;}
  const r=await executarMensal(base);
  await reg.set({em:new Date().toISOString(),criados:r.criados.length,movidos:r.movidos.length,duplicados:r.duplicados,semTelefone:r.semTelefone});
  let texto=`📅 Relacionamento — entrada automática de ${chave}:\n• ${r.criados.length} cliente(s) novo(s) em 1 ano / 2 anos\n• ${r.movidos.length} card(s) movido(s)\n• ${r.semTelefone.length} sem telefone (procurar contato)`;
  if(r.duplicados.length)texto+=`\n\n🔁 Possíveis duplicados (NÃO entraram — confira se é o mesmo cliente):\n`+r.duplicados.slice(0,25).map(x=>'• '+x).join('\n')+(r.duplicados.length>25?`\n…e mais ${r.duplicados.length-25}`:'');
  // Lembrete combinado com a Aline: a partir de agosto/2027 os clientes que
  // entraram em "7 dias" pelo termo aprovado comecam a completar 1 ano.
  if(chave>='2027-07')texto+=`\n\n⚠️ Pendência: a partir de agosto/2027 os clientes que entraram em "7 dias" começam a completar 1 ano — combinar com o Claude como evitar duplicar na entrada de "1 ano".`;
  await avisarAline(texto);
});
/* Simulacao (sem gravar nada) - pra conferir antes do dia 1o. So' gestao. */
const EMAILS_GESTOR=['contato@rtcar.com.br','marcela@rtcar.com.br','rafael@rtcar.com.br','milena@rtcar.com.br'];
exports.relacionamentoMensalSimular=onRequest({region:'southamerica-east1',cors:true,timeoutSeconds:300},async(req,res)=>{
  try{
    const tok=(req.headers.authorization||'').replace('Bearer ','');const dec=await admin.auth().verifyIdToken(tok);
    if(!EMAILS_GESTOR.includes(String(dec.email||'').toLowerCase())){res.status(403).json({erro:'sem permissão'});return;}
    const mes=String(req.query.mes||'');const base=/^\d{4}-\d{2}$/.test(mes)?new Date(mes+'-01T12:00:00Z'):new Date();
    res.json(await executarMensal(base,{simular:true}));
  }catch(e){res.status(401).json({erro:String(e.message||e)});}
});
