/**
 * ==================================================================
 * MapTube - GAS バックエンド (Code.gs) 認証機能付き
 * 公開URL: https://kenken6291.github.io/video-pin-map/
 * ------------------------------------------------------------------
 * シート構成（列は「列名」で参照。足りない認証用の列は自動で末尾に追加されます）
 *   users    : email | passwordHash | salt | nickname | role | mustChangePassword | createdAt
 *              | tempPasswordHash | tempSalt | tempPasswordExpiresAt | lastResetAt   ←自動追加
 *   sessions : token | email | expiresAt | mustChange                               ←mustChangeは自動追加
 *   posts    : postId | timestamp | lat | lng | videoUrl | description | visible | ownerEmail | nickname | photoUrl | photoFileId
 *   comments : commentId | postId | comment | ownerEmail | nickname | timestamp | visible
 *
 * 認証の仕組み
 *   ・新規登録：仮パスワード（24時間有効）をメール送信 → 初回ログインで本パスワード設定を強制
 *   ・パスワード再発行：再設定用の仮パスワード（1時間有効）を送信。今のパスワードは変更完了まで有効
 *   ・仮パスワードでログイン中は、投稿・コメント等をサーバー側で拒否（PASSWORD_CHANGE_REQUIRED）
 *   ・ハッシュ：SHA-256 + ソルト + ペッパー + ストレッチ（"h1$"付き）。
 *     旧方式で保存されたパスワードも引き続きログインでき、ログイン成功時に新方式へ自動で置き換え
 *
 * スクリプトプロパティ
 *   SHEET_ID     … スプレッドシートID（setupProperties() で設定済み）
 *   AUTH_PEPPER  … 自動生成。変更・削除しないこと（全員ログインできなくなります）
 *   PHOTO_FOLDER_ID … 自動生成
 *
 * 最初の管理者は、通常どおり登録 → usersシートのrole列を手動で "admin" に書き換える。
 * コードを更新したら「デプロイを管理」→ 既存のデプロイを編集 → 新しいバージョン（URLは変わりません）
 * ==================================================================
 */

const PROPS = PropertiesService.getScriptProperties();
const SHEET_ID = PROPS.getProperty('SHEET_ID');

const SHEET_USERS = 'users';
const SHEET_SESSIONS = 'sessions';
const SHEET_POSTS = 'posts';
const SHEET_COMMENTS = 'comments';

const APP_NAME = 'MapTube';
const APP_URL = 'https://kenken6291.github.io/video-pin-map/';

const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7日間
const MAX_DESC_LENGTH = 200;
const MAX_COMMENT_LENGTH = 300;
const MAX_URL_LENGTH = 300;
const LOGIN_LOCK_THRESHOLD = 5;      // 連続失敗回数
const LOGIN_LOCK_MINUTES = 15;       // ロックする時間(分)

const TEMP_TTL_REGISTER_HOURS = 24;  // 新規登録の仮パスワード有効期限
const TEMP_TTL_RESET_HOURS = 1;      // 再発行の仮パスワード有効期限
const RESET_COOLDOWN_SEC = 300;      // 再発行メールの連続送信を防ぐ間隔
const HASH_ITERATIONS = 1000;        // ストレッチ回数
const PW_MIN = 8;
const PW_MAX = 64;

const PHOTO_FOLDER_NAME = 'MapTube_Photos';
const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // デコード後3MBまで(クライアント側で縮小済み想定・安全マージン)
const ALLOWED_PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const ALLOWED_VIDEO_HOSTS = [
  'youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com',
  'twitter.com', 'x.com',
  'instagram.com', 'www.instagram.com',
  'tiktok.com', 'www.tiktok.com'
];

const USER_AUTH_COLUMNS = ['tempPasswordHash', 'tempSalt', 'tempPasswordExpiresAt', 'lastResetAt'];
const SESSION_AUTH_COLUMNS = ['mustChange'];

const MSG_SESSION = 'ログインの有効期限が切れました。もう一度ログインしてください。';
const MSG_NEED_PW = '新しいパスワードを設定するまで、この操作はできません。';
const MSG_BAD_LOGIN = 'メールアドレスまたはパスワードが正しくありません。';

/**
 * ====== 初回セットアップ(1回だけ手動実行) ======
 */
function setupProperties() {
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', '1ZZJBg0gCuIPme-AN48t4KLjnyGXkP3QV9u53k6dtaOw');
}

/**
 * 認証機能のアップグレード用（任意・1回だけ手動実行）
 * 実行しなくても初回アクセス時に自動で同じ処理が行われます。
 */
function setupAuth() {
  ensureAuthColumns_();
  getPepper_();
  Logger.log('認証用の列とペッパーの準備ができました');
}

/**
 * ====== GET: 表示可能なピン+コメントをJSONで配信(認証不要・閲覧は誰でも可) ======
 */
function doGet(e) {
  if (!SHEET_ID) return jsonOutput({ status: 'error', message: 'サーバーの設定が完了していません(SHEET_ID未設定)' });

  const sheet = getSheet_(SHEET_POSTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['postId','lat','lng','videoUrl','description','visible','nickname','photoUrl']);

  // コメントを事前に読み込み、postIdごとにグループ化しておく
  const commentsByPost = loadVisibleComments_();

  const pins = values
    .filter(row => row[idx.visible] === true || row[idx.visible] === 'TRUE')
    .map(row => {
      const postId = String(row[idx.postId]);
      return {
        postId: postId,
        lat: Number(row[idx.lat]),
        lng: Number(row[idx.lng]),
        // videoUrlは isAllowedVideoUrl_ で検証済み。フロントはtextContent/属性で扱うためここではエスケープしない
        videoUrl: String(row[idx.videoUrl] || ''),
        description: String(row[idx.description] || '').slice(0, MAX_DESC_LENGTH),
        nickname: String(row[idx.nickname] || '匿名'),
        photoUrl: idx.photoUrl !== -1 ? String(row[idx.photoUrl] || '') : '',
        comments: commentsByPost[postId] || []
      };
    })
    .filter(p => !isNaN(p.lat) && !isNaN(p.lng));

  return jsonOutput({ status: 'ok', pins: pins });
}

/**
 * 表示可能なコメントを全件読み込み、postIdごとにグループ化して返す
 * (ownerEmailは公開JSONに含めない = プライバシー保護)
 */
function loadVisibleComments_() {
  const sheet = getSheet_(SHEET_COMMENTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['commentId','postId','comment','nickname','timestamp','visible']);

  const grouped = {};
  values.forEach(row => {
    if (!(row[idx.visible] === true || row[idx.visible] === 'TRUE')) return;
    const postId = String(row[idx.postId]);
    if (!grouped[postId]) grouped[postId] = [];
    grouped[postId].push({
      commentId: String(row[idx.commentId]),
      comment: String(row[idx.comment] || '').slice(0, MAX_COMMENT_LENGTH),
      nickname: String(row[idx.nickname] || '匿名'),
      timestamp: row[idx.timestamp] ? new Date(row[idx.timestamp]).toISOString() : ''
    });
  });
  return grouped;
}

/**
 * ====== POST: すべての書き込み系操作の窓口 ======
 */
function doPost(e) {
  try {
    if (!SHEET_ID) return errorOut_('SERVER_CONFIG', 'サーバーの設定が完了していません(SHEET_ID未設定)');
    if (!e.postData || !e.postData.contents) return errorOut_('BAD_REQUEST', 'リクエストが空です');

    const body = JSON.parse(e.postData.contents);
    switch (body.action) {
      case 'register':        return handleRegister_(body);
      case 'login':           return handleLogin_(body);
      case 'logout':          return handleLogout_(body);
      case 'session':         return handleSession_(body);
      case 'forgotPassword':  return handleForgotPassword_(body);
      case 'changePassword':  return handleChangePassword_(body);
      case 'updateNickname':  return handleUpdateNickname_(body);
      case 'createPost':      return handleCreatePost_(body);
      case 'updatePost':      return handleUpdatePost_(body);
      case 'deletePost':      return handleDeletePost_(body);
      case 'addComment':      return handleAddComment_(body);
      case 'updateComment':   return handleUpdateComment_(body);
      case 'deleteComment':   return handleDeleteComment_(body);
      default:                return errorOut_('UNKNOWN_ACTION', '不明な操作です');
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return errorOut_('SERVER_ERROR', 'サーバーでエラーが発生しました。時間をおいてお試しください。');
  }
}

/* ============================================================
 * ユーザー登録（仮パスワード方式）
 * ============================================================ */
function handleRegister_(body) {
  if (body.hp) return errorOut_('SPAM', '送信できませんでした。'); // ハニーポット

  const email = String(body.email || '').trim().toLowerCase();
  const nickname = stripTags_(String(body.nickname || '')).trim().slice(0, 30);

  if (!isValidEmail_(email)) return errorOut_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
  if (!nickname) return errorOut_('INVALID_NICKNAME', 'ニックネームを入力してください。');

  // 簡易レート制限(同一メールでの連続登録を防ぐ)
  const cache = CacheService.getScriptCache();
  const rateKey = 'register_' + email;
  if (cache.get(rateKey)) return errorOut_('RATE_LIMIT', '少し時間をおいてからもう一度お試しください。');
  cache.put(rateKey, '1', 60);

  ensureAuthColumns_();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const user = getUserByEmail_(email);
    const unfinished = user && isTrue_(user.mustChangePassword) && !user.passwordHash; // 仮登録のまま

    if (!user || unfinished) {
      const temp = generateTempPassword_();
      const tempSalt = Utilities.getUuid();
      const expires = new Date(Date.now() + TEMP_TTL_REGISTER_HOURS * 3600 * 1000);
      const tempFields = {
        tempPasswordHash: hashPasswordV2_(temp, tempSalt),
        tempSalt: tempSalt,
        tempPasswordExpiresAt: expires
      };
      if (!user) {
        appendByHeader_(getSheet_(SHEET_USERS), Object.assign({
          email: email, passwordHash: '', salt: '', nickname: nickname, role: 'user',
          mustChangePassword: true, createdAt: new Date()
        }, tempFields));
      } else {
        updateUserFields_(user.row, Object.assign({ nickname: nickname }, tempFields));
      }
      if (!sendTempPasswordMail_(email, nickname, temp, expires, 'register')) {
        return errorOut_('MAIL_FAILED', 'メールを送信できませんでした。時間をおいてもう一度お試しください。');
      }
    } else {
      // 登録済みの人には「登録済み」の案内だけを送る(画面上は同じ応答にしてメールアドレスの存在を判別させない)
      sendAlreadyRegisteredMail_(email, String(user.nickname || ''));
    }

    return jsonOutput({
      status: 'ok',
      message: '登録を受け付けました。入力したメールアドレスに仮パスワードを送りました(有効期限' + TEMP_TTL_REGISTER_HOURS + '時間)。'
    });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * ログイン（本パスワード / 仮パスワードの両方に対応）
 * ============================================================ */
function handleLogin_(body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return errorOut_('INVALID_CREDENTIALS', MSG_BAD_LOGIN);

  const cache = CacheService.getScriptCache();
  const lockKey = 'loginlock_' + email;
  const failKey = 'loginfail_' + email;

  if (cache.get(lockKey)) {
    return errorOut_('ACCOUNT_LOCKED', 'ログインに' + LOGIN_LOCK_THRESHOLD + '回続けて失敗したため、一時的にロックしています。' +
      LOGIN_LOCK_MINUTES + '分ほど待ってからお試しください。');
  }

  ensureAuthColumns_();
  const user = getUserByEmail_(email);

  let ok = false, viaTemp = false, tempExpired = false;
  if (user) {
    if (verifyPassword_(password, user.salt, user.passwordHash)) {
      ok = true;
    } else if (user.tempPasswordHash && verifyPassword_(password, user.tempSalt, user.tempPasswordHash)) {
      if (toTime_(user.tempPasswordExpiresAt) > Date.now()) { ok = true; viaTemp = true; }
      else tempExpired = true;
    }
  }

  if (tempExpired) {
    return errorOut_('TEMP_EXPIRED', '仮パスワードの有効期限が切れています。「パスワードをお忘れの方はこちら」からもう一度発行してください。');
  }

  if (!ok) {
    const fails = Number(cache.get(failKey) || '0') + 1;
    if (fails >= LOGIN_LOCK_THRESHOLD) {
      cache.put(lockKey, '1', LOGIN_LOCK_MINUTES * 60);
      cache.remove(failKey);
      return errorOut_('ACCOUNT_LOCKED', 'ログインに' + LOGIN_LOCK_THRESHOLD + '回続けて失敗したため、' +
        LOGIN_LOCK_MINUTES + '分間ロックしました。');
    }
    cache.put(failKey, String(fails), 60 * 30);
    return errorOut_('INVALID_CREDENTIALS', MSG_BAD_LOGIN);
  }
  cache.remove(failKey);

  if (!viaTemp) {
    const updates = {};
    // 旧方式のハッシュなら新方式に置き換え
    if (String(user.passwordHash).indexOf('h1$') !== 0) {
      const salt = Utilities.getUuid();
      updates.passwordHash = hashPasswordV2_(password, salt);
      updates.salt = salt;
    }
    // 本パスワードでログインできた → 第三者が申請した再発行用の仮パスワードは無効化
    if (user.tempPasswordHash) Object.assign(updates, clearTempFields_());
    if (Object.keys(updates).length) updateUserFields_(user.row, updates);
  }

  const mustChange = viaTemp || isTrue_(user.mustChangePassword);
  const token = createSession_(email, mustChange);

  return jsonOutput({
    status: 'ok',
    token: token,
    nickname: user.nickname,
    role: user.role,
    mustChangePassword: mustChange
  });
}

/* ============================================================
 * ログイン状態の確認(ページ読み込み時)
 * ============================================================ */
function handleSession_(body) {
  const chk = checkSession_(body.token, true);
  if (chk.error) return chk.error;
  const user = getUserByEmail_(chk.session.email);
  if (!user) return errorOut_('SESSION_EXPIRED', MSG_SESSION);
  return jsonOutput({
    status: 'ok',
    nickname: user.nickname,
    role: user.role,
    mustChangePassword: chk.session.mustChange
  });
}

/* ============================================================
 * ログアウト
 * ============================================================ */
function handleLogout_(body) {
  const token = String(body.token || '');
  const sheet = getSheet_(SHEET_SESSIONS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === token) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  return jsonOutput({ status: 'ok' });
}

/* ============================================================
 * パスワード再発行(登録の有無に関わらず同じ応答を返す)
 * ============================================================ */
function handleForgotPassword_(body) {
  if (body.hp) return errorOut_('SPAM', '送信できませんでした。');

  const email = String(body.email || '').trim().toLowerCase();
  if (!isValidEmail_(email)) return errorOut_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');

  const generic = jsonOutput({
    status: 'ok',
    message: 'ご登録のメールアドレスであれば、再設定用の仮パスワードを送りました(有効期限' +
      TEMP_TTL_RESET_HOURS + '時間)。今のパスワードは、新しいパスワードを設定するまでそのまま使えます。'
  });

  const cache = CacheService.getScriptCache();
  const rateKey = 'forgot_' + email;
  if (cache.get(rateKey)) return generic;
  cache.put(rateKey, '1', 60);

  ensureAuthColumns_();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let issued = null;
  try {
    const user = getUserByEmail_(email);
    if (!user) return generic;
    const last = toTime_(user.lastResetAt);
    if (last && Date.now() - last < RESET_COOLDOWN_SEC * 1000) return generic;

    const temp = generateTempPassword_();
    const tempSalt = Utilities.getUuid();
    const expires = new Date(Date.now() + TEMP_TTL_RESET_HOURS * 3600 * 1000);
    updateUserFields_(user.row, {
      tempPasswordHash: hashPasswordV2_(temp, tempSalt),
      tempSalt: tempSalt,
      tempPasswordExpiresAt: expires,
      lastResetAt: new Date()
    });
    issued = { temp: temp, expires: expires, nickname: String(user.nickname || '') };
  } finally {
    lock.releaseLock();
  }

  if (issued) sendTempPasswordMail_(email, issued.nickname, issued.temp, issued.expires, 'reset');
  return generic;
}

/* ============================================================
 * パスワード変更(初回強制変更・再発行後の設定・通常の変更を兼ねる)
 * ============================================================ */
function handleChangePassword_(body) {
  const chk = checkSession_(body.token, true); // 仮パスワード状態でも呼べる唯一の更新操作
  if (chk.error) return chk.error;
  const session = chk.session;

  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (body.newPasswordConfirm !== undefined && String(body.newPasswordConfirm) !== newPassword) {
    return errorOut_('PASSWORD_MISMATCH', '新しいパスワードと確認用が一致しません。');
  }
  const policyErr = passwordPolicyError_(newPassword);
  if (policyErr) return errorOut_('WEAK_PASSWORD', policyErr);
  if (newPassword === oldPassword) return errorOut_('SAME_PASSWORD', '今のパスワードとは違うパスワードにしてください。');

  ensureAuthColumns_();
  const user = getUserByEmail_(session.email);
  if (!user) return errorOut_('SESSION_EXPIRED', MSG_SESSION);

  const okOld =
    verifyPassword_(oldPassword, user.salt, user.passwordHash) ||
    (!!user.tempPasswordHash && toTime_(user.tempPasswordExpiresAt) > Date.now() &&
     verifyPassword_(oldPassword, user.tempSalt, user.tempPasswordHash));
  if (!okOld) {
    return errorOut_('WRONG_PASSWORD', session.mustChange
      ? '仮パスワードが正しくないか、有効期限が切れています。仮パスワードを入力し直してください。'
      : '現在のパスワードが正しくありません。');
  }

  const salt = Utilities.getUuid();
  updateUserFields_(user.row, Object.assign({
    passwordHash: hashPasswordV2_(newPassword, salt),
    salt: salt,
    mustChangePassword: false
  }, clearTempFields_()));

  // パスワード変更時は既存の全セッションを無効化(他の端末は再ログインが必要)し、この端末には新しいセッションを発行
  invalidateAllSessions_(session.email);
  const token = createSession_(session.email, false);

  return jsonOutput({
    status: 'ok',
    message: 'パスワードを変更しました。',
    token: token,
    nickname: user.nickname,
    role: user.role
  });
}

/* ============================================================
 * ニックネーム変更(本人のみ。既存の投稿・コメントの表示名も合わせて更新する)
 * ============================================================ */
function handleUpdateNickname_(body) {
  const chk = checkSession_(body.token);
  if (chk.error) return chk.error;
  const session = chk.session;

  const newNickname = stripTags_(String(body.nickname || '')).trim().slice(0, 30);
  if (!newNickname) return errorOut_('INVALID_NICKNAME', 'ニックネームを入力してください。');

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const user = getUserByEmail_(session.email);
    if (!user) return errorOut_('NOT_FOUND', 'ユーザーが見つかりません。');
    updateUserFields_(user.row, { nickname: newNickname });

    // 既存の投稿・コメントの表示名も合わせて更新
    updateNicknameInSheet_(SHEET_POSTS, session.email, newNickname);
    updateNicknameInSheet_(SHEET_COMMENTS, session.email, newNickname);

    return jsonOutput({ status: 'ok', nickname: newNickname });
  } finally {
    lock.releaseLock();
  }
}

function updateNicknameInSheet_(sheetName, email, newNickname) {
  const sheet = getSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['ownerEmail', 'nickname']);
  if (idx.ownerEmail === -1 || idx.nickname === -1) return;

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.ownerEmail]).toLowerCase() === email) {
      sheet.getRange(i + 2, idx.nickname + 1).setValue(newNickname);
    }
  }
}

/* ============================================================
 * 投稿作成
 * ============================================================ */
function handleCreatePost_(body) {
  if (body.hp) return errorOut_('SPAM', '送信できませんでした。');

  const chk = checkSession_(body.token);
  if (chk.error) return chk.error;
  const session = chk.session;

  const cache = CacheService.getScriptCache();
  const rateKey = 'post_' + session.email;
  if (cache.get(rateKey)) return errorOut_('RATE_LIMIT', '続けての投稿はできません。少し待ってからお試しください。');
  cache.put(rateKey, '1', 30);

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return errorOut_('INVALID_INPUT', '位置情報が正しくありません。');
  }

  const rawVideoUrl = String(body.videoUrl || '').trim();
  if (!rawVideoUrl && !body.photoBase64) {
    return errorOut_('INVALID_INPUT', '動画URLか写真のどちらかが必要です。');
  }
  const videoUrl = rawVideoUrl.slice(0, MAX_URL_LENGTH);
  if (videoUrl && !isAllowedVideoUrl_(videoUrl)) {
    return errorOut_('INVALID_INPUT', '動画URLは YouTube / X / Instagram / TikTok の https:// で始まるURLを入力してください。');
  }

  const description = stripTags_(String(body.description || '')).slice(0, MAX_DESC_LENGTH);

  // 写真(任意)。クライアント側で縮小済みのdata URL(base64)を受け取り、Driveに保存する。
  let photoUrl = '';
  let photoFileId = '';
  if (body.photoBase64) {
    try {
      const saved = savePhotoToDrive_(body.photoBase64);
      photoUrl = saved.url;
      photoFileId = saved.fileId;
    } catch (err) {
      return errorOut_('PHOTO_FAILED', err.message || '写真の保存に失敗しました。');
    }
  }

  const user = getUserByEmail_(session.email);
  const postId = Utilities.getUuid();

  // appendRowは列の「位置」で書き込むため、postsシートの列順(冒頭コメント参照)と合わせること
  getSheet_(SHEET_POSTS).appendRow([postId, new Date(), lat, lng, videoUrl, description, true, session.email, user.nickname, photoUrl, photoFileId]);

  return jsonOutput({ status: 'ok', postId: postId, photoUrl: photoUrl });
}

/* ============================================================
 * 写真をGoogle Driveに保存し、{url, fileId} を返す
 * body.photoBase64 は "data:image/jpeg;base64,xxxx" 形式のdata URLを想定。
 * ============================================================ */
function savePhotoToDrive_(photoDataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(photoDataUrl || ''));
  if (!match) throw new Error('写真データが正しくありません。');

  const mimeType = match[1];
  if (ALLOWED_PHOTO_MIME.indexOf(mimeType) === -1) throw new Error('対応していない画像形式です。');

  const bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error('写真のサイズが大きすぎます。');
  if (bytes.length === 0) throw new Error('写真データが空です。');

  const ext = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
  const blob = Utilities.newBlob(bytes, mimeType, 'photo_' + Utilities.getUuid() + '.' + ext);

  const folder = getOrCreatePhotoFolder_();
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const fileId = file.getId();
  return { url: 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1000', fileId: fileId };
}

/* ============================================================
 * 写真保存用フォルダを取得(なければ作成)。フォルダIDはスクリプトプロパティにキャッシュする。
 * ============================================================ */
function getOrCreatePhotoFolder_() {
  const cachedId = PROPS.getProperty('PHOTO_FOLDER_ID');
  if (cachedId) {
    try { return DriveApp.getFolderById(cachedId); } catch (e) { /* 削除されていた場合は再作成 */ }
  }
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
  PROPS.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

/* ============================================================
 * 投稿に紐づく写真ファイルをゴミ箱に移動する(存在しない/削除済みでもエラーにしない)
 * ============================================================ */
function deletePhotoFile_(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* 既に削除済みなどは無視 */ }
}

/* ============================================================
 * 投稿編集(本人または管理者のみ)
 * ============================================================ */
function handleUpdatePost_(body) {
  const chk = checkSession_(body.token);
  if (chk.error) return chk.error;
  const session = chk.session;

  const postId = String(body.postId || '');
  const sheet = getSheet_(SHEET_POSTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['postId','videoUrl','description','ownerEmail','photoUrl','photoFileId']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.postId]) === postId) {
      const isOwner = String(values[i][idx.ownerEmail]).toLowerCase() === session.email;
      const isAdmin = session.role === 'admin';
      if (!isOwner && !isAdmin) return errorOut_('PERMISSION_DENIED', 'この操作をする権限がありません。');

      const rawVideoUrl = String(body.videoUrl || '').trim();
      if (rawVideoUrl && !isAllowedVideoUrl_(rawVideoUrl)) {
        return errorOut_('INVALID_INPUT', '動画URLは YouTube / X / Instagram / TikTok の https:// で始まるURLを入力してください。');
      }

      const hasExistingPhoto = idx.photoUrl !== -1 && !!values[i][idx.photoUrl];
      const willHavePhoto = body.removePhoto ? false : (body.photoBase64 ? true : hasExistingPhoto);
      if (!rawVideoUrl && !willHavePhoto) {
        return errorOut_('INVALID_INPUT', '動画URLか写真のどちらかが必要です。');
      }

      const videoUrl = rawVideoUrl.slice(0, MAX_URL_LENGTH);
      const description = stripTags_(String(body.description || '')).slice(0, MAX_DESC_LENGTH);

      const row = i + 2;
      sheet.getRange(row, idx.videoUrl + 1).setValue(videoUrl);
      sheet.getRange(row, idx.description + 1).setValue(description);

      if (idx.photoUrl !== -1 && idx.photoFileId !== -1) {
        if (body.removePhoto) {
          deletePhotoFile_(values[i][idx.photoFileId]);
          sheet.getRange(row, idx.photoUrl + 1).setValue('');
          sheet.getRange(row, idx.photoFileId + 1).setValue('');
        } else if (body.photoBase64) {
          try {
            const saved = savePhotoToDrive_(body.photoBase64);
            deletePhotoFile_(values[i][idx.photoFileId]); // 古い写真を削除
            sheet.getRange(row, idx.photoUrl + 1).setValue(saved.url);
            sheet.getRange(row, idx.photoFileId + 1).setValue(saved.fileId);
          } catch (err) {
            return errorOut_('PHOTO_FAILED', err.message || '写真の保存に失敗しました。');
          }
        }
      }

      return jsonOutput({ status: 'ok' });
    }
  }
  return errorOut_('NOT_FOUND', '投稿が見つかりません。');
}

/* ============================================================
 * 投稿削除(本人または管理者のみ)
 * ============================================================ */
function handleDeletePost_(body) {
  const chk = checkSession_(body.token);
  if (chk.error) return chk.error;
  const session = chk.session;

  const postId = String(body.postId || '');
  const sheet = getSheet_(SHEET_POSTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['postId','ownerEmail','photoFileId']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.postId]) === postId) {
      const isOwner = String(values[i][idx.ownerEmail]).toLowerCase() === session.email;
      const isAdmin = session.role === 'admin';
      if (!isOwner && !isAdmin) return errorOut_('PERMISSION_DENIED', 'この操作をする権限がありません。');

      if (idx.photoFileId !== -1) deletePhotoFile_(values[i][idx.photoFileId]);

      sheet.deleteRow(i + 2);
      return jsonOutput({ status: 'ok' });
    }
  }
  return errorOut_('NOT_FOUND', '投稿が見つかりません。');
}

/* ============================================================
 * コメント追加(ログイン済み・本パスワード設定済みのユーザーのみ)
 * ============================================================ */
function handleAddComment_(body) {
  if (body.hp) return errorOut_('SPAM', '送信できませんでした。');

  const chk = checkSession_(body.token);
  if (chk.error) return chk.error;
  const session = chk.session;

  const cache = CacheService.getScriptCache();
  const rateKey = 'comment_' + session.email;
  if (cache.get(rateKey)) return errorOut_('RATE_LIMIT', '続けてのコメントはできません。少し待ってからお試しください。');
  cache.put(rateKey, '1', 15);

  const postId = String(body.postId || '');
  if (!postId) return errorOut_('INVALID_INPUT', '投稿が指定されていません。');

  const postsSheet = getSheet_(SHEET_POSTS);
  const postValues = postsSheet.getDataRange().getValues();
  const postHeader = postValues.shift();
  const postIdx = colIndex_(postHeader, ['postId','visible']);
  const targetPost = postValues.find(row => String(row[postIdx.postId]) === postId);
  if (!targetPost || !(targetPost[postIdx.visible] === true || targetPost[postIdx.visible] === 'TRUE')) {
    return errorOut_('NOT_FOUND', '投稿が見つかりません。');
  }

  const comment = stripTags_(String(body.comment || '')).trim().slice(0, MAX_COMMENT_LENGTH);
  if (!comment) return errorOut_('INVALID_INPUT', 'コメントを入力してください。');

  const user = getUserByEmail_(session.email);
  const commentId = Utilities.getUuid();

  getSheet_(SHEET_COMMENTS).appendRow([commentId, postId, comment, session.email, user.nickname, new Date(), true]);

  return jsonOutput({ status: 'ok', commentId: commentId });
}

/* ============================================================
 * コメント編集(本人または管理者のみ)
 * ============================================================ */
function handleUpdateComment_(body) {
  const chk = checkSession_(body.token);
  if (chk.error) return chk.error;
  const session = chk.session;

  const commentId = String(body.commentId || '');
  const sheet = getSheet_(SHEET_COMMENTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['commentId','comment','ownerEmail']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.commentId]) === commentId) {
      const isOwner = String(values[i][idx.ownerEmail]).toLowerCase() === session.email;
      const isAdmin = session.role === 'admin';
      if (!isOwner && !isAdmin) return errorOut_('PERMISSION_DENIED', 'この操作をする権限がありません。');

      const comment = stripTags_(String(body.comment || '')).trim().slice(0, MAX_COMMENT_LENGTH);
      if (!comment) return errorOut_('INVALID_INPUT', 'コメントを入力してください。');

      sheet.getRange(i + 2, idx.comment + 1).setValue(comment);
      return jsonOutput({ status: 'ok' });
    }
  }
  return errorOut_('NOT_FOUND', 'コメントが見つかりません。');
}

/* ============================================================
 * コメント削除(本人または管理者のみ)
 * ============================================================ */
function handleDeleteComment_(body) {
  const chk = checkSession_(body.token);
  if (chk.error) return chk.error;
  const session = chk.session;

  const commentId = String(body.commentId || '');
  const sheet = getSheet_(SHEET_COMMENTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['commentId','ownerEmail']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.commentId]) === commentId) {
      const isOwner = String(values[i][idx.ownerEmail]).toLowerCase() === session.email;
      const isAdmin = session.role === 'admin';
      if (!isOwner && !isAdmin) return errorOut_('PERMISSION_DENIED', 'この操作をする権限がありません。');

      sheet.deleteRow(i + 2);
      return jsonOutput({ status: 'ok' });
    }
  }
  return errorOut_('NOT_FOUND', 'コメントが見つかりません。');
}

/* ============================================================
 * セッション
 * ============================================================ */

/**
 * セッションを検証する。allowMustChange=false(既定)の場合、仮パスワード状態のセッションは拒否する。
 * 戻り値: { session } または { error: レスポンス }
 */
function checkSession_(token, allowMustChange) {
  const s = getSession_(token);
  if (!s) return { error: errorOut_('SESSION_EXPIRED', MSG_SESSION) };
  if (s.mustChange && !allowMustChange) return { error: errorOut_('PASSWORD_CHANGE_REQUIRED', MSG_NEED_PW) };
  return { session: s };
}

function createSession_(email, mustChange) {
  const token = randomHex_(32);
  appendByHeader_(getSheet_(SHEET_SESSIONS), {
    token: token,
    email: email,
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
    mustChange: !!mustChange
  });
  return token;
}

/** 有効なら {email, role, mustChange} を返す。無効ならnull */
function getSession_(token) {
  if (!token || typeof token !== 'string') return null;
  const sheet = getSheet_(SHEET_SESSIONS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['token','email','expiresAt','mustChange']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.token]) === token) {
      const expiresAt = new Date(values[i][idx.expiresAt]);
      if (expiresAt.getTime() < Date.now()) return null; // 期限切れ
      const user = getUserByEmail_(values[i][idx.email]);
      if (!user) return null;
      return {
        email: user.email,
        role: user.role,
        mustChange: idx.mustChange !== -1 && isTrue_(values[i][idx.mustChange])
      };
    }
  }
  return null;
}

/** 指定メールアドレスの全セッションを無効化(パスワード変更時などに使用) */
function invalidateAllSessions_(email) {
  const sheet = getSheet_(SHEET_SESSIONS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['email']);

  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][idx.email]).toLowerCase() === email) {
      sheet.deleteRow(i + 2);
    }
  }
}

/**
 * 定期クリーンアップ(任意: 時間主導トリガーで1日1回など実行推奨)
 * 期限切れセッションを削除する
 */
function cleanupExpiredSessions() {
  const sheet = getSheet_(SHEET_SESSIONS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['expiresAt']);
  const now = Date.now();

  for (let i = values.length - 1; i >= 0; i--) {
    if (new Date(values[i][idx.expiresAt]).getTime() < now) {
      sheet.deleteRow(i + 2);
    }
  }
}

/* ============================================================
 * ユーザー
 * ============================================================ */
function getUserByEmail_(email) {
  email = String(email || '').trim().toLowerCase();
  const sheet = getSheet_(SHEET_USERS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, [
    'email','passwordHash','salt','nickname','role','mustChangePassword',
    'tempPasswordHash','tempSalt','tempPasswordExpiresAt','lastResetAt'
  ]);
  const get = (row, key) => (idx[key] === -1 ? '' : row[idx[key]]);

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (String(row[idx.email]).toLowerCase() === email) {
      return {
        row: i + 2,
        email: String(row[idx.email]).toLowerCase(),
        passwordHash: String(get(row, 'passwordHash') || ''),
        salt: String(get(row, 'salt') || ''),
        nickname: get(row, 'nickname'),
        role: get(row, 'role'),
        mustChangePassword: get(row, 'mustChangePassword'),
        tempPasswordHash: String(get(row, 'tempPasswordHash') || ''),
        tempSalt: String(get(row, 'tempSalt') || ''),
        tempPasswordExpiresAt: get(row, 'tempPasswordExpiresAt'),
        lastResetAt: get(row, 'lastResetAt')
      };
    }
  }
  return null;
}

/** usersシートの指定行を列名で部分更新する */
function updateUserFields_(rowNumber, fields) {
  const sheet = getSheet_(SHEET_USERS);
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Object.keys(fields).forEach(key => {
    const col = header.indexOf(key);
    if (col !== -1) sheet.getRange(rowNumber, col + 1).setValue(fields[key]);
  });
}

function clearTempFields_() {
  return { tempPasswordHash: '', tempSalt: '', tempPasswordExpiresAt: '' };
}

/** 認証用の列が無ければ末尾に追加する(既存データはそのまま) */
let authColumnsReady_ = false;
function ensureAuthColumns_() {
  if (authColumnsReady_) return;
  ensureColumns_(SHEET_USERS, USER_AUTH_COLUMNS);
  ensureColumns_(SHEET_SESSIONS, SESSION_AUTH_COLUMNS);
  authColumnsReady_ = true;
}

function ensureColumns_(sheetName, names) {
  const sheet = getSheet_(sheetName);
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const missing = names.filter(n => header.indexOf(n) === -1);
  if (missing.length) {
    const start = header.filter(String).length === 0 ? 1 : lastCol + 1;
    sheet.getRange(1, start, 1, missing.length).setValues([missing]);
  }
}

/* ============================================================
 * パスワード
 * ============================================================ */
function getPepper_() {
  let pepper = PROPS.getProperty('AUTH_PEPPER');
  if (!pepper) {
    pepper = randomHex_(32);
    PROPS.setProperty('AUTH_PEPPER', pepper);
  }
  return pepper;
}

/** 新方式: SHA-256 + ソルト + ペッパー + ストレッチ */
function hashPasswordV2_(password, salt) {
  const SHA = Utilities.DigestAlgorithm.SHA_256;
  const saltBytes = Utilities.newBlob(String(salt)).getBytes();
  let d = Utilities.computeDigest(SHA, salt + '\u0000' + password + '\u0000' + getPepper_(), Utilities.Charset.UTF_8);
  for (let i = 1; i < HASH_ITERATIONS; i++) {
    d = Utilities.computeDigest(SHA, d.concat(saltBytes));
  }
  return 'h1$' + Utilities.base64Encode(d);
}

/** 旧方式(既存ユーザーのログイン用。ログイン成功時に新方式へ置き換える) */
function hashPasswordLegacy_(password, salt) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt);
  return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function verifyPassword_(password, salt, stored) {
  stored = String(stored || '');
  salt = String(salt || '');
  if (!stored || !salt) return false;
  const calc = stored.indexOf('h1$') === 0 ? hashPasswordV2_(password, salt) : hashPasswordLegacy_(password, salt);
  return safeEqual_(calc, stored);
}

/** 比較時間を一定にしてタイミング攻撃を防ぐ */
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function passwordPolicyError_(pw) {
  if (pw.length < PW_MIN) return 'パスワードは' + PW_MIN + '文字以上にしてください。';
  if (pw.length > PW_MAX) return 'パスワードは' + PW_MAX + '文字以内にしてください。';
  if (/\s/.test(pw)) return 'パスワードにスペースは使えません。';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'パスワードには英字と数字を両方含めてください。';
  return '';
}

function randomBytes_(n) {
  const out = [];
  while (out.length < n) {
    const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
    for (let i = 0; i < d.length && out.length < n; i++) out.push((d[i] + 256) % 256);
  }
  return out;
}

function randomHex_(n) {
  return randomBytes_(n).map(b => ('0' + b.toString(16)).slice(-2)).join('');
}

/** 仮パスワード：紛らわしい文字(0/O, 1/l/I)を除いた英数字10桁。英字と数字を必ず含む */
function generateTempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    const bytes = randomBytes_(10);
    let pw = '';
    for (let i = 0; i < 10; i++) pw += chars.charAt(bytes[i] % chars.length);
    if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

/* ============================================================
 * メール
 * ============================================================ */
function sendTempPasswordMail_(email, nickname, temp, expires, kind) {
  const isReg = kind === 'register';
  const subject = '【' + APP_NAME + '】' + (isReg ? '仮パスワードのお知らせ' : 'パスワード再設定用の仮パスワード');
  const body =
    (nickname || '') + ' 様\n\n' +
    (isReg
      ? APP_NAME + 'へのご登録ありがとうございます。\n'
      : 'パスワード再発行のお申し込みを受け付けました。\n') +
    '下の仮パスワードでログインすると、新しいパスワードの設定画面が表示されます。\n\n' +
    'メールアドレス: ' + email + '\n' +
    '仮パスワード: ' + temp + '\n' +
    '有効期限: ' + Utilities.formatDate(expires, 'Asia/Tokyo', 'yyyy年M月d日 HH:mm') + ' まで\n\n' +
    APP_URL + '\n\n' +
    (isReg ? '' : '※今のパスワードは、新しいパスワードを設定するまでそのまま使えます。\n') +
    '※このメールに心当たりがない場合は破棄してください。\n';
  try {
    MailApp.sendEmail({ to: email, subject: subject, body: body, name: APP_NAME });
    return true;
  } catch (err) {
    console.error('メール送信失敗: ' + err);
    return false;
  }
}

function sendAlreadyRegisteredMail_(email, nickname) {
  try {
    MailApp.sendEmail({
      to: email,
      subject: '【' + APP_NAME + '】ご登録についてのお知らせ',
      name: APP_NAME,
      body:
        (nickname || '') + ' 様\n\n' +
        'このメールアドレスはすでに' + APP_NAME + 'に登録されています。\n' +
        'パスワードがわからない場合は、ログイン画面の「パスワードをお忘れの方はこちら」から再発行してください。\n\n' +
        APP_URL + '\n\n' +
        '※このメールに心当たりがない場合は破棄してください。\n'
    });
  } catch (err) {
    console.error('メール送信失敗: ' + err);
  }
}

/* ============================================================
 * ユーティリティ
 * ============================================================ */
let spreadsheet_ = null;
function getSheet_(name) {
  if (!spreadsheet_) spreadsheet_ = SpreadsheetApp.openById(SHEET_ID);
  return spreadsheet_.getSheetByName(name);
}

function colIndex_(header, names) {
  const idx = {};
  names.forEach(n => idx[n] = header.indexOf(n));
  return idx;
}

/** 見出し行の列名に合わせて1行追加する(列の並び順に依存しない) */
function appendByHeader_(sheet, obj) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = header.map(h => (Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : ''));
  sheet.appendRow(row);
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorOut_(code, message) {
  return jsonOutput({ status: 'error', code: code, message: message });
}

function isTrue_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

function toTime_(v) {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function stripTags_(str) {
  return str.replace(/<[^>]*>/g, '');
}

function isValidEmail_(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAllowedVideoUrl_(url) {
  if (!url) return false;
  // GASの実行環境にはブラウザのURLクラスが存在しないため、正規表現でホスト名を抽出する
  const m = /^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(url.trim());
  if (!m) return false;
  let hostname = m[1].toLowerCase();
  hostname = hostname.split('@').pop(); // ユーザー情報(user:pass@)を除去
  hostname = hostname.split(':')[0];    // ポート番号を除去
  return ALLOWED_VIDEO_HOSTS.indexOf(hostname) !== -1;
}
