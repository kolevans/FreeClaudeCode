# 🛠️ Руководство по решению проблем FreeClaudeCode & OmniRoute (Troubleshooting Guide)

Данный документ содержит подробные инструкции по запуску проекта **FreeClaudeCode**, а также решения основных ошибок при интеграции с **OmniRoute** и авторизации через **Kiro / AWS Builder ID**.

---

## 🤖 Шаг 0: Быстрый запуск с помощью ИИ-Агента (Antigravity / Cursor / Claude Code)

Если вы запускаете проект впервые, лучше всего доверить установку и первичную настройку вашему **ИИ-агенту (AI Coding Agent)**:

1. Откройте папку проекта **FreeClaudeCode** в вашем ИИ-редакторе/ассистенте (Antigravity, Cursor, Claude Code, Windsurf и т.д.).
2. Отправьте агенту промпт:
   > *"Установи все зависимости проекта, проверь и запусти сервер `node server.js`, а также убедись, что OmniRoute работает в режиме Online."*
3. ИИ-агент автоматически установит зависимости `npm install`, запустит `node server.js` и настроит базу данных.

---

## 1. Ошибка онбординга и пароля OmniRoute
### (`{"error":"No password configured. Complete onboarding first.","needsSetup":true}`)

### 📌 Почему возникает эта ошибка?

Начиная с версии **OmniRoute v3.8+**, при первом запуске система в целях безопасности требует создания пароля администратора (management password) и прохождения первичного онбординга. Если хэш пароля отсутствует в SQLite базе данных (`~/.omniroute/storage.sqlite`), OmniRoute блокирует все запросы авторизации с ошибкой **`HTTP 403 Forbidden`** (`No password configured`).

### 🚀 Способы решения:

#### Способ 1: Автоматический фикс в коде `server.js` (Уже встроено)
В `server.js` добавлена функция `seedOmniPasswordIfNeeded()`. При первом старте она автоматически создаёт безопасный bcrypt-хэш пароля по умолчанию (`CHANGEME`) и проставляет `setupComplete: true` в базе данных. вам не нужно ничего делать вручную!

#### Способ 2: Настройка через веб-интерфейс (Ручной способ)
1. Откройте в браузере страницу онбординга:
   - **[http://127.0.0.1:20128/dashboard/onboarding](http://127.0.0.1:20128/dashboard/onboarding)**
   - или **[http://localhost:20128/dashboard/onboarding](http://localhost:20128/dashboard/onboarding)**
2. Придумайте пароль (или подтвердите стандартный **`CHANGEME`**).
3. Нажмите **Continue / Сохранить**.
4. Вернитесь в панель **FreeClaude GUI** ([http://127.0.0.1:3847](http://127.0.0.1:3847)) и нажмите **"Войти в Kiro"**.

#### Способ 3: Запись хэша напрямую в базу данных через Терминал
Выполните следующую команду в терминале:

```bash
node -e "
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
const db = new Database(dbPath);
const hash = bcrypt.hashSync('CHANGEME', 12);

db.prepare(\"INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'password', ?)\").run(JSON.stringify(hash));
db.prepare(\"INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'setupComplete', 'true')\").run();

console.log('✅ Хэш пароля OmniRoute успешно добавлен в БД!');
"
```
После этого перезапустите сервер (`pkill -f omniroute && node server.js`).

---

## 2. Не открывается окно авторизации Kiro / AWS Builder ID
### (Зависает статус `Ждём вход в AWS...`)

### 📌 Почему это происходит?

1. **Завязка на систему Windows**: В оригинальном коде запуск окна авторизации был прописан через специфичные для Windows команды (`cmd.exe` / `start` и пути `C:\Program Files\...`). На macOS и Linux браузер не запускался автоматически.
2. **Блокировщик всплывающих окон (Pop-up Blocker)**: Современные браузеры (Chrome, Safari, Edge) из соображений безопасности блокируют автоматическое открытие окон, вызванное асинхронными API-запросами.

### 🚀 Способы решения:

#### Способ 1: Нажатие кнопки вручную (1 секунда)
В всплывающем модальном окне **"Вход в Kiro · AWS Builder ID"** просто нажмите на кнопку **`"Открыть / обновить AWS"`**. Браузер сразу откроет официальную страницу авторизации AWS.

#### Способ 2: Кроссплатформенный фикс в `server.js` (Уже встроено)
В `server.js` обновлены функции `findBrowser()` и `openUrlApp()` с поддержкой всех операционных систем (macOS, Windows, Linux):

```javascript
function findBrowser() {
  const candidates = [
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Arc.app/Contents/MacOS/Arc",
    // Windows
    path.join(process.env.ProgramFiles || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft\\Edge\\Application\\msedge.exe"),
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}
```

---

## 💡 Итог

Все описанные исправления интегрированы прямо в исходный код репозитория `FreeClaudeCode`. Любой новый пользователь при запуске через ИИ-агента получит полностью настроенную и готовую к работе систему без ошибок!
