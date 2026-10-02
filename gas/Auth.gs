/**
 * ==========================================================
 * MapTube 認証モジュール (Auth.gs)
 * ----------------------------------------------------------
 * ・新規登録：仮パスワード（有効期限つき）をメール送信 → 初回ログインで本パスワード設定を強制
 * ・パスワード再発行：再設定用の仮パスワードを発行（現在のパスワードは変更完了まで有効）
 * ・ハッシュ：GASでは bcrypt が使えないため SHA-256 + ソルト + ペッパー + ストレッチング
 *   （Node.js等へ移行する場合は bcrypt / argon2 に置き換え。hashは "h1$" で版管理）
 * ・セッション：CacheService（最大6時間）。パスワード変更で他端末のセッションも無効化
 * ・ログイン5回失敗で15分ロック
 * Code.gs と同じGASプロジェクトに置いてください。
 * ==========================================================
 */

var AUTH = {
  USER_SHEET: 'AuthUsers',
  TEMP_TTL_REGISTER_HOURS: 24,   // 新規登録の仮パスワード有効期限
  TEMP_TTL_RESET_HOURS: 1,       // 再発行の仮パスワード有効期限
  SESSION_TTL_SEC: 21600,        // セッション有効期間（CacheServiceの上限が6時間）
  HASH_ITERATIONS: 1000,         // ストレッチ回数（重い場合は500程度に）
  MAX_FAILED_LOGINS: 5,
  LOCK_MINUTES: 15,
  RESET_COOLDOWN_SEC: 300,       // 再発行メールの連続送信を防ぐ間隔
  PW_MIN: 8,
  PW_MAX: 64,
  SHOW_TEMP_PASSWORD_ON_SCREEN: false, // trueで仮パスワードを画面にも表示（テスト用。本番はfalse）
  APP_NAME: 'MapTube',
  APP_URL: 'https://kenken6291.github.io/video-pin-map/', // ★実際の公開URLに変更
  TZ: 'Asia/Tokyo'
};

var USER_HEADERS = [
  'user_id', 'email', 'username',
  'password_hash', 'password_salt',
  'is_temporary_password', 'temp_password_hash', 'temp_password_salt', 'temp_password_expires_at',
  'failed_login_count', 'locked_until', 'last_reset_requested_at',
  'session_version', 'status',
  'created_at', 'updated_at', 'last_login_at', 'password_changed_at'
];

/** 初期設定（Code.gs の setup() から呼ばれる） */
function authSetup_() {
  getPepper_();
  ensureSheet_(AUTH.USER_SHEET, USER_HEADERS);
}

/* ==========================================================
   API ハンドラ
   ========================================================== */

/** 新規登録：仮パスワードを発行して送信 */
function authRegister_(p) {
  var email = normEmail_(p.email);
  var username = String(p.username || '').trim();
  if (!isEmail_(email)) fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません');
  if (!username || username.length > 20) fail_('INVALID_USERNAME', 'ユーザー名は1〜20文字で入力してください');

  var temp = generateTempPassword_();
  var expires = new Date(Date.now() + AUTH.TEMP_TTL_REGISTER_HOURS * 3600 * 1000);

  withLock_(function () {
    var t = readTable_(AUTH.USER_SHEET, USER_HEADERS);
    var u = findRow_(t, 'email', email);
    if (u && u.status && u.status !== 'active') fail_('ACCOUNT_SUSPENDED', 'このアカウントは利用停止中です');
    if (u && u.password_hash) {
      fail_('EMAIL_EXISTS', 'このメールアドレスは登録済みです。パスワードを忘れた場合は「パスワードをお忘れの方はこちら」から再発行してください');
    }
    var now = new Date();
    var salt = newSalt_();
    var fields = {
      username: username,
      is_temporary_password: true,
      temp_password_hash: hashPassword_(temp, salt),
      temp_password_salt: salt,
      temp_password_expires_at: expires,
      failed_login_count: 0,
      locked_until: '',
      updated_at: now
    };
    if (u) {
      // 仮パスワードのまま本登録が終わっていない人の再申請 → 仮パスワードを再発行
      Object.assign(u, fields);
      writeRow_(t, u);
    } else {
      appendRow_(t, Object.assign({
        user_id: newId_('u'),
        email: email,
        password_hash: '',
        password_salt: '',
        last_reset_requested_at: '',
        session_version: 1,
        status: 'active',
        created_at: now,
        last_login_at: '',
        password_changed_at: ''
      }, fields));
    }
  });

  var mailed = sendTempPasswordMail_(email, username, temp, expires, 'register');
  if (!mailed && !AUTH.SHOW_TEMP_PASSWORD_ON_SCREEN) {
    fail_('MAIL_FAILED', 'メールを送信できませんでした。時間をおいてもう一度お試しください');
  }
  var res = {
    ok: true,
    message: mailed ? email + ' に仮パスワードを送信しました。' : '仮パスワードを発行しました。',
    expiresAt: expires.toISOString()
  };
  if (AUTH.SHOW_TEMP_PASSWORD_ON_SCREEN) res.tempPassword = temp;
  return res;
}

/** ログイン（本パスワード / 仮パスワードの両方に対応） */
function authLogin_(p) {
  var email = normEmail_(p.email);
  var pw = String(p.password || '');
  var GENERIC = 'メールアドレスまたはパスワードが正しくありません';
  if (!email || !pw) fail_('INVALID_CREDENTIALS', GENERIC);

  return withLock_(function () {
    var t = readTable_(AUTH.USER_SHEET, USER_HEADERS);
    var u = findRow_(t, 'email', email);
    if (!u) fail_('INVALID_CREDENTIALS', GENERIC);
    if (u.status !== 'active') fail_('ACCOUNT_SUSPENDED', 'このアカウントは利用停止中です');

    var now = Date.now();
    var lockedUntil = toTime_(u.locked_until);
    if (lockedUntil > now) {
      fail_('ACCOUNT_LOCKED', 'ログインに続けて失敗したため、一時的にロックしています。' +
        Math.ceil((lockedUntil - now) / 60000) + '分後にもう一度お試しください');
    }

    var ok = false, viaTemp = false;
    if (u.password_hash && verify_(pw, u.password_salt, u.password_hash)) {
      ok = true;
    } else if (isTrue_(u.is_temporary_password) && u.temp_password_hash &&
               verify_(pw, u.temp_password_salt, u.temp_password_hash)) {
      if (toTime_(u.temp_password_expires_at) > now) {
        ok = true;
        viaTemp = true;
      } else {
        fail_('TEMP_EXPIRED', '仮パスワードの有効期限が切れています。新規登録または「パスワードをお忘れの方はこちら」からもう一度発行してください');
      }
    }

    if (!ok) {
      var n = Number(u.failed_login_count || 0) + 1;
      if (n >= AUTH.MAX_FAILED_LOGINS) {
        u.failed_login_count = 0;
        u.locked_until = new Date(now + AUTH.LOCK_MINUTES * 60000);
      } else {
        u.failed_login_count = n;
      }
      u.updated_at = new Date();
      writeRow_(t, u);
      if (n >= AUTH.MAX_FAILED_LOGINS) {
        fail_('ACCOUNT_LOCKED', 'ログインに' + AUTH.MAX_FAILED_LOGINS + '回失敗したため、' + AUTH.LOCK_MINUTES + '分間ロックしました');
      }
      fail_('INVALID_CREDENTIALS', GENERIC);
    }

    u.failed_login_count = 0;
    u.locked_until = '';
    u.last_login_at = new Date();
    // 本パスワードでログインできた → 第三者が出した再発行用の仮パスワードは無効化
    if (!viaTemp && isTrue_(u.is_temporary_password)) clearTemp_(u);
    writeRow_(t, u);

    var mustChange = viaTemp || !u.password_hash;
    var token = createSession_(u, mustChange);
    return { ok: true, token: token, user: publicUser_(u), mustChangePassword: mustChange };
  });
}

/** パスワード変更（仮パスワードからの初回設定・再設定・通常変更を兼ねる） */
function authChangePassword_(p) {
  var r = requireUser_(p.token);
  var cur = String(p.currentPassword || '');
  var np = String(p.newPassword || '');
  if (p.newPasswordConfirm !== undefined && String(p.newPasswordConfirm) !== np) {
    fail_('PASSWORD_MISMATCH', '新しいパスワードと確認用が一致しません');
  }
  var policyErr = passwordPolicyError_(np);
  if (policyErr) fail_('WEAK_PASSWORD', policyErr);
  if (np === cur) fail_('SAME_PASSWORD', '今のパスワードとは違うパスワードにしてください');

  return withLock_(function () {
    var t = readTable_(AUTH.USER_SHEET, USER_HEADERS);
    var u = findRow_(t, 'user_id', r.user.user_id);
    if (!u) fail_('SESSION_EXPIRED', 'ログインの有効期限が切れました。もう一度ログインしてください');

    var now = Date.now();
    var curOk =
      (u.password_hash && verify_(cur, u.password_salt, u.password_hash)) ||
      (isTrue_(u.is_temporary_password) && u.temp_password_hash &&
       toTime_(u.temp_password_expires_at) > now &&
       verify_(cur, u.temp_password_salt, u.temp_password_hash));
    if (!curOk) {
      fail_('WRONG_PASSWORD', r.sess.mustChange
        ? '仮パスワードが正しくないか、有効期限が切れています。仮パスワードを入力し直してください'
        : '現在のパスワードが正しくありません');
    }

    var salt = newSalt_();
    u.password_hash = hashPassword_(np, salt);
    u.password_salt = salt;
    clearTemp_(u);
    u.session_version = Number(u.session_version || 0) + 1; // 他端末のログインを無効化
    u.password_changed_at = new Date();
    u.updated_at = new Date();
    writeRow_(t, u);

    // この端末のセッションは新しい版で継続
    r.sess.mustChange = false;
    r.sess.ver = Number(u.session_version);
    putSession_(p.token, r.sess);

    return { ok: true, user: publicUser_(u), mustChangePassword: false, message: 'パスワードを変更しました' };
  });
}

/** パスワード再発行（登録有無に関わらず同じ応答を返す） */
function authForgotPassword_(p) {
  var email = normEmail_(p.email);
  if (!isEmail_(email)) fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません');

  var res = {
    ok: true,
    message: 'ご登録のメールアドレスであれば、再設定用の仮パスワードを送信しました（有効期限' +
      AUTH.TEMP_TTL_RESET_HOURS + '時間）。メールをご確認ください。'
  };

  var issued = withLock_(function () {
    var t = readTable_(AUTH.USER_SHEET, USER_HEADERS);
    var u = findRow_(t, 'email', email);
    if (!u || u.status !== 'active') return null;
    var last = toTime_(u.last_reset_requested_at);
    if (last && Date.now() - last < AUTH.RESET_COOLDOWN_SEC * 1000) return null;

    var temp = generateTempPassword_();
    var salt = newSalt_();
    var exp = new Date(Date.now() + AUTH.TEMP_TTL_RESET_HOURS * 3600 * 1000);
    Object.assign(u, {
      is_temporary_password: true,
      temp_password_hash: hashPassword_(temp, salt),
      temp_password_salt: salt,
      temp_password_expires_at: exp,
      last_reset_requested_at: new Date(),
      updated_at: new Date()
    });
    writeRow_(t, u);
    return { temp: temp, exp: exp, username: String(u.username) };
  });

  if (issued) {
    sendTempPasswordMail_(email, issued.username, issued.temp, issued.exp, 'reset');
    if (AUTH.SHOW_TEMP_PASSWORD_ON_SCREEN) {
      res.tempPassword = issued.temp; // テスト専用：登録有無が分かってしまうため本番では無効に
      res.expiresAt = issued.exp.toISOString();
    }
  }
  return res;
}

/** ログイン状態の確認 */
function authMe_(p) {
  var r = requireUser_(p.token);
  return { ok: true, user: publicUser_(r.user), mustChangePassword: !!r.sess.mustChange };
}

/** ログアウト */
function authLogout_(p) {
  destroySession_(p.token);
  return { ok: true };
}

/* ==========================================================
   他のAPIから使うガード
   ========================================================== */

/** ログイン必須（仮パスワード状態も可） */
function requireUser_(token) {
  var sess = getSession_(token);
  if (!sess) fail_('SESSION_EXPIRED', 'ログインの有効期限が切れました。もう一度ログインしてください');
  var t = readTable_(AUTH.USER_SHEET, USER_HEADERS);
  var u = findRow_(t, 'user_id', sess.uid);
  if (!u || u.status !== 'active' || Number(u.session_version || 0) !== Number(sess.ver)) {
    destroySession_(token);
    fail_('SESSION_EXPIRED', 'ログインの有効期限が切れました。もう一度ログインしてください');
  }
  return { user: u, sess: sess };
}

/** 投稿・コメントなど通常機能用（本パスワード設定済みが必須） */
function requireActiveUser_(token) {
  var r = requireUser_(token);
  if (r.sess.mustChange) fail_('PASSWORD_CHANGE_REQUIRED', '新しいパスワードを設定するまで、この機能は使えません');
  return r.user;
}

/* ==========================================================
   セッション
   ========================================================== */
function createSession_(u, mustChange) {
  var token = bytesToHex_(randomBytes_(32));
  putSession_(token, { uid: String(u.user_id), ver: Number(u.session_version || 0), mustChange: !!mustChange });
  return token;
}
function putSession_(token, sess) {
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(sess), AUTH.SESSION_TTL_SEC);
}
function getSession_(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  var v = CacheService.getScriptCache().get('sess_' + token);
  return v ? JSON.parse(v) : null;
}
function destroySession_(token) {
  if (token && typeof token === 'string') CacheService.getScriptCache().remove('sess_' + token);
}

/* ==========================================================
   パスワード・乱数
   ========================================================== */
var _pepperCache = null;
function getPepper_() {
  if (_pepperCache) return _pepperCache;
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty('AUTH_PEPPER');
  if (!v) {
    v = bytesToHex_(randomBytes_(32));
    props.setProperty('AUTH_PEPPER', v);
  }
  _pepperCache = v;
  return v;
}

function hashPassword_(password, salt) {
  var SHA = Utilities.DigestAlgorithm.SHA_256;
  var saltBytes = Utilities.newBlob(String(salt)).getBytes();
  var d = Utilities.computeDigest(SHA, salt + '\u0000' + password + '\u0000' + getPepper_(), Utilities.Charset.UTF_8);
  for (var i = 1; i < AUTH.HASH_ITERATIONS; i++) {
    d = Utilities.computeDigest(SHA, d.concat(saltBytes));
  }
  return 'h1$' + Utilities.base64Encode(d);
}

function verify_(password, salt, hash) {
  if (!salt || !hash) return false;
  return safeEqual_(hashPassword_(password, String(salt)), String(hash));
}

/** 比較時間を一定にして、タイミング攻撃を防ぐ */
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomBytes_(n) {
  var out = [];
  while (out.length < n) {
    var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
    for (var i = 0; i < d.length && out.length < n; i++) out.push((d[i] + 256) % 256);
  }
  return out;
}
function bytesToHex_(bytes) {
  return bytes.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}
function newSalt_() { return 's' + bytesToHex_(randomBytes_(16)); }

/** 仮パスワード：紛らわしい文字（0/O, 1/l/I）を除いた英数字10桁 */
function generateTempPassword_() {
  var LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  var DIGITS = '23456789';
  var ALL = LETTERS + DIGITS;
  for (;;) {
    var b = randomBytes_(10), s = '';
    for (var i = 0; i < 10; i++) s += ALL.charAt(b[i] % ALL.length);
    if (/[A-Za-z]/.test(s) && /[0-9]/.test(s)) return s;
  }
}

function passwordPolicyError_(pw) {
  if (pw.length < AUTH.PW_MIN) return 'パスワードは' + AUTH.PW_MIN + '文字以上にしてください';
  if (pw.length > AUTH.PW_MAX) return 'パスワードは' + AUTH.PW_MAX + '文字以内にしてください';
  if (/\s/.test(pw)) return 'パスワードにスペースは使えません';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'パスワードには英字と数字を両方含めてください';
  return '';
}

function clearTemp_(u) {
  u.is_temporary_password = false;
  u.temp_password_hash = '';
  u.temp_password_salt = '';
  u.temp_password_expires_at = '';
}

function publicUser_(u) {
  return { userId: String(u.user_id), username: String(u.username), email: String(u.email) };
}

/* ==========================================================
   メール
   ========================================================== */
function sendTempPasswordMail_(email, username, temp, expires, kind) {
  var isReg = kind === 'register';
  var subject = '[' + AUTH.APP_NAME + '] ' + (isReg ? '仮パスワードのお知らせ' : 'パスワード再設定用の仮パスワード');
  var body =
    username + ' さん\n\n' +
    (isReg
      ? AUTH.APP_NAME + ' へのご登録ありがとうございます。\n'
      : 'パスワード再発行のお申し込みを受け付けました。\n') +
    '下の仮パスワードでログインすると、新しいパスワードの設定画面が表示されます。\n\n' +
    '仮パスワード：' + temp + '\n' +
    '有効期限：' + Utilities.formatDate(expires, AUTH.TZ, 'yyyy年M月d日 HH:mm') + ' まで\n\n' +
    AUTH.APP_URL + '\n\n' +
    (isReg ? '' : '※いまのパスワードは、新しいパスワードを設定するまでそのまま使えます。\n') +
    '※お心当たりがない場合は、このメールを破棄してください。\n';
  try {
    MailApp.sendEmail({ to: email, subject: subject, body: body, name: AUTH.APP_NAME });
    return true;
  } catch (err) {
    console.error('メール送信失敗: ' + err);
    return false;
  }
}

/* ==========================================================
   共通ユーティリティ（Code.gs からも使用）
   ========================================================== */
function fail_(code, message) {
  var e = new Error(message);
  e.code = code;
  throw e;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) fail_('BUSY', '混み合っています。少し待ってからもう一度お試しください');
  try { return fn(); } finally { lock.releaseLock(); }
}

function normEmail_(v) { return String(v || '').trim().toLowerCase(); }
function isEmail_(s) { return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function toTime_(v) {
  if (!v) return 0;
  var t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}
function toIso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }
function newId_(prefix) { return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16); }

function getSs_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

var _ensuredSheets = {};
function ensureSheet_(name, headers) {
  if (_ensuredSheets[name]) return _ensuredSheets[name];
  var ss = getSs_();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else {
    var cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    var missing = headers.filter(function (h) { return cur.indexOf(h) < 0; });
    if (missing.length) sh.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]); // 列の追加に追従
  }
  _ensuredSheets[name] = sh;
  return sh;
}

function readTable_(name, headers) {
  var sh = ensureSheet_(name, headers);
  var values = sh.getDataRange().getValues();
  var hdr = values[0].map(String);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var o = { _row: i + 1 };
    for (var j = 0; j < hdr.length; j++) o[hdr[j]] = values[i][j];
    rows.push(o);
  }
  return { sheet: sh, headers: hdr, rows: rows };
}

function findRow_(t, key, value) {
  var v = String(value).toLowerCase();
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][key]).trim().toLowerCase() === v) return t.rows[i];
  }
  return null;
}

/** 数式インジェクション対策：= + - @ で始まる文字列は文字列として保存 */
function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function writeRow_(t, rowObj) {
  var arr = t.headers.map(function (h) { return cell_(rowObj[h]); });
  t.sheet.getRange(rowObj._row, 1, 1, arr.length).setValues([arr]);
}

function appendRow_(t, obj) {
  var arr = t.headers.map(function (h) { return cell_(obj[h]); });
  t.sheet.appendRow(arr);
  obj._row = t.sheet.getLastRow();
  t.rows.push(obj);
  return obj;
}
