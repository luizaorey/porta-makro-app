import { derivar, CFG_PADRAO, textoComando, horaCurta, proximaExecucao, rotuloDias, resumoSemana, horaRotulo, diaLocal, isoDow, NOMES_DIA, CURTO_DIA } from './logic.js';
import { criarSimulacao } from './backend-sim.js';

const $ = id => document.getElementById(id);
const CONFIG = window.PORTA_CONFIG || {};
const nuvemConfigurada = !!(CONFIG.supabaseUrl && CONFIG.anonKey);
const salvar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const ler = k => { try { return localStorage.getItem(k); } catch { return null; } };

export const VERSAO_APP = 'v9';
let backend = null;
let snap = null;            // último retorno do backend
let offsetRelogio = 0;      // relógio do servidor - relógio do aparelho
let falhaRede = false;
let pendente = null;        // comando enviado aguardando confirmação do ESP32
let msgRetorno = { texto: '', erro: false, ate: 0 };
let timerPoll = null;

const agora = () => Date.now() + offsetRelogio;
const NOMES = { abrir: 'abertura', parar: 'parada', fechar: 'fechamento' };

// ---------- início ----------
async function iniciar() {
  const forcaSim = new URLSearchParams(location.search).has('sim');
  let modo = forcaSim ? 'sim' : ler('modo') || (nuvemConfigurada ? 'real' : 'sim');
  if (modo === 'real' && !nuvemConfigurada) modo = 'sim';
  if (modo === 'sim') return entrarSimulacao();
  try {
    const { criarNuvem } = await import('./backend-cloud.js');
    backend = await criarNuvem(CONFIG);
    const perfil = await backend.sessao();
    if (perfil) return abrirApp(); else mostrarLogin();
  } catch (e) {
    mostrarLogin(); $('erroLogin').textContent = 'Não foi possível falar com a nuvem. ' + e.message;
  }
}
function mostrarLogin() { $('login').hidden = false; $('app').hidden = true; }
function entrarSimulacao() { backend = criarSimulacao(); salvar('modo', 'sim'); abrirApp(); }

function abrirApp() {
  $('login').hidden = true; $('app').hidden = false;
  const sim = backend.modo === 'simulacao';
  $('faixaSim').hidden = !sim; $('blocoSim').hidden = !sim;
  $('menuUsuario').textContent = (sim ? 'Modo simulação.' : `Conectado como ${backend.usuario().nome}.`) + ` Versão do app: ${VERSAO_APP}.`;
  $('btnTrocarModo').textContent = sim ? (nuvemConfigurada ? 'Usar a porta real' : '') : 'Ir para simulação';
  $('btnTrocarModo').hidden = sim && !nuvemConfigurada;
  $('btnSair').hidden = sim;
  if (sim) {
    backend.onChegada(e => notificarLocal(e));
    ligarBancada();
  }
  atualizarBotaoPush();
  poll();
}

// ---------- ciclo de leitura ----------
async function poll() {
  clearTimeout(timerPoll);
  if (!backend || $('app').hidden) return;     // ainda na tela de login
  try {
    snap = await backend.snapshot();
    offsetRelogio = snap.agora - Date.now();
    falhaRede = false;
    conferirComando();
  } catch (e) { falhaRede = true; }
  render();
  timerPoll = setTimeout(poll, document.hidden ? 4000 : backend.modo === 'simulacao' ? 500 : 1500);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

// ---------- comandos ----------
document.querySelectorAll('button[data-cmd]').forEach(b => b.addEventListener('click', () => enviar(b.dataset.cmd)));
async function enviar(acao) {
  if (navigator.vibrate) navigator.vibrate(30);
  retorno('Enviando comando…');
  try {
    const c = await backend.comando(acao);
    pendente = { id: c.id, acao, desde: Date.now() };
    poll();
  } catch (e) {
    pendente = null;
    retorno(e.message === 'sem_comunicacao' ? 'Sem comunicação com a porta. O comando não foi enviado.' : 'Não foi possível enviar: ' + e.message, true, 8000);
  }
}
function conferirComando() {
  if (!pendente || !snap) return;
  const c = snap.cmds.find(x => x.id === pendente.id);
  if (c && c.status === 'executado') { retorno(textoComando(pendente.acao), false, 6000); pendente = null; }
  else if (c && c.status === 'expirado') { retorno('O comando não chegou à porta. Tente de novo.', true, 8000); pendente = null; }
  else if (Date.now() - pendente.desde > 12000) { retorno('Sem confirmação da porta. Verifique antes de tentar de novo.', true, 8000); pendente = null; }
}
function retorno(texto, erro = false, duracao = 0) { msgRetorno = { texto, erro, ate: duracao ? Date.now() + duracao : 0 }; render(); }

// ---------- desenho ----------
// Só a lâmina se move: sobe e some atrás da caixa ao abrir, desce ao fechar. Caixa e guias ficam fixas.
const ALTURA_VAO = 192;
function desenharPorta(pct, { naoConfirmado = false, desconhecida = false } = {}) {
  const p = pct == null ? 0 : pct;
  $('lamina').setAttribute('transform', `translate(0 ${(-(p / 100) * ALTURA_VAO).toFixed(2)})`);
  $('porta').classList.toggle('nao-confirmado', naoConfirmado || desconhecida);
  $('porta').classList.toggle('desconhecida', desconhecida);
}

let ultimaKey = '';
function render() {
  if (!snap) { $('conTxt').textContent = falhaRede ? 'Sem internet' : 'Conectando…'; return; }
  const cfg = { ...CFG_PADRAO, ...snap.cfg };
  const t = agora();
  const v = derivar(snap.est, cfg, t);
  const semSinal = v.comunicacao === 'sem_comunicacao';
  const sem = semSinal || falhaRede;
  const u = snap.est.ultimo;

  // --- desenho ---
  let pct = v.pct, naoConf = v.estimado || !!v.aviso;
  if (semSinal) { pct = u ? (u.pos === 'aberta' ? 100 : 0) : 0; naoConf = true; }   // última posição confirmada, esmaecida
  desenharPorta(pct, { naoConfirmado: naoConf, desconhecida: semSinal || v.posicao === 'falha' || (pct == null) });

  // --- selo sob a porta: confirmado x estimado ---
  const selo = $('selo');
  selo.className = 'selo';
  if (semSinal) $('pctTxt').textContent = '';
  else if (v.posicao === 'falha') $('pctTxt').textContent = 'Leitura inválida';
  else if (v.estimado) { selo.classList.add('estimado'); $('pctTxt').textContent = `≈ ${Math.round(pct)}% aberta · estimado`; }
  else if (pct == null) { selo.classList.add('estimado'); $('pctTxt').textContent = 'Posição desconhecida · sem estimativa'; }
  else $('pctTxt').textContent = '';            // confirmado: o texto "Confirmada pelo sensor" já aparece abaixo

  // --- textos: "aberta/fechada" só com o fim de curso ---
  let rotulo, classe = '', sub = '';
  if (semSinal) {
    rotulo = 'Posição desconhecida';
    sub = u ? `Última confirmação · ${u.pos === 'aberta' ? 'Aberta' : 'Fechada'} às ${horaCurta(u.em)}` : 'Ainda sem confirmação';
  } else if (v.posicao === 'falha') {
    rotulo = 'Falha nos sensores'; classe = 'erro'; sub = 'Os dois fins de curso estão ativos ao mesmo tempo';
  } else if (v.movimento) {
    rotulo = v.movimento === 'abrindo' ? 'Abrindo' : 'Fechando'; sub = 'Movimento estimado · aguardando o sensor';
  } else if (v.posicao === 'entre') {
    rotulo = 'Entre os limites';
    sub = v.estimado ? 'Parada · posição estimada, sem confirmação do sensor' : 'Movimento externo ou desconhecido';
  } else {
    rotulo = v.rotulo; sub = 'Confirmada pelo sensor';
  }
  $('rotulo').textContent = rotulo; $('rotulo').className = 'rotulo ' + classe;
  $('sub').textContent = sub;
  $('aviso').hidden = !v.aviso || semSinal; $('aviso').textContent = v.aviso || '';

  // --- conexão e comandos ---
  $('ponto').className = 'ponto ' + (sem ? 'off' : 'on');
  $('conTxt').textContent = falhaRede ? 'Sem internet no celular' : semSinal ? 'Sem comunicação' : 'Conectada';
  $('atualizadoTxt').textContent = snap.est.visto ? '· ' + horaComSegundos(snap.est.visto) : '';
  document.querySelectorAll('button[data-cmd]').forEach(b => { b.disabled = sem; });

  if (msgRetorno.ate && Date.now() > msgRetorno.ate) msgRetorno = { texto: '', erro: false, ate: 0 };
  const nota = $('nota');
  if (msgRetorno.texto) { nota.textContent = msgRetorno.texto; nota.className = 'nota' + (msgRetorno.erro ? ' erro' : ''); }
  else { nota.textContent = sem ? 'Comandos disponíveis ao reconectar.' : ''; nota.className = 'nota'; }

  // --- atividade (só redesenha se mudou) + ponto vermelho em Alertas ---
  const key = snap.eventos.map(e => e.id).join(',');
  if (key !== ultimaKey) { ultimaKey = key; desenharHistorico(snap.eventos); }
  const visto = +(ler('alertaVisto') || 0);
  $('pontoAlerta').hidden = !snap.eventos.some(e => e.tipo === 'agenda_falha' && e.id > visto);

  renderAgenda(t);
  agendarQuadro(!!v.movimento);   // animação suave só enquanto há movimento
}
function horaComSegundos(ms) {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/Bahia' }).format(new Date(ms));
}
let rafId = 0;
function agendarQuadro(mover) {
  if (!mover) { cancelAnimationFrame(rafId); rafId = 0; return; }
  if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; render(); });
}
setInterval(() => { if (snap && !document.hidden) render(); }, 1000);

function desenharHistorico(evs) {
  const ul = $('historico'); ul.textContent = '';
  if (!evs.length) { const li = document.createElement('li'); li.className = 'vazio'; li.textContent = 'Sem eventos ainda.'; ul.append(li); return; }
  for (const e of evs.slice(0, 20)) {
    const li = document.createElement('li');
    const w = document.createElement('div'); w.className = 'quando';
    const a = document.createElement('div'); a.className = 'o-que';
    const q = document.createElement('div'); q.className = 'quem';
    const origemTxt = e.origem === 'agenda' ? 'Agenda semanal' : e.origem === 'app' ? `Comando de ${e.usuario}` : 'Acionamento externo';
    if (e.tipo === 'chegada_aberta') { a.textContent = 'Abertura confirmada'; q.textContent = origemTxt; }
    else if (e.tipo === 'chegada_fechada') { a.textContent = 'Fechamento confirmado'; q.textContent = origemTxt; }
    else if (e.tipo === 'comando') { a.textContent = e.msg; q.textContent = e.origem === 'agenda' ? 'Agenda semanal' : `Enviado por ${e.usuario}`; }
    else if (e.tipo === 'agenda_falha') { li.classList.add('alerta-ag'); a.textContent = e.msg; q.textContent = 'Agenda semanal'; }
    else if (e.tipo === 'agenda_info') { a.textContent = e.msg; }
    else { a.textContent = e.msg || e.tipo; }
    const dia = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Bahia' }).format(new Date(e.em));
    const hoje = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Bahia' }).format(new Date());
    w.textContent = horaCurta(e.em) + (dia === hoje ? '' : ' · ' + dia);
    li.append(w, a); if (q.textContent) li.append(q);
    ul.append(li);
  }
}

// ---------- notificações ----------
function notificarLocal(e) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const txt = e.tipo === 'chegada_aberta' ? `A porta abriu completamente às ${horaCurta(e.em)}.` : `A porta fechou completamente às ${horaCurta(e.em)}.`;
  new Notification('Makro Boutique', { body: txt, tag: 'porta-' + e.tipo });
}
async function atualizarBotaoPush() {
  const b = $('btnPush'), m = $('pushMsg');
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const instalado = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!('Notification' in window)) { b.hidden = true; m.textContent = ios && !instalado ? 'No iPhone: toque em Compartilhar › Adicionar à Tela de Início e abra pelo ícone para ativar notificações.' : 'Este navegador não suporta notificações.'; return; }
  if (backend.modo === 'real' && !backend.pushSuportado()) { b.hidden = true; m.textContent = 'No iPhone: toque em Compartilhar › Adicionar à Tela de Início e abra pelo ícone para ativar notificações.'; return; }
  b.hidden = false;
  const ativo = backend.modo === 'real' ? await backend.pushAtivo() : Notification.permission === 'granted';
  b.textContent = ativo ? 'Notificações ativas — enviar teste' : 'Ativar notificações';
  m.textContent = backend.modo === 'simulacao' ? 'Na simulação o aviso aparece só com o app aberto. O envio com app fechado vale no modo real.' : '';
}
$('btnPush').addEventListener('click', async () => {
  try {
    if (backend.modo === 'real') {
      if (await backend.pushAtivo()) { await backend.testarPush(); $('pushMsg').textContent = 'Teste enviado. Feche o app e aguarde a notificação.'; }
      else { await backend.ativarPush(); $('pushMsg').textContent = 'Notificações ativadas neste aparelho.'; }
    } else {
      const p = await Notification.requestPermission();
      $('pushMsg').textContent = p === 'granted' ? 'Alertas locais ativados.' : 'Permissão negada.';
    }
  } catch (e) { $('pushMsg').textContent = e.message; }
  atualizarBotaoPush();
});

// ---------- bancada (simulação) ----------
function ligarBancada() {
  const bn = backend.bancada;
  const sync = () => { const d = bn.estado(); $('simAuto').checked = d.auto; $('simAberto').checked = d.aberto; $('simFechado').checked = d.fechado; $('simOffline').checked = !d.online; $('simAberto').disabled = $('simFechado').disabled = false; };
  $('simAuto').onchange = e => { bn.setAuto(e.target.checked); sync(); };
  $('simAberto').onchange = e => { bn.setSensor('aberto', e.target.checked); sync(); };
  $('simFechado').onchange = e => { bn.setSensor('fechado', e.target.checked); sync(); };
  $('simOffline').onchange = e => bn.setOnline(!e.target.checked);
  $('simReiniciar').onclick = () => bn.reiniciar();
  $('simAvancar').onclick = () => { const p = bn.avancarAteProxima(); $('simRelogio').textContent = p ? `Relógio avançado: faltam 5 s para ${acaoNome(p.acao)} às ${horaRotulo(p.regra.hora)}.` : 'Não há regra ativa (e agenda ligada) para avançar.'; };
  document.querySelectorAll('[data-ext]').forEach(b => b.onclick = () => bn.externo(b.dataset.ext));
  sync(); setInterval(sync, 700);
}


// ---------- agenda semanal ----------
const ehAdmin = () => backend.modo === 'simulacao' || backend.usuario()?.papel === 'admin';
const acaoNome = a => (a === 'abrir' ? 'Abrir' : 'Fechar');
let agKey = '';
function renderAgenda(t) {
  const regras = snap.agenda || [], cfgA = snap.agendaCfg || { habilitada: false, fecharLiberado: false };
  const adm = ehAdmin();

  // próxima execução (recalcula todo render, é barato)
  const p = cfgA.habilitada ? proximaExecucao(regras, t) : null;
  let txt;
  if (!regras.length) txt = 'Nenhuma regra ainda.';
  else if (!cfgA.habilitada) txt = 'Agenda desligada — nenhuma regra é executada.';
  else if (!p) txt = 'Nenhuma regra ativa.';
  else {
    const dd = diaLocal(p.em) - diaLocal(t);
    const quando = dd === 0 ? 'hoje' : dd === 1 ? 'amanhã' : NOMES_DIA[isoDow(diaLocal(p.em))].toLowerCase();
    txt = `Próxima: ${quando} às ${horaCurta(p.em)} — ${acaoNome(p.acao)}`;
  }
  $('agProxima').textContent = txt;

  const temFechar = regras.some(r => r.ativa && r.acao === 'fechar');
  const aviso = $('agAviso');
  if (cfgA.habilitada && temFechar && !cfgA.fecharLiberado) { aviso.hidden = false; aviso.textContent = 'Fechamento automático ainda bloqueado: as regras de Fechar não serão enviadas até você liberar.'; }
  else aviso.hidden = true;

  const hoje = isoDow(diaLocal(t));
  const key = JSON.stringify([regras, cfgA, adm, hoje]);
  if (key === agKey) return;
  agKey = key;

  // grade da semana
  const grade = $('agGrade'); grade.textContent = '';
  for (const d of resumoSemana(regras)) {
    const row = document.createElement('div'); row.className = 'ag-dia' + (d.dia === hoje ? ' hoje' : '');
    const b = document.createElement('b'); b.textContent = CURTO_DIA[d.dia];
    const it = document.createElement('div'); it.className = 'itens';
    if (!d.itens.length) { const v = document.createElement('span'); v.className = 'vazio'; v.textContent = 'sem regra'; it.append(v); }
    for (const i of d.itens) {
      const c = document.createElement('span'); c.className = `ag-item ${i.acao}${i.ativa ? '' : ' pausada'}`;
      c.textContent = `${i.acao === 'abrir' ? '↑' : '↓'} ${horaRotulo(i.hora)}`; it.append(c);
    }
    row.append(b, it); grade.append(row);
  }

  // travas
  $('agLigada').checked = cfgA.habilitada; $('agFechar').checked = cfgA.fecharLiberado;
  $('agLigada').disabled = $('agFechar').disabled = !adm;

  // lista de regras: horário grande; toque abre a edição
  const ul = $('agLista'); ul.textContent = '';
  if (!regras.length) { const v = document.createElement('li'); v.className = 'ag-vazio'; v.style.cursor = 'default'; v.textContent = adm ? 'Nenhuma regra. Toque em + para criar.' : 'Nenhuma regra.'; ul.append(v); }
  for (const r of regras) {
    const li = document.createElement('li'); if (!r.ativa) li.className = 'pausada';
    const hora = document.createElement('div'); hora.className = 'hora'; hora.textContent = r.hora;
    const desc = document.createElement('div'); desc.className = 'desc';
    const ac = document.createElement('b'); ac.className = r.acao; ac.textContent = (r.acao === 'abrir' ? '↑ ' : '↓ ') + acaoNome(r.acao);
    desc.append(ac, ` · ${rotuloDias(r.dias)}${r.ativa ? '' : ' · pausada'}`);
    li.append(hora, desc);
    if (adm) {
      li.onclick = () => abrirRegra(r);
      const lab = document.createElement('label'); lab.className = 'troca'; lab.onclick = ev => ev.stopPropagation();
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = r.ativa; inp.setAttribute('aria-label', r.ativa ? 'Pausar regra' : 'Ativar regra');
      inp.onchange = () => agAcao(() => backend.agendaAtivar(r.id, inp.checked));
      lab.append(inp, document.createElement('i')); li.append(lab);
      const ac2 = document.createElement('div'); ac2.className = 'acoes'; ac2.onclick = ev => ev.stopPropagation();
      const ed = document.createElement('button'); ed.className = 'mini'; ed.textContent = '✎ Editar'; ed.onclick = () => abrirRegra(r);
      const ex = document.createElement('button'); ex.className = 'mini excluir'; ex.textContent = '🗑 Excluir';
      ex.onclick = () => { if (confirm(`Excluir a regra das ${r.hora} (${acaoNome(r.acao)}, ${rotuloDias(r.dias)})?`)) agAcao(() => backend.agendaExcluir(r.id)); };
      ac2.append(ed, ex); li.append(ac2);
    }
    ul.append(li);
  }
  $('agNova').hidden = !adm; $('agSomenteLeitura').hidden = adm;
}
async function agAcao(fn) {
  try { await fn(); agKey = ''; await poll(); }
  catch (e) { retorno('Agenda: ' + textoErroAgenda(e.message), true, 7000); agKey = ''; poll(); }
}
function textoErroAgenda(m) {
  if (m.startsWith('conflito:')) {
    const [, acao, dias] = m.split(':');
    return `já existe uma regra de ${acaoNome(acao)} em ${rotuloDias(dias.split(',').map(Number))} nesse horário. Escolha outro horário ou outros dias.`;
  }
  return { sem_permissao: 'só administradores editam a agenda.', hora_invalida: 'horário inválido.', dias_invalidos: 'escolha pelo menos um dia.' }[m] || m;
}

// tela de edição da regra (tela cheia, com roda de horário)
let editando = null, hSel = 8, mSel = 0, diasSel = [1, 2, 3, 4, 5], acaoSel = 'abrir';
const pad2 = n => String(n).padStart(2, '0');
const ALT = 44;
function montarRoda(el, n, aoMudar) {
  el.textContent = '';
  for (let i = 0; i < n; i++) {
    const it = document.createElement('div'); it.className = 'item'; it.textContent = pad2(i); it.setAttribute('role', 'option');
    it.onclick = () => el.scrollTo({ top: i * ALT, behavior: 'smooth' });
    el.append(it);
  }
  let t;
  const ler = () => { const v = Math.min(n - 1, Math.max(0, Math.round(el.scrollTop / ALT))); [...el.children].forEach((c, i) => c.classList.toggle('sel', i === v)); aoMudar(v); };
  el.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(ler, 70); });
  el.irPara = v => { el.scrollTop = v * ALT; [...el.children].forEach((c, i) => c.classList.toggle('sel', i === v)); };
}
montarRoda($('rodaH'), 24, v => { hSel = v; });
montarRoda($('rodaM'), 60, v => { mSel = v; });

const chips = $('chipsDias');
CURTO_DIA.forEach((nome, i) => {
  if (!i) return;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = nome; b.dataset.dia = i; b.setAttribute('aria-pressed', 'false');
  b.onclick = () => { diasSel = diasSel.includes(i) ? diasSel.filter(d => d !== i) : [...diasSel, i]; pintar(); };
  chips.append(b);
});
function pintar() {
  chips.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-pressed', String(diasSel.includes(+b.dataset.dia))));
  $('valRepetir').textContent = diasSel.length ? rotuloDias(diasSel) : 'Escolha os dias';
  document.querySelectorAll('#segAcao .seg-btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.acao === acaoSel)));
  $('valAcao').textContent = acaoNome(acaoSel);
}
document.querySelectorAll('#segAcao .seg-btn').forEach(b => b.onclick = () => { acaoSel = b.dataset.acao; pintar(); });
document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { diasSel = { util: [1, 2, 3, 4, 5], todos: [1, 2, 3, 4, 5, 6, 7], fim: [6, 7] }[b.dataset.preset]; pintar(); });
const alterna = (linha, caixa) => { const abre = $(caixa).hidden; $(caixa).hidden = !abre; $(linha).setAttribute('aria-expanded', String(abre)); };
$('linhaRepetir').onclick = () => alterna('linhaRepetir', 'boxDias');
$('linhaAcao').onclick = () => alterna('linhaAcao', 'boxAcao');

function abrirRegra(r) {
  editando = r || null; $('regraErro').textContent = '';
  $('painelFechar').hidden = true;
  $('dlgRegraTitulo').textContent = r ? 'Editar regra' : 'Nova regra';
  const [hh, mm] = (r ? r.hora : '08:00').split(':').map(Number); hSel = hh; mSel = mm;
  diasSel = r ? [...r.dias] : [1, 2, 3, 4, 5]; acaoSel = r ? r.acao : 'abrir';
  $('boxDias').hidden = !!r === false ? true : true; $('linhaRepetir').setAttribute('aria-expanded', 'false');
  $('boxAcao').hidden = false; $('linhaAcao').setAttribute('aria-expanded', 'true');
  $('regraExcluir').hidden = !r;
  pintar();
  $('telaRegra').hidden = false; document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => { $('rodaH').irPara(hSel); $('rodaM').irPara(mSel); });
}
function fecharRegra() { $('telaRegra').hidden = true; document.body.style.overflow = ''; }
$('agNova').onclick = () => abrirRegra(null);
$('regraCancelar').onclick = fecharRegra;
$('regraSalvar').onclick = async () => {
  if (!diasSel.length) { $('regraErro').textContent = 'Escolha pelo menos um dia em "Repetir".'; $('boxDias').hidden = false; $('linhaRepetir').setAttribute('aria-expanded', 'true'); return; }
  $('regraSalvar').disabled = true;
  try {
    await backend.agendaSalvar({ id: editando?.id, acao: acaoSel, dias: diasSel, hora: `${pad2(hSel)}:${pad2(mSel)}`, ativa: editando ? editando.ativa : true });
    fecharRegra(); agKey = ''; poll();
  } catch (e) { $('regraErro').textContent = textoErroAgenda(e.message).replace(/^./, c => c.toUpperCase()); }
  $('regraSalvar').disabled = false;
};
$('regraExcluir').onclick = () => {
  if (!editando || !confirm(`Excluir a regra das ${editando.hora}?`)) return;
  const id = editando.id; fecharRegra(); agAcao(() => backend.agendaExcluir(id));
};

// travas
$('agLigada').onchange = e => agAcao(() => backend.agendaConfig({ habilitada: e.target.checked }));
$('agFechar').onchange = e => {
  if (!e.target.checked) { agAcao(() => backend.agendaConfig({ fecharLiberado: false })); return; }
  e.target.checked = false;                       // só marca depois da confirmação
  $('chkObstaculo').checked = $('chkParada').checked = false; $('fecharConfirmar').disabled = true;
  $('painelFechar').hidden = false;
  $('painelFechar').scrollIntoView({ behavior: 'smooth', block: 'center' });
};
const confere = () => { $('fecharConfirmar').disabled = !($('chkObstaculo').checked && $('chkParada').checked); };
$('chkObstaculo').onchange = $('chkParada').onchange = confere;
$('fecharCancelar').onclick = () => { $('painelFechar').hidden = true; };
$('fecharConfirmar').onclick = () => { $('painelFechar').hidden = true; agAcao(() => backend.agendaConfig({ fecharLiberado: true })); };

// ---------- login / menu ----------
$('formLogin').addEventListener('submit', async ev => {
  ev.preventDefault(); $('erroLogin').textContent = '';
  try { await backend.entrar($('email').value.trim(), $('senha').value); $('senha').value = ''; abrirApp(); }
  catch (e) { $('erroLogin').textContent = e.message; }
});
$('irSim').addEventListener('click', entrarSimulacao);
// ---------- folhas (Agenda, Alertas, Ajustes) ----------
function abrirFolha(id) {
  document.querySelectorAll('.folha').forEach(f => { f.hidden = f.id !== id; });
  document.body.style.overflow = 'hidden';
  if (id === 'folhaAlertas' && snap) { const m = Math.max(0, ...snap.eventos.map(e => e.id)); salvar('alertaVisto', String(m)); $('pontoAlerta').hidden = true; }
  agKey = ''; if (snap) renderAgenda(agora());
}
function fecharFolhas() { document.querySelectorAll('.folha').forEach(f => { f.hidden = true; }); document.body.style.overflow = ''; }
document.querySelectorAll('[data-voltar]').forEach(b => b.addEventListener('click', fecharFolhas));
$('btnAgenda').addEventListener('click', () => abrirFolha('folhaAgenda'));
$('btnAlertas').addEventListener('click', () => abrirFolha('folhaAlertas'));
$('btnMenu').addEventListener('click', () => {
  const c = { ...CFG_PADRAO, ...(snap?.cfg || {}) };
  $('cfgAbrir').value = c.tempo_abrir_s; $('cfgFechar').value = c.tempo_fechar_s; $('cfgPulso').value = c.pulso_ms;
  abrirFolha('folhaAjustes');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('telaRegra').hidden) fecharFolhas(); });
$('cfgSalvar').addEventListener('click', async () => {
  try {
    await backend.configurar({ tempo_abrir_s: +$('cfgAbrir').value, tempo_fechar_s: +$('cfgFechar').value, pulso_ms: +$('cfgPulso').value });
    poll(); fecharFolhas();
  } catch (e) { retorno('Não foi possível salvar: ' + e.message, true, 6000); }
});
$('btnSair').addEventListener('click', async () => { await backend.sair(); location.reload(); });
$('btnTrocarModo').addEventListener('click', () => {
  salvar('modo', backend.modo === 'simulacao' ? 'real' : 'sim'); location.search = ''; location.reload();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
  let recarregou = false;   // quando uma versão nova do app assume, recarrega uma vez para não ficar misturando arquivos velhos e novos
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (recarregou || !navigator.serviceWorker.controller) return; recarregou = true; location.reload(); });
}
iniciar();
