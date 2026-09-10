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
    sorts: { model: 'total_tokens', task: 'total_tokens', tool: 'count', session: 'last_activity_at' },
    dirs: {},
    liveFilter: 'all',
    trends: {},
    trendPending: {},
    lastSignature: null,
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
  const periodLabel = (days) => (days === 1 ? 'последний день' : `последние ${days} ${plural(days, ['день', 'дня', 'дней'])}`);
  const prevLabel = (days) => (days === 1 ? 'вчерашним днём' : `предыдущими ${days} ${plural(days, ['днём', 'днями', 'днями'])}`);
  const dayHuman = (day) => new Date(day + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

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
    daily: 'Каждый столбик — один день. <b>Синяя часть</b> — сколько ИИ прочитал (ваш вопрос, история диалога, результаты инструментов), <b>голубая</b> — сколько написал в ответ. Наведите курсор на столбик, чтобы увидеть точные цифры.',
    live: '<b>Живая лента</b> — последние события из журнала ассистента: обращения к ИИ, вызовы инструментов, фоновые проверки. Обновляется сама, пока панель открыта. Кнопками сверху можно оставить только интересный тип событий.',
    filters: 'Фильтры сужают показанное: выберите конкретного провайдера, модель или задачу — и таблицы ниже покажут только их. Кнопка «Сбросить» вернёт всё как было.',
    models_table: 'Каждая строка — сочетание «модель + провайдер + задача». Одна и та же модель в обычном диалоге и, скажем, при сжатии истории — это две строки: токены у Hermes копятся отдельно.',
    tasks_table: 'Hermes делит работу на внутренние задачи: основной диалог, сжатие истории, фоновые проверки. Так видно, на что реально уходят усилия и деньги.',
    sessions_table: 'Список ваших разговоров за период. <b>Нажмите на строку</b> — ниже откроется «карта» этого разговора: что вы просили и что ассистент делал шаг за шагом.',
    graph: 'Это схема «родословной» одного разговора. Слева — сам разговор, правее — ваши сообщения, вызовы инструментов, обращения к ИИ и подзадачи. Цвета прямоугольников объясняет легенда под заголовком. <b>Нажмите на любой прямоугольник</b> — справа появятся подробности.',
    quality: 'Мы никогда не выдумываем данные. Чего нет в файлах Hermes — того на панели не будет: вместо этого будет честная пометка.',
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
    $('statusDot').className = 'dot ' + (kind || '');
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
    fill('providerFilter', uniq(d.models || [], 'provider').map((v) => ({ value: v, label: v })), state.filters.provider);
    fill('modelFilter', uniq(d.models || [], 'model').map((v) => ({ value: v, label: v })), state.filters.model);
    fill('taskFilter', (d.tasks || []).map((t) => t.task).filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .sort((a, b) => a.localeCompare(b, 'ru'))
      .map((v) => ({ value: v, label: taskLabel(v) })), state.filters.task);
    const any = state.filters.provider || state.filters.model || state.filters.task;
    $('filterReset').hidden = !any;
    $('periodMeta').textContent = `период: ${periodLabel(state.days)}${any ? ' · фильтры действуют в таблицах ниже' : ''}`;
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

  /* ---------- Рендер: «Главное за период» ---------- */

  function trendHtml(t) {
    if (!t || !t.prev) {
      return `<span class="trend flat">🕵️ Для сравнения нет данных за ${esc(prevLabel(state.days))} — возможно, ассистент тогда ещё не работал.</span>`;
    }
    const pct = Math.round((t.cur - t.prev) / t.prev * 100);
    if (Math.abs(pct) <= 3) {
      return `<span class="trend flat">➖ Активность примерно как за ${esc(prevLabel(state.days))} (изменение всего ${Math.abs(pct)}%).</span>`;
    }
    const up = pct > 0;
    const word = up ? 'выросла' : 'снизилась';
    return `<span class="trend ${up ? 'up' : 'down'}">${up ? '📈' : '📉'} Активность ${word} на ${Math.abs(pct)}% по сравнению с ${esc(prevLabel(state.days))}: ${esc(tokens(t.prev))} → ${esc(tokens(t.cur))} токенов.</span>`;
  }

  function updateTrend() {
    const el = $('trendLine');
    if (el && state.trends[state.days]) el.innerHTML = trendHtml(state.trends[state.days]);
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
    const busiest = (d.daily || []).slice().sort((a, b) =>
      ((Number(b.input_tokens) || 0) + (Number(b.output_tokens) || 0)) -
      ((Number(a.input_tokens) || 0) + (Number(a.output_tokens) || 0)))[0];
    const billable = actual || estimated;

    const facts = [];
    if (topModel && Number(s.total_tokens) > 0) {
      const share = Math.round((Number(topModel.total_tokens) || 0) / Number(s.total_tokens) * 100);
      facts.push(['🤖', 'Основная модель', esc(topModel.model), `${share}% всех токенов · провайдер: ${esc(topModel.provider)}`]);
    }
    if (topTool) {
      facts.push(['🛠️', 'Чаще всего используется', esc(topTool.name), `${fmt.format(topTool.count || 0)} ${plural(topTool.count, ['вызов', 'вызова', 'вызовов'])}`]);
    }
    if (busiest && (Number(busiest.input_tokens) || Number(busiest.output_tokens))) {
      const dayTokens = (Number(busiest.input_tokens) || 0) + (Number(busiest.output_tokens) || 0);
      facts.push(['📅', 'Самый насыщенный день', esc(dayHuman(busiest.day)), `${tokens(dayTokens)} токенов`]);
    }
    if (billable && Number(s.sessions) > 0) {
      facts.push(['💵', 'Средняя цена разговора', esc(money(billable / Number(s.sessions))), 'по текущим тарифам моделей']);
    }

    el.innerHTML =
      `<p class="story-lead">${paragraph}</p>` +
      (facts.length
        ? `<div class="facts">${facts.map(([icon, label, value, note]) =>
            `<div class="fact"><div class="fact-icon">${icon}</div><div class="fact-label">${esc(label)}</div><div class="fact-value">${value}</div><div class="fact-note">${esc(note)}</div></div>`).join('')}</div>`
        : '') +
      `<div class="trendline" id="trendLine">${state.trends[state.days]
        ? trendHtml(state.trends[state.days])
        : '<span class="trend loading">⏳ Сравниваем с предыдущим периодом…</span>'}</div>`;
  }

  /* ---------- Рендер: ключевые цифры ---------- */

  function renderKpis() {
    const s = state.data?.summary || {};
    const words = Math.round((Number(s.total_tokens) || 0) * 0.75);
    const items = [
      { icon: '🧮', label: 'Токенов израсходовано', key: 'tokens', value: tokens(s.total_tokens),
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
    $('kpis').innerHTML = items.map((it) =>
      `<div class="kpi"><div class="kpi-top"><span class="kpi-label">${it.icon} ${esc(it.label)}</span>${hint(it.key)}</div>` +
      `<div class="kpi-value">${esc(it.value)}</div><div class="kpi-note">${esc(it.note)}</div></div>`).join('');
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
    const max = Math.max(1, ...rows.map((r) => (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0)));
    const bars = rows.map((r) => {
      const input = Number(r.input_tokens) || 0;
      const output = Number(r.output_tokens) || 0;
      const ih = input ? Math.max(3, input / max * 160) : 0;
      const oh = output ? Math.max(3, output / max * 160) : 0;
      const head = new Date(r.day + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' });
      const lines = [
        `<b>${esc(head)}</b>`,
        `прочитано ИИ: ${fullTokens(input)}`,
        `создано ИИ: ${fullTokens(output)}`,
      ];
      if (Number(r.cache_read_tokens)) lines.push(`из кэша: ${fullTokens(r.cache_read_tokens)}`);
      if (Number(r.reasoning_tokens)) lines.push(`размышления: ${fullTokens(r.reasoning_tokens)}`);
      lines.push(`обращений к ИИ: ${fmt.format(Number(r.api_calls) || 0)}`);
      if (Number(r.estimated_cost_usd)) lines.push(`стоимость (оценка): ${money(r.estimated_cost_usd)}`);
      const src = SOURCE_LABELS[r.source] || r.source;
      if (src) lines.push(`<span class="dim">данные: ${esc(src)}</span>`);
      return `<div class="bar-cell"><div class="bar-tip">${lines.join('<br>')}</div>` +
        `<div class="bar-stack"><div class="bar-in" style="height:${ih}px"></div><div class="bar-out" style="height:${oh}px"></div></div></div>`;
    }).join('');
    el.innerHTML = `<div class="bars">${bars}</div>` +
      `<div class="chart-axis"><span>${esc(rows[0].day)}</span><span>${esc(rows[Math.floor(rows.length / 2)]?.day || '')}</span><span>${esc(rows[rows.length - 1].day)}</span></div>`;
    const total = rows.reduce((acc, r) => acc + (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0), 0);
    metaEl.textContent = rows.length > 1 ? `в среднем ${tokens(total / rows.length)} токенов в день` : 'в выбранном периоде один день';
  }

  /* ---------- Рендер: живая лента ---------- */

  function renderEvents() {
    const events = state.data?.live_events || [];
    const counts = { all: events.length, api: 0, tool: 0, aux: 0 };
    events.forEach((e) => {
      if (e.kind === 'api_call') counts.api += 1;
      else if (e.kind === 'tool_event') counts.tool += 1;
      else counts.aux += 1;
    });
    const chips = [
      ['all', 'Все'], ['api', '🤖 Запросы к ИИ'], ['tool', '🛠 Инструменты'], ['aux', '🔎 Фоновые'],
    ].map(([key, label]) =>
      `<button type="button" class="chip ${state.liveFilter === key ? 'active' : ''}" data-live-filter="${key}">${label}<span class="count">${fmt.format(counts[key])}</span></button>`).join('');
    $('liveChips').innerHTML = chips;
    $('eventMeta').textContent = 'обновляется сама';

    const filtered = events.filter((e) =>
      state.liveFilter === 'all' ||
      (state.liveFilter === 'api' && e.kind === 'api_call') ||
      (state.liveFilter === 'tool' && e.kind === 'tool_event') ||
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
      return `<div class="event"><div class="event-time">${esc(timeFmt((e.timestamp || 0) * 1000))}</div>` +
        `<div class="event-main"><div class="event-title">${icon} ${esc(title)}</div><div class="event-sub">${esc(sub)}</div></div>` +
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
        return `<tr>` +
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
        return `<tr><td class="mono">${esc(r.name)}</td>` +
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
      `<th class="right">${sortButton('Последняя активность', 'last_activity_at', 'session')}</th>` +
      `</tr></thead><tbody>` +
      rows.map((r) => {
        const tok = (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0) +
          (Number(r.cache_read_tokens) || 0) + (Number(r.cache_write_tokens) || 0);
        return `<tr class="clickable ${r.id === state.sessionId ? 'selected' : ''}" data-session="${esc(r.id)}">` +
          `<td><div class="truncate" title="${esc(r.display_label)}">${esc(r.display_label)}</div>` +
          `<div class="event-sub mono">${esc(r.id)}${r.parent_session_id ? ' · подзадача' : ''}</div></td>` +
          `<td class="mono truncate">${esc(r.model || '—')}</td>` +
          `<td class="muted">${esc(r.billing_provider || '—')}</td>` +
          `<td class="right number">${esc(tokens(tok))}</td>` +
          `<td class="right number">${esc(fmt.format(r.tool_call_count || 0))}</td>` +
          `<td class="right muted">${esc(dateFmt(r.last_activity_at_iso))}</td></tr>`;
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
    const lines = g.edges.map((e) => {
      const a = pos[e.source];
      const b = pos[e.target];
      return a && b ? `<line class="graph-edge" x1="${a.x + 54}" y1="${a.y + 17}" x2="${b.x - 8}" y2="${b.y + 17}"/>` : '';
    }).join('');
    const nodes = g.nodes.map((n) => {
      const p = pos[n.id];
      const raw = String(n.label || '');
      const label = raw.length > 24 ? raw.slice(0, 23) + '…' : raw;
      return `<g class="graph-node ${esc(n.kind)} ${n.id === state.nodeId ? 'selected' : ''}" data-node="${esc(n.id)}" transform="translate(${p.x},${p.y})">` +
        `<title>${esc(raw)}</title>` +
        `<rect width="116" height="36"></rect>` +
        `<text x="8" y="15">${esc(label)}</text>` +
        `<text x="8" y="29" class="tiny">${esc(nodeDetail(n))}</text></g>`;
    }).join('');
    svg.innerHTML = `<rect width="${graphWidth}" height="510" fill="#0b1017"></rect>${lines}${nodes}`;
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
        `<div class="inspector-help">Слева — «карта» одного разговора: что вы просили, какие инструменты вызывал ассистент, какими были его обращения к ИИ.<br><br>` +
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
    $('inspector').innerHTML = `<h3>${esc(node.label)}</h3><dl class="kv">${rows.join('')}</dl>${content}`;
  }

  async function loadGraph(id) {
    state.sessionId = id;
    state.nodeId = null;
    renderSessions();
    $('graphMeta').textContent = 'загружаем карту…';
    try {
      state.graph = await getJSON('/api/graph?session_id=' + encodeURIComponent(id));
    } catch (e) {
      state.graph = { error: e.message, nodes: [] };
    }
    renderGraph();
    $('graphPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  function renderAll() {
    renderFilters();
    renderNotice();
    renderStory();
    renderKpis();
    renderDaily();
    renderEvents();
    renderModels();
    renderTasks();
    renderTools();
    renderSessions();
    renderGraph();
    renderQuality();
    const src = state.data?.source;
    $('sourceMeta').textContent = src?.db
      ? `данные: ${src.db} · журнал: agent.log · только чтение`
      : 'источник не прочитан';
  }

  async function ensureTrend() {
    const days = state.days;
    if (state.trends[days]) { updateTrend(); return; }
    if (state.trendPending[days]) return;
    state.trendPending[days] = true;
    try {
      const wide = await getJSON('/api/snapshot?days=' + days * 2);
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
        state.trends[days] = t;
        updateTrend();
      }
    } catch {
      const el = $('trendLine');
      if (el) el.innerHTML = '<span class="trend flat">Сравнение с предыдущим периодом сейчас недоступно.</span>';
    } finally {
      delete state.trendPending[days];
    }
  }

  async function loadSnapshot(force = false) {
    try {
      const data = await getJSON('/api/snapshot?days=' + state.days + (force ? '&t=' + Date.now() : ''));
      const newHash = data?.signature?.hash;
      if (newHash && newHash !== state.lastSignature) state.trends = {};
      state.lastSignature = newHash;
      state.data = data;
      renderAll();
      setStatus('', 'обновляется автоматически');
      ensureTrend();
      if (state.sessionId) await loadGraph(state.sessionId);
    } catch (e) {
      setStatus('err', 'нет связи с сервером');
      $('notice').innerHTML = errorBox('Не получилось получить данные', e.message,
        'Проверьте, что панель всё ещё запущена: <code>python server.py</code>, и попробуйте кнопку «Обновить».');
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
    { sel: '#dailyPanel', title: 'Активность по дням',
      text: 'Каждый столбик — один день: синее — сколько ИИ прочитал, голубое — сколько написал. Наведите курсор на столбик, чтобы увидеть точные цифры, включая стоимость дня.' },
    { sel: '#livePanel', title: 'Живая лента',
      text: 'Здесь мелькают последние события из журнала ассистента: обращения к ИИ, вызовы инструментов, фоновые проверки. Кнопками сверху можно оставить только интересующий тип событий.' },
    { sel: '#tablesRow', title: 'Подробности',
      text: 'Три таблицы: какие модели ИИ работали, на какие внутренние задачи ушли усилия и какими инструментами ассистент пользовался. Полоски показывают долю каждого. Нажмите на столбец — сортировка.' },
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
    showTourStep();
  }

  function endTour() {
    tourIndex = -1;
    tourTarget = null;
    $('tourOverlay').hidden = true;
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

  document.addEventListener('click', (event) => {
    if (event.target.closest('.hint')) return; // подсказки обрабатывает свой движок
    const target = event.target.closest('[data-days],[data-sort],[data-session],[data-node],[data-live-filter]');
    if (!target) return;
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
    if (target.dataset.session) { loadGraph(target.dataset.session); return; }
    if (target.dataset.node) { state.nodeId = target.dataset.node; renderGraph(); return; }
    if (target.dataset.liveFilter !== undefined) { state.liveFilter = target.dataset.liveFilter; renderEvents(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideHint();
      if (tourIndex >= 0) endTour();
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
      renderFilters();
      renderModels();
      renderTasks();
    });
    ['providerFilter', 'modelFilter', 'taskFilter'].forEach((id) => {
      $(id).addEventListener('change', (e) => {
        state.filters[id.replace('Filter', '')] = e.target.value;
        renderFilters();
        renderModels();
        renderTasks();
      });
    });

    renderGlossary();
    loadSnapshot(true);
    setInterval(heartbeat, 2000);
  }

  init();
})();
