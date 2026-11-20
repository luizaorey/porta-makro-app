// Modelo do "servidor": o que a nuvem faz com o que o ESP32 reporta.
// É a especificação executável das regras. O modo simulação do app usa este módulo,
// e supabase/migrations/001_porta.sql implementa as MESMAS regras em plpgsql.
import { CFG_PADRAO, posicaoDosSensores, pctEstimado, diaLocal, isoDow, instanteDe, dataDe, horaRotulo } from './logic.js';

export const REGRAS = {
  expira_cmd_s: 10,     // comando que não foi entregue em 10 s morre
  lacuna_s: 20,         // ESP32 sumiu por mais que isso = ressincroniza sem anunciar
  janela_origem_extra_s: 5,
  min_entre_chegadas_s: 5,
  agenda_janela_s: 15,   // a agenda só dispara até 15 s depois do horário; passou disso, descarta e registra
};

export function novoServidor(cfg = {}) {
  return {
    cfg: { ...CFG_PADRAO, ...cfg },
    est: { aberto: false, fechado: true, visto: null, pct_base: 0, mov_dir: null, mov_inicio: null, ultimo: null },
    cmds: [], eventos: [], prox: 1,
    agenda: [], proxAg: 1, execAg: {},
    agendaCfg: { habilitada: false, fecharLiberado: false },   // dois cadeados, ambos desligados de fábrica
  };
}

const evento = (S, tipo, agora, extra = {}) => {
  const e = { id: S.eventos.length + 1, tipo, em: agora, origem: null, usuario: null, msg: null, ...extra };
  S.eventos.push(e);
  return e;
};

// App -> nuvem. Recusa se o ESP32 está sem sinal (não enfileira comando que chegaria atrasado).
export function enviarComando(S, acao, usuario, agora) {
  if (!['abrir', 'parar', 'fechar'].includes(acao)) throw new Error('acao_invalida');
  if (S.est.visto == null || agora - S.est.visto > S.cfg.offline_apos_s * 1000) throw new Error('sem_comunicacao');
  const c = { id: S.prox++, acao, usuario, criado: agora, expira: agora + REGRAS.expira_cmd_s * 1000, status: 'pendente', executado: null };
  S.cmds.push(c);
  return c;
}

function inicioMovimento(S, dir, sens, agora) {
  const pos = posicaoDosSensores(sens.aberto, sens.fechado);
  if ((dir === 'abrindo' && pos === 'aberta') || (dir === 'fechando' && pos === 'fechada')) return; // já no extremo
  const pct = pos === 'aberta' ? 100 : pos === 'fechada' ? 0 : pctEstimado(S.est, S.cfg, agora);
  S.est.pct_base = pct; S.est.mov_dir = dir; S.est.mov_inicio = agora;
}

// ESP32 -> nuvem, a cada ~1 s. Devolve os comandos que o ESP32 deve executar agora.
export function sincronizarDispositivo(S, { aberto, fechado, boot = false, ack = [] }, agora) {
  const prev = S.est;
  const posAnt = prev.visto == null ? null : posicaoDosSensores(prev.aberto, prev.fechado);
  const ressinc = boot || prev.visto == null || agora - prev.visto > REGRAS.lacuna_s * 1000;
  if (prev.visto != null && agora - prev.visto > S.cfg.offline_apos_s * 1000) {
    evento(S, 'conexao', agora, { msg: 'Comunicação com a porta restabelecida.' });
  }

  // 1) confirmações de comandos executados
  const sens = { aberto, fechado };
  for (const id of ack) {
    const c = S.cmds.find(x => x.id === id);
    if (!c || c.status === 'executado') continue;
    c.status = 'executado'; c.executado = agora;
    if (c.acao === 'abrir') inicioMovimento(S, 'abrindo', sens, agora);
    else if (c.acao === 'fechar') inicioMovimento(S, 'fechando', sens, agora);
    else { prev.pct_base = pctEstimado(prev, S.cfg, agora); prev.mov_dir = null; prev.mov_inicio = null; }
    evento(S, 'comando', agora, { origem: c.origem || 'app', usuario: c.usuario, msg: { abrir: 'Comando de abertura recebido', parar: 'Comando de parada recebido', fechar: 'Comando de fechamento recebido' }[c.acao], acao: c.acao });
  }

  // 2) leitura dos sensores
  const pos = posicaoDosSensores(aberto, fechado);
  prev.aberto = aberto; prev.fechado = fechado; prev.visto = agora;
  if (pos === 'aberta' || pos === 'fechada') { prev.ultimo = { pos, em: agora }; }

  if (!ressinc && posAnt !== pos) {
    if (pos === 'aberta' || pos === 'fechada') {
      const tipo = pos === 'aberta' ? 'chegada_aberta' : 'chegada_fechada';
      const ult = [...S.eventos].reverse().find(e => e.tipo === tipo);
      if (!ult || agora - ult.em >= REGRAS.min_entre_chegadas_s * 1000) {
        // quem causou? último abrir/fechar executado na direção certa, sem parar depois, dentro da janela
        const dir = pos === 'aberta' ? 'abrir' : 'fechar';
        const tempo = (pos === 'aberta' ? S.cfg.tempo_abrir_s : S.cfg.tempo_fechar_s) * 1000;
        const exec = S.cmds.filter(c => c.status === 'executado' && !c.consumido);
        const ultMov = [...exec].reverse().find(c => c.acao !== 'parar');
        const parouDepois = ultMov && exec.some(c => c.acao === 'parar' && c.executado > ultMov.executado);
        let origem = 'externo', usuario = null;
        if (ultMov && ultMov.acao === dir && !parouDepois && agora - ultMov.executado <= tempo * 1.5 + REGRAS.janela_origem_extra_s * 1000) {
          origem = ultMov.origem === 'agenda' ? 'agenda' : 'app'; usuario = ultMov.usuario; ultMov.consumido = true;
        }
        evento(S, tipo, agora, { origem, usuario, msg: origem === 'externo' ? 'Acionamento externo' : null });
      }
    } else if (pos === 'falha') {
      evento(S, 'falha_sensores', agora, { msg: 'Falha nos sensores: os dois fins de curso ativos.' });
    }
  }
  // sensor prevalece
  if (pos === 'aberta') { prev.pct_base = 100; prev.mov_dir = null; }
  else if (pos === 'fechada') { prev.pct_base = 0; prev.mov_dir = null; }
  else if (posAnt && (posAnt === 'aberta' || posAnt === 'fechada') && !prev.mov_dir) {
    prev.pct_base = null; // saiu de um extremo sem comando nosso: movimento desconhecido
  }

  agendaTick(S, agora, true);

  // 3) entrega: expira velhos, devolve pendentes (parar primeiro)
  for (const c of S.cmds) if (c.status === 'pendente' && c.expira <= agora) c.status = 'expirado';
  const pend = S.cmds.filter(c => c.status === 'pendente').sort((a, b) => (a.acao === 'parar' ? -1 : 0) - (b.acao === 'parar' ? -1 : 0) || a.id - b.id);
  for (const c of pend) c.status = 'entregue';
  return pend.map(c => ({ id: c.id, acao: c.acao }));
}


// ---------- Agenda semanal ----------
const HORA_OK = /^([01]\d|2[0-3]):[0-5]\d$/;

export function agendaSalvar(S, r, agora) {
  if (!['abrir', 'fechar'].includes(r.acao)) throw new Error('acao_invalida');
  const dias = [...new Set(r.dias || [])].sort((a, b) => a - b);
  if (!dias.length || dias.some(d => !(d >= 1 && d <= 7))) throw new Error('dias_invalidos');
  if (!HORA_OK.test(r.hora || '')) throw new Error('hora_invalida');
  // mesmo dia + mesmo horário em outra regra (Abrir ou Fechar, ativa ou pausada) = conflito
  for (const o of S.agenda) {
    if (o.id === r.id || o.hora !== r.hora) continue;
    const inter = o.dias.filter(d => dias.includes(d));
    if (inter.length) throw new Error(`conflito:${o.acao}:${inter.join(',')}`);
  }
  if (r.id) {
    const o = S.agenda.find(x => x.id === r.id); if (!o) throw new Error('nao_encontrada');
    Object.assign(o, { acao: r.acao, dias, hora: r.hora, ativa: r.ativa ?? o.ativa, atualizado: agora });
    return o.id;
  }
  const n = { id: S.proxAg++, acao: r.acao, dias, hora: r.hora, ativa: r.ativa ?? true, atualizado: agora };
  S.agenda.push(n); return n.id;
}
export function agendaAtivar(S, id, ativa, agora) {
  const o = S.agenda.find(x => x.id === id); if (!o) throw new Error('nao_encontrada');
  o.ativa = !!ativa; o.atualizado = agora;   // reativar não "recupera" horários que passaram enquanto pausada
}
export function agendaExcluir(S, id) { S.agenda = S.agenda.filter(x => x.id !== id); }
export function agendaConfigurar(S, { habilitada, fecharLiberado }) {
  if (habilitada !== undefined) S.agendaCfg.habilitada = !!habilitada;
  if (fecharLiberado !== undefined) S.agendaCfg.fecharLiberado = !!fecharLiberado;
}

// Roda a cada sincronização do ESP32 e a cada leitura do app. online=false quando o ESP32 está sem sinal.
export function agendaTick(S, agora, online) {
  const hoje = diaLocal(agora);
  for (const r of S.agenda) {
    if (!r.ativa) continue;
    for (const dia of [hoje - 1, hoje]) {
      if (!r.dias.includes(isoDow(dia))) continue;
      const inst = instanteDe(dia, r.hora);
      if (inst > agora || inst <= r.atualizado) continue;            // futuro, ou regra editada depois do horário
      const chave = `${r.id}|${dataDe(dia)}`;
      if (S.execAg[chave]) continue;
      const nome = r.acao === 'abrir' ? 'Abertura' : 'Fechamento';
      if (!S.agendaCfg.habilitada) { S.execAg[chave] = 'ignorado'; continue; }
      if (r.acao === 'fechar' && !S.agendaCfg.fecharLiberado) {
        S.execAg[chave] = 'bloqueado';
        evento(S, 'agenda_falha', agora, { origem: 'agenda', usuario: 'Agenda semanal', msg: `Fechamento automático ainda não liberado: o fechamento das ${horaRotulo(r.hora)} não foi enviado.` });
        continue;
      }
      if (agora - inst <= REGRAS.agenda_janela_s * 1000) {
        if (!online) continue;                                         // ainda dentro da janela: espera o ESP32 voltar
        S.execAg[chave] = 'disparado';
        S.cmds.push({ id: S.prox++, acao: r.acao, usuario: 'Agenda semanal', origem: 'agenda', criado: agora, expira: agora + REGRAS.expira_cmd_s * 1000, status: 'pendente', executado: null });
      } else {
        S.execAg[chave] = 'perdido';
        evento(S, 'agenda_falha', agora, { origem: 'agenda', usuario: 'Agenda semanal', msg: `${nome} das ${horaRotulo(r.hora)} não foi enviado: sem comunicação com a porta. Comando descartado.` });
      }
    }
  }
}
export function lerComTick(S, agora) {
  const online = S.est.visto != null && agora - S.est.visto <= S.cfg.offline_apos_s * 1000;
  agendaTick(S, agora, online);
}
