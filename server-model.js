// Modelo do "servidor": o que a nuvem faz com o que o ESP32 reporta.
// É a especificação executável das regras. O modo simulação do app usa este módulo,
// e supabase/migrations/001_porta.sql implementa as MESMAS regras em plpgsql.
import { CFG_PADRAO, posicaoDosSensores, pctEstimado } from './logic.js';

export const REGRAS = {
  expira_cmd_s: 10,     // comando que não foi entregue em 10 s morre
  lacuna_s: 20,         // ESP32 sumiu por mais que isso = ressincroniza sem anunciar
  janela_origem_extra_s: 5,
  min_entre_chegadas_s: 5,
};

export function novoServidor(cfg = {}) {
  return {
    cfg: { ...CFG_PADRAO, ...cfg },
    est: { aberto: false, fechado: true, visto: null, pct_base: 0, mov_dir: null, mov_inicio: null, ultimo: null },
    cmds: [], eventos: [], prox: 1,
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
    evento(S, 'comando', agora, { origem: 'app', usuario: c.usuario, msg: { abrir: 'Comando de abertura recebido', parar: 'Comando de parada recebido', fechar: 'Comando de fechamento recebido' }[c.acao], acao: c.acao });
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
          origem = 'app'; usuario = ultMov.usuario; ultMov.consumido = true;
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

  // 3) entrega: expira velhos, devolve pendentes (parar primeiro)
  for (const c of S.cmds) if (c.status === 'pendente' && c.expira <= agora) c.status = 'expirado';
  const pend = S.cmds.filter(c => c.status === 'pendente').sort((a, b) => (a.acao === 'parar' ? -1 : 0) - (b.acao === 'parar' ? -1 : 0) || a.id - b.id);
  for (const c of pend) c.status = 'entregue';
  return pend.map(c => ({ id: c.id, acao: c.acao }));
}
