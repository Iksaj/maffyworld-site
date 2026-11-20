# MaffyWorld — безопасный перенос Netlify → Cloudflare

**Статус:** код Cloudflare опубликован в `main`; ОПЛАТА ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНА.
D1 создана, схема SQL выполнена в панели Cloudflare (подтверждено пользователем).
Команды кейсов заданы в `src/worker.mjs`. Реальные платежи нельзя включать до проверки Minecraft-агента и AnyPay.

## Почему нужен перенос серверной части
В Netlify использовались Netlify Blobs и Functions. Cloudflare не выполняет
`netlify/functions/*.mjs` автоматически. Новый `src/worker.mjs` работает с D1.
URL `/.netlify/functions/create-payment` оставлен совместимым с текущим HTML.
Создавать оплачиваемые счета до полной проверки интеграции запрещено.

## До деплоя
1. Создать Cloudflare D1 базу `maffyworld-orders`.
2. Заменить `REPLACE_WITH_YOUR_D1_DATABASE_ID` в `wrangler.jsonc` на настоящий ID D1.
3. Выполнить `npx wrangler d1 execute maffyworld-orders --remote --file=./schema.sql`.
4. В Cloudflare Worker → Settings → Variables and Secrets задать **секреты**:
   `ANYPAY_PROJECT_ID`, `ANYPAY_SECRET_KEY`, `ANYPAY_API_ID`,
   `ANYPAY_API_KEY`, `DELIVERY_AGENT_TOKEN` (случайная строка от 32 символов).
   **Не вводить секреты в GitHub / HTML / сообщения чата.**
5. Для рангов 1–7 настроить `DELIVERY_COMMANDS_JSON` как текстовый JSON.
   Пример для LuckPerms (только если группа действительно существует):
   `{"1":"lp user {nickname} parent add sergeant"}`.
   **Кейсы 11–14 уже сопоставлены по подтверждённым командам владельца:**
   - `11` Донат-Кейс: `cases givekey {nickname} donate {quantity}`
   - `12` Игровая валюта: `cases givekey {nickname} money {quantity}`
   - `13` Маффи-токены: `cases givekey {nickname} tokens {quantity}`
   - `14` Донат-вещи: `cases givekey {nickname} items {quantity}`
   В RCON команды вводятся без начального `/`. Коды товаров и количество
   берутся только из серверного каталога и заказа, а не из ввода покупателя.
6. На Minecraft-сервере либо доверенном хосте с приватным RCON запустить
   `scripts/delivery-agent.mjs` с переменными `API_BASE_URL`,
   `DELIVERY_AGENT_TOKEN`, `RCON_HOST`, `RCON_PORT`, `RCON_PASSWORD`.
   Для запуска нужен Node.js с поддержкой fetch, Node 20+ рекомендован.
7. Убедиться в корректности AnyPay SCI-подписей, параметров API и статусов
   по настройкам реального проекта. В AnyPay указать notification URL:
   `https://<ваш-домен>/api/anypay-webhook`.
8. Проверить `/api/health`: `paymentsConfigured:false` до включения.
   Провести тестовые заказы и проверить отсутствие повторной выдачи,
   ошибки и сценарий ручной проверки, не используя реальные деньги.
9. Только после проверки настроить `ENABLE_PAYMENTS=true` в Cloudflare.
   Переменная `PUBLIC_SITE_URL` должна совпадать с реальным доменом.
10. В конце (не в начале) подключить `maffyworld.ru` к Cloudflare.

## Текущие ограничения
- Код AnyPay не проверен реальным платежом: **не включать живые платежи** до проверки.
- Кейсы 11–14 имеют фиксированные серверные команды; ранги 1–7 всё ещё
  требуют настроенной карты LuckPerms в `DELIVERY_COMMANDS_JSON`.
- Кнопка оплаты в HTML доступна для рангов и кейсов, включая количество кейсов.
  Не открывать реальную оплату до проверки заказа с подтверждением от AnyPay
  и теста выдачи товара на Minecraft-сервере.
- Выдача **не повторяется** после RCON-ошибки, статус требует ручной проверки.
- Нет публичной административной панели для обработки заказов.
- В Worker D1 допускаются только отдельные запросы, без повторной выдачи заказа.
- Ник Minecraft проверяется, но он не доказывает владение аккаунтом.
- Перенос домена не переносит старые заказы из Netlify Blobs автоматически.
- Не открывать RCON-порт в интернет. Не публиковать токены и доступы.

## Для разработчика
Рабочие пути API: `/api/create-payment`, `/api/anypay-webhook`,
`/api/agent/claim`, `/api/agent/ack`, `/api/health`.
Совместимые Netlify-маршруты включены только для текущего фронтенда.
