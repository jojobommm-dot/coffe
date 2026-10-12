/* ================================================================
   Настройки сайта Fastcup — меняйте только этот файл и points.js
   ================================================================ */
window.FASTCUP_CONFIG = {
  // Ключ JavaScript API Яндекс Карт.
  // Получить: https://developer.tech.yandex.ru → «Подключить API» → «JavaScript API и HTTP Геокодер».
  // В настройках ключа укажите домен сайта (и localhost для проверки).
  yandexApiKey: "",

  // Центр карты по умолчанию (Пермь) и масштаб
  mapCenter: [58.0105, 56.2294],
  mapZoom: 12,

  // Контакты
  phone: "+7 (900) 000-00-00",       // как показывать
  phoneHref: "+79000000000",          // для ссылки tel:
  telegram: "https://t.me/fastcup_perm",
  max: "https://max.ru/fastcup_perm",
  email: "hello@fastcup.ru",

  // Куда отправлять заявки из формы (POST JSON).
  // Пусто — заявка откроется письмом на email выше.
  // Варианты: свой обработчик (PHP/Node), Яндекс Cloud Function → Telegram-бот, Formspree.
  formEndpoint: ""
};
