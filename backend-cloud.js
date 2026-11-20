// Modo real: Supabase (login, histórico, comandos, push). O ESP32 fala com a mesma nuvem por HTTPS.
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export async function criarNuvem(cfg) {
  const { createClient } = await import(SUPABASE_JS);
  const sb = createClient(cfg.supabaseUrl, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  let perfil = null;

  const paraMs = t => (t ? new Date(t).getTime() : null);
  const paraEstado = j => ({
    aberto: j.aberto, fechado: j.fechado, visto: paraMs(j.visto_em),
    pct_base: j.pct_base, mov_dir: j.mov_dir, mov_inicio: paraMs(j.mov_inicio),
    ultimo: j.ultimo_pos ? { pos: j.ultimo_pos, em: paraMs(j.ultimo_em) } : null,
  });

  return {
    modo: 'real',
    usuario: () => perfil,
    async sessao() {
      const { data } = await sb.auth.getSession();
      if (!data.session) return null;
      return this._carregarPerfil();
    },
    async entrar(email, senha) {
      const { error } = await sb.auth.signInWithPassword({ email, password: senha });
      if (error) throw new Error('E-mail ou senha incorretos.');
      return this._carregarPerfil();
    },
    async _carregarPerfil() {
      const { data, error } = await sb.rpc('porta_eu');
      if (error || !data) { await sb.auth.signOut(); throw new Error('Este usuário não tem permissão para a porta.'); }
      perfil = { nome: data.nome, papel: data.papel };
      return perfil;
    },
    async sair() { await sb.auth.signOut(); perfil = null; },

    async snapshot() {
      const { data, error } = await sb.rpc('porta_snapshot');
      if (error) throw new Error(error.message);
      return {
        agora: paraMs(data.agora),
        est: paraEstado(data.estado),
        cfg: data.config,
        eventos: (data.eventos || []).map(e => ({ ...e, em: paraMs(e.em) })),
        cmds: (data.comandos || []).map(c => ({ ...c, criado: paraMs(c.criado), executado: paraMs(c.executado) })),
      };
    },
    async comando(acao) {
      const { data, error } = await sb.rpc('porta_comando', { p_acao: acao });
      if (error) throw new Error(error.message.includes('sem_comunicacao') ? 'sem_comunicacao' : error.message);
      return { id: data };
    },
    async configurar(parcial) {
      const { error } = await sb.rpc('porta_configurar', { p_tempo_abrir_s: parcial.tempo_abrir_s, p_tempo_fechar_s: parcial.tempo_fechar_s, p_pulso_ms: parcial.pulso_ms });
      if (error) throw new Error(error.message);
    },

    // --- notificações push ---
    pushSuportado: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    async ativarPush() {
      const reg = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Permissão de notificação negada.');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ParaBytes(cfg.vapidPublicKey) });
      const j = sub.toJSON();
      const { error } = await sb.rpc('porta_push_registrar', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent.slice(0, 200) });
      if (error) throw new Error(error.message);
    },
    async pushAtivo() {
      if (!this.pushSuportado() || Notification.permission !== 'granted') return false;
      const reg = await navigator.serviceWorker.ready;
      return !!(await reg.pushManager.getSubscription());
    },
    async testarPush() {
      const { error } = await sb.rpc('porta_push_teste');
      if (error) throw new Error(error.message);
    },
  };
}

function b64ParaBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
