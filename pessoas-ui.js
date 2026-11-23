// Pessoas com acesso (só o mestre vê e edita) e troca da própria senha.
// O mestre cadastra nome + e-mail + senha; a pessoa entra no app com isso e o NOME dela aparece nos avisos e no histórico.
const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

export function iniciarPessoas(ctx) {
  // ctx: backend(), ehAdmin()
  let modo = 'criar', alvo = null, papel = 'operador';
  const bk = () => ctx.backend();

  async function atualizar() {
    const bloco = $('blocoPessoas');
    bloco.hidden = !ctx.ehAdmin();
    if (bloco.hidden) return;
    const ul = $('listaPessoas');
    try {
      const lista = await bk().pessoas();
      ul.textContent = '';
      for (const p of lista) {
        const li = el('li');
        const nome = el('div', 'nome', p.nome);
        nome.append(el('span', 'selo-papel ' + p.papel, p.papel === 'admin' ? 'Mestre' : 'Operador'));
        if (p.voce) nome.append(el('span', 'dica', '(você)'));
        li.append(nome, el('div', 'email', p.email || ''));
        const ac = el('div', 'acoes');
        const senha = el('button', 'mini', 'Trocar senha'); senha.type = 'button'; senha.onclick = () => abrir('senha', p);
        ac.append(senha);
        if (!p.voce) {
          const pap = el('button', 'mini', p.papel === 'admin' ? 'Tornar operador' : 'Tornar mestre'); pap.type = 'button';
          pap.onclick = async () => {
            if (!confirm(p.papel === 'admin' ? `${p.nome} deixa de ser mestre e não poderá mais mexer na agenda, no Wi‑Fi nem nas pessoas. Continuar?` : `${p.nome} passa a ser mestre e poderá mexer na agenda, no Wi‑Fi, nos ajustes e nas pessoas. Continuar?`)) return;
            try { await bk().pessoaPapel(p.user_id, p.papel === 'admin' ? 'operador' : 'admin'); atualizar(); } catch (e) { alert(e.message); }
          };
          const rem = el('button', 'mini remover', 'Remover'); rem.type = 'button';
          rem.onclick = async () => {
            if (!confirm(`Remover ${p.nome}? Ela perde o acesso à porta na hora. O histórico continua mostrando o nome.`)) return;
            try { await bk().pessoaRemover(p.user_id); atualizar(); } catch (e) { alert(e.message); }
          };
          ac.append(pap, rem);
        }
        li.append(ac); ul.append(li);
      }
    } catch (e) { ul.textContent = ''; ul.append(el('li', 'dica', 'Não foi possível carregar: ' + e.message)); }
  }

  function marcarPapel(p) { papel = p; document.querySelectorAll('#segPapel .seg-btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.papel === p))); }
  document.querySelectorAll('#segPapel .seg-btn').forEach(b => { b.onclick = () => marcarPapel(b.dataset.papel); });
  $('pessoaMostrar').onchange = e => { $('pessoaSenha').type = e.target.checked ? 'text' : 'password'; };

  function abrir(m, p) {
    modo = m; alvo = p || null; $('pessoaErro').textContent = '';
    $('pessoaNome').value = ''; $('pessoaEmail').value = ''; $('pessoaSenha').value = ''; $('pessoaMostrar').checked = false; $('pessoaSenha').type = 'password';
    marcarPapel('operador');
    const criar = m === 'criar';
    $('pessoaTitulo').textContent = criar ? 'Adicionar pessoa' : `Nova senha de ${p.nome}`;
    $('pessoaDados').hidden = !criar; $('pessoaPapelBox').hidden = !criar;
    $('pessoaSenhaTxt').textContent = criar ? 'Senha (mínimo 8 caracteres)' : 'Nova senha (mínimo 8 caracteres)';
    $('telaPessoa').hidden = false; document.body.style.overflow = 'hidden';
    setTimeout(() => (criar ? $('pessoaNome') : $('pessoaSenha')).focus(), 50);
  }
  function fechar() { $('telaPessoa').hidden = true; document.body.style.overflow = ''; }
  $('btnNovaPessoa').onclick = () => abrir('criar');
  $('pessoaCancelar').onclick = fechar;
  $('pessoaSalvar').onclick = async () => {
    const senha = $('pessoaSenha').value;
    if (senha.length < 8) { $('pessoaErro').textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
    $('pessoaSalvar').disabled = true; $('pessoaErro').textContent = '';
    try {
      if (modo === 'criar') {
        const nome = $('pessoaNome').value.trim(), email = $('pessoaEmail').value.trim();
        if (nome.length < 2) throw new Error('Informe o nome (aparece nos avisos).');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('E-mail inválido.');
        await bk().pessoaCriar({ nome, email, senha, papel });
      } else await bk().pessoaSenha(alvo.user_id, senha);
      fechar(); atualizar();
    } catch (e) { $('pessoaErro').textContent = e.message; }
    $('pessoaSalvar').disabled = false;
  };

  // minha senha (qualquer pessoa)
  $('btnMinhaSenha').onclick = async () => {
    const m = $('minhaSenhaMsg'); m.textContent = '';
    try { await bk().trocarMinhaSenha($('minhaSenha').value); $('minhaSenha').value = ''; m.textContent = 'Senha trocada.'; }
    catch (e) { m.textContent = e.message; }
  };

  return { atualizar };
}
