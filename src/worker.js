// Cloudflare Workers 版バックエンド
// - 静的ページは assets バインディング（public/）が配信
// - プリセットと表示状態は KV の "db" キー、画像は "img:*" キーに保存
// - 書き込み系 API は ADMIN_KEY シークレット設定時のみ X-Admin-Key ヘッダで認証

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function loadDb(env) {
  return (await env.KV.get('db', 'json')) || { presets: [], current: null };
}
const saveDb = (env, db) => env.KV.put('db', JSON.stringify(db));

const newId = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

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
      // 読み取り系
      if (method === 'GET') {
        const db = await loadDb(env);
        if (path === '/api/state') return json({ current: db.current });
        if (path === '/api/presets') return json({ presets: db.presets });
        return json({ error: 'not found' }, 404);
      }

      // 書き込み系は合言葉必須（ADMIN_KEY 未設定時はローカル開発とみなし素通し）
      if (env.ADMIN_KEY && req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
        return json({ error: '合言葉が違います' }, 401);
      }

      const db = await loadDb(env);

      if (method === 'POST' && path === '/api/presets') {
        const fd = await req.formData();
        const text = (fd.get('text') || '').toString().trim();
        const file = fd.get('image');
        const hasImage = file && typeof file === 'object' && file.size > 0;
        if (!hasImage && !text) return json({ error: '画像またはテキストを指定してください' }, 400);
        let image = null;
        if (hasImage) {
          try { image = await saveImage(env, file); } catch (e) { return json({ error: e.message }, 400); }
        }
        const preset = { id: newId(), text, image };
        db.presets.push(preset);
        await saveDb(env, db);
        return json({ preset });
      }

      const presetMatch = path.match(/^\/api\/presets\/([\w.-]+)$/);
      if (presetMatch) {
        const preset = db.presets.find((p) => p.id === presetMatch[1]);
        if (!preset) return json({ error: 'not found' }, 404);

        if (method === 'PUT') {
          const fd = await req.formData();
          const wasShown = db.current && db.current.image === preset.image && db.current.text === preset.text;
          const text = fd.get('text');
          if (typeof text === 'string') preset.text = text.trim();
          const file = fd.get('image');
          if (file && typeof file === 'object' && file.size > 0) {
            await deleteImage(env, preset.image);
            try { preset.image = await saveImage(env, file); } catch (e) { return json({ error: e.message }, 400); }
          }
          // 表示中のプリセットを編集した場合は表示にも反映
          if (wasShown) db.current = { text: preset.text, image: preset.image };
          await saveDb(env, db);
          return json({ preset });
        }

        if (method === 'DELETE') {
          db.presets = db.presets.filter((p) => p.id !== preset.id);
          if (db.current && db.current.image === preset.image && db.current.text === preset.text) db.current = null;
          await deleteImage(env, preset.image);
          await saveDb(env, db);
          return json({ ok: true });
        }
      }

      if (method === 'POST' && path === '/api/show') {
        const { presetId } = await req.json();
        const preset = db.presets.find((p) => p.id === presetId);
        if (!preset) return json({ error: 'not found' }, 404);
        db.current = { text: preset.text, image: preset.image };
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
