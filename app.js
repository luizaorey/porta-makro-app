import { derivar, CFG_PADRAO, textoComando, horaCurta } from './logic.js';
import { criarSimulacao } from './backend-sim.js';

const $ = id => document.getElementById(id);
const CONFIG = window.PORTA_CONFIG || {};
const nuvemConfigurada = !!(CONFIG.supabaseUrl && CONFIG.anonKey);
const salvar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const ler = k => { try { return localStorage.getItem(k); } catch { return null; } };

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
  $('menuUsuario').textContent = sim ? 'Modo simulação.' : `Conectado como ${backend.usuario().nome}.`;
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
const ALTURA_VAO = 146, TOPO_VAO = 74;
function desenharPorta(pct, naoConfirmado) {
  const p = pct == null ? 0 : pct;   // desconhecida: lâmina esmaecida, com "?"
  const h = Math.max(0, (1 - p / 100) * ALTURA_VAO);
  $('lamina').setAttribute('height', h);
  $('barra').setAttribute('y', TOPO_VAO + h - 8);
  $('barra').style.display = h < 2 ? 'none' : '';
  $('porta').classList.toggle('nao-confirmado', naoConfirmado || pct == null);
  $('interrog').hidden = pct != null;
}

let ultimaKey = '';
function render() {
  if (!snap) { $('conTxt').textContent = falhaRede ? 'Sem internet' : 'Conectando…'; return; }
  const cfg = { ...CFG_PADRAO, ...snap.cfg };
  const t = agora();
  const v = derivar(snap.est, cfg, t);
  const sem = v.comunicacao === 'sem_comunicacao' || falhaRede;
  const u = snap.est.ultimo;

  // porta
  let pct = v.pct, naoConf = v.estimado || !!v.aviso;
  if (v.comunicacao === 'sem_comunicacao') { pct = null; naoConf = true; }   // sem sinal: posição desconhecida, "?"
  desenharPorta(pct, naoConf);
  if (v.comunicacao === 'sem_comunicacao') $('pctTxt').textContent = '';
  else if (v.posicao === 'falha') $('pctTxt').textContent = 'Leitura inválida';
  else if (pct == null) $('pctTxt').textContent = 'Posição desconhecida (sem percentual)';
  else if (v.estimado) $('pctTxt').textContent = `≈ ${Math.round(pct)}% aberta — estimado, não confirmado`;
  else $('pctTxt').textContent = `${Math.round(pct)}% aberta — confirmado pelo sensor`;

  // estado
  const semSinal = v.comunicacao === 'sem_comunicacao';
  $('rotulo').textContent = semSinal ? 'Posição desconhecida' : v.rotulo;
  $('rotulo').className = 'rotulo ' + (v.posicao === 'falha' && !semSinal ? 'erro' : v.posicao === 'entre' && !semSinal ? 'alerta' : 'ok');
  let sub = '';
  if (semSinal) sub = u ? `Última confirmação · ${u.pos === 'aberta' ? 'Aberta' : 'Fechada'} às ${horaCurta(u.em)}` : 'Sem confirmação anterior';
  else if (v.movimento) sub = (v.movimento === 'abrindo' ? 'Abrindo' : 'Fechando') + ' — movimento estimado';
  else if (v.posicao === 'entre' && v.estimado) sub = 'Parada — posição estimada, sem confirmação do sensor';
  else if (v.posicao === 'entre') sub = 'Movimento externo ou desconhecido';
  else if (v.posicao === 'falha') sub = 'Os dois fins de curso estão ativos ao mesmo tempo';
  else sub = 'Confirmado pelo sensor';
  $('sub').textContent = sub;
  $('aviso').hidden = !v.aviso || semSinal; $('aviso').textContent = v.aviso || '';

  // conexão + comandos
  $('ponto').className = 'ponto ' + (sem ? 'off' : 'on');
  $('conTxt').textContent = falhaRede ? 'Sem internet no celular' : semSinal ? 'Sem comunicação' : 'Conectado ao ESP32';
  $('atualizadoTxt').textContent = snap.est.visto ? 'Última atualização ' + horaComSegundos(snap.est.visto) : 'Sem atualização ainda';
  document.querySelectorAll('button[data-cmd]').forEach(b => { b.disabled = sem; });

  if (msgRetorno.ate && Date.now() > msgRetorno.ate) msgRetorno = { texto: '', erro: false, ate: 0 };
  const nota = $('nota');
  if (msgRetorno.texto) { nota.textContent = msgRetorno.texto; nota.className = 'nota' + (msgRetorno.erro ? ' erro' : ''); }
  else { nota.textContent = sem ? 'Comandos disponíveis ao reconectar.' : ''; nota.className = 'nota'; }

  // atividade (só redesenha se mudou)
  const key = snap.eventos.map(e => e.id).join(',');
  if (key !== ultimaKey) { ultimaKey = key; desenharHistorico(snap.eventos); }

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
    if (e.tipo === 'chegada_aberta') { a.textContent = 'Abertura confirmada'; q.textContent = e.origem === 'app' ? `Comando de ${e.usuario}` : 'Acionamento externo'; }
    else if (e.tipo === 'chegada_fechada') { a.textContent = 'Fechamento confirmado'; q.textContent = e.origem === 'app' ? `Comando de ${e.usuario}` : 'Acionamento externo'; }
    else if (e.tipo === 'comando') { a.textContent = e.msg; q.textContent = `Enviado por ${e.usuario}`; }
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
  document.querySelectorAll('[data-ext]').forEach(b => b.onclick = () => bn.externo(b.dataset.ext));
  sync(); setInterval(sync, 700);
}

// ---------- login / menu ----------
$('formLogin').addEventListener('submit', async ev => {
  ev.preventDefault(); $('erroLogin').textContent = '';
  try { await backend.entrar($('email').value.trim(), $('senha').value); $('senha').value = ''; abrirApp(); }
  catch (e) { $('erroLogin').textContent = e.message; }
});
$('irSim').addEventListener('click', entrarSimulacao);
$('btnMenu').addEventListener('click', () => {
  const c = { ...CFG_PADRAO, ...(snap?.cfg || {}) };
  $('cfgAbrir').value = c.tempo_abrir_s; $('cfgFechar').value = c.tempo_fechar_s; $('cfgPulso').value = c.pulso_ms;
  $('menu').showModal();
});
$('cfgSalvar').addEventListener('click', async () => {
  try {
    await backend.configurar({ tempo_abrir_s: +$('cfgAbrir').value, tempo_fechar_s: +$('cfgFechar').value, pulso_ms: +$('cfgPulso').value });
    poll();
  } catch (e) { retorno('Não foi possível salvar: ' + e.message, true, 6000); }
});
$('btnSair').addEventListener('click', async () => { await backend.sair(); $('menu').close(); location.reload(); });
$('btnTrocarModo').addEventListener('click', () => {
  salvar('modo', backend.modo === 'simulacao' ? 'real' : 'sim'); location.search = ''; location.reload();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
iniciar();
