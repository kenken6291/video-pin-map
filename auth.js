/* ==========================================================
   MapTube 認証UI (auth.js)
   - ログイン / 新規登録（仮パスワード方式）/ パスワード再発行
   - 仮パスワードでログインした場合は「新しいパスワード設定」を強制
   - すべてのパスワード欄に表示/非表示切り替えボタン
   使い方:
     MapTubeAuth.init({ apiUrl: 'GASのURL', onChange: function (s) { ... } });
     ボタンに data-auth="login" / "register" / "forgot" / "change" / "logout" を付けると自動で動作
     MapTubeAuth.requireActive(function () { 投稿処理 }); で投稿前にログインを要求
   ========================================================== */
(function () {
  'use strict';

  var TOKEN_KEY = 'maptube_session_token';
  var PUBLIC_ACTIONS = ['login', 'register', 'forgotPassword'];
  var PW_MIN = 8;

  var ICON_EYE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var ICON_EYE_OFF = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.1 10.1 0 0 1 12 19c-6.4 0-10-7-10-7a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.4 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
  var ICON_CLOSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

  var cfg = { apiUrl: '', onChange: null };
  var state = {
    token: null,
    user: null,
    mustChange: false,
    tempPw: null,      // 強制変更画面で使う、直前に入力された仮パスワード（メモリ上のみ）
    forced: false,     // 強制変更中は閉じられない
    pending: null,     // ログイン完了後に実行する処理
    lastEmail: ''
  };
  var dlg = null;
  var toastTimer = null;

  /* ---------- 小道具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function val(sel) { var el = $(sel, dlg); return el ? el.value : ''; }
  function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254; }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function saveToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 保存できなくても動作は継続 */ }
  }
  function loadToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  /* ---------- 入力欄テンプレート ---------- */
  function textField(id, label, type, autocomplete, extra) {
    return '<div class="mt-field"><label for="' + id + '">' + label + '</label>' +
      '<input class="mt-input" id="' + id + '" type="' + type + '" autocomplete="' + autocomplete + '" ' + (extra || '') + '></div>';
  }
  function pwField(id, label, autocomplete, wrapAttr) {
    return '<div class="mt-field" ' + (wrapAttr || '') + '><label for="' + id + '">' + label + '</label>' +
      '<div class="mt-pw">' +
      '<input class="mt-input" id="' + id + '" type="password" autocomplete="' + autocomplete + '" autocapitalize="off" spellcheck="false">' +
      '<button type="button" class="mt-pw-toggle" aria-controls="' + id + '" aria-pressed="false" aria-label="パスワードを表示">' + ICON_EYE + '</button>' +
      '</div></div>';
  }
  function errorBox() { return '<p class="mt-error" role="alert" hidden></p>'; }
  function tempBox() {
    return '<div class="mt-temp" hidden><output></output>' +
      '<button type="button" class="mt-btn mt-btn-secondary" data-copy>コピー</button></div>';
  }

  function template() {
    return '' +
      '<button type="button" class="mt-close" data-close aria-label="閉じる">' + ICON_CLOSE + '</button>' +
      '<div class="mt-body">' +

      /* ログイン */
      '<form data-view="login" novalidate>' +
        '<h2 class="mt-title">ログイン</h2>' +
        '<p class="mt-lead">投稿やコメントをするにはログインしてください。</p>' +
        errorBox() +
        textField('mt-login-email', 'メールアドレス', 'email', 'username', 'inputmode="email"') +
        pwField('mt-login-pw', 'パスワード', 'current-password') +
        '<p class="mt-note" style="margin:-8px 0 16px">メールで届いた仮パスワードもここに入力します。</p>' +
        '<button type="submit" class="mt-btn mt-btn-primary mt-btn-block">ログイン</button>' +
        '<div class="mt-links">' +
          '<button type="button" class="mt-link" data-goto="forgot">パスワードをお忘れの方はこちら</button>' +
          '<button type="button" class="mt-link" data-goto="register">はじめての方は新規登録</button>' +
        '</div>' +
      '</form>' +

      /* 新規登録 */
      '<form data-view="register" novalidate>' +
        '<h2 class="mt-title">新規登録</h2>' +
        '<p class="mt-lead">入力したメールアドレスに仮パスワードをお送りします。仮パスワードでログインしたあと、ご自分のパスワードを設定します。</p>' +
        errorBox() +
        textField('mt-reg-name', 'ユーザー名（20文字まで）', 'text', 'nickname', 'maxlength="20"') +
        textField('mt-reg-email', 'メールアドレス', 'email', 'email', 'inputmode="email"') +
        '<button type="submit" class="mt-btn mt-btn-primary mt-btn-block">仮パスワードを受け取る</button>' +
        '<div class="mt-links"><button type="button" class="mt-link" data-goto="login">登録済みの方はログイン</button></div>' +
      '</form>' +

      /* 登録受付完了 */
      '<form data-view="registered" novalidate>' +
        '<h2 class="mt-title">仮パスワードを発行しました</h2>' +
        '<p class="mt-lead" data-msg></p>' +
        tempBox() +
        '<p class="mt-note" style="margin:0 0 20px">メールが見当たらない場合は、迷惑メールフォルダもご確認ください。</p>' +
        '<button type="submit" class="mt-btn mt-btn-primary mt-btn-block">ログインへ進む</button>' +
      '</form>' +

      /* パスワード再発行 */
      '<form data-view="forgot" novalidate>' +
        '<h2 class="mt-title">パスワードの再発行</h2>' +
        '<p class="mt-lead">登録したメールアドレスに、再設定用の仮パスワードをお送りします。いまのパスワードは、新しいパスワードを設定するまでそのまま使えます。</p>' +
        errorBox() +
        textField('mt-forgot-email', 'メールアドレス', 'email', 'email', 'inputmode="email"') +
        '<button type="submit" class="mt-btn mt-btn-primary mt-btn-block">仮パスワードを送る</button>' +
        '<div class="mt-links"><button type="button" class="mt-link" data-goto="login">ログインに戻る</button></div>' +
      '</form>' +

      /* 再発行受付完了 */
      '<form data-view="forgotSent" novalidate>' +
        '<h2 class="mt-title">メールを確認してください</h2>' +
        '<p class="mt-lead" data-msg></p>' +
        tempBox() +
        '<button type="submit" class="mt-btn mt-btn-primary mt-btn-block">ログインへ進む</button>' +
      '</form>' +

      /* パスワード変更（強制 / 任意） */
      '<form data-view="change" novalidate>' +
        '<h2 class="mt-title" data-title></h2>' +
        '<p class="mt-lead" data-lead></p>' +
        errorBox() +
        pwField('mt-cur-pw', '現在のパスワード', 'current-password', 'data-current') +
        pwField('mt-new-pw', '新しいパスワード', 'new-password') +
        pwField('mt-new-pw2', '新しいパスワード（確認用）', 'new-password') +
        '<ul class="mt-checklist" aria-live="polite">' +
          '<li data-rule="len">' + PW_MIN + '文字以上</li>' +
          '<li data-rule="alpha">英字を含む</li>' +
          '<li data-rule="num">数字を含む</li>' +
          '<li data-rule="match">確認用と一致している</li>' +
        '</ul>' +
        '<button type="submit" class="mt-btn mt-btn-primary mt-btn-block">パスワードを変更する</button>' +
        '<div class="mt-links"><button type="button" class="mt-link" data-logout hidden>ログアウトする</button></div>' +
      '</form>' +

      '</div>';
  }

  /* ---------- 組み立て ---------- */
  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'mt-dialog';
    dlg.innerHTML = template();
    document.body.appendChild(dlg);

    dlg.addEventListener('click', function (e) {
      var t = e.target;
      if (t === dlg) { close(true); return; }                       // 背景クリック
      var tog = t.closest('.mt-pw-toggle');
      if (tog) { togglePw(tog); return; }
      var go = t.closest('[data-goto]');
      if (go) { openView(go.getAttribute('data-goto'), { email: state.lastEmail }); return; }
      if (t.closest('[data-close]')) { close(true); return; }
      if (t.closest('[data-logout]')) { logout(); return; }
      var cp = t.closest('[data-copy]');
      if (cp) { copyTemp(cp); }
    });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(true); }); // Escキー

    $all('form', dlg).forEach(function (f) { f.addEventListener('submit', onSubmit); });
    $all('#mt-cur-pw, #mt-new-pw, #mt-new-pw2', dlg).forEach(function (i) {
      i.addEventListener('input', updateChecklist);
    });
  }

  function wireTriggers() {
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-auth]');
      if (!b || dlg.contains(b)) return;
      e.preventDefault();
      var a = b.getAttribute('data-auth');
      if (a === 'logout') logout();
      else if (a === 'change') openView('change', { forced: state.mustChange });
      else openView(a, { email: state.lastEmail });
    });
  }

  /* ---------- 表示切替 ---------- */
  function togglePw(btn) {
    var input = document.getElementById(btn.getAttribute('aria-controls'));
    if (!input) return;
    var show = input.type === 'password';
    var s = input.selectionStart, en = input.selectionEnd;
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    btn.innerHTML = show ? ICON_EYE_OFF : ICON_EYE;
    input.focus();
    try { input.setSelectionRange(s, en); } catch (err) { /* 一部ブラウザ非対応 */ }
  }

  function resetPwFields(clearValues) {
    $all('.mt-pw', dlg).forEach(function (w) {
      var input = $('input', w), btn = $('.mt-pw-toggle', w);
      input.type = 'password';
      if (clearValues) input.value = '';
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', 'パスワードを表示');
      btn.innerHTML = ICON_EYE;
    });
  }

  function showError(form, msg, field) {
    var box = $('.mt-error', form);
    if (box) { box.textContent = msg; box.hidden = false; }
    $all('[aria-invalid]', form).forEach(function (i) { i.removeAttribute('aria-invalid'); });
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }
  function clearError(form) {
    var box = $('.mt-error', form);
    if (box) { box.hidden = true; box.textContent = ''; }
    $all('[aria-invalid]', form).forEach(function (i) { i.removeAttribute('aria-invalid'); });
  }

  function busy(form, on, label) {
    var btn = $('button[type="submit"]', form);
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || '送信中…'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  function openView(name, opts) {
    opts = opts || {};
    var view = $('[data-view="' + name + '"]', dlg);
    if (!view) return;
    $all('[data-view]', dlg).forEach(function (v) { v.hidden = v !== view; });
    resetPwFields(true);
    clearError(view);

    state.forced = !!opts.forced;
    $('.mt-close', dlg).hidden = state.forced;

    if (name === 'change') setupChange();
    if (opts.email) {
      var em = $('input[type="email"]', view);
      if (em && !em.value) em.value = opts.email;
    }
    dlg.setAttribute('aria-label', ($('.mt-title', view) || {}).textContent || '');

    if (!dlg.open) { dlg.classList.remove('is-closing'); dlg.showModal(); }
    var first = $all('input', view).filter(function (i) { return !i.closest('[hidden]') && !i.value; })[0] ||
                $('button[type="submit"]', view);
    setTimeout(function () { if (first) first.focus(); }, 40);
  }

  function close(byUser) {
    if (!dlg.open) return;
    if (state.forced) return;                 // パスワード設定が終わるまで閉じさせない
    if (byUser) state.pending = null;         // ユーザーが閉じたら保留中の処理は破棄
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function finish() {
      dlg.classList.remove('is-closing');
      dlg.close();
      resetPwFields(true);
    }
    if (reduce) { finish(); return; }
    dlg.classList.add('is-closing');
    dlg.addEventListener('animationend', finish, { once: true });
  }

  /* ---------- パスワード変更画面 ---------- */
  function setupChange() {
    var form = $('[data-view="change"]', dlg);
    var curWrap = $('[data-current]', form);
    var curLabel = $('label', curWrap);
    var hasTemp = state.forced && !!state.tempPw;

    curWrap.hidden = hasTemp;   // 直前に仮パスワードを入力済みなら再入力させない
    curLabel.textContent = state.forced ? '仮パスワード' : '現在のパスワード';
    $('[data-title]', form).textContent = state.forced ? '新しいパスワードを設定してください' : 'パスワードの変更';
    $('[data-lead]', form).textContent = state.forced
      ? '仮パスワードでログインしました。新しいパスワードを設定すると、投稿やコメントができるようになります。'
      : '新しいパスワードは英字と数字を組み合わせて8文字以上にしてください。';
    $('[data-logout]', form).hidden = !state.forced;
    updateChecklist();
  }

  function pwRules(np, cf) {
    return {
      len: np.length >= PW_MIN,
      alpha: /[A-Za-z]/.test(np),
      num: /[0-9]/.test(np),
      match: cf.length > 0 && np === cf
    };
  }

  function updateChecklist() {
    var form = $('[data-view="change"]', dlg);
    var rules = pwRules(val('#mt-new-pw'), val('#mt-new-pw2'));
    var allOk = true;
    $all('[data-rule]', form).forEach(function (li) {
      var ok = !!rules[li.getAttribute('data-rule')];
      li.setAttribute('data-ok', String(ok));
      if (!ok) allOk = false;
    });
    var curWrap = $('[data-current]', form);
    if (!curWrap.hidden && !val('#mt-cur-pw')) allOk = false;
    $('button[type="submit"]', form).disabled = !allOk;
  }

  /* ---------- 送信処理 ---------- */
  function onSubmit(e) {
    e.preventDefault();
    var form = e.currentTarget;
    var view = form.getAttribute('data-view');
    clearError(form);
    if (view === 'login') return doLogin(form);
    if (view === 'register') return doRegister(form);
    if (view === 'forgot') return doForgot(form);
    if (view === 'change') return doChange(form);
    if (view === 'registered' || view === 'forgotSent') return openView('login', { email: state.lastEmail });
  }

  async function doLogin(form) {
    var emailEl = $('#mt-login-email', form), pwEl = $('#mt-login-pw', form);
    var email = emailEl.value.trim(), pw = pwEl.value;
    if (!isEmail(email)) return showError(form, 'メールアドレスの形式を確認してください', emailEl);
    if (!pw) return showError(form, 'パスワードを入力してください', pwEl);

    busy(form, true, 'ログイン中…');
    var r = await api('login', { email: email, password: pw });
    busy(form, false);
    if (!r.ok) return showError(form, r.message, pwEl);

    state.lastEmail = email;
    setSession(r.token, r.user, r.mustChangePassword);
    if (r.mustChangePassword) {
      state.tempPw = pw;
      openView('change', { forced: true });
    } else {
      finishSuccess(r.user.username + ' さん、ようこそ');
    }
  }

  async function doRegister(form) {
    var nameEl = $('#mt-reg-name', form), emailEl = $('#mt-reg-email', form);
    var name = nameEl.value.trim(), email = emailEl.value.trim();
    if (!name || name.length > 20) return showError(form, 'ユーザー名を1〜20文字で入力してください', nameEl);
    if (!isEmail(email)) return showError(form, 'メールアドレスの形式を確認してください', emailEl);

    busy(form, true);
    var r = await api('register', { username: name, email: email });
    busy(form, false);
    if (!r.ok) return showError(form, r.message);

    state.lastEmail = email;
    showIssued('registered', r);
  }

  async function doForgot(form) {
    var emailEl = $('#mt-forgot-email', form);
    var email = emailEl.value.trim();
    if (!isEmail(email)) return showError(form, 'メールアドレスの形式を確認してください', emailEl);

    busy(form, true);
    var r = await api('forgotPassword', { email: email });
    busy(form, false);
    if (!r.ok) return showError(form, r.message);

    state.lastEmail = email;
    showIssued('forgotSent', r);
  }

  function showIssued(viewName, r) {
    var view = $('[data-view="' + viewName + '"]', dlg);
    var msg = r.message || '';
    if (r.expiresAt) msg += ' 有効期限は ' + fmtDate(r.expiresAt) + ' までです。';
    $('[data-msg]', view).textContent = msg;
    var box = $('.mt-temp', view);
    if (r.tempPassword) {             // GAS側でテスト表示を有効にした場合のみ返ってくる
      $('output', box).textContent = r.tempPassword;
      box.hidden = false;
    } else {
      box.hidden = true;
    }
    openView(viewName);
  }

  async function doChange(form) {
    var curWrap = $('[data-current]', form);
    var cur = curWrap.hidden ? state.tempPw : val('#mt-cur-pw');
    var npEl = $('#mt-new-pw', form), cfEl = $('#mt-new-pw2', form);
    var np = npEl.value, cf = cfEl.value;
    var rules = pwRules(np, cf);

    if (!cur) return showError(form, (state.forced ? '仮パスワード' : '現在のパスワード') + 'を入力してください', $('#mt-cur-pw', form));
    if (!rules.len) return showError(form, 'パスワードは' + PW_MIN + '文字以上にしてください', npEl);
    if (!rules.alpha || !rules.num) return showError(form, '英字と数字を両方含めてください', npEl);
    if (/\s/.test(np)) return showError(form, 'スペースは使えません', npEl);
    if (!rules.match) return showError(form, '確認用のパスワードが一致しません', cfEl);
    if (np === cur) return showError(form, (state.forced ? '仮パスワード' : '現在のパスワード') + 'とは違うパスワードにしてください', npEl);

    busy(form, true, '変更中…');
    var r = await api('changePassword', { currentPassword: cur, newPassword: np, newPasswordConfirm: cf });
    busy(form, false);
    if (!r.ok) {
      if (r.code === 'WRONG_PASSWORD' && curWrap.hidden) { curWrap.hidden = false; state.tempPw = null; updateChecklist(); }
      return showError(form, r.message);
    }

    state.tempPw = null;
    state.forced = false;
    state.mustChange = false;
    state.user = r.user || state.user;
    emit();
    finishSuccess('パスワードを変更しました');
  }

  function finishSuccess(message) {
    var p = state.pending;
    state.pending = null;
    state.forced = false;
    close(false);
    toast(message);
    if (typeof p === 'function') setTimeout(p, 260);
  }

  function copyTemp(btn) {
    var text = $('output', btn.parentNode).textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { toast('コピーしました'); }, function () {});
    }
  }

  /* ---------- セッション ---------- */
  function setSession(token, user, mustChange) {
    state.token = token;
    state.user = user;
    state.mustChange = !!mustChange;
    saveToken(token);
    emit();
  }
  function clearSession() {
    state.token = null;
    state.user = null;
    state.mustChange = false;
    state.tempPw = null;
    saveToken(null);
    emit();
  }
  function emit() {
    if (typeof cfg.onChange === 'function') {
      cfg.onChange({ user: state.user, mustChange: state.mustChange, active: isActive() });
    }
  }
  function isActive() { return !!state.user && !state.mustChange; }

  function logout() {
    var t = state.token;
    if (t) api('logout', { token: t });
    state.forced = false;
    state.pending = null;
    clearSession();
    close(false);
    toast('ログアウトしました');
  }

  function requireActive(cb) {
    if (isActive()) { if (typeof cb === 'function') cb(); return true; }
    state.pending = cb || null;
    if (state.user && state.mustChange) openView('change', { forced: true });
    else openView('login', { email: state.lastEmail });
    return false;
  }

  /* ---------- API通信 ---------- */
  async function api(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    if (state.token && !body.token && PUBLIC_ACTIONS.indexOf(action) < 0) body.token = state.token;

    var data;
    try {
      var res = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // GASのCORS対策
        body: JSON.stringify(body)
      });
      data = await res.json();
    } catch (err) {
      return { ok: false, code: 'NETWORK', message: 'サーバーに接続できませんでした。通信状況を確認して、もう一度お試しください。' };
    }

    if (!data.ok && data.code === 'SESSION_EXPIRED' && state.token) {
      clearSession();
      if (action !== 'me') toast(data.message);
    }
    if (!data.ok && data.code === 'PASSWORD_CHANGE_REQUIRED') {
      state.mustChange = true;
      emit();
      openView('change', { forced: true });
    }
    return data;
  }

  /* ---------- トースト ---------- */
  function toast(msg) {
    var el = $('.mt-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'mt-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-shown'); }, 2800);
  }

  /* ---------- 初期化 ---------- */
  async function init(options) {
    cfg.apiUrl = options.apiUrl;
    cfg.onChange = options.onChange || null;
    build();
    wireTriggers();

    var t = loadToken();
    if (t) {
      state.token = t;
      var r = await api('me');
      if (r.ok) {
        state.user = r.user;
        state.mustChange = !!r.mustChangePassword;
        state.lastEmail = r.user.email || '';
      }
    }
    emit();
    if (state.user && state.mustChange) openView('change', { forced: true });
  }

  window.MapTubeAuth = {
    init: init,
    open: openView,
    logout: logout,
    requireActive: requireActive,
    api: api,
    toast: toast,
    isActive: isActive,
    getUser: function () { return state.user; },
    getToken: function () { return state.token; }
  };
})();
