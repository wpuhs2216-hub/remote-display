// リモート表示アプリ ローカル/LAN用サーバ（クラウド版は src/worker.js）
// /control : 操作側（画像+テキストの登録・送信）
// /display : 出力側（画像を上・テキストを下に全画面表示、2秒ポーリングで反映）
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

// DB: { presets: [{ id, text, image }], current: { text, image } | null }
let db = { presets: [], current: null };
try {
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) {
  console.error('DB読込失敗、初期化します:', e.message);
}
const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

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

// 合言葉の変更
app.post('/api/admin-key', auth, (req, res) => {
  const k = (req.body.newKey || '').trim();
  if (k.length < 4 || k.length > 64) return res.status(400).json({ error: '合言葉は4〜64文字で指定してください' });
  db.adminKey = k;
  saveDb();
  res.json({ ok: true });
});

// 現在の表示内容
app.get('/api/state', (req, res) => res.json({ current: db.current }));

// プリセット一覧
app.get('/api/presets', (req, res) => res.json({ presets: db.presets }));

// プリセット登録（画像 + テキスト）
app.post('/api/presets', auth, upload.single('image'), (req, res) => {
  const text = (req.body.text || '').trim();
  if (!req.file && !text) return res.status(400).json({ error: '画像またはテキストを指定してください' });
  const preset = {
    id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    text,
    image: req.file ? `/uploads/${req.file.filename}` : null,
  };
  db.presets.push(preset);
  saveDb();
  res.json({ preset });
});

// プリセット更新（テキスト・画像差し替え）
app.put('/api/presets/:id', auth, upload.single('image'), (req, res) => {
  const preset = db.presets.find((p) => p.id === req.params.id);
  if (!preset) return res.status(404).json({ error: 'not found' });
  const wasShown = db.current && db.current.image === preset.image && db.current.text === preset.text;
  if (typeof req.body.text === 'string') preset.text = req.body.text.trim();
  if (req.file) {
    deleteImageFile(preset.image);
    preset.image = `/uploads/${req.file.filename}`;
  }
  // 表示中のプリセットを編集した場合は表示にも反映
  if (wasShown) db.current = { text: preset.text, image: preset.image };
  saveDb();
  res.json({ preset });
});

// プリセット削除
app.delete('/api/presets/:id', auth, (req, res) => {
  const idx = db.presets.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [preset] = db.presets.splice(idx, 1);
  if (db.current && db.current.image === preset.image && db.current.text === preset.text) db.current = null;
  deleteImageFile(preset.image);
  saveDb();
  res.json({ ok: true });
});

// プリセットを出力側に表示
app.post('/api/show', auth, (req, res) => {
  const preset = db.presets.find((p) => p.id === req.body.presetId);
  if (!preset) return res.status(404).json({ error: 'not found' });
  db.current = { text: preset.text, image: preset.image };
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
