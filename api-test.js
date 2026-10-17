'use strict';

/*
  Диагностика API Yandex Music: как правильно запросить FLAC, лайкнуть трек, получить плейлисты.
  Запуск: node api-test.js <токен> [trackId]   (trackId вида "albumId:trackId")
  Только stdlib (fetch), зависимостей нет.
*/

const crypto = require('crypto');

const BASE = 'https://api.music.yandex.net';
const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'X-Yandex-Music-Client': 'YandexMusicDesktopAppWindows/5.25.1'
};

// Ключи подписи официального клиента (из JS-бандла music.yandex.ru)
const KEYS = {
  web: '7tvSmFbyf5hJnIHhCimDDD',
  win32: 'kzqU4XhfCaY6B6JTHODeq5',   // как в плагине
  darwin: 'uz0zSpaYCLmgk6C7YLdo5F',
  linux: 'uVNvVMAvdrvjtwN0VlhEt2'
};

function sign(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('base64').replace(/=+$/, '');
}

async function call(token, path, params, method) {
  const url = new URL(BASE + path);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: method || 'GET',
    headers: Object.assign({ Authorization: 'OAuth ' + token }, HEADERS)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text.slice(0, 300); }
  return { status: res.status, data };
}

// Варианты подписи: ключ x единица ts (секунды/миллисекунды)
async function fileInfoVariants(token, trackId) {
  const codecs = ['flac', 'mp3', 'flac-mp4'];
  for (const [keyName, key] of Object.entries(KEYS)) {
    for (const unit of ['sec', 'ms']) {
      const ts = (unit === 'sec') ? Math.floor(Date.now() / 1000) : Date.now();
      // официальный формат: ts + trackId + quality + кодеки без запятых + транспорт
      const s = sign(key, '' + ts + trackId + 'lossless' + codecs.join('') + 'raw');
      const r = await call(token, '/get-file-info', {
        ts: ts, trackId: trackId, quality: 'lossless',
        codecs: codecs.join(','), transports: 'raw', sign: s
      });
      const d = r.data && r.data.downloadInfo ? r.data.downloadInfo : r.data;
      console.log(JSON.stringify({
        key: keyName, ts: unit, status: r.status,
        codec: d.codec, quality: d.quality, bitrate: d.bitrate, transport: d.transport,
        error: d.error
      }));
    }
  }
}

async function main() {
  const token = process.argv[2];
  const trackId = process.argv[3] || '314402:31542';
  if (!token) { console.log('Использование: node api-test.js <токен> [trackId]'); process.exit(1); }

  console.log('=== 1. /account/status и /settings ===');
  const st = await call(token, '/account/status');
  console.log('account:', st.status, JSON.stringify(st.data).slice(0, 300));
  const s = await call(token, '/settings');
  console.log('settings:', s.status, JSON.stringify({ hasPlus: s.data.hasPlus, quality: s.data.quality, losslessAvailable: s.data.losslessAvailable, userAgentIsDesktop: s.data.userAgentIsDesktop }));

  console.log('\n=== 2. download-info (без sign) ===');
  const d = await call(token, '/tracks/' + trackId + '/download-info', { format: 'json' });
  console.log(JSON.stringify({ status: d.status, codec: d.data.codec, quality: d.data.quality, bitrate: d.data.bitrate, transport: d.data.transport }));

  console.log('\n=== 3. get-file-info: варианты подписи ===');
  await fileInfoVariants(token, trackId);

  console.log('\n=== 4. Лайк ===');
  const l = await call(token, '/likes?trackId=' + trackId, null, 'POST');
  console.log('like:', l.status, JSON.stringify(l.data).slice(0, 200));

  console.log('\n=== 5. Плейлисты ===');
  const p = await call(token, '/user/playlists');
  if (p.data && p.data.length) {
    console.log('плейлистов:', p.data.length);
    for (const x of p.data.slice(0, 6)) console.log('  ' + x.id + ' | ' + x.title + ' | tracks=' + x.trackCount + ' | type=' + x.type);
    const one = await call(token, '/playlists/' + p.data[0].id);
    const t = one.data.tracks && one.data.tracks[0];
    if (t) console.log('первый трек: ' + t.id + ':' + (t.albumId || '') + ' ' + t.title + ' losslessAvailable=' + t.losslessAvailable);
  } else {
    console.log('ошибка', p.status, JSON.stringify(p.data).slice(0, 200));
  }
}

main().catch(e => console.error(e));
