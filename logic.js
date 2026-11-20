// Lógica pura da porta: posição a partir dos sensores, estimativa de movimento e textos.
// Sem DOM e sem rede, para ser testada no Node (tests/) e usada pelo app.

export const CFG_PADRAO = {
  tempo_abrir_s: 15,
  tempo_fechar_s: 15,
  pulso_ms: 500,
  offline_apos_s: 8,    // sem sinal do ESP32 por mais que isso = "Sem comunicação"
  folga_sensor_s: 3,    // tempo que o sensor leva para soltar ao sair de um extremo
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Posição física lida pelos dois fins de curso.
export function posicaoDosSensores(aberto, fechado) {
  if (aberto && fechado) return 'falha';
  if (aberto) return 'aberta';
  if (fechado) return 'fechada';
  return 'entre';
}

// Abertura estimada (0 = fechada, 100 = aberta) a partir do último ponto conhecido.
// pct_base null = posição desconhecida (ex.: alguém parou a porta pelo controle).
export function pctEstimado(est, cfg, agoraMs) {
  if (est.pct_base == null) return null;
  if (!est.mov_dir) return est.pct_base;
  const tempo = (est.mov_dir === 'abrindo' ? cfg.tempo_abrir_s : cfg.tempo_fechar_s) * 1000;
  const frac = (agoraMs - est.mov_inicio) / tempo;
  const delta = frac * 100 * (est.mov_dir === 'abrindo' ? 1 : -1);
  return clamp(est.pct_base + delta, 0, 100);
}

// Quanto falta (ms) para o tempo previsto de percurso acabar.
export function fimPrevistoMs(est, cfg) {
  if (!est.mov_dir) return null;
  const tempo = (est.mov_dir === 'abrindo' ? cfg.tempo_abrir_s : cfg.tempo_fechar_s) * 1000;
  if (est.pct_base == null) return est.mov_inicio + tempo;
  const resta = est.mov_dir === 'abrindo' ? (100 - est.pct_base) / 100 : est.pct_base / 100;
  return est.mov_inicio + resta * tempo;
}

// Modelo de tela. est vem do servidor (ou da simulação); agoraMs já corrigido pelo relógio do servidor.
export function derivar(est, cfg, agoraMs) {
  const semSinal = est.visto == null || agoraMs - est.visto > cfg.offline_apos_s * 1000;
  const v = {
    comunicacao: semSinal ? 'sem_comunicacao' : 'ok',
    posicao: 'desconhecida',
    rotulo: 'Posição atual desconhecida',
    pct: null,
    estimado: false,
    movimento: null,
    aviso: null,
    ultimo: est.ultimo || null,
  };
  if (semSinal) return v;

  const fisica = posicaoDosSensores(est.aberto, est.fechado);
  v.posicao = fisica;

  if (fisica === 'falha') {
    v.rotulo = 'Falha nos sensores';
    return v;
  }

  // Saindo de um extremo: o sensor ainda pode estar ativo por instantes.
  const saindoDoLimite =
    est.mov_dir &&
    ((fisica === 'aberta' && est.mov_dir === 'fechando') || (fisica === 'fechada' && est.mov_dir === 'abrindo')) &&
    agoraMs - est.mov_inicio < cfg.folga_sensor_s * 1000;

  if (fisica === 'aberta' && !saindoDoLimite) { v.rotulo = 'Porta aberta'; v.pct = 100; return v; }
  if (fisica === 'fechada' && !saindoDoLimite) { v.rotulo = 'Porta fechada'; v.pct = 0; return v; }

  // Entre os limites (ou saindo de um): o movimento exibido é estimativa.
  v.posicao = 'entre';
  v.rotulo = 'Entre os limites';
  const pct = pctEstimado(est, cfg, agoraMs);
  v.pct = pct;
  v.estimado = pct != null;
  if (est.mov_dir) {
    v.movimento = est.mov_dir;
    if (agoraMs >= fimPrevistoMs(est, cfg)) {
      v.aviso = est.mov_dir === 'abrindo' ? 'Abertura sem confirmação' : 'Fechamento sem confirmação';
      v.movimento = null; // o tempo acabou; posição segue não confirmada
    }
  }
  return v;
}

export function textoComando(acao) {
  return { abrir: 'Comando de abertura recebido', parar: 'Comando de parada recebido', fechar: 'Comando de fechamento recebido' }[acao];
}

export function horaCurta(ms, tz = 'America/Bahia') {
  const p = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).formatToParts(new Date(ms));
  const h = p.find(x => x.type === 'hour').value;
  const m = p.find(x => x.type === 'minute').value;
  return `${h}h${m}`;
}

export function textoChegada(tipo, ms, tz) {
  return tipo === 'chegada_aberta'
    ? `A porta abriu completamente às ${horaCurta(ms, tz)}.`
    : `A porta fechou completamente às ${horaCurta(ms, tz)}.`;
}

// ---------- Agenda semanal ----------
// Horário da loja: Candeias/BA = America/Bahia, UTC-3 o ano todo (sem horário de verão desde 2019).
export const FUSO_OFFSET_MS = -3 * 3600e3;
export const NOMES_DIA = ['', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];   // ISO: 1=segunda … 7=domingo
export const CURTO_DIA = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

export const diaLocal = ms => Math.floor((ms + FUSO_OFFSET_MS) / 864e5);        // nº do dia local desde 1970
export const isoDow = dia => { const d = new Date(dia * 864e5).getUTCDay(); return d === 0 ? 7 : d; };
export const dataDe = dia => new Date(dia * 864e5).toISOString().slice(0, 10);
export const instanteDe = (dia, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return dia * 864e5 + (h * 60 + m) * 6e4 - FUSO_OFFSET_MS; };
export const horaRotulo = hhmm => hhmm.replace(':', 'h');                         // 08:00 -> 08h00

export function proximaExecucao(regras, agoraMs) {
  let melhor = null; const hoje = diaLocal(agoraMs);
  for (let i = 0; i <= 7; i++) {
    const dia = hoje + i, dow = isoDow(dia);
    for (const r of regras) {
      if (!r.ativa || !r.dias.includes(dow)) continue;
      const inst = instanteDe(dia, r.hora);
      if (inst > agoraMs && (!melhor || inst < melhor.em)) melhor = { em: inst, acao: r.acao, regra: r };
    }
  }
  return melhor;
}

export function rotuloDias(dias) {
  const d = [...new Set(dias)].sort((a, b) => a - b), k = d.join(',');
  if (k === '1,2,3,4,5,6,7') return 'Todos os dias';
  if (k === '1,2,3,4,5') return 'Segunda a sexta';
  if (k === '6,7') return 'Sábado e domingo';
  const partes = []; let i = 0;
  while (i < d.length) {
    let j = i; while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
    partes.push(j - i >= 2 ? `${CURTO_DIA[d[i]]} a ${CURTO_DIA[d[j]]}` : d.slice(i, j + 1).map(x => CURTO_DIA[x]).join(', '));
    i = j + 1;
  }
  return partes.join(', ');
}

// Resumo por dia: [{dia:1, itens:[{hora, acao, ativa}]}] — para a grade da semana.
export function resumoSemana(regras) {
  return [1, 2, 3, 4, 5, 6, 7].map(dia => ({
    dia,
    itens: regras.filter(r => r.dias.includes(dia)).map(r => ({ hora: r.hora, acao: r.acao, ativa: r.ativa, id: r.id })).sort((a, b) => a.hora.localeCompare(b.hora)),
  }));
}
