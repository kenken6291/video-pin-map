/**
 * ==================================================================
 * MapTube - GAS バックエンド (Code.gs) 認証機能付き
 * ------------------------------------------------------------------
 * シート構成:
 *   users    : email | passwordHash | salt | nickname | role | mustChangePassword | createdAt
 *   sessions : token | email | expiresAt
 *   posts    : postId | timestamp | lat | lng | videoUrl | description | visible | ownerEmail | nickname | photoUrl | photoFileId
 *
 * ※ 写真投稿機能を追加するため、postsシートの見出し行(1行目)の末尾に
 *    「photoUrl」「photoFileId」の2列を追加してください(列の順番は自由。列名で参照します)。
 *
 * 最初の管理者は、通常どおり登録 → usersシートのrole列を手動で "admin" に書き換える。
 * ==================================================================
 */

const PROPS = PropertiesService.getScriptProperties();
const SHEET_ID = PROPS.getProperty('SHEET_ID');

const SHEET_USERS = 'users';
const SHEET_SESSIONS = 'sessions';
const SHEET_POSTS = 'posts';
const SHEET_COMMENTS = 'comments';

const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7日間
const MAX_DESC_LENGTH = 200;
const MAX_COMMENT_LENGTH = 300;
const MAX_URL_LENGTH = 300;
const LOGIN_LOCK_THRESHOLD = 5;      // 連続失敗回数
const LOGIN_LOCK_MINUTES = 15;       // ロックする時間(分)

const PHOTO_FOLDER_NAME = 'MapTube_Photos';
const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // デコード後3MBまで(クライアント側で縮小済み想定・安全マージン)
const ALLOWED_PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const ALLOWED_VIDEO_HOSTS = [
  'youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com',
  'twitter.com', 'x.com',
  'instagram.com', 'www.instagram.com',
  'tiktok.com', 'www.tiktok.com'
];

/**
 * ====== 初回セットアップ(1回だけ手動実行) ======
 */
function setupProperties() {
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', '1ZZJBg0gCuIPme-AN48t4KLjnyGXkP3QV9u53k6dtaOw');
}

/**
 * ====== GET: 表示可能なピン+コメントをJSONで配信(認証不要・閲覧は誰でも可) ======
 */
function doGet(e) {
  if (!SHEET_ID) return jsonOutput({ status: 'error', message: 'server not configured' });

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
        // videoUrlは isAllowedVideoUrl_ で検証済みのURLそのものを返す(HTMLエスケープすると
        // "&" を含むURL(YouTubeの再生リスト等)が壊れるため、ここではエスケープしない)
        videoUrl: String(row[idx.videoUrl] || ''),
        // description/nicknameはフロント側で必ずtextContentを使って挿入するため、
        // ここでHTMLエスケープすると "&" が "&amp;" のまま画面に表示される二重エスケープになる。
        // タグそのものは投稿時(stripTags_)で既に除去済みなので、ここでは長さ制限のみ行う。
        description: String(row[idx.description] || '').slice(0, MAX_DESC_LENGTH),
        nickname: String(row[idx.nickname] || '匿名'),
        // 写真URLはDrive上のファイルを直接指すURLで、ユーザー入力ではないためそのまま返す。
        // 列がまだ追加されていない場合(idx.photoUrl === -1)は空文字を返す。
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
      // フロントはtextContentで挿入するため、ここでのHTMLエスケープは不要(二重エスケープ防止)
      comment: String(row[idx.comment] || '').slice(0, MAX_COMMENT_LENGTH),
      nickname: String(row[idx.nickname] || '匿名'),
      timestamp: row[idx.timestamp] ? new Date(row[idx.timestamp]).toISOString() : ''
    });
  });
  return grouped;
}

/**
 * ====== POST: すべての書き込み系操作の窓口 ======
 * body.action で処理を振り分ける
 */
function doPost(e) {
  try {
    if (!SHEET_ID) return jsonOutput({ status: 'error', message: 'server not configured' });
    if (!e.postData || !e.postData.contents) return jsonOutput({ status: 'error', message: 'no data' });

    const body = JSON.parse(e.postData.contents);
    switch (body.action) {
      case 'register':       return handleRegister_(body);
      case 'login':           return handleLogin_(body);
      case 'logout':          return handleLogout_(body);
      case 'changePassword':  return handleChangePassword_(body);
      case 'updateNickname':  return handleUpdateNickname_(body);
      case 'createPost':      return handleCreatePost_(body);
      case 'updatePost':      return handleUpdatePost_(body);
      case 'deletePost':      return handleDeletePost_(body);
      case 'addComment':      return handleAddComment_(body);
      case 'updateComment':   return handleUpdateComment_(body);
      case 'deleteComment':   return handleDeleteComment_(body);
      default:                return jsonOutput({ status: 'error', message: 'unknown action' });
    }
  } catch (err) {
    return jsonOutput({ status: 'error', message: 'server error' });
  }
}

/* ============================================================
 * ユーザー登録
 * ============================================================ */
function handleRegister_(body) {
  if (body.hp) return jsonOutput({ status: 'error', message: 'spam detected' }); // ハニーポット

  const email = String(body.email || '').trim().toLowerCase();
  const nickname = stripTags_(String(body.nickname || '')).trim().slice(0, 30);

  if (!isValidEmail_(email)) return jsonOutput({ status: 'error', message: 'invalid email' });
  if (!nickname) return jsonOutput({ status: 'error', message: 'nickname required' });

  // 簡易レート制限(同一メールでの連続登録を防ぐ)
  const cache = CacheService.getScriptCache();
  const rateKey = 'register_' + email;
  if (cache.get(rateKey)) return jsonOutput({ status: 'error', message: 'please wait before retrying' });
  cache.put(rateKey, '1', 60);

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const sheet = getSheet_(SHEET_USERS);
    const values = sheet.getDataRange().getValues();
    const header = values.shift();
    const idx = colIndex_(header, ['email']);

    const exists = values.some(row => String(row[idx.email]).toLowerCase() === email);

    // 既に登録済みでも「登録済みです」とは返さない(メールアドレスの存在を外部から判別できないようにする)
    // 未登録の場合のみ実際にユーザーを作成しメールを送信する
    if (!exists) {
      const password = generateTempPassword_();
      const salt = Utilities.getUuid();
      const hash = hashPassword_(password, salt);

      sheet.appendRow([email, hash, salt, nickname, 'user', true, new Date()]);

      MailApp.sendEmail({
        to: email,
        subject: '【MapTube】仮パスワードのお知らせ',
        body:
          `${nickname} 様\n\n` +
          `MapTubeへのご登録ありがとうございます。\n` +
          `以下の仮パスワードでログインし、ログイン後すぐに新しいパスワードに変更してください。\n\n` +
          `メールアドレス: ${email}\n` +
          `仮パスワード: ${password}\n\n` +
          `※このメールに心当たりがない場合は破棄してください。`
      });
    }

    // 登録済み/未登録どちらの場合も同じメッセージを返す(アカウント列挙対策)
    return jsonOutput({ status: 'ok', message: '登録処理を受け付けました。メールをご確認ください。' });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * ログイン
 * ============================================================ */
function handleLogin_(body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const cache = CacheService.getScriptCache();
  const lockKey = 'loginlock_' + email;
  const failKey = 'loginfail_' + email;

  if (cache.get(lockKey)) {
    return jsonOutput({ status: 'error', message: 'too many failed attempts. please wait.' });
  }

  const user = getUserByEmail_(email);
  if (!user || hashPassword_(password, user.salt) !== user.passwordHash) {
    const fails = Number(cache.get(failKey) || '0') + 1;
    if (fails >= LOGIN_LOCK_THRESHOLD) {
      cache.put(lockKey, '1', LOGIN_LOCK_MINUTES * 60);
      cache.remove(failKey);
    } else {
      cache.put(failKey, String(fails), 60 * 30);
    }
    return jsonOutput({ status: 'error', message: 'invalid email or password' });
  }
  cache.remove(failKey);

  const token = Utilities.getUuid();
  const sheet = getSheet_(SHEET_SESSIONS);
  sheet.appendRow([token, email, new Date(Date.now() + SESSION_DURATION_MS)]);

  return jsonOutput({
    status: 'ok',
    token: token,
    nickname: user.nickname,
    role: user.role,
    mustChangePassword: user.mustChangePassword === true || user.mustChangePassword === 'TRUE'
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
 * パスワード変更(初回強制変更にも通常の変更にも使用)
 * ============================================================ */
function handleChangePassword_(body) {
  const session = getSession_(body.token);
  if (!session) return jsonOutput({ status: 'error', message: 'session expired. please login again.' });

  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 8) {
    return jsonOutput({ status: 'error', message: 'password must be at least 8 characters' });
  }

  const sheet = getSheet_(SHEET_USERS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['email','passwordHash','salt','mustChangePassword']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.email]).toLowerCase() === session.email) {
      const row = i + 2;
      const salt = values[i][idx.salt];
      if (hashPassword_(oldPassword, salt) !== values[i][idx.passwordHash]) {
        return jsonOutput({ status: 'error', message: 'current password is incorrect' });
      }
      const newSalt = Utilities.getUuid();
      sheet.getRange(row, idx.passwordHash + 1).setValue(hashPassword_(newPassword, newSalt));
      sheet.getRange(row, idx.salt + 1).setValue(newSalt);
      sheet.getRange(row, idx.mustChangePassword + 1).setValue(false);

      // パスワード変更時は既存の全セッションを無効化する(漏えいしたセッションの遮断)
      invalidateAllSessions_(session.email);

      return jsonOutput({ status: 'ok', message: 'password updated. please login again.' });
    }
  }
  return jsonOutput({ status: 'error', message: 'user not found' });
}

/* ============================================================
 * ニックネーム変更(本人のみ。既存の投稿・コメントの表示名も合わせて更新する)
 * ============================================================ */
function handleUpdateNickname_(body) {
  const session = getSession_(body.token);
  if (!session) return jsonOutput({ status: 'error', message: 'session expired. please login again.' });

  const newNickname = stripTags_(String(body.nickname || '')).trim().slice(0, 30);
  if (!newNickname) return jsonOutput({ status: 'error', message: 'nickname required' });

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    // users シートを更新
    const usersSheet = getSheet_(SHEET_USERS);
    const userValues = usersSheet.getDataRange().getValues();
    const userHeader = userValues.shift();
    const userIdx = colIndex_(userHeader, ['email', 'nickname']);

    let found = false;
    for (let i = 0; i < userValues.length; i++) {
      if (String(userValues[i][userIdx.email]).toLowerCase() === session.email) {
        usersSheet.getRange(i + 2, userIdx.nickname + 1).setValue(newNickname);
        found = true;
        break;
      }
    }
    if (!found) return jsonOutput({ status: 'error', message: 'user not found' });

    // 既存の投稿・コメントの表示名も合わせて更新(過去投稿の表示が古いニックネームのまま残らないように)
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
  if (body.hp) return jsonOutput({ status: 'error', message: 'spam detected' });

  const session = getSession_(body.token);
  if (!session) return jsonOutput({ status: 'error', message: 'session expired. please login again.' });

  const cache = CacheService.getScriptCache();
  const rateKey = 'post_' + session.email;
  if (cache.get(rateKey)) return jsonOutput({ status: 'error', message: 'too many requests. please wait.' });
  cache.put(rateKey, '1', 30);

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return jsonOutput({ status: 'error', message: 'invalid coordinates' });
  }

  const rawVideoUrl = String(body.videoUrl || '').trim();
  if (!rawVideoUrl && !body.photoBase64) {
    return jsonOutput({ status: 'error', message: 'video url or photo required' });
  }
  const videoUrl = rawVideoUrl.slice(0, MAX_URL_LENGTH);
  if (videoUrl && !isAllowedVideoUrl_(videoUrl)) return jsonOutput({ status: 'error', message: 'invalid video url' });

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
      return jsonOutput({ status: 'error', message: err.message || 'photo upload failed' });
    }
  }

  const user = getUserByEmail_(session.email);
  const postId = Utilities.getUuid();

  // appendRowは列の「位置」で書き込むため、postsシートの列順(冒頭コメント参照)と
  // このまま合わせること。photoUrl/photoFileIdは末尾に追加した想定。
  const sheet = getSheet_(SHEET_POSTS);
  sheet.appendRow([postId, new Date(), lat, lng, videoUrl, description, true, session.email, user.nickname, photoUrl, photoFileId]);

  return jsonOutput({ status: 'ok', postId: postId, photoUrl: photoUrl });
}

/* ============================================================
 * 写真をGoogle Driveに保存し、{url, fileId} を返す
 * body.photoBase64 は "data:image/jpeg;base64,xxxx" 形式のdata URLを想定。
 * ============================================================ */
function savePhotoToDrive_(photoDataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(photoDataUrl || ''));
  if (!match) throw new Error('invalid photo data');

  const mimeType = match[1];
  if (ALLOWED_PHOTO_MIME.indexOf(mimeType) === -1) throw new Error('unsupported photo format');

  const bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error('photo too large');
  if (bytes.length === 0) throw new Error('empty photo data');

  const ext = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
  const blob = Utilities.newBlob(bytes, mimeType, 'photo_' + Utilities.getUuid() + '.' + ext);

  const folder = getOrCreatePhotoFolder_();
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const fileId = file.getId();
  // thumbnail エンドポイントは公開共有された画像を軽量に直接表示できる(<img>のsrcにそのまま使える)。
  return { url: 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1000', fileId: fileId };
}

/* ============================================================
 * 写真保存用フォルダを取得(なければ作成)。フォルダIDはスクリプトプロパティにキャッシュする。
 * ============================================================ */
function getOrCreatePhotoFolder_() {
  const cachedId = PROPS.getProperty('PHOTO_FOLDER_ID');
  if (cachedId) {
    try { return DriveApp.getFolderById(cachedId); } catch (e) { /* フォルダが削除されていた場合は再作成する */ }
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
  const session = getSession_(body.token);
  if (!session) return jsonOutput({ status: 'error', message: 'session expired. please login again.' });

  const postId = String(body.postId || '');
  const sheet = getSheet_(SHEET_POSTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['postId','videoUrl','description','ownerEmail','photoUrl','photoFileId']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.postId]) === postId) {
      const isOwner = String(values[i][idx.ownerEmail]).toLowerCase() === session.email;
      const isAdmin = session.role === 'admin';
      if (!isOwner && !isAdmin) return jsonOutput({ status: 'error', message: 'permission denied' });

      const rawVideoUrl = String(body.videoUrl || '').trim();
      if (rawVideoUrl && !isAllowedVideoUrl_(rawVideoUrl)) return jsonOutput({ status: 'error', message: 'invalid video url' });

      // 動画URLを削除する場合は、更新後に写真が残る(削除しない/新規アップロードする)ことを必須にする
      const hasExistingPhoto = idx.photoUrl !== -1 && !!values[i][idx.photoUrl];
      const willHavePhoto = body.removePhoto ? false : (body.photoBase64 ? true : hasExistingPhoto);
      if (!rawVideoUrl && !willHavePhoto) {
        return jsonOutput({ status: 'error', message: 'video url or photo required' });
      }

      const videoUrl = rawVideoUrl.slice(0, MAX_URL_LENGTH);
      const description = stripTags_(String(body.description || '')).slice(0, MAX_DESC_LENGTH);

      const row = i + 2;
      sheet.getRange(row, idx.videoUrl + 1).setValue(videoUrl);
      sheet.getRange(row, idx.description + 1).setValue(description);

      // 写真の差し替え・削除(任意)。photoUrl/photoFileId列がまだ無いシートでは何もしない。
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
            return jsonOutput({ status: 'error', message: err.message || 'photo upload failed' });
          }
        }
      }

      return jsonOutput({ status: 'ok' });
    }
  }
  return jsonOutput({ status: 'error', message: 'post not found' });
}

/* ============================================================
 * 投稿削除(本人または管理者のみ)
 * ============================================================ */
function handleDeletePost_(body) {
  const session = getSession_(body.token);
  if (!session) return jsonOutput({ status: 'error', message: 'session expired. please login again.' });

  const postId = String(body.postId || '');
  const sheet = getSheet_(SHEET_POSTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['postId','ownerEmail','photoFileId']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.postId]) === postId) {
      const isOwner = String(values[i][idx.ownerEmail]).toLowerCase() === session.email;
      const isAdmin = session.role === 'admin';
      if (!isOwner && !isAdmin) return jsonOutput({ status: 'error', message: 'permission denied' });

      if (idx.photoFileId !== -1) deletePhotoFile_(values[i][idx.photoFileId]);

      sheet.deleteRow(i + 2);
      return jsonOutput({ status: 'ok' });
    }
  }
  return jsonOutput({ status: 'error', message: 'post not found' });
}

/* ============================================================
 * コメント追加(ログイン済みユーザーのみ)
 * ============================================================ */
function handleAddComment_(body) {
  if (body.hp) return jsonOutput({ status: 'error', message: 'spam detected' });

  const session = getSession_(body.token);
  if (!session) return jsonOutput({ status: 'error', message: 'session expired. please login again.' });

  const cache = CacheService.getScriptCache();
  const rateKey = 'comment_' + session.email;
  if (cache.get(rateKey)) return jsonOutput({ status: 'error', message: 'too many requests. please wait.' });
  cache.put(rateKey, '1', 15);

  const postId = String(body.postId || '');
  if (!postId) return jsonOutput({ status: 'error', message: 'postId required' });

  // 対象のピンが実在し、かつ表示中であることを確認
  const postsSheet = getSheet_(SHEET_POSTS);
  const postValues = postsSheet.getDataRange().getValues();
  const postHeader = postValues.shift();
  const postIdx = colIndex_(postHeader, ['postId','visible']);
  const targetPost = postValues.find(row => String(row[postIdx.postId]) === postId);
  if (!targetPost || !(targetPost[postIdx.visible] === true || targetPost[postIdx.visible] === 'TRUE')) {
    return jsonOutput({ status: 'error', message: 'post not found' });
  }

  const comment = stripTags_(String(body.comment || '')).trim().slice(0, MAX_COMMENT_LENGTH);
  if (!comment) return jsonOutput({ status: 'error', message: 'comment required' });

  const user = getUserByEmail_(session.email);
  const commentId = Utilities.getUuid();

  const sheet = getSheet_(SHEET_COMMENTS);
  sheet.appendRow([commentId, postId, comment, session.email, user.nickname, new Date(), true]);

  return jsonOutput({ status: 'ok', commentId: commentId });
}

/* ============================================================
 * コメント編集(本人または管理者のみ)
 * ============================================================ */
function handleUpdateComment_(body) {
  const session = getSession_(body.token);
  if (!session) return jsonOutput({ status: 'error', message: 'session expired. please login again.' });

  const commentId = String(body.commentId || '');
  const sheet = getSheet_(SHEET_COMMENTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['commentId','comment','ownerEmail']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.commentId]) === commentId) {
      const isOwner = String(values[i][idx.ownerEmail]).toLowerCase() === session.email;
      const isAdmin = session.role === 'admin';
      if (!isOwner && !isAdmin) return jsonOutput({ status: 'error', message: 'permission denied' });

      const comment = stripTags_(String(body.comment || '')).trim().slice(0, MAX_COMMENT_LENGTH);
      if (!comment) return jsonOutput({ status: 'error', message: 'comment required' });

      sheet.getRange(i + 2, idx.comment + 1).setValue(comment);
      return jsonOutput({ status: 'ok' });
    }
  }
  return jsonOutput({ status: 'error', message: 'comment not found' });
}

/* ============================================================
 * コメント削除(本人または管理者のみ)
 * ============================================================ */
function handleDeleteComment_(body) {
  const session = getSession_(body.token);
  if (!session) return jsonOutput({ status: 'error', message: 'session expired. please login again.' });

  const commentId = String(body.commentId || '');
  const sheet = getSheet_(SHEET_COMMENTS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['commentId','ownerEmail']);

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idx.commentId]) === commentId) {
      const isOwner = String(values[i][idx.ownerEmail]).toLowerCase() === session.email;
      const isAdmin = session.role === 'admin';
      if (!isOwner && !isAdmin) return jsonOutput({ status: 'error', message: 'permission denied' });

      sheet.deleteRow(i + 2);
      return jsonOutput({ status: 'ok' });
    }
  }
  return jsonOutput({ status: 'error', message: 'comment not found' });
}

/* ============================================================
 * 指定メールアドレスの全セッションを無効化(パスワード変更時などに使用)
 * ============================================================ */
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

/* ============================================================
 * セッション検証(有効なら {email, role} を返す。無効ならnull)
 * ============================================================ */
function getSession_(token) {
  if (!token) return null;
  const sheet = getSheet_(SHEET_SESSIONS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['token','email','expiresAt']);

  for (let i = 0; i < values.length; i++) {
    if (values[i][idx.token] === token) {
      const expiresAt = new Date(values[i][idx.expiresAt]);
      if (expiresAt.getTime() < Date.now()) return null; // 期限切れ
      const user = getUserByEmail_(values[i][idx.email]);
      if (!user) return null;
      return { email: user.email, role: user.role };
    }
  }
  return null;
}

function getUserByEmail_(email) {
  email = String(email || '').trim().toLowerCase();
  const sheet = getSheet_(SHEET_USERS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = colIndex_(header, ['email','passwordHash','salt','nickname','role','mustChangePassword']);

  for (const row of values) {
    if (String(row[idx.email]).toLowerCase() === email) {
      return {
        email: String(row[idx.email]).toLowerCase(),
        passwordHash: row[idx.passwordHash],
        salt: row[idx.salt],
        nickname: row[idx.nickname],
        role: row[idx.role],
        mustChangePassword: row[idx.mustChangePassword]
      };
    }
  }
  return null;
}

/* ============================================================
 * 定期クリーンアップ(任意: 時間主導トリガーで1日1回など実行推奨)
 * 期限切れセッションを削除する
 * ============================================================ */
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
 * ユーティリティ
 * ============================================================ */
function getSheet_(name) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
}

function colIndex_(header, names) {
  const idx = {};
  names.forEach(n => idx[n] = header.indexOf(n));
  return idx;
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function stripTags_(str) {
  return str.replace(/<[^>]*>/g, '');
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

function hashPassword_(password, salt) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt);
  return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function generateTempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  return pw;
}
