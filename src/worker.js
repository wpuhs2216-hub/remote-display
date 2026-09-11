// Cloudflare Workers 版バックエンド
// - 静的ページは assets バインディング（public/）が配信
// - 状態（プリセット・表示内容・設定）は Durable Object に保存（強整合・即時反映）
// - 出力画面へは WebSocket でプッシュ配信（ポーリングはフォールバック）
// - 画像のみ KV に保存（immutable なのでエッジキャッシュと相性が良い）
//
// DB 構造:
//   presets: [{ id, image, texts: [string], note }]   … 1画像に複数テキスト候補+注釈
//   current: { image, text, note, showNote } | null    … 表示中の内容
//   settings: { bg, fg }                                … 背景色・文字色（既定: 白地に黒文字）
//   adminKey: string?                                   … UIで変更された合言葉（シークレットより優先）

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// 旧形式からの移行と既定値の補完
// texts は [{ t: テキスト, note: 注釈 }] 形式（注釈はテキスト候補ごとに紐付け）
function normalizeDb(db) {
  for (const p of db.presets) {
    if (!Array.isArray(p.texts)) p.texts = p.text ? [p.text] : [];
    delete p.text;
    p.texts = p.texts
      .map((x) => (typeof x === 'string' ? { t: x, note: '' } : { t: String(x.t || ''), note: String(x.note || '') }))
      .filter((x) => x.t);
    // 旧プリセット単位の注釈は「〇を含まない」テキスト（答え側）へ紐付けて移行
    if (typeof p.note === 'string' && p.note.trim()) {
      const target = p.texts.find((x) => !x.t.includes('〇')) || p.texts[p.texts.length - 1];
      if (target && !target.note) target.note = p.note.trim();
    }
    delete p.note;
    if (typeof p.folder !== 'string') p.folder = '';
  }
  if (!db.settings) db.settings = { bg: '#ffffff', fg: '#000000' };
  if (db.current && db.current.showNote === undefined) db.current.showNote = true;
  if (!db.quiz) db.quiz = quizDefault();
  if (!db.quiz.tableStats) db.quiz.tableStats = {};
  // 旧仕様（正解+3P）からの移行: 1問+1P・全問正解ボーナス+10P
  if (db.quiz.pointsPerCorrect === 3) db.quiz.pointsPerCorrect = 1;
  if (!db.quiz.playerStats) db.quiz.playerStats = {};
  if (!db.quiz.perfectBonus) db.quiz.perfectBonus = 10;
  if (!db.quiz.perfectAwarded) db.quiz.perfectAwarded = [];
  return db;
}

const newId = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
const isHexColor = (v) => /^#[0-9a-fA-F]{6}$/.test(v || '');

// 回答判定用の正規化（全角半角統一・空白除去・カタカナ→ひらがな・小文字化）
const normAnswer = (s) => (s || '')
  .normalize('NFKC')
  .replace(/\s+/g, '')
  .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
  .toLowerCase();

// クイズ大会の初期状態
const quizDefault = () => ({
  hosts: [],                                   // [{name, team: 'A'|'B'}]
  teamNames: { A: 'チームA', B: 'チームB' },
  state: 'idle',                               // idle | open | closed | revealed
  qnum: 0,
  current: null,                               // {presetId, questionIndex, correctIndex, correctText, correctNote}
  answers: {},                                 // playerId -> {name, host, table, answer, at, ok?}
  scores: {},                                  // 担当名 -> 累計ポイント
  tableStats: {},                              // 卓名 -> {answers, correct} の累計
  playerStats: {},                             // playerId -> {name, host, table, answered, correct} の累計
  pointsPerCorrect: 1,
  perfectBonus: 10,                            // 全問正解ボーナス
  perfectAwarded: [],                          // ボーナス付与済み playerId（二重付与防止）
});

// 穴埋め入力モード: 問題文に〇があり、正解と文字数が一致する場合のみ有効
const isBlankMode = (qText, correctText) =>
  !!qText && qText.includes('〇') && [...qText].length === [...(correctText || '')].length;

// 参加者・進行画面に配る公開クイズ状態（正解は発表後のみ含める）
function publicQuiz(db) {
  const q = db.quiz;
  let question = null;
  if (q.state !== 'idle' && q.current) {
    const p = db.presets.find((x) => x.id === q.current.presetId);
    if (p) {
      const qText = (p.texts[q.current.questionIndex] || p.texts[0] || { t: '' }).t;
      question = { image: p.image, text: qText, blankMode: isBlankMode(qText, q.current.correctText) };
    }
  }
  const pub = {
    state: q.state, qnum: q.qnum, hosts: q.hosts, teamNames: q.teamNames,
    question, answered: Object.keys(q.answers).length,
    scores: q.scores, points: q.pointsPerCorrect,
  };
  if (q.state === 'revealed' && q.current) {
    pub.correct = q.current.correctText;
    pub.note = q.current.correctNote || '';
    if (q.current.extraCorrect && q.current.extraCorrect.length) pub.alsoCorrect = q.current.extraCorrect;
    pub.results = {};
    for (const [pid, a] of Object.entries(q.answers)) {
      pub.results[pid] = { ok: !!a.ok, answer: a.answer, name: a.name, host: a.host };
    }
  }
  return pub;
}

// 画像・動画を KV に保存してパスを返す
async function saveImage(env, file) {
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const key = `img:${newId()}.${ext}`;
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 20 * 1024 * 1024) throw new Error('ファイルは20MBまでです');
  await env.KV.put(key, buf, { metadata: { ct: file.type } });
  return `/uploads/${key.slice(4)}`;
}

const deleteImage = (env, imagePath) =>
  imagePath ? env.KV.delete(`img:${imagePath.split('/').pop()}`) : Promise.resolve();

// 状態を保持する Durable Object（グローバル1インスタンス）
export class StateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._db = null;
  }

  async db() {
    if (!this._db) {
      let db = await this.state.storage.get('db');
      // 初回のみ旧KV保存データから移行
      if (!db) db = (await this.env.KV.get('db', 'json')) || { presets: [], current: null };
      this._db = normalizeDb(db);
    }
    return this._db;
  }

  async save() {
    await this.state.storage.put('db', this._db);
  }

  // 接続中の全画面（出力・操作・クイズ）へ即時プッシュ
  broadcast() {
    const msg = JSON.stringify({ current: this._db.current, settings: this._db.settings, quiz: publicQuiz(this._db) });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  webSocketMessage() {}
  webSocketClose() {}
  webSocketError() {}

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const db = await this.db();

    // 出力画面のWebSocket接続（接続時に現在の状態を送る）
    if (path === '/ws') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ current: db.current, settings: db.settings, quiz: publicQuiz(db) }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // 読み取り系
    if (method === 'GET') {
      if (path === '/api/state') return json({ current: db.current, settings: db.settings });
      if (path === '/api/presets') return json({ presets: db.presets });
      if (path === '/api/quiz/state') return json({ quiz: publicQuiz(db) });
      return json({ error: 'not found' }, 404);
    }

    // 参加者の回答送信（合言葉不要・受付中のみ）
    if (method === 'POST' && path === '/api/quiz/answer') {
      const body = await req.json();
      const { playerId, name, host, answer } = body;
      const q = db.quiz;
      if (q.state !== 'open') return json({ error: '回答受付中ではありません' }, 400);
      if (typeof playerId !== 'string' || !playerId || playerId.length > 64) return json({ error: 'playerId が不正です' }, 400);
      let a = (answer || '').toString().trim();
      if (!a || a.length > 50) return json({ error: '回答は1〜50文字で入力してください' }, 400);
      if (q.hosts.length && !q.hosts.some((h) => h.name === host)) return json({ error: '担当を選択してください' }, 400);
      // 穴埋めモード: 穴の文字だけ送られてきたら問題文に流し込んで完全な単語に復元する
      if (q.current) {
        const p = db.presets.find((x) => x.id === q.current.presetId);
        const qText = p ? (p.texts[q.current.questionIndex] || p.texts[0] || { t: '' }).t : '';
        if (isBlankMode(qText, q.current.correctText)) {
          const qChars = [...qText];
          const blanks = qChars.filter((c) => c === '〇').length;
          const aChars = [...a];
          if (aChars.length === blanks) {
            let k = 0;
            a = qChars.map((c) => (c === '〇' ? aChars[k++] : c)).join('');
          }
          // 文字数が合わない場合は全文入力とみなしてそのまま保存（旧バージョンの画面とも互換）
        }
      }
      q.answers[playerId] = {
        name: (name || '').toString().slice(0, 20),
        host: (host || '').toString().slice(0, 20),
        table: (body.table || '').toString().slice(0, 10),
        answer: a, at: Date.now(),
      };
      await this.save();
      this.broadcast();
      return json({ ok: true });
    }

    // 書き込み系は合言葉必須（UIで変更された値が優先。未設定時はローカル開発とみなし素通し）
    const adminKey = db.adminKey || this.env.ADMIN_KEY;
    if (adminKey && req.headers.get('X-Admin-Key') !== adminKey) {
      return json({ error: '合言葉が違います' }, 401);
    }

    // ---- クイズ大会（進行管理・要合言葉） ----
    if (method === 'POST' && path.startsWith('/api/quiz/')) {
      const q = db.quiz;
      const action = path.slice('/api/quiz/'.length);

      // 担当・チーム設定（既存スコアは名前一致で引き継ぐ）
      if (action === 'hosts') {
        const { teamA, teamB, teamNames } = await req.json();
        const mk = (arr, team) => (Array.isArray(arr) ? arr : [])
          .map((n) => (n || '').toString().trim()).filter(Boolean)
          .map((name) => ({ name: name.slice(0, 20), team }));
        q.hosts = [...mk(teamA, 'A'), ...mk(teamB, 'B')];
        if (teamNames && typeof teamNames.A === 'string') q.teamNames.A = teamNames.A.slice(0, 20) || 'チームA';
        if (teamNames && typeof teamNames.B === 'string') q.teamNames.B = teamNames.B.slice(0, 20) || 'チームB';
        await this.save();
        this.broadcast();
        return json({ quiz: publicQuiz(db) });
      }

      // 出題開始（回答受付オープン）
      if (action === 'start') {
        const { presetId, correctIndex, questionIndex } = await req.json();
        const p = db.presets.find((x) => x.id === presetId);
        if (!p) return json({ error: 'not found' }, 404);
        const ci = p.texts[correctIndex] ? correctIndex : 0;
        if (p.texts[ci] && p.texts[ci].t.includes('〇')) {
          return json({ error: '問題文（〇入り）は正解に指定できません' }, 400);
        }
        // 問題文は指定がなければ「〇を含むテキスト」を自動選択
        let qi = questionIndex;
        if (!p.texts[qi]) qi = Math.max(0, p.texts.findIndex((x) => x.t.includes('〇')));
        q.current = {
          presetId, questionIndex: qi, correctIndex: ci,
          correctText: p.texts[ci] ? p.texts[ci].t : '',
          correctNote: p.texts[ci] ? p.texts[ci].note : '',
          extraCorrect: [],
        };
        q.answers = {};
        q.state = 'open';
        q.qnum += 1;
        await this.save();
        this.broadcast();
        return json({ quiz: publicQuiz(db) });
      }

      // 追加の正解をリアルタイム登録（発表前のみ・想定外の正解対応）
      if (action === 'add-correct') {
        const { text } = await req.json();
        const t = (text || '').toString().trim();
        if (!t || t.length > 50) return json({ error: '1〜50文字で指定してください' }, 400);
        if (t.includes('〇')) return json({ error: '〇入りのテキストは正解にできません' }, 400);
        if (!q.current || q.state === 'revealed' || q.state === 'idle') {
          return json({ error: '出題中（発表前）のみ追加できます' }, 400);
        }
        if (!q.current.extraCorrect) q.current.extraCorrect = [];
        const key = normAnswer(t);
        if (key !== normAnswer(q.current.correctText) && !q.current.extraCorrect.some((x) => normAnswer(x) === key)) {
          q.current.extraCorrect.push(t);
          await this.save();
        }
        return json({ quiz: { ...publicQuiz(db), current: q.current } });
      }

      // 回答締切
      if (action === 'close') {
        if (q.state === 'open') q.state = 'closed';
        await this.save();
        this.broadcast();
        return json({ quiz: publicQuiz(db) });
      }

      // 結果発表（自動判定 + 担当へ加点 + 卓別集計）
      if (action === 'reveal') {
        if (q.current && (q.state === 'open' || q.state === 'closed')) {
          const keys = [q.current.correctText, ...(q.current.extraCorrect || [])].map(normAnswer);
          if (!q.tableStats) q.tableStats = {};
          for (const [pid, a] of Object.entries(q.answers)) {
            a.ok = keys.includes(normAnswer(a.answer));
            if (a.ok && a.host) q.scores[a.host] = (q.scores[a.host] || 0) + q.pointsPerCorrect;
            const t = a.table || '不明';
            if (!q.tableStats[t]) q.tableStats[t] = { answers: 0, correct: 0 };
            q.tableStats[t].answers += 1;
            if (a.ok) q.tableStats[t].correct += 1;
            // 参加者別の累計（全問正解ボーナス判定用）
            if (!q.playerStats[pid]) q.playerStats[pid] = { answered: 0, correct: 0 };
            const ps = q.playerStats[pid];
            ps.name = a.name; ps.host = a.host; ps.table = a.table;
            ps.answered += 1;
            if (a.ok) ps.correct += 1;
          }
          q.state = 'revealed';
          await this.save();
          this.broadcast();
        }
        return json({ quiz: publicQuiz(db) });
      }

      // 待機に戻す（次の問題へ）
      if (action === 'idle') {
        q.state = 'idle';
        q.current = null;
        q.answers = {};
        await this.save();
        this.broadcast();
        return json({ quiz: publicQuiz(db) });
      }

      // スコア・進行の全リセット（担当設定は残す）
      if (action === 'reset') {
        db.quiz = { ...quizDefault(), hosts: q.hosts, teamNames: q.teamNames };
        await this.save();
        this.broadcast();
        return json({ quiz: publicQuiz(db) });
      }

      // 全問正解ボーナスの付与（全問回答かつ全問正解の参加者の担当へ加点・二重付与なし）
      if (action === 'award-perfect') {
        if (!q.qnum) return json({ error: 'まだ出題がありません' }, 400);
        const awarded = [];
        for (const [pid, ps] of Object.entries(q.playerStats || {})) {
          if (ps.answered === q.qnum && ps.correct === q.qnum && !q.perfectAwarded.includes(pid)) {
            if (ps.host) q.scores[ps.host] = (q.scores[ps.host] || 0) + q.perfectBonus;
            q.perfectAwarded.push(pid);
            awarded.push({ name: ps.name, host: ps.host, table: ps.table });
          }
        }
        if (awarded.length) {
          await this.save();
          this.broadcast();
        }
        return json({ awarded, bonus: q.perfectBonus, quiz: publicQuiz(db) });
      }

      // 進行用の詳細状態（回答一覧・卓別集計・参加者別累計つき）
      if (action === 'admin-state') {
        return json({ quiz: { ...publicQuiz(db), answers: q.answers, current: q.current, tableStats: q.tableStats || {}, playerStats: q.playerStats || {}, perfectBonus: q.perfectBonus, perfectAwarded: q.perfectAwarded || [] } });
      }

      return json({ error: 'not found' }, 404);
    }

    // 合言葉の変更
    if (method === 'POST' && path === '/api/admin-key') {
      const { newKey } = await req.json();
      const k = (newKey || '').trim();
      if (k.length < 4 || k.length > 64) return json({ error: '合言葉は4〜64文字で指定してください' }, 400);
      db.adminKey = k;
      await this.save();
      return json({ ok: true });
    }

    // 背景色・文字色の変更
    if (method === 'POST' && path === '/api/settings') {
      const { bg, fg } = await req.json();
      if (isHexColor(bg)) db.settings.bg = bg;
      if (isHexColor(fg)) db.settings.fg = fg;
      await this.save();
      this.broadcast();
      return json({ settings: db.settings });
    }

    // 注釈の表示ON/OFF（表示中いつでも切替可能）
    if (method === 'POST' && path === '/api/note') {
      const { showNote } = await req.json();
      if (db.current) {
        db.current.showNote = !!showNote;
        await this.save();
        this.broadcast();
      }
      return json({ current: db.current });
    }

    if (method === 'POST' && path === '/api/presets') {
      const fd = await req.formData();
      // texts は textsJson（複数候補+注釈）優先、なければ従来の text/note 単一
      let texts = [];
      const textsJson = fd.get('textsJson');
      if (typeof textsJson === 'string' && textsJson) {
        try {
          const arr = JSON.parse(textsJson);
          if (Array.isArray(arr)) {
            texts = arr
              .map((x) => (typeof x === 'string' ? { t: x.trim(), note: '' } : { t: String(x.t || '').trim(), note: String(x.note || '').trim() }))
              .filter((x) => x.t);
          }
        } catch { return json({ error: 'textsJson が不正です' }, 400); }
      } else {
        const text = (fd.get('text') || '').toString().trim();
        const note = (fd.get('note') || '').toString().trim();
        if (text) texts = [{ t: text, note }];
      }
      const file = fd.get('image');
      const hasImage = file && typeof file === 'object' && file.size > 0;
      if (!hasImage && !texts.length) return json({ error: '画像またはテキストを指定してください' }, 400);
      let image = null;
      if (hasImage) {
        try { image = await saveImage(this.env, file); } catch (e) { return json({ error: e.message }, 400); }
      }
      const preset = { id: newId(), image, texts, folder: (fd.get('folder') || '').toString().trim() };
      const vfile = fd.get('video');
      if (vfile && typeof vfile === 'object' && vfile.size > 0) {
        try { preset.video = await saveImage(this.env, vfile); } catch (e) { return json({ error: e.message }, 400); }
      }
      db.presets.push(preset);
      await this.save();
      return json({ preset });
    }

    const presetMatch = path.match(/^\/api\/presets\/([\w.-]+)$/);
    if (presetMatch) {
      const preset = db.presets.find((p) => p.id === presetMatch[1]);
      if (!preset) return json({ error: 'not found' }, 404);
      const wasShown = db.current && db.current.image === preset.image;

      if (method === 'PUT') {
        const fd = await req.formData();
        const textsJson = fd.get('textsJson');
        if (typeof textsJson === 'string') {
          try {
            const arr = JSON.parse(textsJson);
            if (Array.isArray(arr)) {
              preset.texts = arr
                .map((x) => (typeof x === 'string' ? { t: x.trim(), note: '' } : { t: String(x.t || '').trim(), note: String(x.note || '').trim() }))
                .filter((x) => x.t);
            }
          } catch { return json({ error: 'textsJson が不正です' }, 400); }
        }
        const folder = fd.get('folder');
        if (typeof folder === 'string') preset.folder = folder.trim();
        const file = fd.get('image');
        if (file && typeof file === 'object' && file.size > 0) {
          await deleteImage(this.env, preset.image);
          try { preset.image = await saveImage(this.env, file); } catch (e) { return json({ error: e.message }, 400); }
        }
        // 解説動画の添付・差し替え
        const vfile = fd.get('video');
        if (vfile && typeof vfile === 'object' && vfile.size > 0) {
          await deleteImage(this.env, preset.video);
          try { preset.video = await saveImage(this.env, vfile); } catch (e) { return json({ error: e.message }, 400); }
        }
        // 表示中のプリセットを編集した場合は表示にも反映
        if (wasShown) {
          const entry = preset.texts.find((x) => x.t === db.current.text) || preset.texts[0] || null;
          db.current = {
            image: preset.image,
            text: entry ? entry.t : '',
            note: entry ? entry.note : '',
            showNote: db.current.showNote,
          };
          this.broadcast();
        }
        await this.save();
        return json({ preset });
      }

      if (method === 'DELETE') {
        db.presets = db.presets.filter((p) => p.id !== preset.id);
        if (wasShown) {
          db.current = null;
          this.broadcast();
        }
        await deleteImage(this.env, preset.image);
        await deleteImage(this.env, preset.video);
        await this.save();
        return json({ ok: true });
      }
    }

    if (method === 'POST' && path === '/api/show') {
      const { presetId, textIndex, showNote, video } = await req.json();
      const preset = db.presets.find((p) => p.id === presetId);
      if (!preset) return json({ error: 'not found' }, 404);
      // 解説動画の出力（画像+テキストの代わりに動画を全画面再生）
      if (video === true && preset.video) {
        db.current = { image: null, text: '', note: '', showNote: false, video: preset.video };
        await this.save();
        this.broadcast();
        return json({ current: db.current });
      }
      const entry = textIndex >= 0 ? (preset.texts[textIndex] || null) : null;
      db.current = {
        image: preset.image,
        text: entry ? entry.t : '',
        note: entry ? entry.note : '',
        showNote: typeof showNote === 'boolean' ? showNote : (db.current ? db.current.showNote : true),
      };
      await this.save();
      this.broadcast();
      return json({ current: db.current });
    }

    // プリセットの並び替え（idの配列順に更新）
    if (method === 'POST' && path === '/api/reorder') {
      const { ids } = await req.json();
      if (Array.isArray(ids)) {
        const map = new Map(db.presets.map((p) => [p.id, p]));
        const ordered = ids.map((id) => map.get(id)).filter(Boolean);
        const rest = db.presets.filter((p) => !ids.includes(p.id));
        db.presets = [...ordered, ...rest];
        await this.save();
      }
      return json({ ok: true });
    }

    if (method === 'POST' && path === '/api/clear') {
      db.current = null;
      await this.save();
      this.broadcast();
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    // 画像配信（ファイル名が一意なのでエッジキャッシュOK）
    if (path.startsWith('/uploads/')) {
      const { value, metadata } = await env.KV.getWithMetadata(`img:${path.split('/').pop()}`, 'arrayBuffer');
      if (!value) return new Response('not found', { status: 404 });
      return new Response(value, {
        headers: { 'Content-Type': metadata?.ct || 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
    }

    // 状態系はすべて Durable Object へ（強整合・即時反映）
    if (path.startsWith('/api/') || path === '/ws') {
      const stub = env.STATE.get(env.STATE.idFromName('main'));
      return stub.fetch(req);
    }

    if (path === '/') return Response.redirect(`${url.origin}/control`, 302);
    // 拡張子なしURL → 対応する静的ページ（アセット未ヒット時に到達する）
    if (path === '/quiz' || path === '/quiz-admin') {
      return env.ASSETS.fetch(new Request(`${url.origin}${path}.html`, req));
    }
    return env.ASSETS.fetch(req);
  },
};
