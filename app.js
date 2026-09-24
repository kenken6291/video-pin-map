'use strict';

/* =========================================================
 * 設定：GASのWebアプリURL（/exec で終わるもの）に置き換える
 * ========================================================= */
const API_URL = 'https://script.google.com/macros/s/AKfycbzJmO3WWtFMzSEMQupzHG-5jUGSKBrtI3q5vXYVLOLPwjZuMd0HcZBLjBNeo4ovArmV/exec';

const STORAGE_KEY = 'receiptKakeibo.session';
const IMAGE_MAX_SIDE = 1600;
const IMAGE_QUALITY = 0.85;
const LIST_PAGE = 20;
const FALLBACK_CATEGORY = 'その他';
const MANAGE_VALUE = '__manage__';   // 選択肢の「＋ 種別を追加・編集…」

const yen = new Intl.NumberFormat('ja-JP');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  token: null,
  email: null,
  categories: [],
  authMode: 'login',      // login | register | forgot
  mustChange: false,
  passwordMode: 'forced', // forced（仮パスワード後） | voluntary（通常の変更）
  view: 'dashboard',
  mode: 'receipt',        // receipt | manual
  editingId: null,
  trendMonths: 6,
  listLimit: LIST_PAGE,
  expenses: new Map(),
  incomeMonth: null,        // 'YYYY-MM'
  incomes: new Map(),
  catEdit: null,            // { name, mode: 'edit' | 'delete' }
  categoriesChanged: false,
  charts: { donut: null, trend: null }
};

/* =========================================================
 * API
 * ========================================================= */
async function api(action, payload = {}) {
  if (API_URL.includes('XXXXXXXX')) {
    throw new Error('app.js の API_URL をGASのWebアプリURLに書き換えてください。');
  }
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      // text/plain にすることでCORSのプリフライトを発生させない
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: state.token, payload }),
      redirect: 'follow'
    });
  } catch (e) {
    throw new Error('サーバーに接続できません。通信環境を確認してください。');
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('サーバーの応答を読み取れませんでした。GASのデプロイ設定（アクセスできるユーザー：全員）を確認してください。');
  }

  if (!json.ok) {
    if (json.code === 'AUTH') {
      clearSession();
      showAuth();
    } else if (json.code === 'MUST_CHANGE') {
      state.mustChange = true;
      showPasswordView('forced');
    }
    const err = new Error(json.error || 'エラーが発生しました。');
    err.code = json.code;
    throw err;
  }
  return json.data;
}

/* =========================================================
 * セッション
 * ========================================================= */
function saveSession(token, email, mustChange = false) {
  state.token = token;
  state.email = email;
  state.mustChange = !!mustChange;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, email, mustChange: state.mustChange })); } catch (e) { /* noop */ }
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (s && s.token) {
      state.token = s.token;
      state.email = s.email;
      state.mustChange = !!s.mustChange;
      return true;
    }
  } catch (e) { /* noop */ }
  return false;
}

function clearSession() {
  state.token = null;
  state.email = null;
  state.mustChange = false;
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* noop */ }
}

/* =========================================================
 * 画面切り替え・共通UI
 * ========================================================= */
function hideAllScreens() {
  ['#view-auth', '#view-password', '#app-shell'].forEach(id => $(id).classList.add('hidden'));
  resetPasswordToggles();
}

function showAuth(mode = 'login') {
  hideAllScreens();
  $('#view-auth').classList.remove('hidden');
  $('#login-password').value = '';
  setAuthMode(mode);
}

function enterApp(categories) {
  state.categories = categories || [];
  renderCategoryOptions();
  $('#user-email').textContent = state.email || '';
  hideAllScreens();
  $('#app-shell').classList.remove('hidden');
  showView('dashboard');
}

function showView(name) {
  state.view = name;
  $('#view-dashboard').classList.toggle('hidden', name !== 'dashboard');
  $('#view-add').classList.toggle('hidden', name !== 'add');
  $('#view-income').classList.toggle('hidden', name !== 'income');
  $$('.tab').forEach(t => {
    if (t.dataset.nav === name) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0 });

  if (name === 'dashboard') loadDashboard();
  if (name === 'add' && !state.editingId) resetEntry(state.mode);
  if (name === 'income') {
    if (!state.incomeMonth) state.incomeMonth = currentMonthKey();
    resetIncomeForm();
    loadIncomes();
  }
}

function setOverlay(on, text) {
  $('#overlay-text').textContent = text || '読み込んでいます…';
  $('#overlay').classList.toggle('hidden', !on);
}

let toastTimer = null;
function toast(message, type = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'fixed left-1/2 -translate-x-1/2 bottom-6 z-50 max-w-[90vw] rounded-lg px-4 py-3 text-sm shadow-lg ' +
    (type === 'error' ? 'bg-shu text-white' : 'bg-ink text-white');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), type === 'error' ? 5000 : 2800);
}

function setPressed(buttons, predicate) {
  buttons.forEach(b => b.setAttribute('aria-pressed', predicate(b) ? 'true' : 'false'));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 収支の表示（プラスは＋、マイナスは−） */
function signedYen(v) {
  if (v > 0) return `+¥${yen.format(v)}`;
  if (v < 0) return `−¥${yen.format(-v)}`;
  return '¥0';
}

function setBalance(el, v) {
  el.textContent = signedYen(v);
  el.classList.toggle('text-shu', v < 0);
  el.classList.toggle('text-ai', v > 0);
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${y}年${m}月`;
}

function shortDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const thisYear = new Date().getFullYear();
  return y === thisYear ? `${m}月${d}日` : `${y}年${m}月${d}日`;
}

function categoryColor(name) {
  const c = state.categories.find(x => x.name === name);
  return c ? c.color : '#8A9096';
}

/* =========================================================
 * パスワードの表示・非表示
 * ========================================================= */
function setPasswordVisible(btn, visible) {
  const input = document.getElementById(btn.dataset.pwToggle);
  if (!input) return;
  input.type = visible ? 'text' : 'password';
  btn.textContent = visible ? '隠す' : '表示';
  btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
  btn.setAttribute('aria-label', visible ? 'パスワードを隠す' : 'パスワードを表示する');
}

function resetPasswordToggles() {
  $$('[data-pw-toggle]').forEach(b => setPasswordVisible(b, false));
}

/* =========================================================
 * 認証画面（ログイン / 新規登録 / パスワードを忘れた方）
 * ========================================================= */
function setAuthMode(mode, { keepNotice = false } = {}) {
  state.authMode = mode;
  $('#form-login').classList.toggle('hidden', mode !== 'login');
  $('#form-register').classList.toggle('hidden', mode !== 'register');
  $('#form-forgot').classList.toggle('hidden', mode !== 'forgot');
  $('#auth-tabs').classList.toggle('hidden', mode === 'forgot');
  setPressed($$('#auth-tabs [data-auth-mode]'), b => b.dataset.authMode === mode);
  ['#login-error', '#register-error', '#forgot-error'].forEach(id => $(id).classList.add('hidden'));
  if (!keepNotice) $('#auth-notice').classList.add('hidden');
  resetPasswordToggles();

  // 入力済みのメールアドレスを引き継ぐ
  const email = $('#login-email').value || $('#register-email').value || $('#forgot-email').value;
  ['#login-email', '#register-email', '#forgot-email'].forEach(id => { if (!$(id).value) $(id).value = email; });
}

function showAuthNotice(html) {
  const el = $('#auth-notice');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function formError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.classList.remove('hidden');
}

async function withButton(btn, busyText, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
}

async function onLogin(e) {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  if (!email || !password) return formError('#login-error', 'メールアドレスとパスワードを入力してください。');

  await withButton($('#login-submit'), 'ログインしています…', async () => {
    try {
      const data = await api('login', { email, password });
      saveSession(data.token, data.user.email, data.mustChange);
      $('#login-password').value = '';
      if (data.mustChange) showPasswordView('forced');
      else enterApp(data.categories);
    } catch (err) {
      formError('#login-error', err.message);
    }
  });
}

async function onRegister(e) {
  e.preventDefault();
  $('#register-error').classList.add('hidden');
  const email = $('#register-email').value.trim();
  if (!email) return formError('#register-error', 'メールアドレスを入力してください。');

  await withButton($('#register-submit'), '送信しています…', async () => {
    try {
      const data = await api('register', { email });
      $('#login-email').value = data.email;
      setAuthMode('login');
      showAuthNotice(
        `<p><strong>${escapeHtml(data.email)}</strong> に仮パスワードを送信しました。</p>` +
        `<p class="mt-1">メールに書かれた仮パスワードで、下からログインしてください（有効期限は${data.expiresHours}時間）。メールが見当たらないときは迷惑メールフォルダもご確認ください。</p>`);
      $('#login-password').focus();
    } catch (err) {
      formError('#register-error', err.message);
    }
  });
}

async function onForgot(e) {
  e.preventDefault();
  $('#forgot-error').classList.add('hidden');
  const email = $('#forgot-email').value.trim();
  if (!email) return formError('#forgot-error', 'メールアドレスを入力してください。');

  await withButton($('#forgot-submit'), '送信しています…', async () => {
    try {
      const data = await api('requestTempPassword', { email });
      $('#login-email').value = data.email;
      setAuthMode('login');
      showAuthNotice(
        `<p><strong>${escapeHtml(data.email)}</strong> が登録済みであれば、仮パスワードを送信しました。</p>` +
        `<p class="mt-1">メールに書かれた仮パスワードで、下からログインしてください（有効期限は${data.expiresHours}時間）。メールが見当たらないときは迷惑メールフォルダもご確認ください。</p>`);
      $('#login-password').focus();
    } catch (err) {
      formError('#forgot-error', err.message);
    }
  });
}

async function onLogout() {
  if (!confirm('ログアウトしますか？')) return;
  api('logout').catch(() => {});
  clearSession();
  showAuth();
}

/* =========================================================
 * パスワード設定画面
 * ========================================================= */
function showPasswordView(mode) {
  state.passwordMode = mode;
  const forced = mode === 'forced';
  hideAllScreens();
  $('#view-password').classList.remove('hidden');

  $('#pw-title').textContent = forced ? '新しいパスワードの設定' : 'パスワードの変更';
  $('#pw-lead').textContent = forced
    ? '仮パスワードでログインしました。これから使うパスワードを決めてください。設定が終わると家計簿を使えるようになります。'
    : '現在のパスワードと、新しいパスワードを入力してください。変更すると、ほかの端末ではもう一度ログインが必要になります。';
  $('#pw-current-wrap').classList.toggle('hidden', forced);
  $('#pw-back').classList.toggle('hidden', forced);
  $('#pw-logout').classList.toggle('hidden', !forced);
  $('#pw-submit').textContent = forced ? 'パスワードを設定' : 'パスワードを変更';
  $('#pw-username').value = state.email || '';
  ['#pw-current', '#pw-new', '#pw-confirm'].forEach(id => { $(id).value = ''; });
  $('#pw-error').classList.add('hidden');
  (forced ? $('#pw-new') : $('#pw-current')).focus();
}

async function onPasswordSubmit(e) {
  e.preventDefault();
  $('#pw-error').classList.add('hidden');
  const forced = state.passwordMode === 'forced';
  const current = $('#pw-current').value;
  const next = $('#pw-new').value;
  const confirmValue = $('#pw-confirm').value;

  if (!forced && !current) return formError('#pw-error', '現在のパスワードを入力してください。');
  if (next.length < 8) return formError('#pw-error', '新しいパスワードは8文字以上にしてください。');
  if (!/[A-Za-z]/.test(next) || !/\d/.test(next)) return formError('#pw-error', '新しいパスワードには英字と数字を両方含めてください。');
  if (/\s/.test(next)) return formError('#pw-error', 'パスワードに空白は使えません。');
  if (next !== confirmValue) return formError('#pw-error', '確認用のパスワードが一致しません。');

  await withButton($('#pw-submit'), '保存しています…', async () => {
    try {
      const payload = forced ? { newPassword: next } : { currentPassword: current, newPassword: next };
      const data = await api('changePassword', payload);
      saveSession(data.token, data.user.email, false);
      enterApp(data.categories);
      toast(forced ? 'パスワードを設定しました' : 'パスワードを変更しました');
    } catch (err) {
      if (err.code !== 'AUTH') formError('#pw-error', err.message);
    }
  });
}

function onPasswordBack() {
  hideAllScreens();
  $('#app-shell').classList.remove('hidden');
  showView('dashboard');
}

/* =========================================================
 * ダッシュボード
 * ========================================================= */
async function loadDashboard() {
  try {
    const [summary, list] = await Promise.all([
      api('getSummary', { months: state.trendMonths }),
      api('listExpenses', { limit: state.listLimit })
    ]);
    renderSummary(summary);
    renderList(list);
  } catch (err) {
    if (err.code !== 'AUTH') toast(err.message, 'error');
  }
}

function renderSummary(s) {
  const cur = s.current;
  $('#dash-month-label').textContent = `${monthLabel(cur.month)}の支出（${cur.count}件）`;
  $('#dash-total').textContent = yen.format(cur.total);

  const prev = s.previous.total;
  const diff = cur.total - prev;
  let compare = '';
  if (prev > 0) {
    compare = diff === 0
      ? `先月（${monthLabel(s.previous.month)}）と同じです。`
      : `先月の ¥${yen.format(prev)} より ¥${yen.format(Math.abs(diff))} ${diff > 0 ? '多く使っています' : '少なく済んでいます'}。`;
  } else {
    compare = `先月（${monthLabel(s.previous.month)}）の記録はありません。`;
  }
  $('#dash-compare').textContent = compare;

  $('#dash-income').textContent = `¥${yen.format(cur.income)}`;
  $('#dash-expense').textContent = `¥${yen.format(cur.total)}`;
  setBalance($('#dash-balance'), cur.balance);
  $('#dash-income-hint').classList.toggle('hidden', cur.income > 0);

  renderDonut(cur.byCategory, cur.total);
  renderTrend(s);
  renderTrendTable(s);
}

function renderDonut(byCategory, total) {
  const canvas = $('#chart-donut');
  const empty = byCategory.length === 0;
  $('#donut-empty').classList.toggle('hidden', !empty);
  canvas.classList.toggle('invisible', empty);

  const legend = $('#dash-legend');
  legend.innerHTML = byCategory.map(c => {
    const pct = total > 0 ? Math.round((c.amount / total) * 100) : 0;
    return `<li class="flex items-center gap-3 py-2.5">
        <span class="h-3 w-3 rounded-sm shrink-0" style="background:${escapeHtml(c.color)}"></span>
        <span class="flex-1">${escapeHtml(c.category)}</span>
        <span class="text-mute text-xs num w-10 text-right">${pct}%</span>
        <span class="num font-medium w-24 text-right">¥${yen.format(c.amount)}</span>
      </li>`;
  }).join('');

  if (state.charts.donut) state.charts.donut.destroy();
  if (empty) { state.charts.donut = null; return; }

  state.charts.donut = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: byCategory.map(c => c.category),
      datasets: [{
        data: byCategory.map(c => c.amount),
        backgroundColor: byCategory.map(c => c.color),
        borderColor: '#F2F4F1',
        borderWidth: 3,
        hoverOffset: 6
      }]
    },
    options: {
      maintainAspectRatio: false,
      cutout: '66%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.label}  ¥${yen.format(c.raw)}` } }
      }
    }
  });
}

function renderTrend(s) {
  if (state.charts.trend) state.charts.trend.destroy();
  const labels = s.months.map((k, i) => {
    const [y, m] = k.split('-').map(Number);
    return (i === 0 || m === 1) ? `${String(y).slice(2)}年${m}月` : `${m}月`;
  });

  state.charts.trend = new Chart($('#chart-trend'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        ...s.series.map(x => ({
          label: x.category,
          data: x.values,
          backgroundColor: x.color,
          borderRadius: 2,
          maxBarThickness: 36,
          stack: 'total',
          order: 1
        })),
        ...(s.incomeTotals.some(v => v > 0) ? [{
          type: 'line',
          label: '収入',
          data: s.incomeTotals,
          borderColor: '#1D2733',
          backgroundColor: '#1D2733',
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 3.5,
          pointHoverRadius: 5,
          stack: 'income',
          order: 0
        }] : [])
      ]
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: '#E6E9E5' },
          ticks: { callback: v => v >= 10000 ? `${yen.format(v / 10000)}万` : yen.format(v) }
        }
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, padding: 12 } },
        tooltip: {
          filter: item => item.raw > 0,
          callbacks: {
            title: items => items.length ? monthLabel(s.months[items[0].dataIndex]) : '',
            label: c => ` ${c.dataset.label}  ¥${yen.format(c.raw)}`,
            footer: items => {
              if (!items.length) return '';
              const i = items[0].dataIndex;
              return [
                `支出合計  ¥${yen.format(s.monthTotals[i])}`,
                `収入  ¥${yen.format(s.incomeTotals[i])}`,
                `収支  ${signedYen(s.balances[i])}`
              ];
            }
          }
        }
      }
    }
  });
}

/** 種別×月の金額表（行＝種別、列＝月、右端＝期間合計、最下段＝月合計） */
function renderTrendTable(s) {
  const table = $('#trend-table');
  const nowKey = s.current.month;
  const fmt = v => v > 0 ? `¥${yen.format(v)}` : '—';
  const monthHead = k => {
    const [y, m] = k.split('-').map(Number);
    return `${String(y).slice(2)}年${m}月`;
  };
  const nowCls = k => (k === nowKey ? ' col-now' : '');

  table.querySelector('thead').innerHTML = `<tr>
      <th scope="col" class="col-name">種別</th>
      ${s.months.map(k => `<th scope="col" class="num${nowCls(k)}">${escapeHtml(monthHead(k))}</th>`).join('')}
      <th scope="col" class="col-total">期間合計</th>
    </tr>`;

  const tbody = table.querySelector('tbody');
  const tfoot = table.querySelector('tfoot');

  const rows = s.series
    .map(x => ({ ...x, total: x.values.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);

  tbody.innerHTML = !rows.length
    ? `<tr><td colspan="${s.months.length + 2}" class="text-center text-mute py-6">この期間の支出の記録はまだありません。</td></tr>`
    : rows.map(x => `<tr>
      <th scope="row" class="col-name font-normal">
        <span class="inline-flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-sm shrink-0" style="background:${escapeHtml(x.color)}"></span>${escapeHtml(x.category)}
        </span>
      </th>
      ${x.values.map((v, i) => `<td class="num text-right${v > 0 ? '' : ' zero'}${nowCls(s.months[i])}">${fmt(v)}</td>`).join('')}
      <td class="num text-right font-medium col-total">${fmt(x.total)}</td>
    </tr>`).join('');

  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const balCell = (v, extra) =>
    `<td class="num text-right${v < 0 ? ' text-shu' : v > 0 ? ' text-ai' : ' zero'}${extra}">${v === 0 ? '—' : escapeHtml(signedYen(v))}</td>`;

  tfoot.innerHTML = `<tr>
      <th scope="row" class="col-name">支出合計</th>
      ${s.monthTotals.map((v, i) => `<td class="num text-right${v > 0 ? '' : ' zero'}${nowCls(s.months[i])}">${fmt(v)}</td>`).join('')}
      <td class="num text-right col-total">${fmt(sum(s.monthTotals))}</td>
    </tr>
    <tr class="row-income">
      <th scope="row" class="col-name">収入</th>
      ${s.incomeTotals.map((v, i) => `<td class="num text-right${v > 0 ? '' : ' zero'}${nowCls(s.months[i])}">${fmt(v)}</td>`).join('')}
      <td class="num text-right col-total">${fmt(sum(s.incomeTotals))}</td>
    </tr>
    <tr class="row-balance">
      <th scope="row" class="col-name">収支</th>
      ${s.balances.map((v, i) => balCell(v, nowCls(s.months[i]))).join('')}
      ${balCell(sum(s.balances), ' col-total')}
    </tr>`;
}

function renderList(list) {
  state.expenses.clear();
  list.items.forEach(x => state.expenses.set(x.id, x));

  const ul = $('#expense-list');
  $('#list-empty').classList.toggle('hidden', list.total > 0);
  $('#list-count').textContent = list.total > 0 ? `全${list.total}件` : '';
  $('#btn-more').classList.toggle('hidden', list.items.length >= list.total);

  ul.innerHTML = list.items.map(x => {
    const title = x.store || x.memo || x.category;
    const parts = (x.breakdown && x.breakdown.length) ? x.breakdown : [{ category: x.category, amount: x.amount }];
    const stripe = stripeStyle(parts);
    const catLabel = parts.length > 1
      ? parts.map(p => `${p.category} ¥${yen.format(p.amount)}`).join('／')
      : parts[0].category;
    const sub = x.store && x.memo ? `<span class="truncate">${escapeHtml(x.memo)}</span>` : '';
    const receipt = x.imageUrl
      ? `<a href="${escapeHtml(x.imageUrl)}" target="_blank" rel="noopener" class="text-ai underline underline-offset-2 shrink-0">レシート</a>`
      : '';
    return `<li class="flex items-center gap-3 py-3 border-b border-rule">
        <span class="w-1.5 self-stretch rounded-full shrink-0" style="${escapeHtml(stripe)}"></span>
        <div class="flex-1 min-w-0">
          <p class="truncate font-medium">${escapeHtml(title)}</p>
          <p class="text-xs text-mute mt-0.5 flex gap-2 min-w-0">
            <span class="num shrink-0">${escapeHtml(shortDate(x.date))}</span>
            <span class="${parts.length > 1 ? 'truncate' : 'shrink-0'}">${escapeHtml(catLabel)}</span>
            ${receipt}
            ${sub}
          </p>
        </div>
        <p class="num font-medium text-right shrink-0">¥${yen.format(x.amount)}</p>
        <div class="flex gap-1 shrink-0">
          <button type="button" data-edit="${escapeHtml(x.id)}" class="rounded-md px-2 py-1.5 text-xs border border-rule bg-white hover:border-ink">編集</button>
          <button type="button" data-delete="${escapeHtml(x.id)}" class="rounded-md px-2 py-1.5 text-xs text-shu hover:bg-shu hover:text-white">削除</button>
        </div>
      </li>`;
  }).join('');
}

/** 種別ごとの金額比率で、明細の左端の色帯を塗り分ける */
function stripeStyle(parts) {
  const total = parts.reduce((s, p) => s + p.amount, 0);
  if (parts.length === 1 || total <= 0) return `background:${categoryColor(parts[0].category)}`;
  let acc = 0;
  const stops = parts.map(p => {
    const from = (acc / total) * 100;
    acc += p.amount;
    const to = (acc / total) * 100;
    const c = categoryColor(p.category);
    return `${c} ${from.toFixed(1)}% ${to.toFixed(1)}%`;
  });
  return `background:linear-gradient(to bottom, ${stops.join(', ')})`;
}

async function onListClick(e) {
  const editBtn = e.target.closest('[data-edit]');
  const delBtn = e.target.closest('[data-delete]');
  if (editBtn) startEdit(editBtn.dataset.edit);
  if (delBtn) deleteExpense(delBtn.dataset.delete);
}

async function deleteExpense(id) {
  const x = state.expenses.get(id);
  const label = x ? `${shortDate(x.date)}「${x.store || x.category}」¥${yen.format(x.amount)}` : 'この明細';
  if (!confirm(`${label} を削除しますか？\nレシート画像もGoogleドライブのゴミ箱へ移動します。`)) return;
  setOverlay(true, '削除しています…');
  try {
    await api('deleteExpense', { id });
    toast('削除しました');
    await loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setOverlay(false);
  }
}

/* =========================================================
 * 記録フォーム
 * ========================================================= */
function renderCategoryOptions() {
  const sel = $('#f-category');
  const current = sel.value;
  sel.innerHTML = categoryOptionsHtml();
  sel.value = state.categories.some(c => c.name === current) ? current : (state.categories[0]?.name || '');
  sel.dataset.prev = sel.value;
}

function setMode(mode) {
  state.mode = mode;
  setPressed($$('[data-mode]'), b => b.dataset.mode === mode);
  resetEntry(mode);
}

function resetEntry(mode) {
  state.editingId = null;
  $('#add-title').textContent = '支出を記録';
  $('#mode-switch').classList.remove('hidden');
  $('#btn-save').textContent = 'この内容で登録';
  $('#receipt-pane').classList.toggle('hidden', mode !== 'receipt');
  $('#analyze-warning').classList.add('hidden');
  $('#receipt-thumb').classList.add('hidden');
  $('#receipt-thumb').removeAttribute('src');

  fillForm({
    id: '', date: todayStr(), store: '', category: state.categories[0]?.name || '',
    amount: '', memo: '', items: [], imageUrl: ''
  });
  $('#items-section').classList.add('hidden');
  // レシートモードでは解析が終わるまでフォームを出さない
  $('#entry-wrap').classList.toggle('hidden', mode === 'receipt');
}

function fillForm(x) {
  $('#f-id').value = x.id || '';
  $('#f-date').value = x.date || todayStr();
  $('#f-store').value = x.store || '';
  $('#f-category').value = state.categories.some(c => c.name === x.category)
    ? x.category : (state.categories.find(c => c.name === 'その他')?.name || '');
  $('#f-category').dataset.prev = $('#f-category').value;
  $('#f-amount').value = (x.amount ?? '') === '' ? '' : String(x.amount);
  $('#f-memo').value = x.memo || '';
  $('#f-image-url').value = x.imageUrl || '';
  $('#f-image-link').href = x.imageUrl || '#';
  $('#f-image-link-wrap').classList.toggle('hidden', !x.imageUrl);
  $('#entry-error').classList.add('hidden');
  renderItems(x.items || []);
}

function showForm(withItems) {
  $('#items-section').classList.toggle('hidden', !withItems);
  const wrap = $('#entry-wrap');
  wrap.classList.remove('hidden');
  const form = $('#entry-form');
  form.classList.remove('print-in');
  void form.offsetWidth; // アニメーション再生のためのリフロー
  form.classList.add('print-in');
}

function startEdit(id) {
  const x = state.expenses.get(id);
  if (!x) return;
  showView('add');
  state.editingId = id;
  $('#add-title').textContent = '明細を編集';
  $('#mode-switch').classList.add('hidden');
  $('#receipt-pane').classList.add('hidden');
  $('#btn-save').textContent = '変更を保存';
  fillForm(x);
  showForm(true);
}

/* ---- 品目と種別 ---- */
function categoryOptionsHtml() {
  return state.categories
    .map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
    .join('') + `<option value="${MANAGE_VALUE}">＋ 種別を追加・編集…</option>`;
}

function renderItems(items) {
  const wrap = $('#items-wrap');
  wrap.innerHTML = '';
  items.forEach(addItemRow);
  updateItemsBreakdown();
}

function paintItemCategory(select) {
  select.style.borderLeftColor = categoryColor(select.value);
}

function addItemRow(item = { name: '', price: '', category: '' }) {
  const row = document.createElement('div');
  row.className = 'item-row py-2 text-sm';
  row.innerHTML = `
    <div class="flex items-center gap-2">
      <input type="text" class="item-name rc-input flex-1 min-w-0" maxlength="100" placeholder="品名" aria-label="品名">
      <input type="number" class="item-price rc-input num text-right w-24" inputmode="numeric" step="1" placeholder="0" aria-label="金額">
      <button type="button" class="item-remove text-mute hover:text-shu px-1 text-lg leading-none" aria-label="この品目を削除">×</button>
    </div>
    <label class="mt-1 flex items-center gap-2 text-xs text-mute">
      <span class="shrink-0">種別</span>
      <select class="item-category rounded border border-rule border-l-4 bg-white px-2 py-1 text-xs text-ink" aria-label="この品目の種別">${categoryOptionsHtml()}</select>
    </label>`;

  const name = row.querySelector('.item-name');
  const price = row.querySelector('.item-price');
  const cat = row.querySelector('.item-category');
  name.value = item.name || '';
  price.value = item.price === '' || item.price == null ? '' : String(item.price);
  cat.value = state.categories.some(c => c.name === item.category) ? item.category : $('#f-category').value;
  cat.dataset.prev = cat.value;
  paintItemCategory(cat);

  cat.addEventListener('change', () => {
    if (cat.value === MANAGE_VALUE) {
      cat.value = cat.dataset.prev;
      openCategoryDialog();
      return;
    }
    cat.dataset.prev = cat.value;
    paintItemCategory(cat);
    updateItemsBreakdown();
  });
  price.addEventListener('input', updateItemsBreakdown);
  name.addEventListener('input', updateItemsBreakdown);
  row.querySelector('.item-remove').addEventListener('click', () => { row.remove(); updateItemsBreakdown(); });
  $('#items-wrap').appendChild(row);
  return row;
}

function collectItems() {
  return $$('.item-row').map(r => ({
    name: r.querySelector('.item-name').value.trim(),
    price: parseInt(r.querySelector('.item-price').value, 10),
    category: r.querySelector('.item-category').value
  })).filter(i => i.name && Number.isFinite(i.price));
}

/** 種別ごとの品目小計を表示（2種別以上のときだけ） */
function updateItemsBreakdown() {
  const el = $('#items-breakdown');
  const sums = {};
  collectItems().forEach(i => { sums[i.category] = (sums[i.category] || 0) + i.price; });
  const cats = state.categories.map(c => c.name).filter(n => sums[n] !== undefined);
  if (cats.length < 2) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.innerHTML = '<p class="text-mute">種別ごとの小計</p>' + cats.map(n => `
    <p class="flex items-center gap-2">
      <span class="h-2.5 w-2.5 rounded-sm shrink-0" style="background:${escapeHtml(categoryColor(n))}"></span>
      <span class="flex-1">${escapeHtml(n)}</span>
      <span class="num">¥${yen.format(sums[n])}</span>
    </p>`).join('');
  el.classList.remove('hidden');
}

/** 全体カテゴリを変えたら、それまで全体カテゴリと同じだった品目の種別も追従させる */
function onOverallCategoryChange() {
  const sel = $('#f-category');
  const prev = sel.dataset.prev;
  if (sel.value === MANAGE_VALUE) {
    sel.value = prev;
    openCategoryDialog();
    return;
  }
  $$('.item-category').forEach(s => {
    if (s.value === prev) { s.value = sel.value; s.dataset.prev = sel.value; paintItemCategory(s); }
  });
  sel.dataset.prev = sel.value;
  updateItemsBreakdown();
}

function onItemsAll() {
  const v = $('#f-category').value;
  const selects = $$('.item-category');
  if (!selects.length) { toast('品目がありません。', 'error'); return; }
  selects.forEach(s => { s.value = v; s.dataset.prev = v; paintItemCategory(s); });
  updateItemsBreakdown();
  toast(`全品目の種別を「${v}」にしました`);
}

function onSumItems() {
  const items = collectItems();
  if (!items.length) { toast('金額の入った品目がありません。', 'error'); return; }
  $('#f-amount').value = String(items.reduce((s, i) => s + i.price, 0));
}

/* =========================================================
 * 収入
 * ========================================================= */
const DEFAULT_INCOME_SOURCES = ['給与', '年金', '賞与', '副業', '臨時収入', 'その他'];

async function loadIncomes() {
  const month = state.incomeMonth;
  $('#inc-month').value = month;
  try {
    const data = await api('listIncomes', { month });
    if (month !== state.incomeMonth) return; // 読み込み中に月が変わった
    renderIncomes(data);
  } catch (err) {
    if (err.code !== 'AUTH' && err.code !== 'MUST_CHANGE') toast(err.message, 'error');
  }
}

function renderIncomes(data) {
  state.incomes.clear();
  data.items.forEach(x => state.incomes.set(x.id, x));

  $('#inc-sum-income').textContent = `¥${yen.format(data.income)}`;
  $('#inc-sum-expense').textContent = `¥${yen.format(data.expense)}`;
  $('#inc-sum-label').textContent = `${monthLabel(data.month)}の収支`;
  setBalance($('#inc-sum-balance'), data.balance);

  $('#inc-empty').classList.toggle('hidden', data.items.length > 0);
  $('#inc-copy-prev').textContent = `${monthLabel(shiftMonth(data.month, -1))}の収入をコピーする`;

  $('#inc-list').innerHTML = data.items.map(x => `<li class="flex items-center gap-3 py-3 border-b border-rule">
      <div class="min-w-0 flex-1">
        <p class="truncate font-medium">${escapeHtml(x.source)}</p>
        ${x.memo ? `<p class="truncate text-xs text-mute mt-0.5">${escapeHtml(x.memo)}</p>` : ''}
      </div>
      <p class="num font-medium text-right shrink-0">¥${yen.format(x.amount)}</p>
      <div class="flex gap-1 shrink-0">
        <button type="button" data-inc-edit="${escapeHtml(x.id)}" class="rounded-md px-2 py-1.5 text-xs border border-rule bg-white hover:border-ink">編集</button>
        <button type="button" data-inc-delete="${escapeHtml(x.id)}" class="rounded-md px-2 py-1.5 text-xs text-shu hover:bg-shu hover:text-white">削除</button>
      </div>
    </li>`).join('');

  const sources = [...new Set([...(data.sources || []), ...DEFAULT_INCOME_SOURCES])];
  $('#inc-source-list').innerHTML = sources.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
}

function setIncomeMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  state.incomeMonth = month;
  resetIncomeForm();
  loadIncomes();
}

function resetIncomeForm() {
  $('#inc-id').value = '';
  $('#inc-source').value = '';
  $('#inc-amount').value = '';
  $('#inc-memo').value = '';
  $('#inc-form-title').textContent = '収入を追加';
  $('#inc-save').textContent = '追加する';
  $('#inc-cancel').classList.add('hidden');
  $('#inc-error').classList.add('hidden');
}

function startIncomeEdit(id) {
  const x = state.incomes.get(id);
  if (!x) return;
  $('#inc-id').value = x.id;
  $('#inc-source').value = x.source;
  $('#inc-amount').value = String(x.amount);
  $('#inc-memo').value = x.memo;
  $('#inc-form-title').textContent = '収入を編集';
  $('#inc-save').textContent = '変更を保存';
  $('#inc-cancel').classList.remove('hidden');
  $('#inc-error').classList.add('hidden');
  $('#inc-form').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('#inc-amount').focus();
}

async function onIncomeSave(e) {
  e.preventDefault();
  const errEl = $('#inc-error');
  errEl.classList.add('hidden');
  const fail = msg => { errEl.textContent = msg; errEl.classList.remove('hidden'); };

  const id = $('#inc-id').value;
  const source = $('#inc-source').value.trim();
  const amount = parseInt($('#inc-amount').value, 10);
  if (!source) return fail('種類を入力してください（例：給与、年金）。');
  if (!Number.isFinite(amount) || amount < 0) return fail('金額を0以上の数字で入力してください。');

  await withButton($('#inc-save'), '保存しています…', async () => {
    try {
      await api('saveIncome', { id: id || undefined, month: state.incomeMonth, source, amount, memo: $('#inc-memo').value.trim() });
      toast(id ? '変更を保存しました' : '収入を追加しました');
      resetIncomeForm();
      await loadIncomes();
    } catch (err) {
      fail(err.message);
    }
  });
}

async function onIncomeListClick(e) {
  const edit = e.target.closest('[data-inc-edit]');
  const del = e.target.closest('[data-inc-delete]');
  if (edit) startIncomeEdit(edit.dataset.incEdit);
  if (del) {
    const x = state.incomes.get(del.dataset.incDelete);
    if (!x) return;
    if (!confirm(`${monthLabel(state.incomeMonth)}の「${x.source}」¥${yen.format(x.amount)} を削除しますか？`)) return;
    setOverlay(true, '削除しています…');
    try {
      await api('deleteIncome', { id: x.id });
      toast('削除しました');
      if ($('#inc-id').value === x.id) resetIncomeForm();
      await loadIncomes();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setOverlay(false);
    }
  }
}

async function onIncomeCopyPrev() {
  const from = shiftMonth(state.incomeMonth, -1);
  setOverlay(true, 'コピーしています…');
  try {
    const data = await api('copyIncomes', { from, to: state.incomeMonth });
    toast(`${monthLabel(from)}の収入を${data.copied}件コピーしました`);
    await loadIncomes();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setOverlay(false);
  }
}

/* =========================================================
 * 種別（カテゴリ）の設定
 * ========================================================= */
function openCategoryDialog() {
  state.catEdit = null;
  $('#cat-error').classList.add('hidden');
  $('#cat-add-name').value = '';
  renderCategoryList();
  const dlg = $('#cat-dialog');
  if (!dlg.open) dlg.showModal();
}

function closeCategoryDialog() {
  $('#cat-dialog').close();
}

function onCategoryDialogClosed() {
  state.catEdit = null;
  if (state.categoriesChanged) {
    state.categoriesChanged = false;
    if (state.view === 'dashboard') loadDashboard();
  }
}

function renderCategoryList() {
  const list = state.categories;
  const movable = list.filter(c => c.name !== FALLBACK_CATEGORY);
  const ed = state.catEdit;

  $('#cat-list').innerHTML = list.map(c => {
    const n = escapeHtml(c.name);
    const isFallback = c.name === FALLBACK_CATEGORY;

    if (ed && ed.name === c.name && ed.mode === 'edit') {
      return `<li class="py-3" data-name="${n}">
          <div class="flex items-center gap-2">
            <input type="color" class="cat-edit-color h-10 w-12 shrink-0 cursor-pointer rounded border border-rule bg-white p-1" value="${escapeHtml(c.color)}" aria-label="色">
            <input type="text" class="cat-edit-name field min-w-0 flex-1" maxlength="20" value="${n}" aria-label="名前" ${isFallback ? 'disabled' : ''}>
          </div>
          <div class="mt-2 flex justify-end gap-2">
            <button type="button" data-cat-act="cancel" class="rounded-md border border-rule px-3 py-1.5 text-sm">やめる</button>
            <button type="button" data-cat-act="save" class="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white">変更を保存</button>
          </div>
        </li>`;
    }

    if (ed && ed.name === c.name && ed.mode === 'delete') {
      const options = list.filter(x => x.name !== c.name)
        .map(x => `<option value="${escapeHtml(x.name)}" ${x.name === FALLBACK_CATEGORY ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
      return `<li class="py-3" data-name="${n}">
          <p class="text-sm">「${n}」を削除します。この種別で登録済みの支出と品目は、次の種別に移します。</p>
          <label class="mt-2 flex items-center gap-2 text-sm">
            <span class="shrink-0 text-mute">移動先</span>
            <select class="cat-move-to field py-2">${options}</select>
          </label>
          <div class="mt-2 flex justify-end gap-2">
            <button type="button" data-cat-act="cancel" class="rounded-md border border-rule px-3 py-1.5 text-sm">やめる</button>
            <button type="button" data-cat-act="confirm-delete" class="rounded-md bg-shu px-3 py-1.5 text-sm font-medium text-white">削除する</button>
          </div>
        </li>`;
    }

    const i = movable.findIndex(x => x.name === c.name);
    const upDisabled = isFallback || i <= 0;
    const downDisabled = isFallback || i >= movable.length - 1;
    return `<li class="flex items-center gap-2 py-2.5" data-name="${n}">
        <span class="h-4 w-4 shrink-0 rounded" style="background:${escapeHtml(c.color)}"></span>
        <span class="min-w-0 flex-1 truncate">${n}</span>
        <button type="button" data-cat-act="up" class="rounded-md px-2 py-1 text-mute hover:text-ink disabled:opacity-25" aria-label="「${n}」を上へ" ${upDisabled ? 'disabled' : ''}>↑</button>
        <button type="button" data-cat-act="down" class="rounded-md px-2 py-1 text-mute hover:text-ink disabled:opacity-25" aria-label="「${n}」を下へ" ${downDisabled ? 'disabled' : ''}>↓</button>
        <button type="button" data-cat-act="edit" class="rounded-md border border-rule px-2 py-1.5 text-xs hover:border-ink">編集</button>
        ${isFallback
          ? '<span class="w-[2.6rem]"></span>'
          : `<button type="button" data-cat-act="delete" class="rounded-md px-2 py-1.5 text-xs text-shu hover:bg-shu hover:text-white">削除</button>`}
      </li>`;
  }).join('');

  const focusEl = $('#cat-list .cat-edit-name:not([disabled])') || $('#cat-list .cat-edit-color') || $('#cat-list .cat-move-to');
  if (focusEl) focusEl.focus();
}

/** 種別一覧が変わったとき、フォームの選択欄をすべて作り直す（rename: {旧名: 新名}） */
function applyCategories(categories, rename = {}) {
  state.categories = categories;
  state.categoriesChanged = true;
  const valid = v => state.categories.some(c => c.name === v) ? v : FALLBACK_CATEGORY;
  const fix = v => valid(rename[v] ?? v);

  const f = $('#f-category');
  const fv = fix(f.value);
  f.innerHTML = categoryOptionsHtml();
  f.value = fv;
  f.dataset.prev = fv;

  $$('.item-category').forEach(sel => {
    const v = fix(sel.value);
    sel.innerHTML = categoryOptionsHtml();
    sel.value = v;
    sel.dataset.prev = v;
    paintItemCategory(sel);
  });
  updateItemsBreakdown();
  renderCategoryList();
}

async function categoryRequest(action, payload, rename) {
  const dlg = $('#cat-dialog');
  $('#cat-error').classList.add('hidden');
  dlg.classList.add('opacity-60', 'pointer-events-none');
  dlg.setAttribute('aria-busy', 'true');
  try {
    const data = await api(action, payload);
    state.catEdit = null;
    applyCategories(data.categories, rename);
    return data;
  } catch (err) {
    const el = $('#cat-error');
    el.textContent = err.message;
    el.classList.remove('hidden');
    return null;
  } finally {
    dlg.classList.remove('opacity-60', 'pointer-events-none');
    dlg.removeAttribute('aria-busy');
  }
}

async function onCategoryListClick(e) {
  const btn = e.target.closest('[data-cat-act]');
  if (!btn) return;
  const li = btn.closest('li');
  const name = li.dataset.name;
  const act = btn.dataset.catAct;

  if (act === 'edit' || act === 'delete') {
    state.catEdit = { name, mode: act };
    $('#cat-error').classList.add('hidden');
    renderCategoryList();
    return;
  }
  if (act === 'cancel') {
    state.catEdit = null;
    renderCategoryList();
    return;
  }

  if (act === 'up' || act === 'down') {
    const names = state.categories.map(c => c.name).filter(n => n !== FALLBACK_CATEGORY);
    const i = names.indexOf(name);
    const j = act === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    await categoryRequest('reorderCategories', { names });
    return;
  }

  if (act === 'save') {
    const newName = li.querySelector('.cat-edit-name').value.trim();
    const color = li.querySelector('.cat-edit-color').value;
    if (!newName) {
      $('#cat-error').textContent = '種別の名前を入力してください。';
      $('#cat-error').classList.remove('hidden');
      return;
    }
    const data = await categoryRequest('updateCategory', { oldName: name, name: newName, color }, { [name]: newName });
    if (data) toast(data.changedExpenses ? `変更しました（${data.changedExpenses}件の支出も更新）` : '変更しました');
    return;
  }

  if (act === 'confirm-delete') {
    const moveTo = li.querySelector('.cat-move-to').value;
    const data = await categoryRequest('deleteCategory', { name, moveTo }, { [name]: moveTo });
    if (data) toast(data.changedExpenses ? `削除しました（${data.changedExpenses}件の支出を「${moveTo}」に移動）` : '削除しました');
  }
}

async function onCategoryAdd(e) {
  e.preventDefault();
  const name = $('#cat-add-name').value.trim();
  const color = $('#cat-add-color').value;
  if (!name) {
    $('#cat-error').textContent = '追加する種別の名前を入力してください。';
    $('#cat-error').classList.remove('hidden');
    $('#cat-add-name').focus();
    return;
  }
  const data = await categoryRequest('addCategory', { name, color });
  if (data) {
    $('#cat-add-name').value = '';
    toast(`「${name}」を追加しました`);
  }
}

/* ---- 保存 ---- */
async function onSave(e) {
  e.preventDefault();
  const errEl = $('#entry-error');
  const fail = msg => { errEl.textContent = msg; errEl.classList.remove('hidden'); };
  errEl.classList.add('hidden');

  const payload = {
    id: state.editingId || undefined,
    date: $('#f-date').value,
    store: $('#f-store').value.trim(),
    category: $('#f-category').value,
    amount: parseInt($('#f-amount').value, 10),
    memo: $('#f-memo').value.trim(),
    items: $('#items-section').classList.contains('hidden') && !state.editingId ? [] : collectItems(),
    imageUrl: $('#f-image-url').value
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) return fail('日付を入力してください。');
  if (!Number.isFinite(payload.amount) || payload.amount < 0) return fail('合計金額を0以上の数字で入力してください。');
  if (!payload.category) return fail('カテゴリを選んでください。');

  const btn = $('#btn-save');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '保存しています…';
  try {
    await api('saveExpense', payload);
    toast(state.editingId ? '変更を保存しました' : '登録しました');
    state.editingId = null;
    showView('dashboard');
  } catch (err) {
    fail(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function onCancel() {
  if (state.editingId) { state.editingId = null; showView('dashboard'); return; }
  resetEntry(state.mode);
}

/* =========================================================
 * レシート画像
 * ========================================================= */
function fileToJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
        resolve({ dataUrl, base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
      } catch (e) {
        reject(new Error('画像の変換に失敗しました。別の画像でお試しください。'));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('この画像は読み込めませんでした。JPGまたはPNGの画像を選んでください。'));
    };
    img.src = url;
  });
}

async function onFileSelected(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = ''; // 同じ画像を選び直せるようにする
  if (!file) return;

  const warn = $('#analyze-warning');
  warn.classList.add('hidden');
  $('#entry-wrap').classList.add('hidden');

  let img;
  try {
    img = await fileToJpeg(file);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const thumb = $('#receipt-thumb');
  thumb.src = img.dataUrl;
  thumb.classList.remove('hidden');

  setOverlay(true, 'レシートを読み取っています…');
  try {
    const res = await api('analyzeReceipt', { imageBase64: img.base64, mimeType: img.mimeType });
    const p = res.parsed;
    fillForm({
      id: '',
      date: p?.date || todayStr(),
      store: p?.store || '',
      category: p?.category || 'その他',
      amount: p ? p.total : '',
      memo: '',
      items: p?.items || [],
      imageUrl: res.imageUrl
    });
    showForm(true);

    const notes = [];
    if (res.warning) notes.push(res.warning);
    if (p && !p.dateDetected) notes.push('日付が読み取れなかったため、今日の日付を入れています。');
    if (notes.length) {
      warn.textContent = notes.join(' ');
      warn.classList.remove('hidden');
    }
    $('#entry-wrap').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setOverlay(false);
  }
}

/* =========================================================
 * 初期化
 * ========================================================= */
function bindEvents() {
  $$('[data-auth-mode]').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.authMode)));
  $('#form-login').addEventListener('submit', onLogin);
  $('#form-register').addEventListener('submit', onRegister);
  $('#form-forgot').addEventListener('submit', onForgot);
  $('#btn-logout').addEventListener('click', onLogout);
  $('#btn-change-password').addEventListener('click', () => showPasswordView('voluntary'));

  $$('[data-pw-toggle]').forEach(b => b.addEventListener('click', () => {
    setPasswordVisible(b, b.getAttribute('aria-pressed') !== 'true');
    document.getElementById(b.dataset.pwToggle).focus();
  }));
  $('#form-password').addEventListener('submit', onPasswordSubmit);
  $('#pw-back').addEventListener('click', onPasswordBack);
  $('#pw-logout').addEventListener('click', () => {
    api('logout').catch(() => {});
    clearSession();
    showAuth();
  });

  document.addEventListener('click', e => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      state.editingId = null;
      showView(nav.dataset.nav);
    }
  });

  $$('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  $$('[data-months]').forEach(b => b.addEventListener('click', async () => {
    state.trendMonths = Number(b.dataset.months);
    setPressed($$('[data-months]'), x => x === b);
    try {
      renderSummary(await api('getSummary', { months: state.trendMonths }));
    } catch (err) {
      if (err.code !== 'AUTH') toast(err.message, 'error');
    }
  }));

  $('#btn-more').addEventListener('click', async () => {
    state.listLimit += LIST_PAGE;
    try {
      renderList(await api('listExpenses', { limit: state.listLimit }));
    } catch (err) {
      if (err.code !== 'AUTH') toast(err.message, 'error');
    }
  });

  $('#expense-list').addEventListener('click', onListClick);
  $('#file-camera').addEventListener('change', onFileSelected);
  $('#file-library').addEventListener('change', onFileSelected);
  $('#btn-add-item').addEventListener('click', () => addItemRow().querySelector('.item-name').focus());
  $('#btn-sum-items').addEventListener('click', onSumItems);
  $('#btn-items-all').addEventListener('click', onItemsAll);
  $('#f-category').addEventListener('change', onOverallCategoryChange);

  $('#btn-open-categories').addEventListener('click', openCategoryDialog);

  $('#inc-month').addEventListener('change', e => setIncomeMonth(e.target.value));
  $('#inc-prev').addEventListener('click', () => setIncomeMonth(shiftMonth(state.incomeMonth, -1)));
  $('#inc-next').addEventListener('click', () => setIncomeMonth(shiftMonth(state.incomeMonth, 1)));
  $('#inc-form').addEventListener('submit', onIncomeSave);
  $('#inc-cancel').addEventListener('click', resetIncomeForm);
  $('#inc-list').addEventListener('click', onIncomeListClick);
  $('#inc-copy-prev').addEventListener('click', onIncomeCopyPrev);
  $('#cat-close').addEventListener('click', closeCategoryDialog);
  $('#cat-dialog').addEventListener('close', onCategoryDialogClosed);
  $('#cat-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) closeCategoryDialog(); });
  $('#cat-list').addEventListener('click', onCategoryListClick);
  $('#cat-add-form').addEventListener('submit', onCategoryAdd);
  $('#entry-form').addEventListener('submit', onSave);
  $('#btn-cancel').addEventListener('click', onCancel);
}

function setupChartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.font.family = '"Zen Kaku Gothic New", "Hiragino Sans", sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#66707C';
}

async function init() {
  setupChartDefaults();
  bindEvents();

  if (!loadSession()) { showAuth(); return; }

  setOverlay(true, '読み込んでいます…');
  try {
    const data = await api('me');
    saveSession(state.token, data.user.email, data.mustChange);
    if (data.mustChange) showPasswordView('forced');
    else enterApp(data.categories);
  } catch (err) {
    clearSession();
    showAuth();
    if (err.code !== 'AUTH') toast(err.message, 'error');
  } finally {
    setOverlay(false);
  }
}

document.addEventListener('DOMContentLoaded', init);
