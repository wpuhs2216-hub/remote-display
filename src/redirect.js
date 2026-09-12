// 旧本番(wpuhs2216)用: 新本番(eguhaji)へ301リダイレクト（印刷済みQRカード互換のため）
// DOバインディングを維持する必要があるためクラスを再エクスポートする（データは温存）
export { StateDO } from './worker.js';

export default {
  fetch(req) {
    const url = new URL(req.url);
    return Response.redirect('https://quiz.hajimeru.jp' + url.pathname + url.search, 301);
  },
};
