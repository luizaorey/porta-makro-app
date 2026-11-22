// Configurar Wi‑Fi — interface e fluxo (nesta etapa só no simulador; o firmware vem depois).
//
// Na versão definitiva: o app orienta; o iPhone entra na rede temporária "Porta-Config" criada pelo ESP32;
// a página de senha é aberta no Safari e servida pelo próprio ESP32 (funciona sem internet); a placa só salva
// a rede depois de confirmar a conexão. Aqui o "Safari" e a placa são simulados.
import { horaCurta } from './logic.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const btn = (txt, cls, fn) => { const b = el('button', cls, txt); b.type = 'button'; b.onclick = fn; return b; };
const negrito = (txt) => { const f = document.createDocumentFragment(); txt.split('**').forEach((p, i) => f.append(i % 2 ? el('b', '', p) : document.createTextNode(p))); return f; };

export function iniciarWifi(ctx) {
  // ctx: backend(), estado() -> {ok, visto, rede, ultimaRede}, abrirFolha(id), fecharFolhas(), aguardando(bool)
  let modo = 'primeira';                 // 'primeira' | 'trocar'
  let aberto = false;                    // a folha de Wi-Fi está aberta
  const corpo = $('wifiCorpo');
  const sim = () => ctx.backend().wifi;  // só existe no simulador

  // ---------- tela do aplicativo ----------
  function abrir() { aberto = true; ctx.abrirFolha('folhaWifi'); home(); }
  function fechar() { aberto = false; ctx.fecharFolhas(); fecharNav(); }
  function limpar() { corpo.textContent = ''; return corpo; }

  function home() {
    const c = limpar(); c.dataset.vista = 'home';
    const est = ctx.estado();
    const card = el('section', 'cartao');
    const linha = el('div', 'wifi-status');
    linha.append(el('span', 'ponto ' + (est.ok ? 'on' : 'off')), el('b', '', est.ok ? 'Placa conectada' : 'Placa sem comunicação'));
    card.append(linha);
    const rede = est.rede || est.ultimaRede;
    if (est.ok && est.rede) card.append(el('p', 'wifi-rede', `Rede atual: ${est.rede}`));
    else if (est.ok) card.append(el('p', 'dica', 'Nome da rede: a placa ainda não informa (chega com o firmware).'));
    else if (rede) card.append(el('p', 'wifi-rede', `Última rede salva na placa: ${rede}`));
    else card.append(el('p', 'wifi-rede', 'Nenhuma rede configurada ainda.'));
    if (!est.ok && est.visto) card.append(el('p', 'dica', `Última resposta da placa às ${horaCurta(est.visto)}.`));
    if (est.aguardando) card.append(el('p', 'wifi-aviso', 'Wi‑Fi configurado. Aguardando a primeira resposta da placa…'));
    card.append(el('p', 'dica', '“Conectada” só aparece quando a placa responde ao aplicativo. Ter Wi‑Fi na placa não basta: o app precisa conseguir falar com ela.'));
    c.append(card);

    c.append(
      btn('Configurar pela primeira vez', 'primario grande', () => passo1('primeira')),
      btn('Trocar de rede', 'secundario grande', () => passo1('trocar')),
    );
    if (sim()) c.append(cartaoSimulador());
  }

  // ---------- passo 1: orientar ----------
  function passo1(m) {
    modo = m;
    const c = limpar(); c.dataset.vista = 'passo1';
    const est = ctx.estado();
    c.append(el('h3', 'wifi-tit', m === 'primeira' ? 'Configurar pela primeira vez' : 'Trocar de rede'));

    const ol = el('ol', 'passos');
    let n = 0;
    const passo = (...partes) => { const li = el('li'); li.append(...partes); ol.append(li); n++; return li; };

    if (m === 'trocar' && est.ok) {
      const li = passo(negrito('A placa está conectada. Peça a ela para abrir a rede temporária **Porta‑Config**:'));
      const b = btn('Pedir à placa para abrir a Porta‑Config', 'secundario', async () => {
        b.disabled = true; b.textContent = 'Pedindo à placa…';
        try {
          if (sim()) await sim().pedirModoConfig(); else await ctx.backend().pedirConfig();
          b.textContent = 'Pedido enviado: aguarde alguns segundos até a Porta‑Config aparecer';
        } catch (e) { b.disabled = false; b.textContent = 'Não foi possível pedir à placa. Use o botão físico.'; return; }
        ctx.aguardando(false);
      });
      li.append(el('br'), b, el('p', 'dica', 'Enquanto troca de rede, a placa fica sem falar com o app. Faça com a porta parada.'));
    } else if (m === 'trocar') {
      passo(negrito('Ative o modo de configuração: **segure o botão CONFIG da placa por 5 segundos**, até o LED piscar rápido.'));
    } else {
      passo(negrito('Ligue a placa. Se ela ainda não tem Wi‑Fi, a rede protegida **Porta‑Config** aparece sozinha em alguns segundos.'));
    }
    passo(negrito('No iPhone, abra **Ajustes › Wi‑Fi** e toque em **Porta‑Config**. Digite a **senha de configuração da placa** (a que você definiu no firmware, em secrets.h).'));
    passo(negrito('Volte aqui e toque em **Abrir configuração**. A página abre no navegador do iPhone e é servida pela própria placa (endereço 192.168.4.1).'));
    c.append(ol);
    c.append(el('p', 'dica', 'Normal: enquanto estiver na Porta‑Config o iPhone avisa “sem conexão com a internet”. A configuração funciona mesmo assim.'));

    if (sim()) {
      c.append(btn('Abrir configuração', 'primario grande', abrirNav), btn('Cancelar', 'link', home));
      c.append(cartaoSimulador(true));
    } else {
      // placa real: a página é do ESP32 e abre no navegador do iPhone; o app só orienta
      const a = btn('Abrir configuração', 'primario grande', () => { window.open('http://192.168.4.1/', '_blank'); });
      c.append(a, el('p', 'dica', 'Se a página não abrir, digite 192.168.4.1 no Safari. O iPhone precisa estar na rede Porta‑Config.'));
      c.append(btn('Já configurei — voltar ao app', 'secundario grande', () => { ctx.aguardando(true); ctx.fecharFolhas(); aberto = false; }));
      c.append(btn('Cancelar', 'link', home));
    }
  }

  // ---------- cartão do simulador (a "vida real" que o app não controla) ----------
  function cartaoSimulador(enxuto) {
    const w = sim(); const e = w.estado();
    const k = el('section', 'cartao sim-card');
    k.append(el('h4', '', 'Simulador · mundo real'));
    const lista = el('ul', 'sim-lista');
    lista.append(
      el('li', '', `Rede da placa: ${e.rede || (e.ultimaRede ? e.ultimaRede + ' (offline)' : 'nenhuma')}`),
      el('li', '', `Porta‑Config: ${e.modoConfig ? 'ativa (placa emitindo)' : 'desligada'}`),
      el('li', '', `Wi‑Fi do iPhone: ${e.iphone === 'casa' ? 'rede de casa' : 'Porta‑Config'}`),
    );
    k.append(lista);
    const g = el('div', 'grupo-btn');
    g.append(
      btn('Segurar o botão CONFIG (5 s)', 'mini', () => { w.botaoConfig(); ctx.aguardando(false); redesenhar(); }),
      btn('Conectar o iPhone à Porta‑Config', 'mini', () => {
        const r = w.conectarIphone();
        if (!r.ok) alert('Porta‑Config não encontrada. A placa só emite essa rede em modo de configuração.');
        redesenhar();
      }),
      btn('iPhone volta à rede de casa', 'mini', () => { w.voltarParaCasa(); redesenhar(); }),
    );
    k.append(g);
    if (!enxuto) {
      k.append(el('h4', '', 'Cenários de teste'));
      const c = el('div', 'grupo-btn');
      c.append(
        btn('1 · Primeira configuração', 'mini', () => { w.cenario(1); ctx.aguardando(false); home(); }),
        btn('2 · Senha incorreta', 'mini', () => { w.cenario(2); ctx.aguardando(false); home(); }),
        btn('3 · Trocar rede (placa offline)', 'mini', () => { w.cenario(3); ctx.aguardando(false); home(); }),
      );
      k.append(c, el('p', 'dica', 'Cada cenário coloca a placa no ponto de partida. Depois siga o fluxo: “Configurar pela primeira vez” (1 e 2) ou “Trocar de rede” (3).'));
    }
    const sn = w.senhas().map(r => `${r.ssid}: ${r.senha || 'aberta'}`).join(' · ');
    k.append(el('p', 'dica', `Senhas fictícias — ${sn}`));
    return k;
  }
  function redesenhar() { const v = corpo.dataset.vista; if (v === 'passo1') passo1(modo); else if (v === 'home') home(); }

  // ---------- "navegador do iPhone" (simulado), servindo a página do ESP32 ----------
  const nav = $('navSim'), navCorpo = $('navCorpo');
  let redeEscolhida = null, senhaDigitada = '';
  function abrirNav() { nav.hidden = false; document.body.style.overflow = 'hidden'; $('navUrl').textContent = '192.168.4.1'; paginaInicial(); }
  function fecharNav() { nav.hidden = true; }
  $('navFechar').onclick = () => { fecharNav(); if (aberto) redesenhar(); };
  $('navRecarregar').onclick = () => paginaInicial();
  const pag = () => { navCorpo.textContent = ''; return navCorpo; };

  function paginaInicial() {
    if (!sim()) return;
    if (!sim().paginaAlcancavel()) return erroNav();
    redes();
  }
  function erroNav() {
    const p = pag();
    const e = sim().estado();
    p.append(el('div', 'nav-erro-icone', '⚠︎'), el('h3', '', 'Não foi possível abrir a página'));
    p.append(el('p', 'nav-txt', e.iphone !== 'Porta-Config'
      ? 'O iPhone não está conectado à rede Porta‑Config. Abra Ajustes › Wi‑Fi e conecte-se a ela. Se ela não aparecer, ative o modo de configuração na placa.'
      : 'A placa não está emitindo a Porta‑Config agora. Ative o modo de configuração (botão CONFIG, 5 s) e tente de novo.'));
    p.append(btn('Tentar de novo', 'primario', paginaInicial));
  }

  function redes() {
    const p = pag();
    p.append(el('div', 'esp-marca', 'PORTA DE ENROLAR'), el('h3', '', 'Escolha a rede Wi‑Fi da loja'),
      el('p', 'nav-txt', 'Aparecem só redes de 2,4 GHz. A placa não enxerga redes de 5 GHz.'));
    const ul = el('ul', 'redes');
    for (const r of sim().escanear()) {
      const li = el('li');
      const b = el('button', 'rede'); b.type = 'button';
      b.append(el('span', 'rede-nome', r.ssid), el('span', 'rede-info', (r.aberta ? 'aberta ' : '🔒 ') + '▂▄▆'.slice(0, r.sinal)));
      b.onclick = () => { redeEscolhida = r; senhaDigitada = ''; senha(); };
      li.append(b); ul.append(li);
    }
    p.append(ul, btn('Atualizar lista', 'link', redes));
  }

  function senha(erro) {
    const p = pag();
    p.append(el('div', 'esp-marca', 'PORTA DE ENROLAR'), el('h3', '', redeEscolhida.ssid));
    if (erro) p.append(el('p', 'nav-aviso', erro));
    let campo = null;
    if (!redeEscolhida.aberta) {
      const lab = el('label', '', 'Senha do Wi‑Fi');
      campo = el('input'); campo.type = 'password'; campo.autocomplete = 'off'; campo.value = senhaDigitada; campo.placeholder = 'Digite a senha';
      campo.oninput = () => { senhaDigitada = campo.value; ok.disabled = !senhaDigitada; };
      lab.append(campo); p.append(lab);
      const mostra = el('label', 'linha'); const ck = el('input'); ck.type = 'checkbox'; ck.onchange = () => { campo.type = ck.checked ? 'text' : 'password'; };
      mostra.append(ck, document.createTextNode(' Mostrar senha')); p.append(mostra);
    } else p.append(el('p', 'nav-txt', 'Rede aberta: não precisa de senha.'));
    const ok = btn('Conectar', 'primario grande', () => conectar());
    ok.disabled = !redeEscolhida.aberta && !senhaDigitada;
    p.append(ok, btn('Voltar', 'link', redes));
    if (campo) { campo.focus(); campo.select(); }
  }

  async function conectar() {
    const p = pag();
    p.append(el('div', 'esp-marca', 'PORTA DE ENROLAR'), el('div', 'girando'), el('h3', '', 'Tentando conectar…'), el('p', 'nav-txt', `Rede: ${redeEscolhida.ssid}`));
    const r = await sim().tentar(redeEscolhida.ssid, redeEscolhida.aberta ? '' : senhaDigitada);
    if (nav.hidden) return;
    r.ok ? sucesso(r.rede) : falha(r.motivo);
  }

  function sucesso(rede) {
    const p = pag();
    p.append(el('div', 'esp-marca', 'PORTA DE ENROLAR'), el('div', 'nav-ok', '✓'), el('h3', '', 'Wi‑Fi configurado'), el('p', 'nav-rede', rede),
      el('p', 'nav-txt', 'A placa salvou a rede e vai usá-la sempre que ligar.'),
      (() => { const q = el('p', 'nav-txt'); q.append(negrito('Agora **volte ao aplicativo** Porta de enrolar. O iPhone volta sozinho para a sua rede.')); return q; })());
    p.append(btn('Voltar ao aplicativo', 'primario grande', () => {
      fecharNav(); ctx.aguardando(true); ctx.fecharFolhas(); aberto = false;
    }));
  }

  function falha(motivo) {
    const p = pag();
    p.append(el('div', 'esp-marca', 'PORTA DE ENROLAR'), el('div', 'nav-x', '✕'), el('h3', '', 'Não foi possível conectar'),
      el('p', 'nav-txt', motivo === 'senha' ? 'A senha parece estar incorreta. Confira maiúsculas, minúsculas e números.' : 'A placa não encontrou essa rede. Aproxime-a do roteador e tente de novo.'),
      el('p', 'nav-txt', 'A placa continua em modo de configuração. Nada foi salvo.'));
    p.append(btn('Corrigir a senha e tentar novamente', 'primario grande', () => senha(motivo === 'senha' ? 'Senha incorreta. Digite de novo.' : null)),
      btn('Escolher outra rede', 'link', redes));
  }

  return { abrir, fechar, atualizar() { if (aberto && corpo.dataset.vista === 'home') home(); } };
}
