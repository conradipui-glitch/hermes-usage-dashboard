/* ============================================================
   Hermes Usage Dashboard — логика интерфейса.
   Цель: непрофессиональный пользователь всё понимает сам.
   Подсказки «?», история простыми словами, экскурсия, словарик.
   ============================================================ */
(() => {
  'use strict';

  const state = {
    days: 7,
    data: null,
    graph: null,
    sessionId: null,
    nodeId: null,
    filters: { provider: '', model: '', task: '' },
    options: { providers: [], models: [], tasks: [] },
    optionsKey: '',
    sorts: { model: 'total_tokens', task: 'total_tokens', tool: 'count', session: 'last_activity_at' },
    dirs: {},
    liveFilter: 'all',
    toolFilter: '',
    spendMode: 'cost',
    ratesMode: 'period',
    kpiValues: null,
    trends: {},
    trendPending: {},
    lastSignature: null,
    view: { scale: 1, tx: 0, ty: 0 },
    suppressNodeClick: false,
  };

  /* ---------- Утилиты ---------- */

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = new Intl.NumberFormat('ru-RU');

  const plural = (n, forms) => {
    const x = Math.abs(Number(n) || 0) % 100;
    const d = x % 10;
    if (x > 10 && x < 20) return forms[2];
    if (d > 1 && d < 5) return forms[1];
    if (d === 1) return forms[0];
    return forms[2];
  };

  // Компактный формат больших чисел: 1,2 млн / 340 тыс.
  const tokens = (value) => {
    const n = Number(value) || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' млрд';
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',') + ' тыс.';
    return fmt.format(Math.round(n));
  };
  const fullTokens = (value) => fmt.format(Number(value) || 0);

  const money = (value) => {
    if (value == null || Number.isNaN(Number(value))) return '—';
    const n = Number(value);
    if (n === 0) return '$0';
    const a = Math.abs(n);
    const digits = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 2 : 4;
    return '$' + new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  };

  const dateFmt = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const timeFmt = (ms) => (ms ? new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
  const durFmt = (v) => (v == null ? '—' : (Number(v) || 0).toFixed(1).replace('.', ',') + ' с');
  const relTime = (iso) => {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const diff = Date.now() - t;
    if (diff < 60e3) return 'только что';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} мин назад`;
    const d = new Date(t);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'сегодня, ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date(now.getTime() - 86400e3).toDateString()) return 'вчера, ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} ${plural(Math.floor(diff / 86400e3), ['день назад', 'дня назад', 'дней назад'])}`;
    return dateFmt(iso);
  };
  const durationFmt = (startIso, endIso) => {
    const a = new Date(startIso || '').getTime();
    const b = new Date(endIso || '').getTime();
    if (!a || !b || b <= a) return '';
    const mins = Math.round((b - a) / 60000);
    if (mins < 60) return `~${mins} мин`;
    return `~${(mins / 60).toFixed(1).replace('.', ',')} ч`;
  };
  const periodLabel = (days) => (days >= 3650 ? 'всё доступное время' : days === 1 ? 'последний день' : `последние ${days} ${plural(days, ['день', 'дня', 'дней'])}`);
  const prevLabel = (days) => (days === 1 ? 'вчерашним днём' : `предыдущими ${days} ${plural(days, ['днём', 'днями', 'днями'])}`);
  const dayHuman = (day) => new Date(day + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  /* ---------- Одометр, копирование, уважение к reduced-motion ---------- */

  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Число, которое можно «прокрутить»: только простые счётчики и деньги.
  // «12,3 млн» не анимируем — иначе цифра теряет смысл на полпути.
  function odometerNumber(text) {
    const s = String(text ?? '').replace(/[\s\u00a0]/g, '');
    if (!/^\$?-?\d+(?:[.,]\d+)?$/.test(s)) return null;
    const value = Number(s.replace('$', '').replace(',', '.'));
    return Number.isFinite(value) ? { value, money: s.startsWith('$') } : null;
  }

  function animateNumber(el, from, to, opt) {
    const dur = 520;
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const paint = (v) => { el.textContent = opt.money ? money(v) : fmt.format(Math.round(v)); };
    el.classList.add('odometer');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      paint(to);
      el.classList.remove('odometer');
    };
    const step = (now) => {
      if (done) return;
      const t = Math.min(1, (now - t0) / dur);
      paint(from + (to - from) * ease(t));
      if (t < 1) requestAnimationFrame(step); else finish();
    };
    requestAnimationFrame(step);
    // Кадры могут не идти (панель в фоне или скрыта): без страховки число замирало
    // на первом кадре, то есть показывало старое значение.
    setTimeout(finish, dur + 140);
  }

  // Копирование: сначала современный API, потом честный фолбэк для file:// и http.
  async function copyText(text) {
    const value = String(text ?? '');
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) { /* падаём в фолбэк */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function flashCopied(btn, ok) {
    const old = btn.textContent;
    btn.textContent = ok ? '✓' : '✗';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1200);
  }

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  /* ---------- Словари и подсказки ---------- */

  const HINTS = {
    hintdemo: 'Вот так выглядит подсказка! Нажимайте значки «?» в любом месте панели — рядом с каждой цифрой есть простое объяснение.',
    story: 'Здесь те же цифры, что и на всей панели, но обычными словами: что произошло за период, сколько израсходовано и во сколько это обошлось. Обновляется автоматически.',
    tokens: '<b>Токен</b> — кусочек текста, примерно ¾ слова: «при-мер» — это два токена. ИИ читает и пишет текст токенами, и провайдер берёт оплату именно за них. Миллион токенов — это примерно 750 тысяч слов, целая книга.',
    cache: '<b>Кэш</b> — куски диалога, которые ИИ уже читал раньше. Повторное чтение из кэша провайдеры считают в разы дешевле, поэтому большой кэш — это хорошо: та же работа стоит меньше.',
    api_calls: '<b>Обращение к ИИ</b> — один запрос к модели. На один ваш вопрос ассистент может сделать несколько обращений: вызвать инструмент, посмотреть результат и только потом ответить.',
    sessions: '<b>Разговор (сессия)</b> — один диалог с ассистентом, от первого сообщения до последнего. <b>Подзадачи</b> — «дочерние» разговоры, которые ассистент заводит сам, чтобы разобрать часть большой задачи.',
    cost_est: '<b>Оценка</b> — стоимость, рассчитанная по открытым прайс-листам моделей. Реальная сумма в счёте может немного отличаться.',
    cost_actual: '<b>Фактическая стоимость</b> — цифра из отчёта самого провайдера. Показывается, только если провайдер делится ею.',
    provider: '<b>Провайдер</b> — сервис, через который идут запросы к модели: например OpenAI, Anthropic, OpenRouter или ваш собственный сервер.',
    model: '<b>Модель</b> — конкретный ИИ-«двигатель» (GPT, Claude, Qwen…). Модели отличаются умением, скоростью и ценой за токены.',
    task: '<b>Задача</b> — внутренняя учётная категория Hermes: обычный диалог, сжатие истории, фоновая проверка. Помогает понять, на что на самом деле уходят токены.',
    tool: '<b>Инструмент</b> — умение ассистента: выполнить команду в терминале, прочитать файл, поискать в интернете. Модель вызывает инструменты сама, когда решает вашу задачу.',
    skill: '<b>Навык</b> — библиотечка инструкций по отдельной теме, которую ассистент подгружает, когда она нужна для задачи.',
    daily: 'Каждый столбик — один день. <b>Синяя часть</b> — сколько ИИ прочитал (ваш вопрос, история диалога, результаты инструментов), <b>голубая</b> — сколько написал в ответ. Наведите курсор на столбик, чтобы увидеть точные цифры. Главное — общий наклон: выше — активнее, ниже — спокойнее, ровно — стабильно.',
    live: '<b>Живая лента</b> — последние события из журнала ассистента: обращения к ИИ, вызовы инструментов, фоновые проверки. Обновляется сама, пока панель открыта. Кнопками сверху можно оставить только интересный тип событий.',
    filters: 'Фильтры сужают всю страницу: ключевые цифры, графики, расходы, скорости и таблицы пересчитываются по выбранному провайдеру, модели или задаче. Блоки, которые фильтр сузить не может (например, инструменты — в них нет модели), помечаются «весь период». Кнопка «Сбросить» вернёт всё как было.',
    models_table: 'Каждая строка — сочетание «модель + провайдер + задача». Одна и та же модель в обычном диалоге и, скажем, при сжатии истории — это две строки: токены у Hermes копятся отдельно.',
    tasks_table: 'Hermes делит работу на внутренние задачи: основной диалог, сжатие истории, фоновые проверки. Так видно, на что реально уходят усилия и деньги.',
    sessions_table: 'Список ваших разговоров за период. <b>Нажмите на строку</b> — ниже откроется «карта» этого разговора: что вы просили и что ассистент делал шаг за шагом.',
    graph: 'Это схема «родословной» одного разговора. Слева — сам разговор, правее — ваши сообщения, вызовы инструментов, обращения к ИИ и подзадачи. Цвета прямоугольников объясняет легенда под заголовком. <b>Нажмите на любой прямоугольник</b> — справа появятся подробности. Окно карты фиксированной высоты: <b>колесо мыши</b> меняет масштаб, <b>перетаскивание</b> двигает карту, сверху есть кнопки «−»/«+», ползунок и «вписать».',
    rates: '<b>Скорость модели</b> — сколько токенов ответа она пишет в секунду. Режим «период» — среднее за выбранный период. Режим «сейчас» — скорость последних вызовов; шкала — <b>рабочий потолок модели</b> (95-й перцентиль вызовов за период), а цвет дуги — «жар»: жёлтая на слабой скорости, оранжевая в середине, красная у потолка. Вызовы без данных о времени честно пропускаются.',
    spend: 'Каждый столбик — один день, стопка внутри — вклад моделей: <b>внизу самая дорогая</b>. Кнопки «$» и «токены» переключают, что показывает высота. <b>Наведите курсор на столбик</b> — всплывёт разбивка по моделям и итог, как в OpenRouter. Цвета закреплены за моделями и одинаковы везде.',
    quality: 'Мы никогда не выдумываем данные. Чего нет в файлах Hermes — того на панели не будет: вместо этого будет честная пометка.',
    budget: '<b>Бюджет месяца и порог дня</b> — сумма, которую вы задаёте сами. Хранится только в вашем браузере и нужна лишь для индикатора: какая доля месячной суммы израсходована.',
    forecast: 'Простой прогноз: средний расход за последние 7 дней умножается на число дней до конца месяца. Это ориентир «если всё продолжится так же», а не обещание.',
  };

  const TASK_LABELS = { main_agent: 'основные диалоги', compression: 'сжатие истории', background_review: 'фоновая проверка' };
  const taskLabel = (t) => TASK_LABELS[t] || t || 'основные диалоги';

  const KIND_LABELS = {
    session: 'Разговор', parent: 'Родительский разговор', request: 'Ваше сообщение', tool: 'Вызов инструмента',
    result: 'Результат инструмента', api: 'Обращение к ИИ', task: 'Категория расходов', skill: 'Навык', subtask: 'Подзадача',
  };

  const META_LABELS = {
    session_id: 'ID разговора', model: 'Модель', provider: 'Провайдер', tokens: 'Токенов',
    tool_calls: 'Вызовов инструментов', cost: 'Стоимость', api_calls: 'Обращений к ИИ',
    input_tokens: 'Прочитано (input)', output_tokens: 'Создано (output)', cache_read_tokens: 'Из кэша',
    latency_seconds: 'Длительность', request_id: 'ID запроса', task: 'Задача', tool: 'Инструмент',
    estimated_cost: 'Стоимость (оценка)', actual_cost: 'Стоимость (факт)', cost_status: 'Статус стоимости',
    skill: 'Навык', action: 'Действие', call_id: 'ID вызова', message_id: 'ID сообщения',
  };

  const SOURCE_LABELS = {
    'state.db aggregate': 'сводка базы Hermes',
    'state.db task aggregate': 'сводка базы (по задачам)',
    'agent.log exact calls': 'только журнал',
    'state.db aggregate + agent.log observed subset': 'сводка базы + журнал',
  };

  const GLOSSARY = [
    ['🧩 Токен', 'Кусочек текста примерно из ¾ слова. ИИ читает и пишет токенами, а оплата идёт за токены.'],
    ['📥 Прочитано / создано (input / output)', 'Прочитано — всё, что модель получила в запросе: ваш вопрос, история диалога, результаты инструментов. Создано — текст, который она написала в ответ.'],
    ['♻️ Кэш', 'Уже прочитанные ранее куски диалога. Повторное чтение из кэша стоит в разы дешевле, поэтому большой кэш — это экономия.'],
    ['💭 Размышления (reasoning)', 'Токены, которые модель тратит на «обдумывание» перед ответом. Они оплачиваются, но в общий объём токенов не суммируются — чтобы не считать одно и то же дважды.'],
    ['📤 Обращение к ИИ (API-вызов)', 'Один запрос к модели. На один ваш вопрос ассистент может сделать несколько обращений: вызвать инструмент, посмотреть результат, ответить.'],
    ['💬 Разговор (сессия)', 'Один диалог с ассистентом — от первого сообщения до последнего.'],
    ['🧬 Подзадача', '«Дочерний» разговор, который ассистент заводит сам, чтобы разобраться с частью большой задачи.'],
    ['🤖 Модель', 'Конкретный ИИ-«двигатель»: GPT, Claude, Qwen и другие. Отличаются умением, скоростью и ценой.'],
    ['🔌 Провайдер', 'Сервис, через который идут запросы к модели: OpenAI, Anthropic, OpenRouter или ваш собственный сервер.'],
    ['🗂 Задача (категория)', 'Внутренняя учётная категория Hermes: обычный диалог, сжатие истории, фоновая проверка.'],
    ['🛠 Инструмент', 'Умение ассистента: выполнить команду в терминале, прочитать файл, поискать в интернете. Модель вызывает их сама.'],
    ['📚 Навык', 'Библиотечка инструкций по отдельной теме, которую ассистент подгружает при необходимости.'],
    ['⏱ Длительность (латентность)', 'Сколько секунд модель думала перед ответом. Для больших задач нормально несколько секунд и даже больше — чем длиннее задача и «размышления», тем дольше ответ.'],
    ['⚠️ Ошибка инструмента', 'Инструмент (например, терминал или поиск) не смог выполнить команду: сеть, тайм-аут или сама команда. Ассистент обычно видит ошибку и пробует другой путь — такие события видны в живой ленте.'],
    ['💰 Оценка и факт стоимости', 'Оценка — расчёт по открытым прайс-листам моделей. Факт — сумма из отчёта провайдера; появляется, только если провайдер ею делится.'],
  ];

  const hint = (key) => `<button type="button" class="hint" data-hint="${esc(key)}" aria-label="Пояснение: что это значит">?</button>`;

  /* ---------- Движок подсказок (одна всплывашка на всю страницу) ---------- */

  const tooltip = $('tooltip');
  let tooltipOwner = null;

  function showHint(el) {
    const text = HINTS[el.dataset.hint];
    if (!text) return;
    tooltip.innerHTML = text;
    tooltip.hidden = false;
    tooltipOwner = el;
    positionTooltip(el);
  }

  function positionTooltip(el) {
    const r = el.getBoundingClientRect();
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 9;
    if (top + h > window.innerHeight - 8) top = r.top - h - 9;
    if (top < 8) top = 8;
    tooltip.style.left = Math.round(left) + 'px';
    tooltip.style.top = Math.round(top) + 'px';
  }

  function hideHint() {
    tooltip.hidden = true;
    tooltipOwner = null;
  }

  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest('.hint');
    if (el) showHint(el);
  });
  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest('.hint');
    if (el && el === tooltipOwner) hideHint();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('.hint');
    if (el) showHint(el);
  });
  document.addEventListener('focusout', hideHint);
  document.addEventListener('click', (e) => {
    const el = e.target.closest('.hint');
    if (el) {
      e.preventDefault();
      e.stopPropagation();
      showHint(el);
    } else {
      hideHint();
    }
  });
  window.addEventListener('scroll', hideHint, true);
  window.addEventListener('resize', hideHint);

  /* ---------- Статус и пустые состояния ---------- */

  function setStatus(kind, text) {
    // Точка «дышит», пока панель обновляется сама; мигает при потере связи.
    $('statusDot').className = 'dot ' + (kind === 'err' ? 'err dot-blink' : 'dot-live');
    $('statusText').textContent = text;
  }

  const emptyBox = (text, hintText) =>
    `<div class="empty">${esc(text)}${hintText ? `<div class="empty-hint">${esc(hintText)}</div>` : ''}</div>`;
  const tableEmpty = emptyBox;

  function errorBox(title, message, adviceHtml) {
    return `<div class="quality error"><b>${esc(title)}</b><br>${esc(message)}<br><span class="dim">${adviceHtml}</span></div>`;
  }

  /* ---------- Сортировка и фильтры таблиц ---------- */

  function sorted(rows, key) {
    const direction = state.dirs[key] || 'desc';
    return [...rows].sort((a, b) => {
      const av = a[key] ?? '';
      const bv = b[key] ?? '';
      if (av === bv) return 0;
      const result = av > bv ? 1 : -1;
      return direction === 'asc' ? result : -result;
    });
  }

  function sortButton(label, key, scope) {
    const active = state.sorts[scope] === key;
    const arrow = active ? (state.dirs[key] === 'asc' ? '↑' : '↓') : '↕';
    return `<button type="button" data-sort="${esc(key)}" data-scope="${esc(scope)}" title="Нажмите, чтобы отсортировать по этому столбцу">${esc(label)} ${arrow}</button>`;
  }

  const visibleModels = () => (state.data?.models || []).filter((r) =>
    (!state.filters.provider || r.provider === state.filters.provider) &&
    (!state.filters.model || r.model === state.filters.model) &&
    (!state.filters.task || r.task === state.filters.task));
  const visibleTasks = () => (state.data?.tasks || []).filter((r) => !state.filters.task || r.task === state.filters.task);

  /* ---------- Рендер: фильтры ---------- */

  function renderFilters() {
    const d = state.data;
    if (!d) return;
    const uniq = (items, key) => [...new Set(items.map((x) => x[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    const fill = (id, values, current) => {
      $(id).innerHTML = '<option value="">все</option>' +
        values.map((v) => `<option value="${esc(v.value)}" ${v.value === current ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
    };
    const options = state.options || {};
    const asOptions = (values) => (values || []).map((v) => ({ value: v, label: v }));
    const providers = options.providers?.length ? asOptions(options.providers) : asOptions(uniq(d.models || [], 'provider'));
    const models = options.models?.length ? asOptions(options.models) : asOptions(uniq(d.models || [], 'model'));
    const tasks = options.tasks?.length
      ? options.tasks.map((v) => ({ value: v, label: taskLabel(v) }))
      : (d.tasks || []).map((t) => t.task).filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .sort((a, b) => a.localeCompare(b, 'ru'))
        .map((v) => ({ value: v, label: taskLabel(v) }));
    fill('providerFilter', providers, state.filters.provider);
    fill('modelFilter', models, state.filters.model);
    fill('taskFilter', tasks, state.filters.task);
    const names = { provider: 'провайдер', model: 'модель', task: 'задача' };
    const active = Object.entries(state.filters).filter(([, value]) => value);
    $('filterReset').hidden = !active.length;
    $('filterSummary').innerHTML = active.length
      ? 'фильтр: ' + active.map(([key, value]) => `${names[key]} = <b>${esc(key === 'task' ? taskLabel(value) : value)}</b>`).join(' · ')
      : '';
    $('periodMeta').textContent = `период: ${periodLabel(state.days)}${active.length ? ' · фильтр сужает всю страницу' : ''}`;
  }

  /* ---------- Рендер: уведомления об ошибках ---------- */

  function renderNotice() {
    const d = state.data;
    if (!d || !d.error) { $('notice').innerHTML = ''; return; }
    const notFound = /not found/i.test(d.error);
    const advice = notFound
      ? 'Похоже, панель не нашла данные Hermes. Убедитесь, что ассистент запущен хотя бы один раз, и что путь указан верно: <code>python server.py --hermes-home "путь/к/.hermes"</code>'
      : 'Попробуйте обновить страницу или перезапустить панель: <code>python server.py</code>';
    $('notice').innerHTML = errorBox('Не получилось прочитать данные Hermes', d.error, advice);
  }

  /* ---------- Статус-баннер «светофор» ---------- */

  function dayTotals(row) {
    return (Number(row?.input_tokens) || 0) + (Number(row?.output_tokens) || 0);
  }

  function renderStatusBanner() {
    const d = state.data;
    const el = $('statusBanner');
    if (!d) return;
    el.hidden = false;
    let tone = 'ok', emoji = '🟢', headline, detail;

    if (d.error) {
      tone = 'alert'; emoji = '🔴';
      headline = 'Данные ассистента не читаются';
      detail = 'Панель не может открыть файлы Hermes — подробности и что проверить указаны ниже.';
    } else {
      const events = d.live_events || [];
      const toolErrors = events.filter((e) => e.kind === 'tool_event' && e.status === 'error').length;
      const daily = d.daily || [];
      let spike = 0;
      if (daily.length >= 4) {
        const prev = daily.slice(0, -1);
        const avgPrev = prev.reduce((acc, r) => acc + dayTotals(r), 0) / prev.length;
        if (avgPrev > 0) spike = dayTotals(daily[daily.length - 1]) / avgPrev;
      }
      const s = d.summary || {};
      const active = Number(s.active_sessions) > 0;
      const dayLimit = Number(localStorage.getItem('hud.dayLimit')) || 0;
      const lastDay = daily[daily.length - 1];
      const lastDayCost = lastDay ? Number(lastDay.estimated_cost_usd) || 0 : 0;

      // Порог за день: сначала смотрим сегодняшний день, потом — самые дорогие дни периода.
      const worstDay = dayLimit > 0
        ? daily.reduce((acc, r) => ((Number(r.estimated_cost_usd) || 0) > (Number(acc?.estimated_cost_usd) || 0) ? r : acc), null)
        : null;
      const worstCost = worstDay ? Number(worstDay.estimated_cost_usd) || 0 : 0;

      if (dayLimit > 0 && lastDayCost >= dayLimit) {
        tone = 'warn'; emoji = '💸';
        headline = 'Сегодняшний день перешёл ваш порог расходов';
        detail = `За ${lastDay ? dayHuman(lastDay.day) : 'сегодня'} набежало ${money(lastDayCost)} — это ваш лимит ${money(dayLimit)} в день. ` +
          `Изменить или убрать порог можно, нажав на карточку «Порог дня».`;
      } else if (dayLimit > 0 && worstCost >= dayLimit) {
        tone = 'warn'; emoji = '💸';
        headline = 'Дни дороже вашего порога';
        detail = `Сегодня пока ${money(lastDayCost)}, а вот ${dayHuman(worstDay.day)} набежало ${money(worstCost)} — выше вашего лимита ${money(dayLimit)} в день. ` +
          `Порог меняется по нажатию на карточку «Порог дня».`;
      } else if (toolErrors >= 3) {
        tone = 'warn'; emoji = '🟡';
        headline = 'Некоторые инструменты сбоили';
        detail = `За период ${fmt.format(toolErrors)} ${plural(toolErrors, ['вызов', 'вызова', 'вызовов'])} инструментов завершились ошибками — обычно это временные сетевые проблемы или неудачные команды, ассистент пробует другой путь.`;
      } else if (spike > 2) {
        tone = 'warn'; emoji = '🟡';
        headline = 'Заметный всплеск активности';
        detail = `Последний день получился в ${spike.toFixed(1).replace('.', ',')} раза насыщеннее обычного. Если вы не запускали больших задач — просто посмотрите в живой ленте, чем занимался ассистент.`;
      } else {
        headline = active ? 'Ассистент работает прямо сейчас' : 'Всё в порядке';
        const cost = Number(s.estimated_cost_usd) || 0;
        detail = `За ${periodLabel(state.days)}: ${fmt.format(s.sessions || 0)} ${plural(s.sessions, ['разговор', 'разговора', 'разговоров'])}, ${tokens(s.total_tokens)} токенов (≈ ${tokens(Math.round((Number(s.total_tokens) || 0) * 0.75))} слов)` +
          (cost ? `, стоимость ≈ ${money(cost)}. Ничего делать не нужно.` : '. Ничего делать не нужно.');
      }
    }
    el.className = 'status ' + (tone === 'ok' ? '' : tone);
    el.innerHTML = `<div class="emoji" aria-hidden="true">${emoji}</div><div><h2>${esc(headline)}</h2><p>${esc(detail)}</p></div>`;
  }

  /* ---------- Скелетоны при первой загрузке ---------- */

  function renderSkeletons() {
    $('storyBody').innerHTML =
      '<div class="sk sk-line" style="width:92%"></div><div class="sk sk-line" style="width:78%"></div><div class="sk sk-line" style="width:60%"></div>';
    $('kpis').innerHTML = Array.from({ length: 6 }, () =>
      '<div class="kpi"><div class="sk sk-line" style="width:55%"></div><div class="sk sk-big"></div><div class="sk sk-line" style="width:85%"></div></div>').join('');
    $('dailyChart').innerHTML = '<div class="sk" style="height:172px"></div>';
    $('liveEvents').innerHTML = Array.from({ length: 4 }, () =>
      '<div class="sk sk-line" style="width:100%"></div>').join('');
  }

  /* ---------- Тема оформления и режим «Просто / Подробно» ---------- */

  function applyTheme() {
    // Тему можно задать ссылкой (?theme=light|dark) — так её видно и в превью,
    // и в скриншотах; без параметра берём запомненный выбор.
    const urlTheme = new URLSearchParams(location.search).get('theme');
    if (urlTheme === 'light' || urlTheme === 'dark') localStorage.setItem('hud.theme', urlTheme);
    const light = localStorage.getItem('hud.theme') === 'light';
    document.documentElement.dataset.theme = light ? 'light' : '';
    const btn = $('themeBtn');
    if (!btn) return;
    btn.textContent = light ? '🌙' : '☀️';
    btn.title = light ? 'Включить тёмную тему' : 'Включить светлую тему';
  }

  function applyDetailMode(forceDetailed) {
    const stored = localStorage.getItem('hud.simple');
    const simple = forceDetailed === undefined ? stored !== 'detailed' : !forceDetailed;
    $('tablesRow').hidden = simple;
    $('qualityPanel').hidden = simple;
    document.querySelector('.filters').hidden = simple;
    const btn = $('detailBtn');
    btn.textContent = simple ? '📊 Показать детали' : '📊 Скрыть детали';
    btn.title = simple
      ? 'Показать таблицы моделей, задач, инструментов и технические подробности'
      : 'Свернуть таблицы и технические подробности — оставить только главное';
  }

  /* ---------- Диалог месячного бюджета ---------- */

  function openBudgetDialog() {
    $('budgetInput').value = localStorage.getItem('hud.budget') || '';
    $('dayLimitInput').value = localStorage.getItem('hud.dayLimit') || '';
    $('budgetModal').hidden = false;
    $('budgetInput').focus();
  }

  function closeBudgetDialog() {
    $('budgetModal').hidden = true;
  }

  /* ---------- Экспорт всей панели в PNG ---------- */

  /* Панель — обычный DOM, поэтому снимаем её целиком: клонируем содержимое,
     подкладываем в SVG-foreignObject вместе с настоящими стилями и рисуем в canvas.
     Никаких внешних библиотек — работает офлайн, как и весь дашборд. */
  // Стили вставляются в XML: без экранирования «&», «<» и «>» разбор падает
  // (в style.css есть комментарий, где встречается <tr>).
  const xmlSafe = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function exportPng(opts = {}) {
    const d = state.data;
    if (!d || d.error) return null;
    const src = document.querySelector('main.shell, .wrap') || document.body;
    const css = await fetch('static/style.css', { cache: 'no-store' }).then((r) => r.text());
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    const bg = getComputedStyle(document.body).backgroundColor || '#04070d';
    const clone = src.cloneNode(true);
    // В кадр не должны попасть всплывающие слои и служебные подсказки.
    clone.querySelectorAll('#tooltip,.modal-overlay,.tour-overlay,.hint-pop,#welcomeCard,.no-shot,svg#graphSvg .zoom-hint').forEach((el) => el.remove());
    clone.setAttribute('data-theme', theme);
    const w = Math.max(src.scrollWidth, 900);
    // Высоту берём по нижнему краю последнего блока, а не по scrollHeight:
    // иначе в кадр попадает пустой хвост страницы ниже содержимого.
    const rect0 = src.getBoundingClientRect();
    const contentBottom = [...src.children].reduce((m, el) => {
      const r = el.getBoundingClientRect();
      return Math.max(m, r.bottom - rect0.top);
    }, 0);
    const h = Math.ceil(contentBottom) || src.scrollHeight;
    clone.setAttribute('style', `width:${w}px;background:${bg};padding:0;margin:0`);
    // XMLSerializer даёт корректный XHTML: void-теги (<br>, <input>) закрываются сами,
    // иначе XML внутри foreignObject не разберётся.
    const body = new XMLSerializer().serializeToString(clone);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml"><style>${xmlSafe(css)}</style>${body}</div>` +
      `</foreignObject></svg>`;
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('браузер не смог собрать кадр'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    const scale = opts.scale || 2; // кадр «на печать»: 2×, чтобы цифры читались при увеличении
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    // Обрезаем кадр по фактически нарисованному содержимому: шрифты внутри кадра
    // считают строки чуть компактнее живой страницы, и снизу оставался пустой хвост.
    const cropH = (() => {
      const k = 12; // прореживание: ищем нижнюю границу по уменьшенной копии
      const probe = document.createElement('canvas');
      probe.width = Math.max(1, Math.round(canvas.width / k));
      probe.height = Math.max(1, Math.round(canvas.height / k));
      const pctx = probe.getContext('2d');
      pctx.drawImage(canvas, 0, 0, probe.width, probe.height);
      const px = pctx.getImageData(0, 0, probe.width, probe.height).data;
      const ref = document.createElement('canvas').getContext('2d');
      ref.fillStyle = bg;
      ref.fillRect(0, 0, 1, 1);
      const [br, bgc, bb] = ref.getImageData(0, 0, 1, 1).data;
      let last = 0;
      for (let y = 0; y < probe.height; y += 1) {
        for (let x = 0; x < probe.width; x += 1) {
          const i = (y * probe.width + x) * 4;
          if (Math.abs(px[i] - br) > 14 || Math.abs(px[i + 1] - bgc) > 14 || Math.abs(px[i + 2] - bb) > 14) { last = y; break; }
        }
      }
      const bottom = Math.min(canvas.height, Math.round((last + 1) * k) + Math.round(28 * scale));
      return Math.max(Math.round(400 * scale), bottom);
    })();
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = cropH;
    out.getContext('2d').drawImage(canvas, 0, 0, canvas.width, cropH, 0, 0, canvas.width, cropH);
    const url = out.toDataURL('image/png');
    if (opts.download !== false) {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `hermes-monitoring-${stamp}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    return url;
  }

  /* ---------- Экспорт отчёта в CSV ---------- */

  function exportCsv() {
    const d = state.data;
    if (!d || d.error) return;
    const rows = [];
    const cell = (v) => {
      const s = String(v ?? '');
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const push = (...cells) => rows.push(cells.map(cell).join(';'));
    const s = d.summary || {};

    push('Отчёт Hermes — панель использования');
    push('Период', periodLabel(state.days));
    push('Создан', new Date().toLocaleString('ru-RU'));
    push('');
    push('СВОДКА');
    push('Разговоров', s.sessions || 0);
    push('Подзадач', s.subtasks || 0);
    push('Обращений к ИИ', s.api_calls || 0);
    push('Токенов всего', s.total_tokens || 0);
    push('Прочитано (input)', s.input_tokens || 0);
    push('Создано (output)', s.output_tokens || 0);
    push('Из кэша', s.cache_read_tokens || 0);
    push('Стоимость — оценка, $', s.estimated_cost_usd ?? 0);
    push('Стоимость — факт, $', s.actual_cost_usd ?? 0);
    push('');
    push('ПО ДНЯМ');
    push('День', 'Прочитано', 'Создано', 'Из кэша', 'Обращений к ИИ', 'Стоимость (оценка), $');
    (d.daily || []).forEach((r) => push(r.day, r.input_tokens || 0, r.output_tokens || 0, r.cache_read_tokens || 0, r.api_calls || 0, r.estimated_cost_usd ?? 0));
    push('');
    push('МОДЕЛИ');
    push('Модель', 'Провайдер', 'Задача', 'Токенов', 'Обращений', 'Стоимость, $');
    (d.models || []).forEach((r) => push(r.model, r.provider, r.task, r.total_tokens || 0, r.api_calls || 0, r.cost_usd ?? 0));
    push('');
    push('ЗАДАЧИ');
    push('Задача', 'Токенов', 'Обращений', 'Стоимость, $');
    (d.tasks || []).forEach((r) => push(r.task, r.total_tokens || 0, r.api_calls || 0, r.cost_usd ?? 0));
    push('');
    push('ИНСТРУМЕНТЫ');
    push('Инструмент', 'Вызовов', 'Доля, %');
    (d.tools || []).forEach((r) => push(r.name, r.count || 0, r.percentage || 0));
    push('');
    push('РАЗГОВОРЫ');
    push('ID', 'Название', 'Модель', 'Провайдер', 'Токенов', 'Инструментов', 'Последняя активность');
    (d.sessions || []).forEach((r) => push(r.id, r.display_label, r.model, r.billing_provider,
      (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0) + (Number(r.cache_read_tokens) || 0) + (Number(r.cache_write_tokens) || 0),
      r.tool_call_count || 0, r.last_activity_at_iso || ''));

    const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hermes-otchet-${state.days}d-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- Рендер: «Главное за период» ---------- */

  function trendHtml(t) {
    if (!t || !t.prev) {
      return `<span class="trend flat">🕵️ Для сравнения нет данных за ${esc(prevLabel(state.days))} — возможно, ассистент тогда ещё не работал.</span>`;
    }
    const pct = (t.cur - t.prev) / t.prev * 100;
    const a = Math.abs(pct);
    if (a <= 5) {
      return `<span class="trend flat">➖ Активность примерно как за ${esc(prevLabel(state.days))} — изменение всего ${Math.round(a)}%.</span>`;
    }
    const word = a <= 20 ? (pct > 0 ? 'немного выросла' : 'немного снизилась') : (pct > 0 ? 'заметно выросла' : 'заметно снизилась');
    return `<span class="trend ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '📈' : '📉'} Активность ${word} — на ${Math.round(a)}% по сравнению с ${esc(prevLabel(state.days))}: ${esc(tokens(t.prev))} → ${esc(tokens(t.cur))} токенов.</span>`;
  }

  // Дуга внутри периода: активность нарастала к концу, стихала или держалась ровно
  function arcChip() {
    const rows = state.data?.daily || [];
    if (rows.length < 6) return '';
    const third = Math.max(1, Math.floor(rows.length / 3));
    const mean = (list) => list.reduce((acc, r) => acc + dayTotals(r), 0) / Math.max(1, list.length);
    const first = mean(rows.slice(0, third));
    const last = mean(rows.slice(-third));
    if (!first || !last) return '';
    if (last > first * 1.25) return '<span class="trend up">📈 К концу периода активности становилось больше</span>';
    if (last < first * 0.75) return '<span class="trend down">📉 К концу периода активность снижалась</span>';
    return '<span class="trend flat">➖ Активность держалась примерно на одном уровне весь период</span>';
  }

  const trendKey = () => state.days + '|' + [state.filters.provider, state.filters.model, state.filters.task].join('/');

  function renderTrendLine() {
    const el = $('trendLine');
    if (!el) return;
    const key = trendKey();
    const prev = state.days >= 3650 ? '' : (state.trends[key]
      ? trendHtml(state.trends[key])
      : '<span class="trend loading">⏳ Сравниваем с предыдущим периодом…</span>');
    el.innerHTML = arcChip() + prev;
  }

  function updateTrend() {
    renderTrendLine();
  }

  function renderStory() {
    const d = state.data;
    const s = d?.summary || {};
    const el = $('storyBody');
    $('storyMeta').textContent = d && !d.error ? `период: ${periodLabel(state.days)} · обновлено ${timeFmt(Date.now())}` : '';

    if (!d || d.error || !(Number(s.sessions) > 0)) {
      el.innerHTML =
        `<p class="story-lead">За ${esc(periodLabel(state.days))} данных пока нет — похоже, ассистент в это время не работал.</p>` +
        `<p class="dim-hint">Так бывает, если Hermes был не запущен или только что установлен. Попробуйте выбрать период побольше (например, «30 дней») сверху. Если и там пусто — проверьте, что панель указывает на правильную папку с данными ассистента.</p>`;
      return;
    }

    const words = Math.round((Number(s.total_tokens) || 0) * 0.75);
    const actual = Number(s.actual_cost_usd) || 0;
    const estimated = Number(s.estimated_cost_usd) || 0;
    const costSentence = actual
      ? `Провайдер подтвердил <b>${money(actual)}</b>${estimated > actual ? `, ещё примерно <b>${money(estimated - actual)}</b> — наша оценка по прайс-листам` : ''}.`
      : `Стоимость пока известна только по оценке — примерно <b>${money(estimated)}</b>.`;

    const roots = Number(s.root_sessions) || Number(s.sessions);
    let paragraph =
      `За ${esc(periodLabel(state.days))} ассистент Hermes провёл <b>${fmt.format(roots)}</b> ${plural(roots, ['разговор', 'разговора', 'разговоров'])}`;
    if (Number(s.subtasks) > 0) {
      paragraph += ` (и завёл <b>${fmt.format(s.subtasks)}</b> ${plural(s.subtasks, ['подзадачу', 'подзадачи', 'подзадач'])} — маленькие «дочерние» разговоры, он создаёт их сам)`;
    }
    paragraph += ` и сделал <b>${fmt.format(s.api_calls)}</b> ${plural(s.api_calls, ['обращение', 'обращения', 'обращений'])} к ИИ. `;
    paragraph += `Объём работы — <b>${tokens(s.total_tokens)}</b> токенов, это примерно <b>${tokens(words)}</b> слов. ${costSentence}`;

    const topModel = (d.models || []).slice().sort((a, b) => (Number(b.total_tokens) || 0) - (Number(a.total_tokens) || 0))[0];
    const topTool = (d.tools || [])[0];
    const dailyAll = d.daily || [];
    const daySum = (r) => (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0);
    const busiest = dailyAll.slice().sort((a, b) => daySum(b) - daySum(a))[0];
    const quietest = dailyAll.slice().sort((a, b) => daySum(a) - daySum(b))[0];
    const avgDay = dailyAll.length ? dailyAll.reduce((acc, r) => acc + daySum(r), 0) / dailyAll.length : 0;
    const billable = actual || estimated;

    const facts = [];
    if (topModel && Number(s.total_tokens) > 0) {
      const share = Math.round((Number(topModel.total_tokens) || 0) / Number(s.total_tokens) * 100);
      facts.push(['🤖', 'Основная модель', esc(topModel.model), `${share}% всех токенов · провайдер: ${esc(topModel.provider)}`,
        'именно на неё приходится основная часть расходов']);
    }
    if (topTool) {
      facts.push(['🛠️', 'Чаще всего используется', esc(topTool.name), `${fmt.format(topTool.count || 0)} ${plural(topTool.count, ['вызов', 'вызова', 'вызовов'])} за период`]);
    }
    if (busiest && daySum(busiest) > 0) {
      const multiple = avgDay > 0 ? daySum(busiest) / avgDay : 0;
      const note = multiple >= 1.3
        ? `${tokens(daySum(busiest))} токенов · в ${multiple.toFixed(1).replace('.', ',')} раза больше обычного`
        : `${tokens(daySum(busiest))} токенов · активность по дням ровная`;
      facts.push(['📅', 'Самый насыщенный день', esc(dayHuman(busiest.day)), note]);
    }
    if (quietest && avgDay > 0 && dailyAll.length >= 3 && daySum(quietest) < avgDay * 0.35) {
      facts.push(['🌙', 'Самый тихий день', esc(dayHuman(quietest.day)), `всего ${tokens(daySum(quietest))} токенов — возможно, выходной или пауза в работе`]);
    }
    if (dailyAll.length >= 7) {
      const workdays = [];
      const weekends = [];
      dailyAll.forEach((r) => {
        const dow = new Date(r.day + 'T12:00:00').getDay();
        (dow === 0 || dow === 6 ? weekends : workdays).push(daySum(r));
      });
      const avgWork = workdays.length ? workdays.reduce((a, b) => a + b, 0) / workdays.length : 0;
      const avgRest = weekends.length ? weekends.reduce((a, b) => a + b, 0) / weekends.length : 0;
      if (avgWork > 0 && avgRest > 0 && avgWork > avgRest * 1.4) {
        facts.push(['🗓️', 'Ритм недели', 'будни активнее выходных', `в будни токенов в среднем в ${(avgWork / avgRest).toFixed(1).replace('.', ',')} раза больше — типичная рабочая картина`]);
      }
    }
    if (billable && Number(s.sessions) > 0) {
      facts.push(['💵', 'Средняя цена разговора', esc(money(billable / Number(s.sessions))), 'по текущим тарифам моделей',
        'если растёт от периода к периоду — задачи становятся сложнее или модель дороже']);
    }
    const costOf = (r) => Number(r.actual_cost_usd) || Number(r.estimated_cost_usd) || 0;
    const sessionList = d.sessions || [];
    const totalSessionCost = sessionList.reduce((acc, r) => acc + costOf(r), 0);
    const priciest = sessionList.slice().sort((a, b) => costOf(b) - costOf(a))[0];
    if (priciest && costOf(priciest) > 0 && totalSessionCost > 0 && sessionList.length >= 3 && costOf(priciest) / totalSessionCost >= 0.3) {
      const share = Math.round(costOf(priciest) / totalSessionCost * 100);
      const label = String(priciest.display_label || '');
      facts.push(['🏆', 'Самый дорогой разговор', esc(label.length > 26 ? label.slice(0, 25) + '…' : label),
        `${money(costOf(priciest))} — ${share}% всех расходов периода`,
        'нажмите на него в таблице ниже — откроется карта с деталями']);
    }
    // Бюджет месяца (задаётся пользователем, хранится только локально)
    const budget = Number(localStorage.getItem('hud.budget')) || 0;
    if (budget > 0) {
      const month = new Date().toISOString().slice(0, 7);
      const dayCost = (r) => Number(r.actual_cost_usd) || Number(r.estimated_cost_usd) || 0;
      const mtd = dailyAll.filter((r) => String(r.day).startsWith(month)).reduce((acc, r) => acc + dayCost(r), 0);
      const pct = Math.min(100, Math.round(mtd / budget * 100));
      // Полоса — градиент «зелёный → жёлтый → красный» по мере заполнения;
      // у лимита начинает пульсировать.
      facts.push(['🎯', 'Бюджет месяца',
        `${money(mtd)} <span class="dim">из ${money(budget)}</span><div class="budgetbar${pct >= 90 ? ' budgetbar-hot' : ''}"><i style="width:${pct}%"></i></div>`,
        `использовано ${pct}%${pct >= 100 ? ' — бюджет превышен' : pct >= 90 ? ' — почти исчерпан' : ''} · нажмите, чтобы изменить`,
        null, 'data-action="budget" title="Нажмите, чтобы изменить бюджет месяца и порог дня"']);
    } else {
      facts.push(['🎯', 'Бюджет месяца', 'не задан',
        'нажмите — и панель покажет, какую долю месячной суммы вы израсходовали',
        null, 'data-action="budget" title="Задать бюджет месяца и порог дня"']);
    }
    // Порог расходов за день (тоже задаётся вами и живёт только в браузере)
    const dayLimit = Number(localStorage.getItem('hud.dayLimit')) || 0;
    if (dayLimit > 0) {
      const todayRow = dailyAll[dailyAll.length - 1];
      const todayCost = todayRow ? (Number(todayRow.actual_cost_usd) || Number(todayRow.estimated_cost_usd) || 0) : 0;
      const pctDay = Math.min(100, Math.round(todayCost / dayLimit * 100));
      const over = todayCost >= dayLimit;
      facts.push(['💸', 'Порог дня',
        `<span class="${over ? 'warn' : ''}">${money(todayCost)}</span> <span class="dim">из ${money(dayLimit)}</span>` +
        `<div class="budgetbar${pctDay >= 90 ? ' budgetbar-hot' : ''}"><i style="width:${pctDay}%"></i></div>`,
        (over ? 'сегодня расход выше вашего порога · ' : `израсходовано ${pctDay}% порога за сегодня · `) + 'нажмите, чтобы изменить',
        null, 'data-action="budget" title="Нажмите, чтобы изменить порог дня"']);
    } else {
      facts.push(['💸', 'Порог дня', 'не задан',
        'задайте сумму на день — панель отметит дни выше порога и предупредит, если он перешагнется',
        null, 'data-action="budget" title="Задать порог расходов на день"']);
    }
    // Прогноз до конца месяца
    const last7 = dailyAll.slice(-7);
    const avgCost = last7.length ? last7.reduce((acc, r) => acc + (Number(r.actual_cost_usd) || Number(r.estimated_cost_usd) || 0), 0) / last7.length : 0;
    if (avgCost > 0) {
      const now2 = new Date();
      const daysLeft = new Date(now2.getFullYear(), now2.getMonth() + 1, 0).getDate() - now2.getDate() + 1;
      facts.push(['🔮', 'Прогноз до конца месяца', `≈ ${money(avgCost * daysLeft)}`,
        `если тратить как в последние 7 дней (${money(avgCost)} в день) · до конца месяца ${daysLeft} ${plural(daysLeft, ['день', 'дня', 'дней'])}`]);
    }

    el.innerHTML =
      `<p class="story-lead">${paragraph}</p>` +
      (facts.length
        ? `<div class="facts">${facts.map(([icon, label, value, note, tip, attrs]) =>
            `<div class="fact"${attrs ? ' ' + attrs : ''}><div class="fact-icon">${icon}</div><div class="fact-label">${esc(label)}</div><div class="fact-value">${value}</div><div class="fact-note">${esc(note)}</div>${tip ? `<div class="fact-tip">💡 ${esc(tip)}</div>` : ''}</div>`).join('')}</div>`
        : '') +
      '<div class="trendline" id="trendLine"></div>';
    renderTrendLine();
  }

  /* ---------- Рендер: ключевые цифры ---------- */

  function renderKpis() {
    const s = state.data?.summary || {};
    const words = Math.round((Number(s.total_tokens) || 0) * 0.75);
    const items = [
      { icon: '🧮', label: 'Объём работы', key: 'tokens', value: tokens(s.total_tokens),
        note: `≈ ${tokens(words)} слов · ${tokens(s.input_tokens)} прочитано / ${tokens(s.output_tokens)} создано` },
      { icon: '♻️', label: 'Из них из кэша', key: 'cache', value: tokens(s.cache_read_tokens),
        note: 'повторное чтение — заметно дешевле' },
      { icon: '📤', label: 'Обращений к ИИ', key: 'api_calls', value: fmt.format(s.api_calls || 0),
        note: `${fmt.format(s.observed_api_log_events || 0)} из них видно в журнале` },
      { icon: '💬', label: 'Разговоров', key: 'sessions', value: fmt.format(s.sessions || 0),
        note: `${fmt.format(s.root_sessions || 0)} основных · ${fmt.format(s.subtasks || 0)} подзадач · ${fmt.format(s.active_sessions || 0)} активных сейчас` },
      { icon: '💰', label: 'Стоимость — оценка', key: 'cost_est', value: money(s.estimated_cost_usd),
        note: 'по открытым прайс-листам моделей' },
      { icon: '🧾', label: 'Стоимость — факт', key: 'cost_actual', value: money(s.actual_cost_usd),
        note: Number(s.actual_cost_usd) ? 'подтверждено провайдером' : 'провайдер пока не сообщил' },
    ];
    const html = items.map((it) => {
      // Подсветка карточки, когда её цифра изменилась с прошлой отрисовки.
      const changed = state.kpiValues && state.kpiValues[it.key] !== undefined && state.kpiValues[it.key] !== it.value;
      return `<div class="kpi${changed ? ' kpi-changed' : ''}"><div class="kpi-top"><span class="kpi-label">${it.icon} ${esc(it.label)}</span>${hint(it.key)}</div>` +
      `<div class="kpi-value">${esc(it.value)}</div><div class="kpi-note">${esc(it.note)}</div></div>`;
    }).join('');
    $('kpis').innerHTML = html;

    // Одометр: если число изменилось — прокручиваем к новому значению,
    // а не подменяем рывком (глаз успевает заметить, что данные обновились).
    const cells = $('kpis').children;
    items.forEach((it, i) => {
      const el = cells[i] && cells[i].querySelector('.kpi-value');
      const to = odometerNumber(it.value);
      const from = state.kpiValues ? odometerNumber(state.kpiValues[it.key]) : null;
      if (el && to && from && from.value !== to.value && !reduceMotion()) animateNumber(el, from.value, to.value, to);
    });
    state.kpiValues = Object.fromEntries(items.map((it) => [it.key, it.value]));
  }

  /* ---------- Рендер: график по дням ---------- */

  function renderDaily() {
    const rows = state.data?.daily || [];
    const el = $('dailyChart');
    const metaEl = $('dailyMeta');
    if (!rows.length) {
      el.innerHTML = emptyBox('За этот период нет данных.', 'Значит, в эти дни ассистент не работал — или его файлы ещё пустые.');
      metaEl.textContent = '';
      return;
    }
    // Длинная история: группируем по неделям — случайные всплески отдельных дней сглаживаются
    let display = rows;
    let weekly = false;
    if (rows.length > 45) {
      weekly = true;
      display = [];
      for (let i = 0; i < rows.length; i += 7) {
        const chunk = rows.slice(i, i + 7);
        const sum = (key) => chunk.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
        display.push({
          start: chunk[0].day,
          end: chunk[chunk.length - 1].day,
          input_tokens: sum('input_tokens'),
          output_tokens: sum('output_tokens'),
          cache_read_tokens: sum('cache_read_tokens'),
          reasoning_tokens: sum('reasoning_tokens'),
          api_calls: sum('api_calls'),
          estimated_cost_usd: chunk.reduce((acc, r) => acc + (Number(r.estimated_cost_usd) || 0), 0),
        });
      }
    }
    const max = Math.max(1, ...display.map((r) => (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0)));
    const totals = display.map((r) => (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0));
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
    const avgLine = display.length > 1 && avg > 0
      ? `<div class="avg-line" style="bottom:${Math.min(160, avg / max * 160).toFixed(1)}px" aria-hidden="true"><span>обычный уровень ≈ ${esc(tokens(avg))}${weekly ? ' в неделю' : ''}</span></div>`
      : '';
    const headOf = (r) => (weekly
      ? `неделя ${new Date(r.start + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — ${new Date(r.end + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`
      : new Date(r.day + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' }));
    const bars = display.map((r, idx) => {
      const input = Number(r.input_tokens) || 0;
      const output = Number(r.output_tokens) || 0;
      const ih = input ? Math.max(3, input / max * 160) : 0;
      const oh = output ? Math.max(3, output / max * 160) : 0;
      const lines = [
        `<b>${esc(headOf(r))}</b>`,
        `прочитано ИИ: ${fullTokens(input)}`,
        `создано ИИ: ${fullTokens(output)}`,
      ];
      if (Number(r.cache_read_tokens)) lines.push(`из кэша: ${fullTokens(r.cache_read_tokens)}`);
      if (Number(r.reasoning_tokens)) lines.push(`размышления: ${fullTokens(r.reasoning_tokens)}`);
      lines.push(`обращений к ИИ: ${fmt.format(Number(r.api_calls) || 0)}`);
      if (Number(r.estimated_cost_usd)) lines.push(`стоимость (оценка): ${money(r.estimated_cost_usd)}`);
      // Сегодняшний столбик подсвечен — это «сейчас»; остальные растут каскадом при отрисовке.
      const today = String(new Date().toISOString().slice(0, 10)) === String(r.day) ? ' today' : '';
      return `<div class="bar-cell${today}" style="--i:${idx}"><div class="bar-tip">${lines.join('<br>')}</div>` +
        `<div class="bar-stack"><div class="bar-in grow" style="height:${ih}px;animation-delay:${Math.min(idx * 14, 700)}ms"></div><div class="bar-out grow" style="height:${oh}px;animation-delay:${Math.min(idx * 14, 700) + 90}ms"></div></div></div>`;
    }).join('');
    const axisDay = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '');
    const axis = weekly
      ? `<span>${esc(axisDay(display[0].start))}</span><span>${esc(axisDay(display[Math.floor(display.length / 2)]?.start || ''))}</span><span>${esc(axisDay(display[display.length - 1].end))}</span>`
      : `<span>${esc(rows[0].day)}</span><span>${esc(rows[Math.floor(rows.length / 2)]?.day || '')}</span><span>${esc(rows[rows.length - 1].day)}</span>`;
    el.innerHTML = `<div class="bars">${avgLine}${bars}</div><div class="chart-axis">${axis}</div>`;
    const total = totals.reduce((a, b) => a + b, 0);
    metaEl.textContent = weekly
      ? `показано по неделям (${display.length} ${plural(display.length, ['неделя', 'недели', 'недель'])}) — случайные всплески отдельных дней сглажены`
      : rows.length > 1 ? `в среднем ${tokens(total / rows.length)} токенов в день` : 'в выбранном периоде один день';
  }

  /* ---------- Рендер: скорость моделей и расходы по моделям ---------- */

  // Цвета фиксированы за местом в общем зачёте — одна модель одного цвета везде.
  // Холодная шкала: главный цвет (бирюза) — у первой модели, дальше он плавно
  // уходит в синий и сталь. Никаких розовых/фиолетовых пятен, чтобы не спорить
  // с фирменным цветом; жёлтый и красный оставлены статусам.
  const SPEND_COLORS = ['#00ffc6', '#25d6b6', '#3fb8d8', '#4f9cf0', '#6e8fe0', '#8fb8c8', '#8c9aaa'];
  const spendColor = (rank) => SPEND_COLORS[Math.min(6, Number(rank) || 0)];

  const fmtRate = (v) => (v == null ? '—' : v >= 100 ? fmt.format(Math.round(v)) : v.toFixed(1).replace('.', ','));

  // «Жар» дуги: 0 — жёлтый (слабая скорость), 0.5 — оранжевый, 1 — красный
  // (рабочий потолок модели). Между точками — плавный градиент.
  const gaugeHeat = (frac) => {
    const t = Math.max(0, Math.min(1, Number(frac) || 0));
    const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
    const yellow = [230, 184, 106], orange = [240, 130, 60], red = [232, 62, 62];
    const rgb = t <= 0.5 ? mix(yellow, orange, t * 2) : mix(orange, red, (t - 0.5) * 2);
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  };

  // LED-шкала вместо дуги: 22 сегмента; зажжённые идут по рампе «жара»
  // (жёлтый → оранжевый → красный), пустые еле тлеют. frac — доля от потолка.
  const ledBar = (frac, hot) => {
    const N = 22;
    const lit = Math.max(0, Math.min(N, Math.round((Number(frac) || 0) * N)));
    let segs = '';
    for (let i = 0; i < N; i += 1) {
      const on = i < lit;
      const color = gaugeHeat((i + 1) / N);
      segs += on
        ? `<i class="on" style="background:${color};color:${color}"></i>`
        : '<i></i>';
    }
    return `<div class="ledbar${hot ? ' hot' : ''}" role="img" aria-label="${Math.round((Number(frac) || 0) * 100)}% от потолка">${segs}</div>`;
  };

  function renderRates() {
    const el = $('rateGauges');
    const meta = $('ratesMeta');
    if (!el) return;

    if (state.ratesMode === 'now') {
      const all = state.data?.recent_model_rates || [];
      const rows = all.filter((r) => r.fresh && r.output_tokens_per_second != null).slice(0, 8);
      if (!rows.length) {
        el.innerHTML = emptyBox('Прямо сейчас модели молчат.',
          'В режиме «сейчас» тахометры показывают скорость только по вызовам за последние пару минут. Как только ассистент снова обратится к модели, стрелки оживут.');
        if (meta) meta.textContent = 'ожидают новых вызовов…';
        return;
      }
      // Шкала каждого тахометра — рабочий потолок САМОЙ модели: 95-й
      // перцентиль её вызовов за период (короткие всплески не задирают
      // шкалу). Пик используется только если перцентиля нет.
      const scaleByModel = new Map((state.data?.model_rates || []).map((r) => [r.model + '|' + r.provider, r.scale_tokens_per_second || r.peak_tokens_per_second]));
      const scaleOf = (r) => Number(scaleByModel.get(r.model + '|' + r.provider)) || 0;
      const overallScale = Math.max(0, ...(state.data?.model_rates || []).map((r) => Number(r.scale_tokens_per_second) || 0));
      if (meta) {
        const ages = rows.map((r) => r.age_seconds || 0);
        const age = Math.round(Math.max(...ages));
        meta.textContent = `по последним вызовам · шкала: потолок модели${rows.length > 1 && overallScale > 0 ? ` (лучший: ${esc(fmtRate(overallScale))} ток/с)` : ''} · данные ${age <= 2 ? 'только что' : `${age} с назад`}`;
      }
      el.innerHTML = rows.map((r) => {
        const speed = r.output_tokens_per_second;
        const ceiling = scaleOf(r) || speed;
        const frac = ceiling > 0 ? Math.min(1, speed / ceiling) : 0;
        const lastDur = r.last_latency_seconds != null
          ? ` · последний ответ <b>${esc(durFmt(r.last_latency_seconds))}</b>`
          : '';
        // Цвет дуги — «жар»: жёлтый на слабой скорости → оранжевый в середине
        // → красный у рекорда. У самого рекорда дуга начинает светиться.
        return `<div class="gauge${frac >= 0.97 ? ' hot' : ''}"><div class="gauge-name" title="${esc(r.model)}${esc(r.provider ? ' · ' + r.provider : '')}">${esc(r.model)}</div>` +
          `<div class="gauge-provider">${esc(r.provider || '')}</div>` +
          ledBar(frac, frac >= 0.97) +
          `<div class="gauge-value">${esc(fmtRate(speed))} <small>ток/с</small></div>` +
          `<div class="gauge-stats">потолок модели <b>${esc(fmtRate(ceiling || null))} ток/с</b> · сейчас ${Math.round(frac * 100)}% от него<br>` +
          `последние <b>${fmt.format(r.tail_calls)}</b> ${plural(r.tail_calls, ['вызов', 'вызова', 'вызовов'])}${lastDur}</div></div>`;
      }).join('');
      return;
    }

    const rows = (state.data?.model_rates || []).filter((r) => r.output_tokens_per_second != null).slice(0, 8);
    if (!rows.length) {
      el.innerHTML = emptyBox('Замеров скорости нет.', 'В журнале за этот период нет обращений с известными токенами и временем ответа — скорость посчитать не из чего, и мы её не выдумываем.');
      if (meta) meta.textContent = '';
      return;
    }
    const max = Math.max(...rows.map((r) => r.output_tokens_per_second));
    const calls = rows.reduce((a, r) => a + (r.timed_calls || 0), 0);
    if (meta) meta.textContent = `замерено по журналу · ${fmt.format(calls)} ${plural(calls, ['вызов', 'вызова', 'вызовов'])}`;
    el.innerHTML = rows.map((r) => {
      const speed = r.output_tokens_per_second;
      const frac = max > 0 ? Math.min(1, speed / max) : 0;
      const unmeasured = r.unmeasured_calls
        ? `<br>без замеров: <b>${fmt.format(r.unmeasured_calls)}</b> ${plural(r.unmeasured_calls, ['вызов', 'вызова', 'вызовов'])}` : '';
      return `<div class="gauge"><div class="gauge-name" title="${esc(r.model)}${esc(r.provider ? ' · ' + r.provider : '')}">${esc(r.model)}</div>` +
        `<div class="gauge-provider">${esc(r.provider || '')}</div>` +
        ledBar(frac, false) +
        `<div class="gauge-value">${esc(fmtRate(speed))} <small>ток/с</small></div>` +
        `<div class="gauge-stats">средний ответ <b>${esc(durFmt(r.avg_latency_seconds))}</b><br>` +
        `прочитано <b>${esc(fmtRate(r.input_tokens_per_second))} ток/с</b> · вызовов: <b>${fmt.format(r.timed_calls)}</b>${unmeasured}</div></div>`;
    }).join('');
  }

  function renderSpend() {
    const rows = state.data?.daily_models || [];
    const el = $('spendChart');
    const legend = $('spendLegend');
    if (!el) return;
    const mode = state.spendMode || 'cost';
    if (!rows.length) {
      el.innerHTML = emptyBox('Расходов по дням нет.', 'Стоимость считается по учётным строкам Hermes — если их нет, делить по дням и моделям нечего.');
      if (legend) legend.innerHTML = '';
      return;
    }
    const val = (m) => (mode === 'cost' ? Number(m.cost_usd) || 0 : Number(m.total_tokens) || 0);
    const fmtVal = (v) => (mode === 'cost' ? money(v) : `${tokens(v)} ток.`);
    const totalOf = (r) => r.models.reduce((a, m) => a + val(m), 0);
    const max = Math.max(1, ...rows.map(totalOf));
    const bars = rows.map((r, idx) => {
      const total = totalOf(r);
      const ordered = [...r.models].sort((a, b) => val(a) - val(b)); // крупные сегменты внизу
      const segs = ordered.map((m) => {
        const v = val(m);
        const h = v ? Math.max(2, v / max * 160) : 0;
        return `<div class="seg" style="height:${h.toFixed(1)}px;background:${spendColor(m.rank)}"></div>`;
      }).join('');
      const head = new Date(r.day + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' });
      const tip = [`<b>${esc(head)}</b>`].concat(
        [...r.models].sort((a, b) => val(b) - val(a)).map((m) =>
          `<span style="color:${spendColor(m.rank)}">▮</span> ${esc(m.model)} — <b>${esc(fmtVal(val(m)))}</b>`),
        [`Итого: <b>${esc(fmtVal(total))}</b>`],
      );
      return `<div class="bar-cell" style="--i:${idx}"><div class="bar-tip">${tip.join('<br>')}</div><div class="bar-stack">${segs}</div></div>`;
    }).join('');
    const axisDay = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '');
    // Линия порога: видно, в какие дни расходы подходили к вашему лимиту.
    const dayLimit = Number(localStorage.getItem('hud.dayLimit')) || 0;
    const limitLine = (mode === 'cost' && dayLimit > 0)
      ? `<div class="limit-line" style="bottom:${Math.min(160, dayLimit / max * 160).toFixed(1)}px" aria-hidden="true">` +
        `<span>ваш порог ${esc(money(dayLimit))} в день</span></div>`
      : '';
    el.innerHTML = `<div class="bars">${limitLine}${bars}</div>` +
      `<div class="chart-axis"><span>${esc(axisDay(rows[0].day))}</span>` +
      `<span>${esc(axisDay(rows[Math.floor(rows.length / 2)]?.day || ''))}</span>` +
      `<span>${esc(axisDay(rows[rows.length - 1].day))}</span></div>`;
    const seen = new Map();
    for (const r of rows) for (const m of r.models) {
      const key = m.rank + '|' + m.model;
      if (!seen.has(key)) seen.set(key, m);
    }
    if (legend) legend.innerHTML = [...seen.values()].sort((a, b) => a.rank - b.rank).map((m) =>
      `<span><i style="background:${spendColor(m.rank)}"></i>${esc(m.model)}${m.provider ? ` <span class="dim">· ${esc(m.provider)}</span>` : ''}</span>`).join('');
  }

  /* ---------- Рендер: живая лента ---------- */

  /* Единая система статусов ленты: ai / tool / success / warning / error / bg.
     Цвет каждой группы — из CSS-переменных, поэтому тема и «фирменный» цвет
     правятся в одном месте, а лента читается по левому краю и бирке. */
  const EVENT_STATUS = {
    ai: { key: 'ai', tag: 'AI', help: 'Обращение к модели ИИ' },
    tool: { key: 'tool', tag: 'TOOL', help: 'Вызов инструмента' },
    success: { key: 'success', tag: 'ГОТОВО', help: 'Инструмент завершился успешно' },
    warning: { key: 'warning', tag: 'ВНИМАНИЕ', help: 'Инструмент завершился нестандартно' },
    error: { key: 'error', tag: 'ОШИБКА', help: 'Инструмент завершился с ошибкой' },
    bg: { key: 'bg', tag: 'ФОН', help: 'Фоновая служебная проверка' },
  };

  /* Семейства инструментов: вторая бирка рядом со статусом, чтобы лента
     читалась мгновенно (ПРАВКА / ФАЙЛ / ЗРЕНИЕ / КОМАНДА / КОД / БРАУЗЕР). */
  const TOOL_KINDS = [
    [/^patch$/, 'ПРАВКА'],
    [/^(read_file|write_file|search_files|nano_pdf)$/, 'ФАЙЛ'],
    [/^vision_/, 'ЗРЕНИЕ'],
    [/^(terminal|process_manage)$/, 'КОМАНДА'],
    [/^execute_code$/, 'КОД'],
    [/^(browser_exec|web_|goto_|new_tab|js$)/, 'БРАУЗЕР'],
    [/^skill_/, 'НАВЫК'],
    [/^(clarify|ask_)/, 'ВОПРОС'],
  ];

  function toolKind(name) {
    const s = String(name || '').toLowerCase();
    for (const [re, label] of TOOL_KINDS) if (re.test(s)) return label;
    return s ? 'ИНСТРУМЕНТ' : '';
  }

  function eventStatus(e) {
    if (e.kind === 'api_call') return EVENT_STATUS.ai;
    if (e.kind === 'aux_summary') return EVENT_STATUS.bg;
    if (e.kind === 'tool_event') {
      if (e.status === 'error') return EVENT_STATUS.error;
      if (e.status === 'completed' || e.status === 'ok' || e.status === 'success') return EVENT_STATUS.success;
      return e.status ? EVENT_STATUS.warning : EVENT_STATUS.tool;
    }
    return EVENT_STATUS.bg;
  }

  function renderEvents() {
    const allEvents = state.data?.live_events || [];
    // Drill-down: клик по строке инструмента сужает ленту до него одного.
    // Считаем счётчики по суженному набору — чипы не должны противоречить списку.
    const drill = state.toolFilter || '';
    const events = drill ? allEvents.filter((e) => e.kind === 'tool_event' && e.tool === drill) : allEvents;
    const counts = { all: events.length, api: 0, tool: 0, aux: 0, err: 0 };
    events.forEach((e) => {
      if (e.kind === 'api_call') counts.api += 1;
      else if (e.kind === 'tool_event') counts.tool += 1;
      else counts.aux += 1;
      if (e.kind === 'tool_event' && e.status === 'error') counts.err += 1;
    });
    // Статусы ленты: AI / TOOL / ГОТОВО / ОШИБКА / ФОН — фильтры идут по тому же набору.
    const chips = [
      ['all', 'Все'], ['api', '🤖 Запросы к ИИ'], ['tool', '🛠 Инструменты'],
      ['err', '⚠ Ошибки'], ['aux', '🔎 Фоновые'],
    ].map(([key, label]) =>
      `<button type="button" class="chip ${state.liveFilter === key ? 'active' : ''}" data-live-filter="${key}">${label}<span class="count">${fmt.format(counts[key])}</span></button>`).join('');
    $('liveChips').innerHTML = chips + (drill
      ? `<button type="button" class="chip active drill" data-drill-reset="1" title="Снова показать все события">` +
        `🛠 только «${esc(drill)}» ✕</button>`
      : '');
    $('eventMeta').textContent = drill
      ? `${fmt.format(events.length)} ${plural(events.length, ['событие', 'события', 'событий'])} по инструменту`
      : 'обновляется сама';

    const filtered = events.filter((e) =>
      state.liveFilter === 'all' ||
      (state.liveFilter === 'api' && e.kind === 'api_call') ||
      (state.liveFilter === 'tool' && e.kind === 'tool_event') ||
      (state.liveFilter === 'err' && e.kind === 'tool_event' && e.status === 'error') ||
      (state.liveFilter === 'aux' && e.kind === 'aux_summary'));
    const list = $('liveEvents');
    if (!filtered.length) {
      list.innerHTML = emptyBox('Пока нет таких событий.', 'Как только ассистент что-то сделает, события появятся здесь сами.');
      return;
    }
    list.innerHTML = filtered.slice(0, 80).map((e) => {
      let icon, title, sub;
      if (e.kind === 'api_call') {
        icon = '🤖';
        title = `Обращение к ИИ №${e.call_number ?? '?'}`;
        sub = `${e.model || '?'} · ${e.provider || '?'} · ` + (e.input_tokens == null
          ? 'количество токенов неизвестно'
          : `${tokens(e.input_tokens)} прочитано / ${tokens(e.output_tokens)} создано`);
      } else if (e.kind === 'aux_summary') {
        icon = '🔎';
        title = 'Фоновая проверка завершена';
        sub = `${fmt.format(e.api_calls || 0)} ${plural(e.api_calls, ['обращение', 'обращения', 'обращений'])} к ИИ · ${tokens(e.input_tokens)} прочитано`;
      } else if (e.status === 'error') {
        icon = '⚠️';
        title = `Инструмент «${e.tool}» — ошибка`;
        sub = `прервалось через ${durFmt(e.duration_seconds)}`;
      } else {
        icon = '🛠';
        title = `Инструмент «${e.tool}» — готово`;
        sub = `заняло ${durFmt(e.duration_seconds)}` + (e.result_chars ? ` · ${fmt.format(e.result_chars)} символов ответа` : '');
      }
      const sid = e.session_id || '';
      // Новые события вспыхивают и гаснут; ошибки подкрашены пульсацией.
      const age = Date.now() / 1000 - (e.timestamp || 0);
      const fresh = age < 20 ? ' fresh' : '';
      const st = eventStatus(e);
      const err = st.key === 'error' ? ' errored' : '';
      const kind = e.kind === 'tool_event' ? toolKind(e.tool) : '';
      const kindTag = kind
        ? `<span class="kind-tag" title="Семейство инструмента: ${esc(e.tool || '')}">${esc(kind)}</span>`
        : '';
      return `<div class="event st-${st.key}${fresh}${err}"><div class="event-time">${esc(timeFmt((e.timestamp || 0) * 1000))}</div>` +
        `<div class="event-main"><div class="event-title"><span class="st-tag" title="${esc(st.help)}">${esc(st.tag)}</span>${kindTag}${icon} ${esc(title)}</div>` +
        `<div class="event-sub">${esc(sub)}</div></div>` +
        `<span class="badge" title="ID разговора: ${esc(sid)}">${esc(sid ? sid.slice(0, 10) : '—')}</span></div>`;
    }).join('');
  }

  /* ---------- Рендер: таблицы ---------- */

  function renderModels() {
    const rows = sorted(visibleModels(), state.sorts.model);
    const el = $('modelTable');
    if (!rows.length) { el.innerHTML = tableEmpty('Нет данных по моделям.', 'Похоже, за выбранный период (и с текущими фильтрами) обращений к ИИ не было.'); return; }
    const maxTok = Math.max(1, ...rows.map((r) => Number(r.total_tokens) || 0));
    el.innerHTML = `<table><thead><tr>` +
      `<th>${sortButton('Модель', 'model', 'model')}</th>` +
      `<th>${sortButton('Провайдер', 'provider', 'model')}</th>` +
      `<th>${sortButton('Задача', 'task', 'model')}</th>` +
      `<th class="right">${sortButton('Токены', 'total_tokens', 'model')}</th>` +
      `<th class="right" title="Сколько раз обращались к модели">Обращений</th>` +
      `<th class="right" title="Фактическая стоимость, если провайдер сообщил; иначе оценка">Стоимость</th>` +
      `</tr></thead><tbody>` +
      rows.map((r) => {
        const share = Math.round((Number(r.total_tokens) || 0) / maxTok * 100);
        return `<tr class="clickable" data-drill-model="${esc(r.model)}" title="Отфильтровать всю панель по этой модели">` +
          `<td class="mono truncate" title="${esc(r.model)}">${esc(r.model)}</td>` +
          `<td class="muted">${esc(r.provider)}</td>` +
          `<td><span class="badge" title="${esc(r.task)}">${esc(taskLabel(r.task))}</span></td>` +
          `<td class="right"><div class="sharewrap"><span class="number">${esc(tokens(r.total_tokens))}</span><span class="sharebar"><i style="width:${share}%"></i></span></div></td>` +
          `<td class="right number">${esc(fmt.format(r.api_calls || 0))}</td>` +
          `<td class="right number">${esc(money(r.cost_usd))}</td></tr>`;
      }).join('') + '</tbody></table>';
  }

  function renderTasks() {
    const rows = sorted(visibleTasks(), state.sorts.task);
    const el = $('taskTable');
    if (!rows.length) { el.innerHTML = tableEmpty('Нет данных по задачам.', 'Категории появятся, когда Hermes накопит сводки использования.'); return; }
    const maxTok = Math.max(1, ...rows.map((r) => Number(r.total_tokens) || 0));
    el.innerHTML = `<table><thead><tr>` +
      `<th>${sortButton('Задача', 'task', 'task')}</th>` +
      `<th class="right">${sortButton('Токены', 'total_tokens', 'task')}</th>` +
      `<th class="right" title="Сколько раз обращались к ИИ">Обращений</th>` +
      `<th class="right">Стоимость</th>` +
      `</tr></thead><tbody>` +
      rows.map((r) => {
        const share = Math.round((Number(r.total_tokens) || 0) / maxTok * 100);
        return `<tr>` +
          `<td><span class="badge" title="${esc(r.task)}">${esc(taskLabel(r.task))}</span>` +
          `<div class="event-sub" title="${esc((r.models || []).join(', '))}">${esc((r.models || []).join(', '))}</div></td>` +
          `<td class="right"><div class="sharewrap"><span class="number">${esc(tokens(r.total_tokens))}</span><span class="sharebar"><i style="width:${share}%"></i></span></div></td>` +
          `<td class="right number">${esc(fmt.format(r.api_calls || 0))}</td>` +
          `<td class="right number">${esc(money(r.cost_usd))}</td></tr>`;
      }).join('') + '</tbody></table>';
  }

  function renderTools() {
    const rows = sorted(state.data?.tools || [], state.sorts.tool);
    const skills = state.data?.skills || [];
    $('toolsMeta').textContent = `${rows.length} ${plural(rows.length, ['инструмент', 'инструмента', 'инструментов'])}` +
      (skills.length ? ` · ${skills.length} ${plural(skills.length, ['навык', 'навыка', 'навыков'])}` : '');
    const el = $('toolTable');
    if (!rows.length) { el.innerHTML = tableEmpty('Инструменты появятся после первого вызова.', 'Ассистент вызывает инструменты — терминал, файлы, поиск — когда решает ваши задачи.'); return; }
    const max = Math.max(1, ...rows.map((r) => Number(r.count) || 0));
    const table = `<table><thead><tr>` +
      `<th>${sortButton('Инструмент', 'name', 'tool')}</th>` +
      `<th class="right">${sortButton('Вызовы', 'count', 'tool')}</th>` +
      `<th class="right" title="Доля от всех вызовов инструментов">Доля</th>` +
      `</tr></thead><tbody>` +
      rows.map((r) => {
        const share = Math.round((Number(r.count) || 0) / max * 100);
        return `<tr class="clickable" data-drill-tool="${esc(r.name)}" title="Показать в живой ленте только этот инструмент"><td class="mono">${esc(r.name)}</td>` +
          `<td class="right number">${esc(fmt.format(r.count || 0))}</td>` +
          `<td class="right"><div class="sharewrap"><span class="number">${(Number(r.percentage) || 0).toFixed(1).replace('.', ',')}%</span><span class="sharebar"><i style="width:${share}%"></i></span></div></td></tr>`;
      }).join('') + '</tbody></table>';
    const skillsHtml = skills.length
      ? `<div class="skills"><div class="skills-title">📚 Загруженные навыки ${hint('skill')}</div><div class="chips">` +
        skills.slice(0, 12).map((s) =>
          `<span class="chip static" title="Последнее использование: ${esc(s.last_used_at_iso || '—')}">${esc(s.skill)} <span class="count">×${fmt.format(s.total_count || 0)}</span></span>`).join('') +
        `</div></div>`
      : '';
    el.innerHTML = table + skillsHtml;
  }

  function renderSessions() {
    const rows = sorted(state.data?.sessions || [], state.sorts.session);
    $('sessionMeta').textContent = `${rows.length} ${plural(rows.length, ['разговор', 'разговора', 'разговоров'])} · нажмите на строку — откроется карта`;
    const el = $('sessionTable');
    if (!rows.length) { el.innerHTML = tableEmpty('За период нет разговоров.', 'Как только вы напишете ассистенту, разговор появится здесь.'); return; }
    el.innerHTML = `<table><thead><tr>` +
      `<th>${sortButton('Разговор', 'display_label', 'session')}</th>` +
      `<th>${sortButton('Модель', 'model', 'session')}</th>` +
      `<th>Провайдер</th>` +
      `<th class="right">${sortButton('Токены', 'input_tokens', 'session')}</th>` +
      `<th class="right" title="Сколько раз ассистент вызывал инструменты">Инструментов</th>` +
      `<th class="right" title="Фактическая стоимость, если провайдер сообщил; иначе оценка">Стоимость</th>` +
      `<th class="right">${sortButton('Последняя активность', 'last_activity_at', 'session')}</th>` +
      `</tr></thead><tbody>` +
      rows.map((r) => {
        const tok = (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0) +
          (Number(r.cache_read_tokens) || 0) + (Number(r.cache_write_tokens) || 0);
        return `<tr class="clickable ${r.id === state.sessionId ? 'selected' : ''}" data-session="${esc(r.id)}">` +
          `<td><div class="truncate" title="${esc(r.display_label)}">${esc(r.display_label)}</div>` +
          `<div class="event-sub mono">${esc(r.id)}${r.parent_session_id ? ' · подзадача' : ''}${durationFmt(r.started_at_iso, r.last_activity_at_iso) ? ' · длился ' + durationFmt(r.started_at_iso, r.last_activity_at_iso) : ''}</div></td>` +
          `<td class="mono truncate">${esc(r.model || '—')}</td>` +
          `<td class="muted">${esc(r.billing_provider || '—')}</td>` +
          `<td class="right number">${esc(tokens(tok))}</td>` +
          `<td class="right number">${esc(fmt.format(r.tool_call_count || 0))}</td>` +
          `<td class="right number">${esc(money(r.actual_cost_usd ?? r.estimated_cost_usd))}</td>` +
          `<td class="right muted" title="${esc(dateFmt(r.last_activity_at_iso))}">${esc(relTime(r.last_activity_at_iso))}` +
          `<button type="button" class="btn ghost mini copy-btn" data-copy="${esc(r.id)}"` +
          ` title="Скопировать ID разговора: ${esc(r.id)}">ID</button></td></tr>`;
      }).join('') + '</tbody></table>';
  }

  /* ---------- Рендер: карта разговора ---------- */

  function nodeLayout(nodes) {
    const order = { parent: 0, session: 0, subtask: 0, request: 1, api: 2, tool: 3, result: 3, task: 4, skill: 5 };
    const groups = {};
    nodes.forEach((n) => { (groups[n.kind] ||= []).push(n); });
    const cols = { 0: 100, 1: 285, 2: 480, 3: 670, 4: 855, 5: 1035 };
    const positions = {};
    Object.entries(groups).forEach(([kind, list]) => {
      const x = cols[order[kind] ?? 0];
      list.forEach((n, i) => { positions[n.id] = { x, y: 38 + i * 72 }; });
    });
    return positions;
  }

  function nodeDetail(n) {
    const m = n.meta || {};
    switch (n.kind) {
      case 'api':
        return `${m.input_tokens == null ? '?' : tokens(m.input_tokens)} in · ${m.output_tokens == null ? '?' : tokens(m.output_tokens)} out`;
      case 'session': case 'subtask':
        return `${tokens(m.tokens)} токенов`;
      case 'task':
        return `${tokens(m.tokens)} токенов`;
      case 'tool':
        return 'вызов инструмента';
      case 'request':
        return 'ваше сообщение';
      case 'result':
        return 'ответ инструмента';
      case 'skill':
        return 'навык загружен';
      default:
        return n.kind;
    }
  }

  function renderGraph() {
    const svg = $('graphSvg');
    const g = state.graph;
    if (!g || !g.nodes?.length) {
      svg.innerHTML = '';
      $('graphMeta').textContent = g?.error || 'выберите разговор в таблице выше';
      renderInspector(null);
      return;
    }
    const pos = nodeLayout(g.nodes);
    const graphWidth = Math.max(1080, ...Object.values(pos).map((p) => p.x + 140));
    svg.setAttribute('viewBox', `0 0 ${graphWidth} 510`);
    // Недавние узлы (последние 2 минуты) получают «текущие» пунктирные рёбра:
    // видно, какая цепочка отработала только что.
    const recentIds = new Set(g.nodes
      .filter((n) => (n.meta?.timestamp || n.timestamp || 0) > Date.now() / 1000 - 120)
      .map((n) => n.id));
    const lines = g.edges.map((e) => {
      const a = pos[e.source];
      const b = pos[e.target];
      if (!a || !b) return '';
      const flowing = recentIds.has(e.source) && recentIds.has(e.target) && (e.relation === 'calls' || e.relation === 'sequence');
      return `<line class="graph-edge${flowing ? ' flowing' : ''}" x1="${a.x + 54}" y1="${a.y + 17}" x2="${b.x - 8}" y2="${b.y + 17}"${flowing ? ' stroke-dasharray="5 4"' : ''}/>`;
    }).join('');
    const nodes = g.nodes.map((n) => {
      const p = pos[n.id];
      const raw = String(n.label || '');
      const label = raw.length > 24 ? raw.slice(0, 23) + '…' : raw;
      const activeSession = n.kind === 'session' && recentIds.has(n.id) ? ' active' : '';
      return `<g class="graph-node ${esc(n.kind)}${activeSession} ${n.id === state.nodeId ? 'selected' : ''}" data-node="${esc(n.id)}" transform="translate(${p.x},${p.y})">` +
        `<title>${esc(raw)}</title>` +
        `<rect width="116" height="36"></rect>` +
        `<text x="8" y="15">${esc(label)}</text>` +
        `<text x="8" y="29" class="tiny">${esc(nodeDetail(n))}</text></g>`;
    }).join('');
    svg.innerHTML = `<rect width="${graphWidth}" height="510" fill="var(--graph-bg)"></rect><g id="graphWorld">${lines}${nodes}</g>`;
    applyView();
    $('graphMeta').textContent =
      `${g.nodes.length} объектов · ${g.edges.length} связей · нажмите на прямоугольник` +
      (g.truncated ? ' · показаны последние 320 событий журнала' : '');
    const selected = g.nodes.find((n) => n.id === state.nodeId) || g.nodes.find((n) => n.kind === 'session') || g.nodes[0];
    state.nodeId = selected?.id;
    renderInspector(selected);
  }

  function formatMeta(key, value) {
    if (value == null || value === '') return null;
    if (typeof value === 'object') return JSON.stringify(value);
    if (key.includes('tokens')) return `${fullTokens(value)} ток.`;
    if (key === 'latency_seconds') return durFmt(value);
    if (key.includes('cost')) return money(Number(value));
    return String(value);
  }

  function renderInspector(node) {
    if (!node) {
      $('inspector').innerHTML =
        `<h3>Подробности появятся здесь</h3>` +
        `<div class="inspector-help">Слева — «карта» одного разговора: что вы просили, какие инструменты вызывал ассистент, какими были его обращения к ИИ. У выбранного узла ниже появятся кнопки «Копировать ID» и ссылка на разговор.<br><br>` +
        `Чтобы карта появилась, нажмите на любой разговор в таблице «Ваши разговоры с ассистентом». А чтобы увидеть подробности — щёлкните по прямоугольнику на самой карте.</div>`;
      return;
    }
    const meta = node.meta || {};
    const rows = [];
    const push = (label, value) => {
      if (value !== null && value !== undefined && value !== '') rows.push(`<dt>${esc(label)}</dt><dd class="mono">${esc(value)}</dd>`);
    };
    push('Тип', KIND_LABELS[node.kind] || node.kind);
    push('Время', node.timestamp ? new Date(node.timestamp * 1000).toLocaleString('ru-RU') : null);
    const skip = new Set(['content', 'cost_note']);
    for (const [k, v] of Object.entries(meta)) {
      if (skip.has(k)) continue;
      push(META_LABELS[k] || k, formatMeta(k, v));
    }
    const content = meta.content ? `<h3>Текст сообщения</h3><pre class="prompt">${esc(meta.content)}</pre>` : '';
    // Разговор, к которому относится выбранный узел: можно забрать ID или ссылку.
    const sid = state.sessionId;
    const actions = sid
      ? `<div class="inspector-actions">` +
        `<button type="button" class="btn ghost mini" data-copy="${esc(sid)}" title="Скопировать ID разговора">Копировать ID</button>` +
        `<button type="button" class="btn ghost mini" data-copy="${esc(location.origin + location.pathname + '?session=' + sid)}" title="Скопировать ссылку на этот разговор">Ссылка</button>` +
        `<a class="btn ghost mini" href="?session=${encodeURIComponent(sid)}" target="_blank" rel="noopener" title="Открыть этот разговор отдельной вкладкой">Открыть</a>` +
        `<span class="mono muted sid">${esc(sid)}</span></div>`
      : '';
    $('inspector').innerHTML = `<h3>${esc(node.label)}</h3><dl class="kv">${rows.join('')}</dl>${content}${actions}`;
  }

  /* ---------- Карта: масштаб и панорама (окно фиксированной высоты) ---------- */

  function resetView() {
    state.view = { scale: 1, tx: 0, ty: 0 };
    applyView();
  }

  function applyView() {
    const world = $('graphSvg')?.querySelector('#graphWorld');
    if (world) world.setAttribute('transform', `translate(${state.view.tx} ${state.view.ty}) scale(${state.view.scale})`);
    const pct = Math.round(state.view.scale * 100);
    const range = $('zoomRange');
    if (range) range.value = String(Math.min(250, Math.max(25, pct)));
    const label = $('zoomLabel');
    if (label) label.textContent = pct + '%';
  }

  // Масштаб так, чтобы точка под курсором осталась на месте.
  function zoomAt(clientX, clientY, factor) {
    const svg = $('graphSvg');
    const world = svg?.querySelector('#graphWorld');
    if (!svg || !world) return;
    const v = state.view;
    const next = Math.min(3, Math.max(0.25, v.scale * factor));
    if (next === v.scale) return;
    const cursor = new DOMPoint(clientX, clientY).matrixTransform(svg.getScreenCTM().inverse());
    const fixed = new DOMPoint(clientX, clientY).matrixTransform(world.getScreenCTM().inverse());
    v.scale = next;
    v.tx = cursor.x - fixed.x * next;
    v.ty = cursor.y - fixed.y * next;
    applyView();
  }

  function zoomCenter(factor) {
    const svg = $('graphSvg');
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  function fitView() {
    const svg = $('graphSvg');
    const world = svg?.querySelector('#graphWorld');
    if (!svg || !world) return;
    let box;
    try { box = world.getBBox(); } catch (e) { return; }
    if (!box || box.width <= 0 || box.height <= 0) return;
    const vb = svg.viewBox.baseVal;
    const scale = Math.min(3, Math.max(0.25, Math.min(vb.width / box.width, vb.height / box.height)));
    state.view = {
      scale,
      tx: (vb.width - box.width * scale) / 2 - box.x * scale,
      ty: (vb.height - box.height * scale) / 2 - box.y * scale,
    };
    applyView();
  }

  function initGraphViewport() {
    const viewport = $('graphViewport');
    const svg = $('graphSvg');
    if (!viewport || !svg) return;
    // Колесо мыши над картой — масштаб, страница при этом не прокручивается.
    viewport.addEventListener('wheel', (e) => {
      if (!svg.querySelector('#graphWorld')) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    // Перетаскивание — сдвиг карты.
    let panning = false, moved = false, sx = 0, sy = 0;
    viewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      panning = true; moved = false; sx = e.clientX; sy = e.clientY;
      try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!panning || !svg.querySelector('#graphWorld')) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) > 4) { moved = true; viewport.classList.add('panning'); }
      if (moved) {
        const ctm = svg.getScreenCTM();
        const k = ctm && ctm.a ? 1 / ctm.a : 1;
        state.view.tx += dx * k;
        state.view.ty += dy * k;
        sx = e.clientX; sy = e.clientY;
        applyView();
      }
    });
    const stopPan = () => {
      if (!panning) return;
      panning = false;
      viewport.classList.remove('panning');
      if (moved) state.suppressNodeClick = true; // был сдвиг, а не клик по узлу
    };
    viewport.addEventListener('pointerup', stopPan);
    viewport.addEventListener('pointercancel', stopPan);
    const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    bind('zoomIn', () => zoomCenter(1.25));
    bind('zoomOut', () => zoomCenter(1 / 1.25));
    bind('zoomReset', resetView);
    bind('zoomFit', fitView);
    const range = $('zoomRange');
    if (range) range.addEventListener('input', (e) => {
      if (!svg.querySelector('#graphWorld')) return;
      const r = svg.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, (Number(e.target.value) / 100) / state.view.scale);
    });
  }

  let graphSeq = 0;
  let graphApplied = 0;
  let graphInFlight = false;

  async function loadGraph(id, opts = {}) {
    if (graphInFlight && !opts.force) return; // та же причина: не плодим наложение
    const seq = ++graphSeq;
    graphInFlight = true;
    const changed = state.sessionId !== id;
    state.sessionId = id;
    if (changed) {
      state.nodeId = null;
      resetView();
    }
    renderSessions();
    $('graphMeta').textContent = 'загружаем карту…';
    try {
      const g = await getJSON('/api/graph?session_id=' + encodeURIComponent(id));
      if (seq < graphApplied) return; // карту успели переключить на другой разговор
      graphApplied = seq;
      state.graph = g;
    } catch (e) {
      if (seq < graphApplied) return;
      graphApplied = seq;
      state.graph = { error: e.message, nodes: [] };
    } finally {
      graphInFlight = false;
    }
    renderGraph();
    // Скроллим к карте только когда пользователь сам кликнул по разговору.
    // Автообновление данных молча перерисовывает карту и не трогает прокрутку.
    if (opts.scroll) $('graphPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- Рендер: точность и словарик ---------- */

  function renderQuality() {
    const q = state.data?.data_quality || {};
    const body = $('qualityBody');
    if (!Object.keys(q).length) {
      body.innerHTML = '<p>Детали появятся, когда данные будут прочитаны.</p>';
      return;
    }
    const statuses = state.data?.summary?.cost_statuses || {};
    const statusesLine = Object.keys(statuses).length
      ? `<p>Строк со стоимостью за период: ${Object.entries(statuses).map(([k, v]) => `${fmt.format(v)} — «${esc(k)}»`).join(', ')}.</p>`
      : '';
    body.innerHTML =
      `<p>✅ <b>Токены каждого запроса</b> — точные: они берутся из журнала ассистента (<code>agent.log</code>). Строк с токенами распознано: ${fmt.format(q.per_api_call_tokens || 0)}.</p>` +
      `<p>📊 <b>Итоги по моделям, задачам и стоимость</b> — из готовых сводок базы Hermes (<code>state.db</code>): ${fmt.format(q.state_db_usage_rows || 0)} строк сводок за период.</p>` +
      `<p>🧮 <b>Стоимость одного конкретного запроса</b> Hermes пока не сохраняет — поэтому панель её не выдумывает. Показываем только проверяемое: оценку по прайс-листам и факт из отчётов провайдера (если провайдер присылает отчёт).</p>` +
      statusesLine;
  }

  function renderGlossary() {
    $('glossaryGrid').innerHTML = GLOSSARY.map(([term, text]) =>
      `<details><summary>${esc(term)}</summary><div class="details-body">${esc(text)}</div></details>`).join('');
  }

  /* ---------- Загрузка данных ---------- */

  /* ---------- Шапка: «живость» (LIVE + текущая скорость, задачи, вызовы) ---------- */

  // Модель активнее всех «прямо сейчас»: свежий замер (окно 3 мин) с минимальным возрастом.
  function hudRate() {
    const rows = (state.data?.recent_model_rates || [])
      .filter((r) => r.fresh && r.output_tokens_per_second != null && Number(r.output_tokens_per_second) > 0);
    if (!rows.length) return null;
    return rows.reduce((a, b) => ((a.age_seconds ?? 1e9) <= (b.age_seconds ?? 1e9) ? a : b));
  }

  function renderHud() {
    const hud = $('hud');
    if (!hud) return;
    const s = state.data?.summary || {};
    const rate = hudRate();
    const days = state.data?.period_days;
    const periodText = days ? (days >= 3650 ? 'за всё время' : `за ${days} ${plural(days, ['день', 'дня', 'дней'])}`) : 'за период';
    const values = {
      rate: rate ? fmtRate(rate.output_tokens_per_second) : '—',
      tasks: fmt.format(s.active_sessions || 0),
      calls: fmt.format(s.api_calls || 0),
    };
    const model = rate ? String(rate.model || '').split('/').pop() : '';
    const age = rate ? Math.round(rate.age_seconds || 0) : null;
    hud.innerHTML =
      `<span class="hud-live" title="Панель сама перечитывает данные Hermes каждые пару секунд">LIVE</span>` +
      `<span class="hud-item" title="${rate
        ? `Скорость ответа модели ${esc(model)} · измерено по последним ${fmt.format(rate.tail_calls || 0)} вызовам за ${Math.round((rate.window_seconds || 180) / 60)} мин · ${age <= 2 ? 'только что' : `${age} с назад`}`
        : 'Сейчас никто не обращается к модели — как только ассистент начнёт отвечать, скорость появится здесь'}">` +
        `<b class="${hudChanged('rate', values.rate)}">${esc(values.rate)}</b><em>ток/с</em></span>` +
      `<span class="hud-item" title="Разговоров, где ассистент работает прямо сейчас (последние минуты)"><b class="${hudChanged('tasks', values.tasks)}">${esc(values.tasks)}</b><em>${plural(s.active_sessions || 0, ['задача', 'задачи', 'задач'])} в работе</em></span>` +
      `<span class="hud-item" title="Все обращения к ИИ ${periodText} — по данным, которые панель сейчас показывает"><b class="${hudChanged('calls', values.calls)}">${esc(values.calls)}</b><em>обращений к ИИ</em></span>` +
      (model ? `<span class="hud-model">${esc(model)}</span>` : '');
  }

  // Вспышка, когда цифра в шапке меняется — как и у KPI-плиток.
  function hudChanged(key, value) {
    const prev = state.hudValues?.[key];
    state.hudValues = { ...(state.hudValues || {}), [key]: value };
    return prev !== undefined && prev !== value ? 'hud-pulse' : '';
  }

  function renderAll() {
    renderHud();
    renderFilters();
    renderNotice();
    renderStatusBanner();
    renderStory();
    renderKpis();
    renderDaily();
    renderRates();
    renderSpend();
    renderEvents();
    renderModels();
    renderTasks();
    renderTools();
    renderSessions();
    renderGraph();
    renderQuality();
    renderScopeTags();
    const src = state.data?.source;
    $('sourceMeta').textContent = src?.db
      ? `данные: ${src.db} · журнал: ${(src.logs || []).map((p) => String(p).split(/[\\/]/).pop()).join(', ') || 'agent.log'} · только чтение`
      : 'источник не прочитан';
    $('exportBtn').disabled = !state.data || !!state.data.error;
    $('pngBtn').disabled = !state.data || !!state.data.error;
  }

  /* Блоки, которые фильтр не сужает (в логе нет задачи, в таблицах инструментов нет модели),
     помечаются явно — чтобы цифры не выглядели частью среза, когда это весь период. */
  function renderScopeTags() {
    const filter = state.data?.filter;
    const mark = (elId, key) => {
      const el = $(elId);
      if (!el) return;
      el.querySelectorAll('.scope-tag').forEach((node) => node.remove());
      if (!filter?.active) return;
      if ((filter.scope || {})[key] !== 'period') return;
      el.insertAdjacentHTML('beforeend', ' <span class="scope-tag" title="Этот блок нельзя сузить выбранным фильтром — здесь весь период">весь период</span>');
    };
    mark('ratesMeta', 'rates');
    mark('toolsMeta', 'tools');
  }

  async function ensureTrend() {
    const days = state.days;
    if (days >= 3650) { renderTrendLine(); return; }
    const key = trendKey();
    if (state.trends[key]) { updateTrend(); return; }
    if (state.trendPending[key]) return;
    state.trendPending[key] = true;
    try {
      const wideQuery = new URLSearchParams({ days: String(days * 2) });
      if (state.filters.provider) wideQuery.set('provider', state.filters.provider);
      if (state.filters.model) wideQuery.set('model', state.filters.model);
      if (state.filters.task) wideQuery.set('task', state.filters.task);
      const wide = await getJSON('/api/snapshot?' + wideQuery.toString());
      if (!wide.error) {
        const curStart = Date.now() - days * 86400000;
        const prevStart = curStart - days * 86400000;
        const t = { cur: 0, prev: 0 };
        for (const row of wide.daily || []) {
          const ts = new Date(row.day + 'T12:00:00').getTime();
          const total = (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0) +
            (Number(row.cache_read_tokens) || 0) + (Number(row.cache_write_tokens) || 0);
          if (ts >= curStart) t.cur += total;
          else if (ts >= prevStart) t.prev += total;
        }
        state.trends[key] = t;
        updateTrend();
      }
    } catch {
      const el = $('trendLine');
      if (el) el.innerHTML = '<span class="trend flat">Сравнение с предыдущим периодом сейчас недоступно.</span>';
    } finally {
      delete state.trendPending[key];
    }
  }

    // Ответы приходят не по порядку: холодный расчёт на свежих логах занимает секунды,
  // и медленный ответ на старый запрос затирал свежие данные (например, только что
  // поставленный фильтр). Отбрасываем только те ответы, которые старше уже применённого:
  // жёсткое «последний запрос побеждает» при медленном сервере морило панель голодом.
  let snapshotSeq = 0;
  let snapshotApplied = 0;
  let snapshotInFlight = false;

  async function loadSnapshot(force = false) {
    if (snapshotInFlight && !force) return; // уже считаем — не плодим наложение запросов
    const seq = ++snapshotSeq;
    snapshotInFlight = true;
    try {
      const query = new URLSearchParams({ days: String(state.days) });
      if (state.filters.provider) query.set('provider', state.filters.provider);
      if (state.filters.model) query.set('model', state.filters.model);
      if (state.filters.task) query.set('task', state.filters.task);
      if (force) query.set('t', String(Date.now()));
      const data = await getJSON('/api/snapshot?' + query.toString());
      if (seq < snapshotApplied) return; // уже показаны данные свежее этих — не откатываемся назад
      snapshotApplied = seq;
      const newHash = data?.signature?.hash;
      if (newHash && newHash !== state.lastSignature) state.trends = {};
      state.lastSignature = newHash;
      state.data = data;
      renderAll();
      // Списки фильтров берём отдельно: активный фильтр не должен вычищать варианты из «все».
      const optionsKey = state.days + ':' + newHash;
      if (optionsKey !== state.optionsKey) {
        state.optionsKey = optionsKey;
        loadOptions();
      }
      setStatus('', 'обновляется автоматически');
      ensureTrend();
      // Ссылку на карту разговора можно сохранить: ?session=<id> открывает её сразу.
      if (!state.sessionId) {
        const urlSession = new URLSearchParams(location.search).get('session');
        if (urlSession) state.sessionId = urlSession;
      }
      if (state.sessionId) await loadGraph(state.sessionId);
    } catch (e) {
      setStatus('err', 'нет связи с сервером');
      $('notice').innerHTML = errorBox('Не получилось получить данные', e.message,
        'Проверьте, что панель всё ещё запущена: <code>python server.py</code>, и попробуйте кнопку «Обновить».');
    } finally {
      snapshotInFlight = false;
    }
  }

  async function loadOptions() {
    try {
      const data = await getJSON('/api/options?days=' + state.days);
      state.options = data || {};
      renderFilters();
    } catch {
      // Панель фильтров не критична: без неё страница просто покажет данные целиком.
    }
  }

  async function heartbeat() {
    try {
      const h = await getJSON('/api/heartbeat');
      const previous = state.data?.signature?.hash;
      if (!previous || previous !== h.signature.hash) await loadSnapshot();
      else setStatus('', 'обновляется автоматически');
    } catch {
      setStatus('err', 'нет связи — панель продолжит пытаться');
    }
  }

  /* ---------- Экскурсия ---------- */

  const TOUR = [
    { sel: '.topbar', title: '👋 Добро пожаловать!',
      text: 'Это панель наблюдения за ИИ-ассистентом Hermes. Она показывает, чем ассистент занимался и во сколько это обошлось. Экскурсия займёт около минуты — листайте кнопкой «Далее».' },
    { sel: '.toolbar', title: 'Период и статус',
      text: 'Кнопки «Сегодня», «7 дней», «30 дней» и «90 дней» переключают период: все цифры на панели пересчитаются. Зелёная точка слева означает, что данные обновляются автоматически.' },
    { sel: '#storyCard', title: 'Главное — простыми словами',
      text: 'Здесь обычным языком описано, что произошло за период: сколько разговоров, обращений к ИИ и денег. Строка со стрелкой внизу — сравнение с предыдущим периодом: выросла активность или нет.' },
    { sel: '#kpis', title: 'Ключевые цифры',
      text: 'Токены — «объём работы» ИИ, обращения — сколько раз ассистент ходил в модель, ниже — стоимость: оценка и факт. У каждой карточки есть значок «?» — нажмите, появится простое объяснение.' },
    { sel: '#dailyPanel', title: 'Активность',
      text: 'Каждый столбик — день (за длинные периоды — неделя): синее — сколько ИИ прочитал, голубое — сколько написал. Пунктирная линия — обычный уровень. Наведите курсор, чтобы увидеть точные цифры.' },
    { sel: '#livePanel', title: 'Живая лента',
      text: 'Здесь мелькают последние события из журнала ассистента: обращения к ИИ, вызовы инструментов, фоновые проверки. Кнопками сверху можно оставить только интересующий тип событий.' },
    { sel: '#tablesRow', title: 'Подробности',
      text: 'Три таблицы: какие модели ИИ работали, на какие внутренние задачи ушли усилия и какими инструментами ассистент пользовался. В обычном режиме они скрыты — кнопка «Показать детали» в шапке возвращает их. Нажмите на столбец — сортировка.' },
    { sel: '#sessionPanel', title: 'Ваши разговоры',
      text: 'Список разговоров за период. Нажмите на любой — ниже откроется его «карта».' },
    { sel: '#graphPanel', title: 'Карта разговора',
      text: 'Схема одного разговора: что вы просили (прямоугольники слева), какие инструменты ассистент вызывал, его обращения к ИИ и подзадачи. Цвета объясняет легенда. Нажмите на прямоугольник — справа появятся подробности.' },
    { sel: '#qualityPanel', title: 'Честность цифр',
      text: 'Мы никогда не выдумываем данные: чего нет в файлах Hermes, того не будет и на панели. Здесь написано, откуда берётся каждая цифра.' },
    { sel: '#glossary', title: '🎉 Почти готово!',
      text: 'Все термины — «токен», «кэш», «провайдер» — объяснены в словарике. Экскурсию можно повторить в любой момент кнопкой «Экскурсия» сверху. Приятно пользоваться!' },
  ];

  let tourIndex = -1;
  let tourTarget = null;

  function startTour() {
    tourIndex = 0;
    $('tourOverlay').hidden = false;
    localStorage.setItem('hud.tour.done', '1');
    applyDetailMode(true); // на время экскурсии показываем все блоки
    showTourStep();
  }

  function endTour() {
    tourIndex = -1;
    tourTarget = null;
    $('tourOverlay').hidden = true;
    applyDetailMode();
  }

  function showTourStep() {
    const step = TOUR[tourIndex];
    if (!step) { endTour(); return; }
    const target = document.querySelector(step.sel);
    if (!target) {
      tourIndex += 1;
      showTourStep();
      return;
    }
    tourTarget = target;
    $('tourStepLabel').textContent = `Шаг ${tourIndex + 1} из ${TOUR.length}`;
    $('tourTitle').textContent = step.title;
    $('tourText').textContent = step.text;
    $('tourPrev').disabled = tourIndex === 0;
    $('tourNext').textContent = tourIndex === TOUR.length - 1 ? 'Готово ✓' : 'Далее →';
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    positionTour();
  }

  function positionTour() {
    if (tourIndex < 0 || !tourTarget) return;
    const r = tourTarget.getBoundingClientRect();
    const spot = $('tourSpot');
    spot.style.left = Math.max(4, r.left - 6) + 'px';
    spot.style.top = Math.max(4, r.top - 6) + 'px';
    spot.style.width = Math.min(r.width + 12, window.innerWidth - 16) + 'px';
    spot.style.height = (r.height + 12) + 'px';
    const card = $('tourCard');
    let top = r.bottom + 14;
    if (top + card.offsetHeight > window.innerHeight - 10) top = Math.max(10, r.top - card.offsetHeight - 14);
    let left = Math.min(Math.max(10, r.left), window.innerWidth - card.offsetWidth - 10);
    if (left < 10) left = 10;
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  let tourRaf = null;
  function onTourReposition() {
    if (tourRaf) return;
    tourRaf = requestAnimationFrame(() => { tourRaf = null; positionTour(); });
  }

  window.addEventListener('scroll', onTourReposition, true);
  window.addEventListener('resize', onTourReposition);

  $('tourNext').addEventListener('click', () => {
    if (tourIndex >= TOUR.length - 1) endTour();
    else { tourIndex += 1; showTourStep(); }
  });
  $('tourPrev').addEventListener('click', () => { if (tourIndex > 0) { tourIndex -= 1; showTourStep(); } });
  $('tourSkip').addEventListener('click', endTour);

  /* ---------- Приветствие ---------- */

  function dismissWelcome() {
    $('welcomeCard').hidden = true;
    localStorage.setItem('hud.welcome', 'dismissed');
  }

  /* ---------- Общие обработчики кликов ---------- */

  document.addEventListener('click', async (event) => {
    if (event.target.closest('.hint')) return; // подсказки обрабатывает свой движок
    const target = event.target.closest('[data-copy],[data-drill-tool],[data-drill-model],[data-drill-reset],[data-days],[data-sort],[data-session],[data-node],[data-spend],[data-rates],[data-live-filter],[data-action]');
    if (!target) return;
    if (target.dataset.copy !== undefined) {
      event.stopPropagation();
      flashCopied(target, await copyText(target.dataset.copy));
      return;
    }
    if (target.dataset.drillTool) {
      state.toolFilter = state.toolFilter === target.dataset.drillTool ? '' : target.dataset.drillTool;
      renderEvents();
      $('livePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (target.dataset.drillModel) {
      state.filters.model = target.dataset.drillModel;
      state.trends = {};
      renderFilters();
      loadSnapshot();
      return;
    }
    if (target.dataset.drillReset !== undefined) { state.toolFilter = ''; renderEvents(); return; }
    if (target.dataset.action === 'budget') { openBudgetDialog(); return; }
    if (target.dataset.days) {
      state.days = Number(target.dataset.days);
      document.querySelectorAll('[data-days]').forEach((b) => b.classList.toggle('active', b.dataset.days === String(state.days)));
      loadSnapshot(true);
      return;
    }
    if (target.dataset.sort) {
      const scope = target.dataset.scope;
      const key = target.dataset.sort;
      state.sorts[scope] = key;
      state.dirs[key] = (state.dirs[key] || 'desc') === 'desc' ? 'asc' : 'desc';
      if (scope === 'model') renderModels();
      else if (scope === 'task') renderTasks();
      else if (scope === 'tool') renderTools();
      else renderSessions();
      return;
    }
    if (target.dataset.session) {
      const url = new URL(location.href);
      url.searchParams.set('session', target.dataset.session);
      history.replaceState(null, '', url);
      loadGraph(target.dataset.session, { scroll: true });
      return;
    }
    if (target.dataset.node) {
      if (state.suppressNodeClick) { state.suppressNodeClick = false; return; }
      state.nodeId = target.dataset.node; renderGraph(); return;
    }
    if (target.dataset.spend) {
      state.spendMode = target.dataset.spend;
      document.querySelectorAll('[data-spend]').forEach((b) => b.classList.toggle('active', b.dataset.spend === state.spendMode));
      renderSpend();
      return;
    }
    if (target.dataset.rates) {
      state.ratesMode = target.dataset.rates;
      document.querySelectorAll('[data-rates]').forEach((b) => b.classList.toggle('active', b.dataset.rates === state.ratesMode));
      renderRates();
      return;
    }
    if (target.dataset.liveFilter !== undefined) { state.liveFilter = target.dataset.liveFilter; renderEvents(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideHint();
      if (tourIndex >= 0) endTour();
      if (!$('budgetModal').hidden) closeBudgetDialog();
    }
  });

  /* ---------- Инициализация ---------- */

  function init() {
    if (localStorage.getItem('hud.welcome') !== 'dismissed') $('welcomeCard').hidden = false;
    $('welcomeClose').addEventListener('click', dismissWelcome);
    $('welcomeDismiss').addEventListener('click', dismissWelcome);
    $('welcomeTour').addEventListener('click', startTour);
    $('tourBtn').addEventListener('click', startTour);
    $('helpBtn').addEventListener('click', () => {
      const card = $('welcomeCard');
      card.hidden = !card.hidden;
      if (card.hidden) localStorage.setItem('hud.welcome', 'dismissed');
      else {
        localStorage.removeItem('hud.welcome');
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    $('refreshBtn').addEventListener('click', () => loadSnapshot(true));
    $('filterReset').addEventListener('click', () => {
      state.filters = { provider: '', model: '', task: '' };
      state.toolFilter = '';
      state.trends = {};
      renderFilters();
      renderEvents();
      loadSnapshot();
    });
    ['providerFilter', 'modelFilter', 'taskFilter'].forEach((id) => {
      $(id).addEventListener('change', (e) => {
        state.filters[id.replace('Filter', '')] = e.target.value;
        state.trends = {};
        renderFilters();
        loadSnapshot();
      });
    });

    $('themeBtn').addEventListener('click', () => {
      localStorage.setItem('hud.theme', localStorage.getItem('hud.theme') === 'light' ? 'dark' : 'light');
      applyTheme();
    });
    $('detailBtn').addEventListener('click', () => {
      localStorage.setItem('hud.simple', localStorage.getItem('hud.simple') !== 'detailed' ? 'detailed' : 'simple');
      applyDetailMode();
    });
    $('budgetForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const value = Number($('budgetInput').value);
      if (value > 0) localStorage.setItem('hud.budget', String(value));
      else localStorage.removeItem('hud.budget');
      const dayValue = Number($('dayLimitInput').value);
      if (dayValue > 0) localStorage.setItem('hud.dayLimit', String(dayValue));
      else localStorage.removeItem('hud.dayLimit');
      closeBudgetDialog();
      renderStory();
      renderStatusBanner();
    });
    $('budgetCancel').addEventListener('click', closeBudgetDialog);
    $('budgetRemove').addEventListener('click', () => {
      localStorage.removeItem('hud.budget');
      localStorage.removeItem('hud.dayLimit');
      closeBudgetDialog();
      renderStory();
      renderStatusBanner();
    });
    $('budgetModal').addEventListener('click', (e) => { if (e.target === $('budgetModal')) closeBudgetDialog(); });
    applyTheme();
    applyDetailMode();

    renderGlossary();
    renderSkeletons();
    initGraphViewport();
    $('exportBtn').addEventListener('click', exportCsv);
    $('pngBtn').addEventListener('click', () => {
      const btn = $('pngBtn');
      btn.disabled = true;
      exportPng().catch((e) => alert('Не получилось собрать картинку: ' + e.message))
        .finally(() => { btn.disabled = false; });
    });
    loadSnapshot(true);
    setInterval(heartbeat, 2000);
  }

  // Небольшой служебный хук: панель read-only, но её полезно уметь дёргать извне —
  // для снимков, проверок и внешнего мониторинга. Ничего не меняет в данных Hermes.
  window.__hud = { state, loadSnapshot, renderEvents, exportPng, copyText, exportCsv };

  init();
})();
