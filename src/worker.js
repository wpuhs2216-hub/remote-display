// Cloudflare Workers 版バックエンド
// - 静的ページは assets バインディング（public/）が配信
// - プリセットと表示状態は KV の "db" キー、画像は "img:*" キーに保存
// - 書き込み系 API は合言葉（X-Admin-Key）で認証
//
// DB 構造:
//   presets: [{ id, image, texts: [string], note }]   … 1画像に複数テキスト候補+注釈
//   current: { image, text, note, showNote } | null    … 表示中の内容
//   settings: { bg, fg }                                … 背景色・文字色（既定: 白地に黒文字）
//   adminKey: string?                                   … UIで変更された合言葉（シークレットより優先）

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// 旧形式（text 単一）からの移行と既定値の補完
function normalizeDb(db) {
  for (const p of db.presets) {
    if (!Array.isArray(p.texts)) p.texts = p.text ? [p.text] : [];
    delete p.text;
    if (typeof p.note !== 'string') p.note = '';
  }
  if (!db.settings) db.settings = { bg: '#ffffff', fg: '#000000' };
  if (db.current && db.current.showNote === undefined) db.current.showNote = true;
  return db;
}

async function loadDb(env) {
  return normalizeDb((await env.KV.get('db', 'json')) || { presets: [], current: null });
}
const saveDb = (env, db) => env.KV.put('db', JSON.stringify(db));

const newId = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
const isHexColor = (v) => /^#[0-9a-fA-F]{6}$/.test(v || '');

// 画像を KV に保存してパスを返す
async function saveImage(env, file) {
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const key = `img:${newId()}.${ext}`;
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 20 * 1024 * 1024) throw new Error('画像は20MBまでです');
  await env.KV.put(key, buf, { metadata: { ct: file.type } });
  return `/uploads/${key.slice(4)}`;
}

const deleteImage = (env, imagePath) =>
  imagePath ? env.KV.delete(`img:${imagePath.split('/').pop()}`) : Promise.resolve();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // 画像配信
    if (path.startsWith('/uploads/')) {
      const { value, metadata } = await env.KV.getWithMetadata(`img:${path.split('/').pop()}`, 'arrayBuffer');
      if (!value) return new Response('not found', { status: 404 });
      return new Response(value, {
        headers: { 'Content-Type': metadata?.ct || 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
    }

    if (path.startsWith('/api/')) {
      const db = await loadDb(env);

      // 読み取り系
      if (method === 'GET') {
        if (path === '/api/state') return json({ current: db.current, settings: db.settings });
        if (path === '/api/presets') return json({ presets: db.presets });
        return json({ error: 'not found' }, 404);
      }

      // 書き込み系は合言葉必須（UIで変更された値が優先。未設定時はローカル開発とみなし素通し）
      const adminKey = db.adminKey || env.ADMIN_KEY;
      if (adminKey && req.headers.get('X-Admin-Key') !== adminKey) {
        return json({ error: '合言葉が違います' }, 401);
      }

      // 合言葉の変更
      if (method === 'POST' && path === '/api/admin-key') {
        const { newKey } = await req.json();
        const k = (newKey || '').trim();
        if (k.length < 4 || k.length > 64) return json({ error: '合言葉は4〜64文字で指定してください' }, 400);
        db.adminKey = k;
        await saveDb(env, db);
        return json({ ok: true });
      }

      // 背景色・文字色の変更
      if (method === 'POST' && path === '/api/settings') {
        const { bg, fg } = await req.json();
        if (isHexColor(bg)) db.settings.bg = bg;
        if (isHexColor(fg)) db.settings.fg = fg;
        await saveDb(env, db);
        return json({ settings: db.settings });
      }

      // 注釈の表示ON/OFF（表示中いつでも切替可能）
      if (method === 'POST' && path === '/api/note') {
        const { showNote } = await req.json();
        if (db.current) {
          db.current.showNote = !!showNote;
          await saveDb(env, db);
        }
        return json({ current: db.current });
      }

      if (method === 'POST' && path === '/api/presets') {
        const fd = await req.formData();
        const text = (fd.get('text') || '').toString().trim();
        const note = (fd.get('note') || '').toString().trim();
        const file = fd.get('image');
        const hasImage = file && typeof file === 'object' && file.size > 0;
        if (!hasImage && !text) return json({ error: '画像またはテキストを指定してください' }, 400);
        let image = null;
        if (hasImage) {
          try { image = await saveImage(env, file); } catch (e) { return json({ error: e.message }, 400); }
        }
        const preset = { id: newId(), image, texts: text ? [text] : [], note };
        db.presets.push(preset);
        await saveDb(env, db);
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
              if (Array.isArray(arr)) preset.texts = arr.map((t) => String(t).trim()).filter(Boolean);
            } catch { return json({ error: 'textsJson が不正です' }, 400); }
          }
          const note = fd.get('note');
          if (typeof note === 'string') preset.note = note.trim();
          const file = fd.get('image');
          if (file && typeof file === 'object' && file.size > 0) {
            await deleteImage(env, preset.image);
            try { preset.image = await saveImage(env, file); } catch (e) { return json({ error: e.message }, 400); }
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
          await saveDb(env, db);
          return json({ preset });
        }

        if (method === 'DELETE') {
          db.presets = db.presets.filter((p) => p.id !== preset.id);
          if (wasShown) db.current = null;
          await deleteImage(env, preset.image);
          await saveDb(env, db);
          return json({ ok: true });
        }
      }

      if (method === 'POST' && path === '/api/show') {
        const { presetId, textIndex, showNote } = await req.json();
        const preset = db.presets.find((p) => p.id === presetId);
        if (!preset) return json({ error: 'not found' }, 404);
        const text = textIndex >= 0 ? (preset.texts[textIndex] || '') : '';
        db.current = {
          image: preset.image,
          text,
          note: preset.note,
          showNote: typeof showNote === 'boolean' ? showNote : (db.current ? db.current.showNote : true),
        };
        await saveDb(env, db);
        return json({ current: db.current });
      }

      if (method === 'POST' && path === '/api/clear') {
        db.current = null;
        await saveDb(env, db);
        return json({ ok: true });
      }

      return json({ error: 'not found' }, 404);
    }

    if (path === '/') return Response.redirect(`${url.origin}/control`, 302);
    return env.ASSETS.fetch(req);
  },
};
