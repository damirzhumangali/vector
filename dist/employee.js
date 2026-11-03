(function () {
  'use strict';
  window.VektorViews = window.VektorViews || {};

  var statusNames = {
    assigned: 'Назначена', accepted: 'Принята', travel: 'В пути', arrived: 'На объекте',
    work: 'В работе', review: 'На проверке', done: 'Принята', paused: 'Приостановлена'
  };
  var checkLabels = [
    'Подтвердить доступ и безопасность рабочего места',
    'Осмотреть оборудование и зафиксировать дефекты',
    'Выполнить работы по заданию',
    'Проверить результат и работоспособность',
    'Убрать рабочее место и сообщить ответственному'
  ];
  var checkDetails = [
    'Средства защиты надеты. Доступ к оборудованию согласован.',
    'Добавьте фото «до» и отметьте обнаруженные проблемы.',
    'Выполните все операции, указанные в карточке задания.',
    'Убедитесь, что оборудование работает в штатном режиме.',
    'Оставьте объект в безопасном состоянии.'
  ];

  function task(s) {
    return (s.tasks || []).find(function (t) { return t.id === s.selectedTask; }) ||
      (s.tasks || [])[0] || {
        id: '1042', title: 'Обслуживание вентиляции', object: 'БЦ «Астана Тауэр»',
        address: 'Астана, проспект Кабанбай батыра, 17', status: 'work', due: '12:00', priority: 'normal'
      };
  }
  function esc(h, v) { return h.esc(String(v == null ? '' : v)); }
  function count(s) { return (s.checks || []).filter(Boolean).length; }
  function photoCount(s, key) { return Number((s.photos || {})[key] || 0); }
  function heading(h, eyebrow, title, subtitle, actions) {
    return '<div class="page-heading"><div><div class="eyebrow">' + eyebrow + '</div><h1>' +
      title + '</h1>' + (subtitle ? '<p class="muted">' + subtitle + '</p>' : '') +
      '</div>' + (actions ? '<div class="page-actions">' + actions + '</div>' : '') + '</div>';
  }
  function stat(h, value, label, foot, icon) {
    return '<div class="stat-card"><div class="row between"><span class="stat-label">' + label +
      '</span><span class="muted">' + h.icon(icon || 'briefcase', 18) + '</span></div><div class="stat-value">' +
      value + '</div><div class="stat-foot">' + foot + '</div></div>';
  }
  function noResults(h, text) {
    return '<div class="card empty-state">' + h.icon('check-circle', 32) + '<h3>' + text +
      '</h3><p class="muted">Здесь появятся задания, подходящие под выбранный фильтр.</p></div>';
  }
  function fact(h, label, value, icon) {
    return '<div class="fact"><span class="muted">' + h.icon(icon || 'clock', 17) + ' ' + label +
      '</span><strong>' + value + '</strong></div>';
  }
  function taskAction(s, h, t) {
    if (s.role === 'manager' || s.role === 'dispatcher') {
      if (t.status === 'review') return h.nav('Проверить отчёт', 'inspection', 'primary', 'check-circle');
      return h.btn(t.status === 'assigned' ? 'Назначить исполнителя' : 'Передать задачу',
        t.status === 'assigned' ? 'open-assignment' : 'open-handover', 'primary', 'user');
    }
    var next = {
      assigned: h.btn('Принять задачу', 'accept-task', 'primary', 'check'),
      accepted: h.btn('Выехать на объект', 'start-travel', 'primary', 'navigation'),
      travel: h.nav('Подтвердить прибытие', 'route', 'primary', 'map-pin'),
      arrived: h.btn('Начать работу', 'start-work', 'primary', 'play'),
      work: h.nav('Продолжить чек-лист', 'checklist', 'primary', 'arrow-right'),
      review: h.nav('Посмотреть отчёт', 'report', 'primary', 'file-text'),
      done: h.nav('Посмотреть отчёт', 'report', 'secondary', 'file-text'),
      paused: h.btn('Управление паузой', 'open-pause', 'primary', 'play')
    };
    return next[t.status] || next.assigned;
  }
  function statusBadge(h, t) {
    if (t.tag === 'Требует доработки' || t.status === 'rework') return h.badge('Требует доработки', 'red');
    var tone = t.status === 'done' ? 'green' : (t.status === 'paused' ? 'amber' : 'blue');
    return h.badge(statusNames[t.status] || 'Назначена', tone);
  }
  function photoTile(h, kind, i) {
    return '<button class="photo-card" data-action="open-photo" data-photo-kind="' + kind + '" aria-label="Открыть ' +
      (kind === 'before' ? 'фото до' : 'фото после') + '"><div class="photo-image">' + h.photo(kind) +
      '<span class="photo-demo-label">Демо-снимок</span></div><div class="photo-card-caption"><strong>' +
      (kind === 'before' ? 'До начала работ' : 'После выполнения') + '</strong><span class="muted">' +
      (kind === 'before' ? '10:21' : '11:07') + ' · Снимок ' + (i + 1) + '</span></div></button>';
  }

  Object.assign(window.VektorViews, {
    tasks: function (s, h) {
      var all = s.tasks || [];
      var active = all.find(function (t) { return ['work', 'travel', 'arrived', 'accepted'].indexOf(t.status) !== -1; });
      var firstName = (s.profileName || 'Арман Садыков').trim().split(/\s+/)[0] || 'Арман';
      var filters = [['all', 'Все задачи'], ['active', 'Активные'], ['planned', 'Предстоящие'], ['done', 'Завершённые']];
      var selected = s.filter || 'all';
      var visible = all.filter(function (t) {
        if (selected === 'active') return ['accepted', 'travel', 'arrived', 'work', 'paused'].indexOf(t.status) !== -1;
        if (selected === 'planned') return t.status === 'assigned';
        if (selected === 'done') return ['review', 'done'].indexOf(t.status) !== -1;
        return true;
      });
      var greeting = '<section class="employee-greeting card"><div><span class="eyebrow">ВАША СМЕНА · 09:00–18:00</span>' +
        '<h2>Хорошего дня, ' + esc(h, firstName) + ' <span class="greeting-dot">●</span></h2><p class="muted">Всё, что нужно для работы сегодня, — под рукой.</p></div>' +
        '<div class="row gap-8">' + h.badge(s.shiftPaused ? 'Смена приостановлена' : (s.shiftActive ? 'На смене' : 'Смена не начата'), s.shiftPaused ? 'amber' : 'green') +
        h.nav('Моя смена', 'shift', 'ghost', 'arrow-right') + '</div></section>';
      var activeHtml = active ? '<section class="active-task-card"><div class="row between"><span class="eyebrow">' +
        ({work:'СЕЙЧАС В РАБОТЕ',travel:'В ПУТИ НА ОБЪЕКТ',arrived:'ВЫ НА ОБЪЕКТЕ',accepted:'БЛИЖАЙШАЯ ЗАДАЧА'}[active.status] || 'ТЕКУЩАЯ ЗАДАЧА') + '</span>' +
        statusBadge(h, active) + '</div><div class="active-task-id">Заявка №' + esc(h, active.id) + '</div><h2>' +
        esc(h, active.title) + '</h2><p>' + h.icon('map-pin', 17) + ' ' + esc(h, active.object) + '</p>' +
        '<div class="row between"><span class="muted">' + h.icon('clock', 16) + ' Завершить до ' +
        esc(h, active.due || '12:00') + '</span><button class="btn btn-primary" data-task="' + esc(h, active.id) +
        '">Открыть задачу ' + h.icon('arrow-right', 18) + '</button></div></section>' : '';
      var online = s.offline
        ? '<div class="info-box amber">' + h.icon('wifi-off', 20) + '<div><strong>Работа без сети</strong><p>Задания доступны. Ваши действия сохраняются на устройстве.</p></div>' + h.nav('Подробнее', 'sync', 'ghost') + '</div>'
        : '';
      return heading(h, 'ВТОРНИК, 3 НОЯБРЯ', 'Мои задачи', 'Ваш рабочий день в одном месте', h.nav('Расписание', 'calendar', 'secondary', 'calendar')) +
        online + greeting +
        '<div class="grid-3">' + stat(h, all.length, 'Задач на сегодня', 'Включая завершённые', 'briefcase') +
        stat(h, all.filter(function (t) { return ['done', 'review'].indexOf(t.status) !== -1; }).length, 'Завершено', 'Результат передан на проверку', 'check-circle') +
        stat(h, '98%', 'Выполнено в срок', 'За последние 30 дней', 'clock') + '</div>' +
        '<div class="grid-2 employee-dashboard"><div class="stack">' + activeHtml +
        '<div class="row between"><h2 class="section-title">Задания на день</h2><span class="muted">' + all.length + ' задач</span></div>' +
        '<div class="tabs" aria-label="Фильтр задач">' + filters.map(function (f) {
          return '<button class="tab ' + (selected === f[0] ? 'active' : '') + '" data-filter="' + f[0] + '">' + f[1] + '</button>';
        }).join('') + '</div><div class="task-grid">' +
        (visible.length ? visible.map(function (t) { return h.taskCard(t); }).join('') : noResults(h, 'Здесь пока спокойно')) +
        '</div></div><aside class="stack"><section class="card"><div class="card-header"><h3>Объекты на сегодня</h3>' +
        h.nav('Маршрут', 'route', 'ghost', 'arrow-right') + '</div>' + h.map(true) +
        '<div class="card-body"><div class="row gap-12">' + h.icon('navigation', 20) + '<div><strong>Всё по пути</strong>' +
        '<p class="muted">3 объекта · Астана, левый берег</p></div></div></div></section>' +
        '<section class="card card-body"><span class="eyebrow">ПОДГОТОВКА К ВЫЕЗДУ</span><h3>Работайте даже без сети</h3>' +
        '<p class="muted">Сохраните задания, чек-листы и инструкции перед выездом.</p>' +
        h.btn(s.prepared ? 'Задания сохранены' : 'Скачать задания на день', 'prepare-offline', 'secondary', 'download') +
        '<div class="divider"></div><div class="row between"><span class="muted">Последняя синхронизация</span><strong>' +
        (s.offline ? '09:48' : 'Только что') + '</strong></div></section></aside></div>';
    },

    task: function (s, h) {
      var t = task(s);
      var steps = ['Принята', 'В пути', 'На объекте', 'В работе', 'Выполнена', 'Принята'];
      var stepIndex = { assigned: -1, accepted: 0, travel: 1, arrived: 2, work: 3, paused: 3, review: 4, done: 5 }[t.status];
      var history = s.taskTab === 'history';
      var backPage = s.role === 'dispatcher' ? 'orders' : (s.role === 'manager' ? 'review' : 'tasks');
      var backLabel = s.role === 'dispatcher' ? 'Все заявки' : (s.role === 'manager' ? 'Приёмка работ' : 'Мои задачи');
      return '<div class="row gap-8">' + h.nav(backLabel, backPage, 'ghost', 'arrow-left') + '</div>' +
        heading(h, 'ЗАЯВКА №' + esc(h, t.id) + ' · ВЫЕЗД 1', esc(h, t.title), esc(h, t.object),
          ((s.role === 'manager' || s.role === 'dispatcher')
            ? h.btn('Управление назначением', 'open-assignment', 'secondary', 'user')
            : h.btn('Сообщить о задержке', 'open-late', 'secondary', 'clock'))) +
        '<div class="row gap-8">' + statusBadge(h, t) + h.badge(t.priority === 'urgent' ? 'Срочная' : (t.priority === 'high' ? 'Высокий приоритет' : 'Плановая работа'), t.priority === 'urgent' ? 'red' : 'neutral') +
        (s.offline ? h.badge('Ожидает синхронизации', 'amber') : h.badge('Данные актуальны', 'green')) + '</div>' +
        '<div class="card workflow-steps">' + steps.map(function (name, i) {
          return '<div class="workflow-step ' + (i < stepIndex ? 'done' : '') + ' ' + (i === stepIndex ? 'current' : '') +
            '"><span class="workflow-index">' + (i < stepIndex ? h.icon('check', 14) : (i + 1)) + '</span><span>' + name + '</span></div>';
        }).join('') + '</div>' +
        '<div class="tabs"><button class="tab ' + (!history ? 'active' : '') + '" data-task-tab="details">Задание</button>' +
        '<button class="tab ' + (history ? 'active' : '') + '" data-task-tab="history">История выезда</button></div>' +
        (history ? '<section class="card card-body"><h2 class="section-title">Все действия сохранены</h2><div class="timeline">' +
          [['09:00', 'Задание создано', 'Диспетчер Алия Нурланова · назначен ' + esc(h, t.employee || 'Арман Садыков')],
           ['09:32', 'Задание принято', 'Сотрудник подтвердил назначение'],
           ['09:45', 'Выезд на объект', 'Начало поездки · геопозиция записана'],
           ['10:18', 'Прибытие на объект', 'В пределах зоны · точность 12 м'],
           ['10:21', 'Работа начата', 'Фото «до» добавлено · чек-лист открыт']].map(function (event) {
             return '<div class="timeline-item"><span class="timeline-dot"></span><span class="muted">' + event[0] +
               '</span><div><strong>' + event[1] + '</strong><p class="muted">' + event[2] + '</p></div></div>';
           }).join('') + '</div><div class="info-box"><p>Время действия и время получения сохраняются отдельно. Здесь показан пример истории выезда.</p></div></section>'
          :
          '<div class="grid-2"><div class="stack"><section class="card card-body"><div class="row between"><h2 class="section-title">Что нужно сделать</h2>' +
          h.icon('file-text', 20) + '</div><p>' + esc(h, t.description || 'Выполнить работы по заявке. Осмотреть объект, зафиксировать исходное состояние и выполнить необходимые операции. Проверить результат и подготовить фотоотчёт.') + '</p>' +
          '<div class="info-box"><div><strong>Перед началом</strong><p>Согласуйте доступ с ответственным на объекте. Используйте средства индивидуальной защиты.</p></div></div>' +
          '<div class="facts-grid">' + fact(h, 'Плановое время', esc(h, t.time || '10:00–12:00'), 'calendar') +
          fact(h, 'Срок выполнения', 'До ' + esc(h, t.due || '12:00'), 'clock') +
          fact(h, 'Оценка длительности', esc(h, t.estimate || '1 ч 30 мин'), 'briefcase') +
          fact(h, 'Исполнитель', esc(h, t.employee || 'Арман Садыков'), 'user') + '</div></section>' +
          '<section class="card"><div class="card-header"><h3>Готовность отчёта</h3><span class="muted">' +
          Math.round(((count(s) / 5) + Math.min(photoCount(s, 'before'), 1) + Math.min(photoCount(s, 'after'), 1)) / 3 * 100) + '%</span></div>' +
          '<div class="card-body stack"><button class="list-row" data-page="checklist"><span class="row gap-12">' + h.icon('check-square', 22) +
          '<span><strong>Чек-лист работ</strong><span class="muted">' + count(s) + ' из 5 пунктов</span></span></span>' + h.icon('chevron-right', 18) + '</button>' +
          '<button class="list-row" data-page="photos"><span class="row gap-12">' + h.icon('camera', 22) +
          '<span><strong>Фото до и после</strong><span class="muted">' + photoCount(s, 'before') + ' до · ' + photoCount(s, 'after') + ' после</span></span></span>' +
          h.icon('chevron-right', 18) + '</button><button class="list-row" data-page="report"><span class="row gap-12">' +
          h.icon('file-text', 22) + '<span><strong>Результат выезда</strong><span class="muted">Проверить и передать руководителю</span></span></span>' +
          h.icon('chevron-right', 18) + '</button></div></section></div>' +
          '<aside class="stack"><section class="card"><div class="card-header"><h3>Место работы</h3>' + h.icon('map-pin', 20) +
          '</div>' + h.map(true) + '<div class="card-body"><h3>' + esc(h, t.object) + '</h3><p class="muted">' +
          esc(h, t.address || 'Астана, проспект Кабанбай батыра, 17') + '</p><p>Служебный вход со стороны парковки. Пост охраны № 2.</p>' +
          h.nav('Открыть маршрут', 'route', 'secondary', 'navigation') + '</div></section><section class="card card-body">' +
          '<div class="row gap-12"><div class="avatar">МК</div><div><strong>Марат Касенов</strong><p class="muted">Ответственный на объекте</p></div></div>' +
          '<button class="btn btn-secondary" data-modal="contact">' + h.icon('phone', 18) + ' Контакты объекта</button></section>' +
          '<section class="card card-body"><h3>' + ((s.role === 'manager' || s.role === 'dispatcher') ? 'Управление работой' : 'Нужна помощь?') +
          '</h3><p class="muted">' + ((s.role === 'manager' || s.role === 'dispatcher') ? 'Назначение и передача сохраняются в истории заявки.' : 'Сообщите диспетчеру, если работу невозможно продолжить.') + '</p>' +
          ((s.role === 'manager' || s.role === 'dispatcher')
            ? h.btn('Назначить исполнителя', 'open-assignment', 'ghost', 'user')
            : h.btn('Приостановить работу', 'open-pause', 'ghost', 'pause')) + h.btn('Передать задачу', 'open-handover', 'ghost', 'user') +
          '</section></aside></div>') +
        '<div class="sticky-actions"><div><strong>Заявка №' + esc(h, t.id) + '</strong><span class="muted">Следующий шаг</span></div><div class="row gap-8">' +
        h.nav('Фотоотчёт', 'photos', 'secondary', 'camera') + taskAction(s, h, t) + '</div></div>';
    },

    checklist: function (s, h) {
      var t = task(s), done = count(s);
      return h.nav('К заданию', 'task', 'ghost', 'arrow-left') +
        heading(h, 'ЗАЯВКА №' + esc(h, t.id), 'Чек-лист работ', esc(h, t.object), h.nav('Фотоотчёт', 'photos', 'secondary', 'camera')) +
        '<section class="card card-body"><div class="row between"><div><strong>' + done +
        ' из 5 пунктов выполнено</strong><p class="muted">Отмечайте пункты по мере выполнения</p></div>' + h.badge(Math.round(done / 5 * 100) + '%', 'green') +
        '</div>' + h.progress(done / 5 * 100) + '</section>' +
        '<div class="grid-2"><section class="card"><div class="card-body stack">' + checkLabels.map(function (label, i) {
          return '<label class="check-row ' + ((s.checks || [])[i] ? 'completed' : '') + '"><input type="checkbox" data-check="' + i +
            '" ' + ((s.checks || [])[i] ? 'checked' : '') + '><span><strong>' + label + '</strong><span class="muted">' + checkDetails[i] +
            '</span></span><span class="checklist-number">0' + (i + 1) + '</span></label>';
        }).join('') + '</div></section><aside class="stack"><section class="card card-body"><h3>Комментарий к работе</h3><label class="field">' +
        '<span class="field-label">Что важно знать руководителю</span><textarea class="textarea" id="checklist-comment" data-draft="checklistComment" rows="5" placeholder="Например: заменено уплотнение, оборудование проверено…">' +
        esc(h, s.checklistComment || '') + '</textarea></label><span class="muted">Комментарий попадёт в итоговый отчёт.</span></section>' +
        '<section class="info-box amber"><div>' + h.icon('alert-triangle', 22) + '<h3>Обнаружили проблему?</h3><p>Зафиксируйте препятствие. Задание останется в истории, диспетчер поможет с решением.</p>' +
        '<button class="btn btn-secondary" data-modal="problem">Сообщить о проблеме</button></div></section></aside></div>' +
        '<div class="sticky-actions"><div><strong>' + done + '/5 выполнено</strong><span class="muted">Прогресс сохраняется автоматически</span></div>' +
        h.nav(done === 5 ? 'Перейти к фото «после»' : 'К фотоотчёту', 'photos', 'primary', 'arrow-right').replace('data-page="photos"', 'data-page="photos" data-photo-destination="' + (done === 5 ? 'after' : 'before') + '"') + '</div>';
    },

    photos: function (s, h) {
      var t = task(s), kind = s.photoTab === 'after' ? 'after' : 'before', n = photoCount(s, kind);
      return h.nav('К заданию', 'task', 'ghost', 'arrow-left') +
        heading(h, 'ФОТООТЧЁТ · ЗАЯВКА №' + esc(h, t.id), 'Результат в деталях', 'Снимки до и после помогают подтвердить выполненную работу',
          h.nav('Итоговый отчёт', 'report', 'secondary', 'file-text')) +
        '<div class="tabs"><button class="tab ' + (kind === 'before' ? 'active' : '') + '" data-photo-tab="before">До работы <span>' +
        photoCount(s, 'before') + '</span></button><button class="tab ' + (kind === 'after' ? 'active' : '') +
        '" data-photo-tab="after">После работы <span>' + photoCount(s, 'after') + '</span></button></div>' +
        '<div class="grid-2"><div class="stack"><section class="card card-body"><div class="row between"><h2 class="section-title">' +
        (kind === 'before' ? 'Исходное состояние' : 'Выполненная работа') + '</h2>' +
        h.badge(n > 0 ? 'Обязательное фото добавлено' : 'Нужно минимум 1 фото', n > 0 ? 'green' : 'amber') + '</div><p class="muted">' +
        (kind === 'before' ? 'Снимите оборудование целиком и крупно — участок, с которым будете работать.' : 'Повторите ракурс фото «до». На снимке должен быть хорошо виден результат.') +
        '</p><div class="photo-grid">' + Array.from({ length: n }, function (_, i) { return photoTile(h, kind, i); }).join('') +
        '<button class="photo-placeholder" data-action="capture-' + kind + '">' + h.icon('camera', 32) +
        '<strong>Сделать фото</strong><span>Добавить новый снимок</span></button></div><div class="divider"></div>' +
        '<div class="row gap-8 muted">' + h.icon('shield', 17) + '<span>Дата, автор и место будут связаны с выездом</span></div></section>' +
        '<div class="info-box"><div><strong>Интерактивный макет</strong><p>Кнопка «Сделать фото» добавляет демонстрационный снимок. Камера устройства не включается.</p></div></div></div>' +
        '<aside class="stack"><section class="card card-body"><span class="eyebrow">ХОРОШИЙ ФОТООТЧЁТ</span><h3>Покажите самое важное</h3>' +
        '<div class="list-row"><span class="row gap-8">' + h.icon('check', 18) + ' Объект полностью в кадре</span></div>' +
        '<div class="list-row"><span class="row gap-8">' + h.icon('check', 18) + ' Достаточно света и резкости</span></div>' +
        '<div class="list-row"><span class="row gap-8">' + h.icon('check', 18) + ' Один ракурс для «до» и «после»</span></div>' +
        '<div class="list-row"><span class="row gap-8">' + h.icon('check', 18) + ' Результат работы хорошо виден</span></div></section>' +
        '<section class="card card-body"><h3>Информация о съёмке</h3><div class="facts-grid">' +
        fact(h, 'Сотрудник', esc(h, t.employee || 'Арман Садыков'), 'user') + fact(h, 'Объект', esc(h, t.object), 'map-pin') +
        fact(h, 'Передача', s.offline ? 'После восстановления связи' : 'При добавлении снимка', 'upload') +
        '</div></section></aside></div>' +
        '<div class="sticky-actions"><div><strong>' + (photoCount(s, 'before') + photoCount(s, 'after')) +
        ' снимков в отчёте</strong><span class="muted">' + (s.offline ? 'Сохранены на устройстве' : 'Демонстрационный фотоотчёт') +
        '</span></div>' + h.nav('Проверить и завершить', 'report', 'primary', 'arrow-right') + '</div>';
    },

    report: function (s, h) {
      var t = task(s), checks = count(s), before = photoCount(s, 'before'), after = photoCount(s, 'after');
      var ready = checks === 5 && before > 0 && after > 0;
      var submitted = t.status === 'review' || t.status === 'done';
      var readOnly = s.role === 'manager' || s.role === 'dispatcher' || ['review', 'done'].indexOf(t.status) !== -1;
      var rework = t.tag === 'Требует доработки' || t.status === 'rework';
      var requirements = [
        ['Чек-лист заполнен', checks + ' из 5 пунктов', checks === 5, 'checklist'],
        ['Фото до работы', before + ' снимков', before > 0, 'photos'],
        ['Фото после работы', after + ' снимков', after > 0, 'photos']
      ];
      return h.nav('К заданию', 'task', 'ghost', 'arrow-left') +
        heading(h, 'ЗАЯВКА №' + esc(h, t.id) + ' · ВЫЕЗД 1', (submitted || readOnly || rework) ? 'Отчёт по выезду' : 'Проверка перед сдачей',
          (submitted || readOnly || rework) ? 'Результат работы и все материалы выезда' : 'Убедитесь, что всё готово к проверке руководителем') +
        (rework ? '<div class="info-box red">' + h.icon('alert-triangle', 23) + '<div><strong>Требует доработки</strong><p>' +
          esc(h, t.reworkReason || 'Руководитель вернул результат на доработку. Согласуйте дальнейшие действия по заявке.') + '</p></div></div>' : '') +
        (submitted ? '<div class="info-box green">' + h.icon('check-circle', 24) + '<div><strong>' +
          (t.status === 'done' ? 'Результат принят' : 'Работа завершена') + '</strong><p>' +
          (s.offline ? 'Отчёт сохранён на устройстве и будет отправлен после восстановления связи.' :
          (t.status === 'done' ? 'Руководитель подтвердил результат выезда.' : 'Отчёт ожидает проверки руководителем. Можно переходить к следующему заданию.')) +
          '</p></div></div>' : '') +
        '<div class="grid-2"><div class="stack"><section class="card card-body report-summary"><span class="eyebrow">РЕЗУЛЬТАТ ВЫЕЗДА</span><h2>' +
        esc(h, t.title) + '</h2><p class="muted">' + esc(h, t.object) + '</p><div class="facts-grid">' +
        fact(h, 'Прибытие', '10:18', 'map-pin') + fact(h, 'Начало работы', '10:21', 'play') +
        fact(h, 'Исполнитель', esc(h, t.employee || 'Арман Садыков'), 'user') + fact(h, 'Срок', 'До ' + esc(h, t.due || '12:00'), 'clock') +
        '</div><div class="divider"></div><label class="field"><span class="field-label">Итог работы</span><textarea class="textarea" data-draft="reportComment" rows="4" ' + (readOnly ? 'readonly ' : '') + 'placeholder="Кратко опишите, что выполнено">' +
        esc(h, s.reportComment || 'Обслуживание выполнено. Оборудование проверено, замечаний к работе нет.') +
        '</textarea></label></section><section class="card card-body"><h3>Фото до и после</h3><div class="photo-grid">' +
        (before > 0 ? photoTile(h, 'before', 0) : (readOnly ? '<div class="photo-placeholder">' + h.icon('camera', 26) + '<strong>Фото «до» не добавлено</strong></div>' : '<button class="photo-placeholder" data-page="photos">' + h.icon('camera', 26) + '<strong>Добавить фото «до»</strong></button>')) +
        (after > 0 ? photoTile(h, 'after', 0) : (readOnly ? '<div class="photo-placeholder">' + h.icon('camera', 26) + '<strong>Фото «после» не добавлено</strong></div>' : '<button class="photo-placeholder" data-page="photos">' + h.icon('camera', 26) + '<strong>Добавить фото «после»</strong></button>')) +
        '</div></section></div><aside class="stack"><section class="card card-body"><h3>Готовность к отправке</h3>' +
        requirements.map(function (r) {
          return '<button class="list-row" data-page="' + r[3] + '"><span class="row gap-12">' +
            h.icon(r[2] ? 'check-circle' : 'alert-triangle', 22) + '<span><strong>' + r[0] +
            '</strong><span class="muted">' + r[1] + '</span></span></span>' + h.badge(r[2] ? 'Готово' : 'Нужно добавить', r[2] ? 'green' : 'amber') + '</button>';
        }).join('') + '<div class="divider"></div><p class="muted">' + (ready ? 'Все обязательные материалы собраны.' : 'Завершите обязательные пункты, чтобы передать работу на проверку.') +
        '</p></section><div class="info-box"><div><strong>Время работы сохранится</strong><p>' +
        (s.offline ? 'Система запишет время завершения сейчас. Доставка отчёта произойдёт после восстановления связи.' :
        'Время завершения работы и время приёмки руководителем учитываются отдельно.') +
        '</p></div></div></aside></div><div class="sticky-actions"><div><strong>' +
        (readOnly ? 'Материалы выезда' : (submitted ? 'Результат сохранён' : (ready ? 'Всё готово к сдаче' : 'Есть незаполненные пункты'))) +
        '</strong><span class="muted">' + ((submitted || readOnly) ? 'История выезда доступна в карточке' : 'Передайте результат руководителю') +
        '</span></div>' + (readOnly ? h.nav(t.status === 'review' ? 'Проверить результат' : 'К заявке', t.status === 'review' ? 'inspection' : 'task', 'primary', 'arrow-right') :
        (submitted ? h.nav('К моим задачам', 'tasks', 'primary', 'arrow-right') :
        '<button class="btn btn-primary" data-action="finish-task" ' + (ready ? '' : 'disabled') + '>' + h.icon('check', 18) +
        (s.offline ? 'Завершить и сохранить' : 'Завершить работу') + '</button>')) + '</div>';
    },

    route: function (s, h) {
      var t = task(s);
      return heading(h, 'МАРШРУТ И ПРИБЫТИЕ', 'На объект без лишних звонков', esc(h, t.object), h.nav('К заданию', 'task', 'secondary', 'arrow-left')) +
        '<div class="grid-2"><section class="card route-map-card">' + h.map(false) +
        '<div class="card-body"><div class="row between"><div><span class="eyebrow">ТОЧКА ПРИБЫТИЯ</span><h3>' +
        esc(h, t.object) + '</h3><p class="muted">' + esc(h, t.address || 'Астана, проспект Кабанбай батыра, 17') +
        '</p></div>' + h.badge('Радиус 100 м', 'green') + '</div></div></section><aside class="stack"><section class="card card-body">' +
        '<div class="row gap-12"><span class="sync-symbol">' + h.icon('navigation', 26) + '</span><div><span class="eyebrow">В ПРЕДЕЛАХ ОБЪЕКТА</span>' +
        '<h2>52 м до входа</h2></div></div><p class="muted">Служебный вход со стороны парковки. На охране назовите номер заявки.</p>' +
        '<div class="facts-grid">' + fact(h, 'Точность', '12 м', 'map-pin') + fact(h, 'Координаты', '51.1173, 71.4222', 'navigation') +
        '</div><div class="divider"></div>' +
        (t.status === 'travel' ? h.btn('Я на месте', 'arrive', 'primary', 'map-pin') : h.nav('Вернуться к заданию', 'task', 'secondary', 'arrow-left')) +
        '<p class="muted compact">Демонстрационная геопозиция. Ваше реальное местоположение не запрашивается.</p></section>' +
        '<section class="card card-body"><h3>Не удаётся отметиться?</h3><p class="muted">В помещении координаты могут быть недоступны. Укажите причину для проверки руководителем.</p>' +
        '<button class="btn btn-secondary" data-modal="manual-arrival">Отметиться с причиной</button></section>' +
        '<section class="card card-body"><div class="row between"><div><strong>Нужно больше времени?</strong><p class="muted">Предупредите диспетчера о задержке</p></div>' +
        h.btn('Опаздываю', 'open-late', 'ghost', 'clock') + '</div></section></aside></div>';
    },

    calendar: function (s, h) {
      var day = Number(s.calendarDay || 3);
      var days = [[2, 'ПН'], [3, 'ВТ'], [4, 'СР'], [5, 'ЧТ'], [6, 'ПТ'], [7, 'СБ'], [8, 'ВС']];
      var all = s.tasks || [];
      var list = day === 3 ? all : (day < 7 ? all.slice(0, 2) : []);
      return heading(h, 'ПЛАНИРОВАНИЕ ДНЯ', 'Моё расписание', 'Ноябрь 2026 · 2–8 ноября', h.nav('Список задач', 'tasks', 'secondary', 'briefcase')) +
        '<section class="card card-body"><div class="row between"><h3>Рабочая неделя</h3>' + h.badge('09:00–18:00', 'neutral') +
        '</div><div class="weekday-strip">' + days.map(function (d) {
          return '<button class="day-button ' + (day === d[0] ? 'active' : '') + ' ' + (d[0] >= 7 ? 'weekend' : '') +
            '" data-day="' + d[0] + '"><span>' + d[1] + '</span><strong>' + d[0] + '</strong><span class="day-dot">' +
            (d[0] < 7 ? '●' : '·') + '</span></button>';
        }).join('') + '</div></section>' +
        '<div class="grid-2"><div class="stack"><div class="row between"><h2 class="section-title">' + day + ' ноября</h2><span class="muted">' +
        list.length + ' задач</span></div>' + (list.length ? list.map(function (t, i) {
          return '<div class="schedule-row"><div class="schedule-time">' + (['09:00', '10:00', '13:00', '15:00', '16:30'][i] || '17:00') +
            '<span class="muted">' + (t.estimate || '1 ч') + '</span></div>' + h.taskCard(t) + '</div>';
        }).join('') : '<section class="card empty-state">' + h.icon('calendar', 34) +
        '<h3>Выходной день</h3><p class="muted">На этот день задания не запланированы.</p></section>') +
        '</div><aside class="stack"><section class="card card-body"><span class="eyebrow">ГРАФИК СМЕНЫ</span><h3>' +
        (day < 7 ? 'Рабочий день' : 'Выходной') + '</h3><div class="list-row"><span class="muted">Начало смены</span><strong>' +
        (day < 7 ? '09:00' : '—') + '</strong></div><div class="list-row"><span class="muted">Перерыв</span><strong>' +
        (day < 7 ? '12:00–13:00' : '—') + '</strong></div><div class="list-row"><span class="muted">Конец смены</span><strong>' +
        (day < 7 ? '18:00' : '—') + '</strong></div></section><div class="info-box"><div><strong>Планы могут измениться</strong>' +
        '<p>При новом назначении или переносе задания вы получите уведомление.</p>' +
        h.nav('Уведомления', 'notifications', 'ghost', 'bell') + '</div></div></aside></div>';
    },

    sync: function (s, h) {
      var pending = Number(s.syncPending || 0);
      return heading(h, 'СВЯЗЬ И СОХРАННОСТЬ', 'Синхронизация', 'Ваши действия сохраняются, даже когда сеть недоступна',
          h.btn(s.offline ? 'Восстановить связь' : 'Проверить офлайн', 'toggle-offline', 'secondary', s.offline ? 'wifi' : 'wifi-off')) +
        '<section class="card card-body"><div class="row between"><div class="row gap-12"><span class="sync-symbol">' +
        h.icon(s.offline ? 'wifi-off' : 'wifi', 28) + '</span><div><h2>' + (s.offline ? 'Вы работаете без сети' : 'Всё под контролем') +
        '</h2><p class="muted">' + (s.offline ? 'Действия остаются на этом устройстве до восстановления соединения.' :
        'Соединение доступно. Можно отправить накопленные данные.') + '</p></div></div>' +
        h.badge(s.offline ? 'Нет соединения' : 'В сети', s.offline ? 'amber' : 'green') + '</div></section>' +
        '<div class="grid-3">' + stat(h, (s.tasks || []).length, 'Заданий на устройстве', 'Доступны без интернета', 'briefcase') +
        stat(h, pending, 'Ожидают отправки', 'События и фотографии', 'upload') +
        stat(h, '24,8 МБ', 'Сохранённые материалы', 'Инструкции и фото', 'download') + '</div>' +
        '<div class="grid-2"><section class="card"><div class="card-header"><h3>Очередь отправки</h3>' +
        h.badge(pending ? pending + ' событий' : 'Всё отправлено', pending ? 'amber' : 'green') + '</div><div class="card-body stack">' +
        (pending ? [
          ['map-pin', 'Прибытие на объект', 'Заявка №1042 · действие в 10:18'],
          ['camera', 'Фотография до работы', 'Заявка №1042 · 2,4 МБ'],
          ['check-square', 'Обновление чек-листа', 'Заявка №1042 · действие в 10:24']
        ].slice(0, Math.min(pending, 3)).map(function (item) {
          return '<div class="list-row"><div class="row gap-12">' + h.icon(item[0], 22) + '<div><strong>' +
            item[1] + '</strong><p class="muted">' + item[2] + '</p></div></div>' + h.badge('Ожидает', 'amber') + '</div>';
        }).join('') + (pending > 3 ? '<p class="muted">И ещё ' + (pending - 3) + ' событий</p>' : '') :
        '<div class="empty-state">' + h.icon('check-circle', 36) + '<h3>Очередь пуста</h3><p class="muted">Все доступные данные переданы.</p></div>') +
        '<button class="btn btn-primary" data-action="sync-now" ' + (s.offline ? 'disabled' : '') + '>' +
        h.icon('refresh', 18) + ' Синхронизировать сейчас</button></div></section><aside class="stack"><section class="card card-body">' +
        '<h3>Подготовка перед выездом</h3><p class="muted">Скачайте актуальные задания, инструкции и чек-листы, пока есть соединение.</p>' +
        h.btn(s.prepared ? 'Обновить сохранённые задания' : 'Скачать задания на день', 'prepare-offline', 'secondary', 'download') +
        '<div class="divider"></div><div class="list-row"><span>Задания и адреса</span>' + h.badge('Доступны', 'green') +
        '</div><div class="list-row"><span>Чек-листы</span>' + h.badge('Доступны', 'green') +
        '</div><div class="list-row"><span>Материалы к заданию</span>' + h.badge(s.prepared ? 'Обновлены' : 'Сохранены', 'green') + '</div></section>' +
        '<div class="info-box amber"><div><strong>Срочное сообщение без сети</strong><p>Пока данные не отправлены, диспетчер их не видит. Для срочной ситуации используйте доступный способ связи.</p></div></div></aside></div>';
    },

    shift: function (s, h) {
      var active = s.shiftActive, paused = s.shiftPaused;
      var firstName = (s.profileName || 'Арман Садыков').trim().split(/\s+/)[0] || 'Арман';
      return heading(h, 'ВТОРНИК, 3 НОЯБРЯ', 'Моя смена', 'Рабочее время, доступность и передача задач', h.nav('Расписание', 'calendar', 'secondary', 'calendar')) +
        '<section class="active-task-card"><div class="row between"><span class="eyebrow">АСТАНА СЕРВИС · ВЫЕЗДНАЯ СЛУЖБА</span>' +
        h.badge(paused ? 'Недоступен' : (active ? 'На смене' : 'Смена завершена'), paused ? 'amber' : 'green') +
        '</div><h2>' + (paused ? 'Смена приостановлена' : (active ? 'Хороший темп, ' + esc(h, firstName) : 'До новой рабочей смены')) +
        '</h2><p>' + (paused ? 'Новые задания не назначаются. Сообщите, когда будете готовы вернуться.' :
        (active ? 'Задания распределяются с учётом вашей доступности.' : 'Начните смену, чтобы принимать новые задания.')) +
        '</p><div class="row between"><span>Сегодня · 09:00–18:00</span>' +
        (paused ? h.btn('Вернуться на смену', 'resume-shift', 'primary', 'play') : (active ? h.btn('Завершить смену', 'shift-end', 'secondary', 'check') :
        h.btn('Начать смену', 'shift-start', 'primary', 'play'))) + '</div></section>' +
        '<div class="grid-3">' + stat(h, active ? '1 ч 24 мин' : '0 ч', 'На смене', 'С начала рабочего дня', 'clock') +
        stat(h, '42 мин', 'Время в работе', 'Без дороги и пауз', 'briefcase') +
        stat(h, '33 мин', 'Время в пути', 'По событиям выезда', 'navigation') + '</div>' +
        '<div class="grid-2"><section class="card card-body"><h2 class="section-title">История смены</h2><div class="timeline">' +
        [['09:00', 'Начало смены', esc(h, s.profileName || 'Арман Садыков') + ' · доступен для назначений'], ['09:32', 'Принято первое задание', 'Заявка №1042'],
         ['09:45', 'Выезд на объект', 'БЦ «Астана Тауэр»'], ['10:21', 'Начало работ', 'Плановое обслуживание оборудования']].map(function (x) {
           return '<div class="timeline-item"><span class="timeline-dot"></span><span class="muted">' + x[0] +
             '</span><div><strong>' + x[1] + '</strong><p class="muted">' + x[2] + '</p></div></div>';
         }).join('') + '</div></section><aside class="stack"><section class="card card-body"><h3>Управление доступностью</h3>' +
        '<p class="muted">Сообщите диспетчеру, если планы на смену изменились.</p>' +
        '<button class="list-row" data-action="open-late"><span class="row gap-12">' + h.icon('clock', 22) + '<span><strong>Опаздываю</strong><span class="muted">Сообщить причину и ожидаемое время</span></span></span>' +
        h.icon('chevron-right', 18) + '</button><button class="list-row" data-action="open-handover"><span class="row gap-12">' + h.icon('user', 22) +
        '<span><strong>Передать работу</strong><span class="muted">Сохранить сделанное для коллеги</span></span></span>' + h.icon('chevron-right', 18) +
        '</button><button class="list-row" data-action="open-urgent"><span class="row gap-12">' + h.icon('alert-triangle', 22) +
        '<span><strong>Срочный уход</strong><span class="muted">Приостановить смену и уведомить диспетчера</span></span></span>' + h.icon('chevron-right', 18) +
        '</button></section><div class="info-box"><div><strong>Незавершённая работа в конце дня</strong><p>Перед окончанием смены выберите: продолжить, приостановить или передать задачу. Продление фиксируется отдельно.</p></div></div></aside></div>';
    },

    profile: function (s, h) {
      var name = s.profileName || 'Арман Садыков';
      var email = s.profileEmail || 'arman@example.com';
      var initials = name.trim().split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0); }).join('').toUpperCase() || 'АС';
      return heading(h, 'ЛИЧНЫЙ КАБИНЕТ', 'Мой профиль', 'Ваши данные и рабочие настройки', h.btn('Настройки', 'open-settings', 'secondary', 'settings')) +
        '<section class="card card-body profile-hero"><div class="row gap-12"><div class="avatar avatar-large">' + esc(h, initials) + '</div><div><span class="eyebrow">АСТАНА СЕРВИС</span>' +
        '<h2>' + esc(h, name) + '</h2><p class="muted">Выездной специалист · техническая служба</p><div class="row gap-8">' +
        h.badge('Сотрудник', 'neutral') + h.badge(s.shiftPaused ? 'Недоступен' : (s.shiftActive ? 'На смене' : 'Вне смены'), s.shiftPaused ? 'amber' : 'green') +
        '</div></div></div><button class="btn btn-secondary" data-modal="edit-profile">Редактировать профиль</button></section>' +
        '<div class="grid-2"><section class="card card-body"><h3>Рабочая информация</h3>' +
        '<div class="list-row"><span class="muted">Рабочая почта</span><strong style="overflow-wrap:anywhere">' + esc(h, email) + '</strong></div>' +
        '<div class="list-row"><span class="muted">Подразделение</span><strong>Техническая служба</strong></div>' +
        '<div class="list-row"><span class="muted">Зона работы</span><strong>Астана · левый берег</strong></div>' +
        '<div class="list-row"><span class="muted">Руководитель</span><strong>Данияр Омаров</strong></div>' +
        '<div class="list-row"><span class="muted">Диспетчер</span><strong>Алия Нурланова</strong></div>' +
        '<div class="divider"></div><h3>Допуски и специализация</h3><div class="row gap-8">' +
        h.badge('Вентиляция', 'green') + h.badge('Электрооборудование', 'neutral') + h.badge('Плановое ТО', 'neutral') +
        '</div></section><aside class="stack"><section class="card card-body"><h3>Быстрый доступ</h3>' +
        '<button class="list-row" data-page="shift"><span class="row gap-12">' + h.icon('clock', 22) + '<strong>Моя смена</strong></span>' + h.icon('chevron-right', 18) +
        '</button><button class="list-row" data-page="sync"><span class="row gap-12">' + h.icon('refresh', 22) + '<strong>Синхронизация</strong></span>' +
        h.badge(s.offline ? 'Нет связи' : 'В сети', s.offline ? 'amber' : 'green') + '</button>' +
        '<button class="list-row" data-page="notifications"><span class="row gap-12">' + h.icon('bell', 22) + '<strong>Уведомления</strong></span>' + h.icon('chevron-right', 18) +
        '</button><button class="list-row" data-page="pin"><span class="row gap-12">' + h.icon('shield', 22) + '<strong>PIN и быстрый вход</strong></span>' +
        h.icon('chevron-right', 18) + '</button></section><section class="card card-body"><h3>Связь с диспетчером</h3><p class="muted">По вопросам назначения, доступа на объект и изменения планов.</p>' +
        '<button class="btn btn-secondary" data-modal="contact">' + h.icon('phone', 18) + ' Контактная информация</button></section></aside></div>';
    },

    notifications: function (s, h) {
      var read = !!s.notificationsRead;
      return heading(h, 'СОБЫТИЯ РАБОЧЕГО ДНЯ', 'Уведомления', 'Назначения, изменения и обратная связь', h.btn('Отметить прочитанными', 'clear-notifications', 'secondary', 'check')) +
        '<div class="grid-2"><section class="card"><div class="card-header"><h3>Сегодня</h3>' + h.badge(read ? 'Всё прочитано' : '3 новых', read ? 'neutral' : 'green') +
        '</div><div class="card-body stack"><button class="list-row notification-row ' + (read ? '' : 'unread') +
        '" data-action="open-emergency"><span class="sync-symbol">' + h.icon('alert-triangle', 22) +
        '</span><span><span class="row between"><strong>Нужен специалист на аварийный выезд</strong><span class="muted">10:20</span></span>' +
        '<span class="muted">ЖК «Зелёный квартал» · протечка в техническом помещении. Подтвердите возможность выезда.</span>' +
        h.badge('Требует ответа', 'red') + '</span>' + h.icon('chevron-right', 18) + '</button>' +
        '<button class="list-row notification-row ' + (read ? '' : 'unread') + '" data-page="tasks"><span class="sync-symbol">' +
        h.icon('briefcase', 22) + '</span><span><span class="row between"><strong>Новое задание на 13:00</strong><span class="muted">09:56</span></span>' +
        '<span class="muted">Проверка системы освещения · ЖК «Зелёный квартал».</span></span>' + h.icon('chevron-right', 18) + '</button>' +
        '<button class="list-row notification-row ' + (read ? '' : 'unread') + '" data-page="task"><span class="sync-symbol">' + h.icon('file-text', 22) +
        '</span><span><span class="row between"><strong>Диспетчер уточнил доступ на объект</strong><span class="muted">09:40</span></span>' +
        '<span class="muted">Заявка №1042 · используйте служебный вход со стороны парковки.</span></span>' + h.icon('chevron-right', 18) + '</button>' +
        '<button class="list-row notification-row" data-page="sync"><span class="sync-symbol">' + h.icon('download', 22) +
        '</span><span><span class="row between"><strong>Материалы на день сохранены</strong><span class="muted">09:05</span></span>' +
        '<span class="muted">Задания, чек-листы и инструкции доступны без сети.</span></span>' + h.icon('chevron-right', 18) + '</button></div></section>' +
        '<aside class="stack"><section class="card card-body"><h3>Важное всегда рядом</h3><p class="muted">Здесь собраны изменения по вашим заданиям и сообщения от диспетчера.</p>' +
        '<div class="list-row"><span class="row gap-8">' + h.icon('briefcase', 18) + ' Новые назначения</span>' + h.badge('Включено', 'green') +
        '</div><div class="list-row"><span class="row gap-8">' + h.icon('clock', 18) + ' Напоминания о сроках</span>' + h.badge('Включено', 'green') +
        '</div><div class="list-row"><span class="row gap-8">' + h.icon('check-circle', 18) + ' Решение по отчёту</span>' + h.badge('Включено', 'green') +
        '</div></section><div class="info-box"><div><strong>Без интернета</strong><p>Новые уведомления появятся после связи. Уже полученные сообщения останутся доступны.</p></div></div></aside></div>';
    }
  });
})();
