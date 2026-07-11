// リモート表示アプリ ローカル/LAN用サーバ（クラウド版は src/worker.js）
// /control : 操作側（画像+複数テキスト候補+注釈の登録・送信）
// /display : 出力側（画像を上・太字テキストを下・注釈を赤字で全画面表示、2秒ポーリング）
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3800;
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // 未設定ならLAN内利用とみなし認証なし
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// DB構造は src/worker.js と同一（presets/current/settings/adminKey）
let db = { presets: [], current: null };
try {
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) {
  console.error('DB読込失敗、初期化します:', e.message);
}

// 旧形式（text 単一）からの移行と既定値の補完
for (const p of db.presets) {
  if (!Array.isArray(p.texts)) p.texts = p.text ? [p.text] : [];
  delete p.text;
  if (typeof p.note !== 'string') p.note = '';
}
if (!db.settings) db.settings = { bg: '#ffffff', fg: '#000000' };
if (db.current && db.current.showNote === undefined) db.current.showNote = true;

const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const isHexColor = (v) => /^#[0-9a-fA-F]{6}$/.test(v || '');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const deleteImageFile = (imagePath) => {
  if (!imagePath) return;
  const file = path.join(UPLOAD_DIR, path.basename(imagePath));
  fs.existsSync(file) && fs.unlinkSync(file);
};

// 書き込み系APIの合言葉チェック（UIで変更された値が優先）
const auth = (req, res, next) => {
  const adminKey = db.adminKey || ADMIN_KEY;
  if (adminKey && req.get('X-Admin-Key') !== adminKey) {
    return res.status(401).json({ error: '合言葉が違います' });
  }
  next();
};

// ---- API ----

app.get('/api/state', (req, res) => res.json({ current: db.current, settings: db.settings }));
app.get('/api/presets', (req, res) => res.json({ presets: db.presets }));

// 合言葉の変更
app.post('/api/admin-key', auth, (req, res) => {
  const k = (req.body.newKey || '').trim();
  if (k.length < 4 || k.length > 64) return res.status(400).json({ error: '合言葉は4〜64文字で指定してください' });
  db.adminKey = k;
  saveDb();
  res.json({ ok: true });
});

// 背景色・文字色の変更
app.post('/api/settings', auth, (req, res) => {
  const { bg, fg } = req.body;
  if (isHexColor(bg)) db.settings.bg = bg;
  if (isHexColor(fg)) db.settings.fg = fg;
  saveDb();
  res.json({ settings: db.settings });
});

// 注釈の表示ON/OFF（表示中いつでも切替可能）
app.post('/api/note', auth, (req, res) => {
  if (db.current) {
    db.current.showNote = !!req.body.showNote;
    saveDb();
  }
  res.json({ current: db.current });
});

// プリセット登録（画像 + メインテキスト + 注釈）
app.post('/api/presets', auth, upload.single('image'), (req, res) => {
  const text = (req.body.text || '').trim();
  const note = (req.body.note || '').trim();
  if (!req.file && !text) return res.status(400).json({ error: '画像またはテキストを指定してください' });
  const preset = {
    id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    image: req.file ? `/uploads/${req.file.filename}` : null,
    texts: text ? [text] : [],
    note,
  };
  db.presets.push(preset);
  saveDb();
  res.json({ preset });
});

// プリセット更新（テキスト候補一括・注釈・画像差し替え）
app.put('/api/presets/:id', auth, upload.single('image'), (req, res) => {
  const preset = db.presets.find((p) => p.id === req.params.id);
  if (!preset) return res.status(404).json({ error: 'not found' });
  const wasShown = db.current && db.current.image === preset.image;

  if (typeof req.body.textsJson === 'string') {
    try {
      const arr = JSON.parse(req.body.textsJson);
      if (Array.isArray(arr)) preset.texts = arr.map((t) => String(t).trim()).filter(Boolean);
    } catch {
      return res.status(400).json({ error: 'textsJson が不正です' });
    }
  }
  if (typeof req.body.note === 'string') preset.note = req.body.note.trim();
  if (req.file) {
    deleteImageFile(preset.image);
    preset.image = `/uploads/${req.file.filename}`;
  }
  // 表示中のプリセットを編集した場合は表示にも反映
  if (wasShown) {
    db.current = {
      image: preset.image,
      text: preset.texts.includes(db.current.text) ? db.current.text : (preset.texts[0] || ''),
      note: preset.note,
      showNote: db.current.showNote,
    };
  }
  saveDb();
  res.json({ preset });
});

// プリセット削除
app.delete('/api/presets/:id', auth, (req, res) => {
  const idx = db.presets.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [preset] = db.presets.splice(idx, 1);
  if (db.current && db.current.image === preset.image) db.current = null;
  deleteImageFile(preset.image);
  saveDb();
  res.json({ ok: true });
});

// プリセットを出力側に表示（textIndex で候補を選択、-1 でテキストなし）
app.post('/api/show', auth, (req, res) => {
  const preset = db.presets.find((p) => p.id === req.body.presetId);
  if (!preset) return res.status(404).json({ error: 'not found' });
  const textIndex = req.body.textIndex;
  db.current = {
    image: preset.image,
    text: textIndex >= 0 ? (preset.texts[textIndex] || '') : '',
    note: preset.note,
    showNote: db.current ? db.current.showNote : true,
  };
  saveDb();
  res.json({ current: db.current });
});

// 表示クリア
app.post('/api/clear', auth, (req, res) => {
  db.current = null;
  saveDb();
  res.json({ ok: true });
});

// ページルーティング
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/', (req, res) => res.redirect('/control'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`remote-display: http://localhost:${PORT}  (操作: /control  出力: /display)`);
});
