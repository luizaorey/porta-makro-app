// Modo simulação: a nuvem (server-model.js) e um ESP32 + porta virtuais rodando no próprio navegador.
// Serve para demonstrar o ciclo completo antes de ligar qualquer saída à porta real.
import { novoServidor, enviarComando, sincronizarDispositivo, agendaSalvar, agendaAtivar, agendaExcluir, agendaConfigurar, lerComTick } from './server-model.js';
import { proximaExecucao } from './logic.js';

export function criarSimulacao() {
  const S = novoServidor();
  let desloc = 0;                       // relógio da loja na simulação (dá para avançar até o próximo horário da agenda)
  const agoraSim = () => Date.now() + desloc;
  const dev = {
    online: true,
    auto: true,              // sensores seguem a porta virtual; desligado = você aciona os sensores à mão (bancada)
    aberto: false, fechado: true,
    pct: 0, dir: null,       // porta virtual (0 fechada .. 100 aberta)
    ack: [], boot: true,
    ultimoPulso: null,
  };
  // ---- Wi-Fi da placa (simulado; o ESP32 de verdade vem na próxima etapa) ----
  const wifi = {
    rede: 'Loja_Makro',      // rede em que a placa está conectada agora (começa conectada, como em uso normal)
    ultimaRede: 'Loja_Makro',        // última rede salva na placa
    modoConfig: false,       // placa emitindo a rede "Porta-Config"
    iphone: 'casa',          // 'casa' | 'Porta-Config' (Wi-Fi em que o iPhone está)
    redes: [                 // redes fictícias 2,4 GHz (5 GHz o ESP32 não enxerga, então nem aparecem)
      { ssid: 'Loja_Makro', sinal: 3, senha: 'makro1234' },
      { ssid: 'Loja_Makro_Novo', sinal: 3, senha: 'novo12345' },
      { ssid: 'Makro_Visitantes', sinal: 2, senha: 'visita123' },
      { ssid: 'Vizinho_2G', sinal: 1, senha: 'vizinho99' },
      { ssid: 'Cafe_da_Esquina', sinal: 2, senha: null },
    ],
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
    const cmds = sincronizarDispositivo(S, { aberto: dev.aberto, fechado: dev.fechado, boot: dev.boot, ack: dev.ack }, agoraSim());
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
      lerComTick(S, agoraSim());
      return {
        agora: agoraSim(),
        est: { ...S.est },
        cfg: S.cfg,
        agenda: S.agenda.map(r => ({ id: r.id, acao: r.acao, dias: [...r.dias], hora: r.hora, ativa: r.ativa })),
        agendaCfg: { ...S.agendaCfg },
        wifi: { rede: wifi.rede, ultimaRede: wifi.ultimaRede },
        eventos: S.eventos.slice(-40).reverse().map(e => ({ ...e })),
        cmds: S.cmds.slice(-8).map(c => ({ ...c })),
      };
    },
    async comando(acao) { return enviarComando(S, acao, 'Você (simulação)', agoraSim()); },
    configurar(parcial) { Object.assign(S.cfg, parcial); },
    async agendaSalvar(r) { return agendaSalvar(S, r, agoraSim()); },
    async agendaAtivar(id, ativa) { agendaAtivar(S, id, ativa, agoraSim()); },
    async agendaExcluir(id) { agendaExcluir(S, id); },
    async agendaConfig(c) { agendaConfigurar(S, c); },
    onChegada(f) { ouvintes.add(f); return () => ouvintes.delete(f); },
    // --- Wi-Fi da placa (simulação do que o ESP32 fará) ---
    wifi: {
      estado: () => ({ rede: wifi.rede, ultimaRede: wifi.ultimaRede, modoConfig: wifi.modoConfig, iphone: wifi.iphone, placaOnline: dev.online }),
      senhas: () => wifi.redes.map(r => ({ ssid: r.ssid, senha: r.senha })),
      // cenários de teste
      cenario(n) {
        wifi.iphone = 'casa';
        if (n === 1 || n === 2) { wifi.rede = null; wifi.ultimaRede = null; wifi.modoConfig = true; S.est.visto = null; S.est.ultimo = null; }   // placa nunca configurada: abre a Porta-Config sozinha
        if (n === 3) { wifi.rede = null; wifi.ultimaRede = 'Loja_Makro'; wifi.modoConfig = false; S.est.visto = agoraSim() - 60000; }                                              // tinha rede, o roteador mudou: placa offline
        dev.online = false;
      },
      conectarIphone() {                      // iPhone entra na Porta-Config (só existe se a placa a estiver emitindo)
        if (!wifi.modoConfig) return { ok: false, motivo: 'sem-rede' };
        wifi.iphone = 'Porta-Config'; return { ok: true };
      },
      voltarParaCasa() { wifi.iphone = 'casa'; },
      botaoConfig() { wifi.modoConfig = true; dev.online = false; },           // botão físico dedicado, 5 s
      pedirModoConfig() {                      // com a placa online, o app pede para abrir a Porta-Config
        return new Promise(res => setTimeout(() => { wifi.modoConfig = true; dev.online = false; res(); }, 2500));
      },
      paginaAlcancavel: () => wifi.iphone === 'Porta-Config' && wifi.modoConfig,
      escanear: () => wifi.redes.map(r => ({ ssid: r.ssid, sinal: r.sinal, aberta: !r.senha })),
      tentar(ssid, senha) {                    // a placa tenta entrar na rede; só salva se conseguir
        return new Promise(res => setTimeout(() => {
          const r = wifi.redes.find(x => x.ssid === ssid);
          if (!r) return res({ ok: false, motivo: 'nao-encontrada' });
          if (r.senha && senha !== r.senha) return res({ ok: false, motivo: 'senha' });
          wifi.rede = wifi.ultimaRede = ssid; wifi.modoConfig = false; wifi.iphone = 'casa';
          setTimeout(() => { dev.online = true; dev.boot = true; }, 6000);          // a placa liga no roteador e só depois volta a falar com a nuvem
          res({ ok: true, rede: ssid });
        }, 3500));
      },
    },
    // --- controles de bancada (só existem na simulação) ---
    bancada: {
      estado: () => ({ ...dev }),
      setAuto(v) { dev.auto = v; if (v) { dev.pct = dev.aberto ? 100 : dev.fechado ? 0 : dev.pct; } },
      setSensor(qual, v) { dev.auto = false; dev[qual] = v; },
      externo(acao) { pulso(acao); },   // controle sem fio / botoeira da loja
      setOnline(v) { dev.online = v; if (v) dev.boot = false; },
      reiniciar() { dev.boot = true; dev.ack = []; },
      // pula o relógio para 5 s antes da próxima regra ativa (para ver a agenda disparar sem esperar)
      avancarAteProxima() {
        const p = proximaExecucao(S.agenda, agoraSim());
        if (!p) return null;
        desloc += (p.em - 5000) - agoraSim();
        return p;
      },
    },
  };
}
