// Modo simulação: a nuvem (server-model.js) e um ESP32 + porta virtuais rodando no próprio navegador.
// Serve para demonstrar o ciclo completo antes de ligar qualquer saída à porta real.
import { novoServidor, enviarComando, sincronizarDispositivo } from './server-model.js';

export function criarSimulacao() {
  const S = novoServidor();
  const dev = {
    online: true,
    auto: true,              // sensores seguem a porta virtual; desligado = você aciona os sensores à mão (bancada)
    aberto: false, fechado: true,
    pct: 0, dir: null,       // porta virtual (0 fechada .. 100 aberta)
    ack: [], boot: true,
    ultimoPulso: null,
  };
  const ouvintes = new Set();
  const avisar = e => ouvintes.forEach(f => f(e));
  let vistos = 0;

  function fisica(dt) {
    if (!dev.auto || !dev.dir) return;
    const tempo = dev.dir === 'up' ? S.cfg.tempo_abrir_s : S.cfg.tempo_fechar_s;
    dev.pct = Math.min(100, Math.max(0, dev.pct + (dev.dir === 'up' ? 1 : -1) * (dt / tempo) * 100));
    if (dev.pct >= 100 || dev.pct <= 0) dev.dir = null;
  }
  function lerSensores() {
    if (dev.auto) { dev.aberto = dev.pct >= 100; dev.fechado = dev.pct <= 0; }
  }
  function pulso(acao) {          // equivalente a apertar e soltar a botoeira
    if (acao === 'parar') dev.dir = null;
    else if (acao === 'abrir') dev.dir = 'up';
    else if (acao === 'fechar') dev.dir = 'down';
  }

  function ciclo() {
    if (!dev.online) return;
    lerSensores();
    const cmds = sincronizarDispositivo(S, { aberto: dev.aberto, fechado: dev.fechado, boot: dev.boot, ack: dev.ack }, Date.now());
    dev.boot = false; dev.ack = [];
    cmds.forEach(c => { pulso(c.acao); dev.ack.push(c.id); });
    if (dev.ack.length) setTimeout(ciclo, S.cfg.pulso_ms + 100); // confirma logo após o pulso
    notificarNovos();
  }
  function notificarNovos() {
    while (vistos < S.eventos.length) {
      const e = S.eventos[vistos++];
      if (e.tipo === 'chegada_aberta' || e.tipo === 'chegada_fechada') avisar(e);
    }
  }
  let ultimo = Date.now();
  setInterval(() => { const n = Date.now(); fisica((n - ultimo) / 1000); ultimo = n; }, 100);
  setInterval(ciclo, 1000);
  ciclo();

  return {
    modo: 'simulacao',
    usuario: () => ({ nome: 'Você (simulação)' }),
    async snapshot() {
      return {
        agora: Date.now(),
        est: { ...S.est },
        cfg: S.cfg,
        eventos: S.eventos.slice(-40).reverse().map(e => ({ ...e })),
        cmds: S.cmds.slice(-8).map(c => ({ ...c })),
      };
    },
    async comando(acao) { return enviarComando(S, acao, 'Você (simulação)', Date.now()); },
    configurar(parcial) { Object.assign(S.cfg, parcial); },
    onChegada(f) { ouvintes.add(f); return () => ouvintes.delete(f); },
    // --- controles de bancada (só existem na simulação) ---
    bancada: {
      estado: () => ({ ...dev }),
      setAuto(v) { dev.auto = v; if (v) { dev.pct = dev.aberto ? 100 : dev.fechado ? 0 : dev.pct; } },
      setSensor(qual, v) { dev.auto = false; dev[qual] = v; },
      externo(acao) { pulso(acao); },   // controle sem fio / botoeira da loja
      setOnline(v) { dev.online = v; if (v) dev.boot = false; },
      reiniciar() { dev.boot = true; dev.ack = []; },
    },
  };
}
