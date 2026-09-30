# YaM — Яндекс Музыка для Volumio

YaM — плагин музыкального сервиса для [Volumio](https://volumio.com/), который подключает каталог Яндекс Музыки к музыкальному проигрывателю. Он поддерживает поиск, прослушивание альбомов и плейлистов, радиостанции и воспроизведение через MPD.

Для работы нужна подписка Яндекс Музыки и устройство с установленным Volumio. YaM имеет отдельный идентификатор `yam`, поэтому его можно использовать одновременно с оригинальным плагином `yandex_music`.

## Установка из GitHub

1. Включите SSH в настройках Volumio и подключитесь к устройству.
2. Выполните команды:

```sh
cd /home/volumio
git clone https://github.com/GorINIch73/YaM.git
cd YaM
volumio plugin install
```

3. Дождитесь сообщения об успешной установке. Если Volumio предложит включить плагин, подтвердите.
4. В веб-интерфейсе Volumio откройте **Plugins → Installed plugins** и включите **YaM**.
5. Откройте настройки YaM и войдите в аккаунт Яндекс Музыки по логину и паролю либо укажите OAuth-токен.

Команда установки запускается из каталога клонированного репозитория. Volumio установит зависимости из `package.json`.

## Обновление

Подключитесь по SSH и выполните:

```sh
cd /home/volumio/YaM
git pull
volumio plugin update
sudo systemctl restart volumio
```

## Разработка

Исходники плагина находятся в корне репозитория. Перед установкой после изменений используйте `volumio plugin install` или `volumio plugin update` на устройстве Volumio.

## Благодарности

- [Yandex Music API by MarshalX](https://github.com/MarshalX/yandex-music-api)
- [Yandex Music Extension by Alexander Cherkashin](https://github.com/acherkashin/yandex-music-extension)
