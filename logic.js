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
