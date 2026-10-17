# YaM: анализ проблемы с лайками и план доработки

## Приоритеты (что и в каком порядке делаем)

1. **Не сломать gapless-воспроизведение FLAC** — это базовое требование, все изменения проверяются против него (раздел «Что НЕ трогать»).
2. **Плейлисты не «прыгают»**: видим один порядок в UI, играет другой (раздел 8).
3. **Стандартные плейлисты** Яндекса в навигации (раздел 9).
4. **Поиск композиций** — сейчас странный: треки в результатах имеют type `folder` и не играют (раздел 9).
5. **Адекватное отображение типа композиции и статусов** (flac/mp3, битрейт) — раздел 6.
6. **Лайки** — разделы 1–3.

## TL;DR

1. **В текущем HEAD (03d3f67) кода лайков вообще нет.** Он был удалён коммитом `8658271` («Принудительное восстановление файлов из резервной копии»), который откатил `index.js`, `playlist.js`, `UIConfig.json`, `i18n`. Полная версия лежит в истории: `git show 88d19a3:index.js` / `git show 88d19a3:playlist.js`.
2. **Гипотеза про «стрим ≠ композиция» по сути верна, но причина другая.** В Яндексе у трека один `track.id` — для лайка, для FLAC-стрима, для радио. ID теряется не на стороне Яндекса, а при переходе в MPD: Volumio в consume-режиме отдаёт состояние, где `uri` = URL потока (прокси или `get-mp3`), а не `yam/track/<id>`.
3. **Prefetch перезаписывает `self.current_track`** (`onTrackChanging` вызывается и в `prefetch`), поэтому даже fallback «взять текущий трек» даёт *следующий* трек.
4. **Формат id `trackId:albumId` не принимается likes API** — нужен только числовой `trackId`.
5. **Сердечко в UI Volumio рисуется из внутренней базы «Избранного» Volumio**, а не из статуса аккаунта Яндекса. Успешный лайк в Яндексе сам по себе не покажет сердечко.
6. **Кнопка «Назад» ломается из-за MPD, а не Яндекса:** плагин держит в плейлисте MPD только `[текущий, prefetch'енный]` и включает consume-режим MPD (сыгранные треки удаляются), поэтому MPD `previous` с позиции 0 ничего не делает (см. раздел 5).

---

## 1. Как лайк проходит через Volumio (проверено по исходникам `volumio/volumio3-backend`)

| Шаг | Код | Что приходит плагину |
|---|---|---|
| Клик сердечка | WS event `addToFavourites` / `removeFromFavourites` | `data = {uri, service, title, albumart}` |
| Роутинг | `app/playlistManager.js:180` `addToFavourites` | если у сервиса есть метод `addToFavourites` → `plugin.addToFavourites({uri, service})`; **внутренняя база Избранного при этом НЕ пополняется** |
| Отмена | `playlistManager.js:208` `removeFromFavourites` | вызывает метод плагина **и** удаляет из внутренней базы |
| Состояние сердечка | `app/statemachine.js` `checkFavourites(state)` после каждого `pushState` | сравнивает `sanitizeUri(state.uri)` с внутренней базой → `emitFavourites({service, uri, favourite})` |
| Что такое `state.uri` для YaM | `statemachine.js` `getState()` в режиме consume | `consumeState.uri` — uri из MPD, т.е. `http://127.0.0.1:<port>/?codec=…&url=…` (HQ) или `https://…/get-mp3/<hash>/<ts><path>` (обычный режим) |

**Вывод:** плагин получает uri, в котором нет идентификатора трека Яндекса. Никакой «магии» на стороне Яндекса — просто потеря идентичности.

---

## 2. Перечень проблем

| # | Проблема | Где | Следствие |
|---|---|---|---|
| P1 | ID трека не сохраняется при добавлении в MPD | `index.js:836-842`, `876-878` (`getTrackUrl` → `addid`) | сердечко не может определить трек; лайк не отправляется |
| P2 | `prefetch()` вызывает `onTrackChanging()` и затирает `current_track` | `index.js:870` | лайк уходит в следующий трек; также ломается radio-feedback (`onEndTrack` для неверного трека) |
| P3 | `track_id` = `trackId:albumId@playlistId` | `playlist.js:31-33` | `trackId:albumId` — невалидный id для `/likes/tracks/add-multiple` |
| P4 | Сердечко = внутренняя база Volumio | `statemachine.js:checkFavourites` | даже успешный лайк не отображается; повторный клик может снять лайк |
| P5 | Нет чтения статуса «уже лайкано» из аккаунта | HEAD: `getLikedTrackIds` удалён | списки не показывают, что уже в «Мне нравится» |
| P6 | `self.uid` может быть `undefined` в момент вызова | `index.js:151-162` | 404/403 на likes endpoint |
| P7 | Нет тостов/строк i18n `LIKE_SENT`, `LIKE_REMOVED`, `LIKE_FAILED` | `i18n/strings_*.json` | пользователь не видит, что произошло |
| P10 | В `previous()` нет `var self = this` — `self` не определён | `index.js:955-958` | ReferenceError в strict mode: «назад» падает, MPD `previous` не вызывается вовсе |
| P11 | `getAlbumArt` использует `nodetools`, который не импортирован | `index.js:1089, 1103` | ReferenceError при запросе albumart |
| P12 | `handleBrowseUri` не знает `yam/track/`, а треки в поиске имеют type `folder` | `index.js:320-347`, `playlist.js:52-71` | клик по треку в результатах поиска → «Unable to browse» |
| P13 | Нет метода `clearAddPlayTracks` (множественного) | отсутствует в `index.js` | ядро вызывает его при перезапуске блока треков (`statemachine.js:333`) → warning, ничего не играет |
| P14 | В proxy.js нет `proxy.on('error')` и таймаута на upstream-запрос | `proxy.js:95-107` | сбой соединения с Яндексом может обрушить процесс плагина |
| P15 | Proxy: AES-CTR IV всегда 0 — при Range/seek счётчик неверен | `proxy.js:20-28` | шум/искажения при seek в HQ (encraw-транспорт) |
| P16 | `getTrackV1` берёт `sorted[0]` без проверки | `track.js:27-29` | TypeError для треков без mp3-варианта |
| P17 | Кэш `self.playlists` никогда не инвалидируется | `index.js:687`, `playlist.js:142` | устаревшие «Мне нравится»/альбомы при повторном browse |
| P18 | `browseMyPlaylists`/`explodeUri` вызывают API без проверки uid | `index.js:609, 994` | ошибка API при неавторизованном аккаунте |
| P19 | Отладочный блок «YaM DEBUG — журнал» в корне навигации | `index.js:410-429` | мусор в пользовательском меню |
| P8 | `previous()` уходит в MPD `previous`, но в плейлисте MPD только `[текущий, prefetch'енный]`, а consume-режим MPD удаляет сыгранные треки | `index.js:955-958`, `prefetch` (`consume 1`, `index.js:893`) | «Назад» всегда играет текущий трек, очередь «съезжает» |
| P9 | Бейдж качества/битрейта/сэмплрейта берётся из MPD, который для HTTP-стримов их не знает | `playlist.js:46-48, 67-69`, mpd `parseTrackInfo` | UI показывает пустые samplerate/bitdepth, trackType — только по расширению URL |

---

## 3. План: лайки (минимальный, не трогает воспроизведение)

### Шаг 1. Карта «URL потока → track id» (главное исправление, ~4 строки)

```js
// в конструкторе yandexMusic()
self.streamTrack = {};   // MPD stream URL -> числовой track id Яндекса

// в clearAddPlayTrack и prefetch, сразу после getTrackUrl(...):
var baseId = track_id.split('@')[0].split(':')[0];
self.streamTrack[data.uri] = baseId;
```

Почему это надёжно: MPD в `playlistinfo` возвращает ровно тот uri, который мы добавили, и именно он попадает в `state.uri`. Карта работает и при gapless-переходе, и после `seek`, и для prefetch — потому что ключом является *фактически играемый* поток, а не «последний запрошенный трек».

### Шаг 2. Резолвер трека

```js
yandexMusic.prototype.resolveTrackId = function (uri) {
    var m = String(uri || '').match(/yam\/track\/([^/?#]+)/);
    if (m) return m[1].split('@')[0].split(':')[0];
    return this.streamTrack[uri] || null;
};
```

Два источника покрывают оба случая: клик по треку в списке/очереди (`yam/track/…`) и сердечко в плеере (URL потока).

### Шаг 3. Отправка лайка — через уже установленную библиотеку

```js
yandexMusic.prototype.addToFavourites = function (data) { return this.setTrackFavourite(data, true); };
yandexMusic.prototype.removeFromFavourites = function (data) { return this.setTrackFavourite(data, false); };

yandexMusic.prototype.setTrackFavourite = function (data, liked) {
    var self = this;
    var trackId = self.resolveTrackId(data && data.uri);
    if (!trackId) {
        self.addDiagnosticLog('favourite: unresolved track', { uri: data && data.uri });
        return libQ.reject(new Error(self.getI18n('LIKE_FAILED')));
    }
    return self.checkUid().then(function () {
        if (!self.uid) throw new Error(self.getI18n('LOGIN_FAILED'));
        // yandex-music-client: POST /users/{uid}/likes/tracks/add-multiple | /remove
        var action = liked ? self.client.tracks.likeTracks : self.client.tracks.removeLikedTracks;
        return action.call(self.client.tracks, self.uid, { 'track-ids': trackId });
    }).then(function () {
        self.addDiagnosticLog('favourite sent', { trackId: trackId, liked: liked });
        self.commandRouter.emitFavourites({ service: 'yam', uri: data.uri, favourite: liked });
        self.commandRouter.pushToastMessage('success', self.getI18n('YAM_ACCOUNT'),
            self.getI18n(liked ? 'LIKE_SENT' : 'LIKE_REMOVED'));
    }).catch(function (err) {
        self.addDiagnosticLog('favourite failed', { message: err && err.message });
        self.commandRouter.pushToastMessage('error', self.getI18n('YAM_ACCOUNT'), self.getI18n('LIKE_FAILED'));
        throw err;
    });
};
```

Заметки:
- `client.tracks.likeTracks` сам ставит нужные заголовки (`Authorization`, `X-Yandex-Music-Client`, form-urlencoded) — меньше шансов получить 403, чем при ручном axios.
- Токен из `token.js` (oauth.mobile.yandex.net) для likes подходит; при `auth: token` из UI — тоже, если токен музыкальный, а не «паспортный».

### Шаг 4. Сердечко в UI (выбрать один вариант)

- **A. Минимальный (рекомендую для начала):** только `emitFavourites` после успешного лайка (см. выше). Работает до следующего `pushState`, который пересчитывает сердечко из внутренней базы Volumio. Лайк в аккаунте будет правильным, индикация — «плавающей».
- **B. Стабильная индикация:** после лайка добавить поток в избранное Volumio: `self.commandRouter.playListManager.commonAddToPlaylist('/data/favourites/', 'favourites', 'yam', streamUri, title, albumart)` (именно так это делает ядро, когда у сервиса нет своего `addToFavourites`). Минус: в «Избранном» Volumio появятся одноразовые URL потоков, которые позже не воспроизводятся.
- **C. Свой источник истины:** не полагаться на сердечко, а помечать треки в списках (`item.favourite`) по `getLikedTracksIds()` — это восстанавливается из `88d19a3:playlist.js` (`getLikedTrackIds`, `markFavouriteStates`).

Практический компромисс: **A + C**.

### Шаг 5. Проверка (без тестовой инфраструктуры)

1. `curl -s -H "Authorization: Bearer <token>" "https://api.music.yandex.net/users/<uid>/likes/tracks?limit=5"` — убедиться, что endpoint и токен работают.
2. В `addToFavourites` временно `self.logger.info('favourite data', data)` — увидеть, какой uri реально приходит (плеер vs очередь).
3. Поставить лайк на треке из «Моей волны» и из альбома → проверить, что в аккаунте появился именно этот трек (`/likes/tracks`).
4. Проверить gapless: лайкнуть во время воспроизведения, когда следующий трек уже prefetch'ен.

---

## 4. Плейлисты и «дополнительные возможности»

### Что уже есть
- `browseRoot`: «Моя волна» (заголовок), «Собираем для вас», «Новые релизы», «Популярные плейлисты», «Вы недавно слушали», «Ещё плейлисты» — через `landing.getLandingBlocks('personal-playlists,new-releases,new-playlists,play-contexts,playlists')`.
- Радио: `rotor.getRotorStationsDashboard()` + feedback (`trackStarted`, `trackFinished`, `skip`).
- «Мои плейлисты» + «Мне нравится» (`uid:3`).
- Альбомы, артисты, поиск.

### Чего не хватает для parity с веб-клиентом (API уже доступен в `yandex-music-client@0.4.3`)

| Возможность | Метод | Комментарий |
|---|---|---|
| Создать/переименовать/удалить плейлист | `playlists.createPlaylist`, `renamePlaylist`, `deletePlaylist` | нужен раздел UI в `UIConfig.json` |
| Добавить/убрать трек в плейлист | `playlists.changePlaylistTracks` | `new_tracks: [{trackId, albumId}]`, `offset` |
| Скрыть/показать плейлист | `playlists.changePlaylistVisibility` | |
| «Мне нравится» как источник истины | `tracks.getLikedTracksIds` | для `item.favourite` и для сердечка |
| «Не рекомендовать» (дизлайк) | `tracks.removeLikedTracks` / dislikes | опционально |
| Рекомендации треков/артов | `playlists.getRecommendations`, `landing.getChart` | опционально |
| «Собранные мной», «Скачанное», «Диски» | `user.getPlayLists` по `kind` | kind: 1 (пользовательские), 3 (лайки), 5/6/… |

### Порядок (чтобы не сломать работающее)
1. Лайки (шаги 1–5 выше) — это независимый блок, воспроизведение не затрагивается.
2. `markFavouriteStates` в `browsePlaylist`/`browseRadio` — только добавление поля `favourite` к item, ничего не меняет в существующих маршрутах.
3. CRUD плейлистов — отдельная ветка: новые методы `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `removeTrack`; UI-раздел в `UIConfig.json` + i18n строки.
4. Только после этого — новые landing-блоки (chart, «Собранные мной»).

---

## 5. Кнопка «Назад» (previous) — всегда играет текущий трек

Проверенная цепочка (Volumio 3 backend `statemachine.js` + MPD-плагин):

1. **Первое нажатие — это не баг, а стандарт Volumio.** В consume-режиме `CoreStateMachine::previous()` сначала вызывает `thisPlugin.seek(0)` — перезапуск текущего трека. Второй клик в течение 3 с (`previousTrackonPrev`) вызывает `previous()` плагина.
2. **`previous()` плагина → MPD-команда `previous`.** Но плейлист MPD содержит максимум 2 элемента: `[текущий, prefetch'енный следующий]` (`clearAddPlayTrack` = `clear` + `addid`, `prefetch` = `addid`). При этом плагин включает consume-режим MPD (`consume 1`, `index.js:893`), а **в consume-режиме MPD удаляет сыгранные треки из плейлиста**. Значит текущий трек всегда на позиции 0, а MPD `previous` с позиции 0 делает ничего → играет тот же трек.
3. **Настоящая очередь — `stateMachine.playQueue`**, но плагин для previous её не использует. Если в UI включён «Consume mode», ядро удаляет сыгранные элементы из очереди (`statemachine.js:822`) — вернуться назад невозможно даже на уровне ядра.

### Исправление (минимальное)

```js
yandexMusic.prototype.previous = function () {
    var self = this;
    var pos = self.commandRouter.stateMachine.currentPosition;
    if (pos > 0) {
        // play() остановит сервис, выставит currentPosition и вызовет
        // clearAddPlayTrack для элемента очереди — очередь не «съезжает»
        return self.commandRouter.stateMachine.play(pos - 1);
    }
    self.commandRouter.stateMachine.setConsumeUpdateService('mpd');
    return self.mpdPlugin.previous();
};
```

Почему `stateMachine.play(pos - 1)`, а не прямой `clearAddPlayTrack`: `play()` синхронизирует `currentPosition`, поэтому после «назад» следующий трек продолжится из правильной позиции очереди.

### Оговорки

- Gapless на «назад» теряется (stop + clear + addid) — для возврата назад это нормально.
- Первое нажатие по-прежнему перезапускает текущий трек (стандарт Volumio); для перехода назад нужно два нажатия.
- `next()` оставляем как MPD `next` (gapless). Быстрые повторные нажатия next сверх prefetch'енного элемента не работают (в плейлисте MPD только 2 элемента), позиция синхронизируется таймером ядра.
- **Рассинхронизация очереди:** при ручном «next» MPD переходит к треку сразу, а `currentPosition` ядра увеличивается только когда таймер воспроизведения доходит до конца. Если в этот интервал нажать «назад», `play(pos - 1)` может попасть не в тот трек. Исправление выше это уменьшает, но не устраняет полностью.

---

## 6. Бейдж типа трека (mp3/flac, bitrate, samplerate)

Откуда берутся значения в UI (consume-режим, `consumeState` из MPD `getState()`):

| Поле | Источник | Проблема |
|---|---|---|
| `trackType` | расширение `file` из MPD `playlistinfo` (`file.split('.').pop()`, >10 символов → пусто) | работает только через прокси, где URL заканчивается `ext=.flac`/`.mp3`; прямой `get-mp3` без расширения → бейдж пустой |
| `isStreaming` | MPD `Time == 0` | верно для радио |
| `bitrate` | MPD status (для HTTP-стримов обычно 0 → null) | реальный битрейт Яндекса теряется |
| `samplerate`, `bitdepth` | MPD для стримов не сообщает | всегда пустые |

В плагине: `PREFER_PROXY = true` → все стримы идут через прокси, бейдж flac/mp3 уже корректен; `clearAddPlayTrack`/`prefetch` получают `codec`/`bitrate` из `getTrackUrl`, но никуда их не передают; `playlist.js:46-48, 67-69` кладёт в очередь пустые `trackType/samplerate/bitdepth`.

### План

1. В `clearAddPlayTrack`/`prefetch` после `getTrackUrl` писать метаданные в элемент очереди: `track.trackType = data.codec` (flac-mp4 → 'flac'), `track.bitrate = data.bitrate`.
2. В `playlist.js` задать `samplerate: 44100`, `bitdepth: 16` для flac-треков. shortcut: точные глубина/частота известны только после декодирования; повышать, если в аккаунте появятся 24-битные релизы.
3. Опциональный рычаг: `setConsumeUpdateService('mpd', true)` — второй аргумент включает `consumeIgnoreMetadata`, и тогда `consumeState` берёт title/album/uri/samplerate из элемента очереди, а `state.uri` становится `yam/track/<id>` вместо URL потока. Это упрощает резолв лайка (раздел 3) и чинит бейджи. **Риск:** для радио метаданные элемента очереди устаревают (станция меняет треки) — для радио `consumeIgnoreMetadata` нужно оставлять выключенным. Проверить перед внедрением.

---

## 7. Дополнительные исправления из аудита (P10–P19)

| # | Исправление | Размер |
|---|---|---|
| P10 | В `previous()` добавить `var self = this;` — сейчас `self` не определён, в strict mode функция бросает ReferenceError. Делается вместе с исправлением из раздела 5 | 1 строка |
| P11 | `getAlbumArt`: заменить `nodetools.urlEncode` на `encodeURIComponent` (nodetools не импортирован) | 2 строки |
| P12 | `handleBrowseUri`: добавить ветку `yam/track/` (возвращать навигацию с одним треком) ИЛИ менять type треков в поиске на `song` — см. раздел 9 | ~10 строк |
| P13 | Добавить `clearAddPlayTracks(uris)` → `clearAddPlayTrack({uri: uris[0], ...})`; ядро вызывает его при перезапуске блока (`statemachine.js:333`) | 3 строки |
| P14 | `proxy.js`: `proxy.on('error', () => res.end())` + `timeout` на `https.request` — сейчас обрыв соединения с Яндексом может обрушить процесс плагина | 2 строки |
| P15 | Proxy + encraw: IV AES-CTR всегда 0; при Range/seek MPD счётчик должен начинаться со смещения блока. Ограничение зафиксировать комментарием; если seek в HQ нужен — считать IV от offset | small |
| P16 | `getTrackV1`: guard на пустой `sorted` (трек без mp3) | 1 строка |
| P17 | Кэш `self.playlists`: для `kind=3` (лайки) и radio не кэшировать tracks, либо сбрасывать при `initClient` | 2 строки |
| P18 | `browseMyPlaylists`/`explodeUri('yam/myplaylists')`: вызывать после `checkUid()`, при `!uid` возвращать пустую навигацию | 3 строки |
| P19 | Отладочный блок «YaM DEBUG — журнал» в корне (index.js:410-429) — убрать из пользовательской навигации, оставить только в UIConfig | удаление |

---

## 8. «Прыгающие» плейлисты: очередь Volumio vs плейлист MPD

Источник истины для порядка — очередь ядра (`playQueue`). MPD содержит только `[текущий, prefetch'енный следующий]`. Расхождения возникают в четырёх местах:

1. **Ручной next/previous.** MPD переходит на трек сразу, а `currentPosition` ядра увеличивается только когда таймер воспроизведения доходит до конца. В этот интервал следующий prefetch добавляет в MPD не тот трек → сдвиг/дубли. Фикс: `previous()` через очередь (раздел 5).
2. **Двойной prefetch одного трека.** `prefetchDone = true` ставится до реального `addid`; если `getTrackUrl` для prefetch'а вызывается повторно (после сброса `askedForPrefetch`), в MPD добавляются две копии → последовательность сдвигается. Фикс: карта `self.streamTrack` (шаг 1 лайков) одновременно служит guard'ом: перед `addid` проверять, что `data.uri` уже не добавлен.
3. **Радио-добавления в очередь.** `onTrackChanging` (index.js:786) вызывает `addQueueItems` для новых треков станции, даже если `current_track` устарел (P2) и пользователь играет обычный плейлист → в очередь попадают чужие треки в конец. Фикс: добавлять в очередь только если текущий элемент очереди принадлежит той же радио-плейлисте (`uri` начинается с `yam/radio/<id>` / содержит `@<station>`).
4. **Нет `clearAddPlayTracks` (P13).** Ядро при «играть блок» логрует warning и ничего не делает — UI показывает плейлист, а играет то, что уже было в MPD.

Проверка после фикса: воспроизвести плейлист из 10 треков, на 3-м треке нажать next, затем previous — порядок в UI и фактическое воспроизведение должны совпадать (логи: `CURRENT POSITION`, MPD `playlistinfo`).

---

## 9. Поиск и стандартные плейлисты

### Поиск
Сейчас: `client.search.search(text, 0, 'all', false)` → artists/albums/tracks; треки оформлены через `trackToFolder` (type `folder`) → клик пытается открыть `yam/track/...`, а `handleBrowseUri` такой ветки не имеет → ошибка. Минимальные фиксы:
- треки поиска: type `song` (клик = воспроизведение), а не `folder`;
- добавить в результаты плейлисты (`resp.result.playlists`), если есть;
- при желании — пагинация (`page` параметр есть в API), но не обязательно.

### Стандартные плейлисты
- Блоки лендинга `'playlists'` и `'new-playlists'` уже подключены («Популярные плейлисты», «Ещё плейлисты»).
- Добавить блок `'collections'` (коллекции Яндекса) в `requestedBlocks` — тот же `landingToPlaylist` подходит.
- «Моя волна» сейчас только заголовок без элементов. Сделать её играбельной: треки My Wave доступны как радио-станция (`rotor.getStationTracks('mine')` — проверить точный id) и использовать существующий radio-механизм с feedback.

---

## 10. Что НЕ трогать (риски регрессии)

- `proxy.js` и `ext=.flac` — нужны для Content-Type в MPD и для иконки качества в UI.
- `PREFER_MP3` / `PREFER_PROXY` — обходят GnuTLS/faad проблемы Volumio.
- Семантика `self.current_track` — от неё зависит radio-feedback; вместо её изменения добавляется отдельная `self.streamTrack`.
- `onPushState` / `positionAtPrefetch` — хак для gapless в Volumio 3.
- Формат id `trackId:albumId@playlistId` в uri — он нужен `getTrackV2` (для `albumId`) и `explodeTrack`; менять его нельзя, можно только нормализовать при резолве.

---

## 11. Что осталось непроверенным

- Точный id станции «Моя волна» для `rotor.getStationTracks` (предположительно `mine`) — проверить перед внедрением.
- Точный uri, который отправляет фронтенд при клике на сердечко (плеер vs очередь) — проверить шагом 5.2.
- Работает ли `emitFavourites` из контекста плагина в конкретной версии Volumio (в `88d19a3` использовался, но с `typeof` guard).
- Реальный набор `kind` плейлистов в аккаунте пользователя — проверить через `/users/<uid>/playlists/list`.
- Эффект `setConsumeUpdateService('mpd', true)` (`consumeIgnoreMetadata`) на радио: не «застываются» ли title/albumart станции.
- Синхронизация `currentPosition` ядра с MPD-позицией при ручном next/previous — проверить на живой системе (логи `CURRENT POSITION`).
