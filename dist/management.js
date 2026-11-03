/* ВЕКТОР — manager, administration and onboarding prototype screens. */
(function () {
  'use strict';
  window.VektorViews = window.VektorViews || {};

  const header = (eyebrow, title, text, actions = '') => `
    <div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="muted">${text}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`;
  const stat = (label, value, foot, icon, h) => `<div class="stat-card"><div class="row between"><span class="stat-label">${label}</span><span class="stat-icon">${h.icon(icon, 19)}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`;
  const reviews = s => (s.tasks || []).filter(t => t.status === 'review');
  const current = s => (s.tasks || []).find(t => t.id === s.selectedTask) || reviews(s)[0] || (s.tasks || [])[0] || {id: '1042', title: 'Техническое обслуживание вентиляции', object: 'БЦ «Астана Тауэр»', address: 'проспект Кабанбай батыра, 12', employee: 'Арман Садыков', status: 'review'};
  const checklistLabels = ['Подтвердить доступ и безопасность рабочего места', 'Осмотреть оборудование и зафиксировать дефекты', 'Выполнить работы по заданию', 'Проверить результат и работоспособность', 'Убрать рабочее место и сообщить ответственному'];
  const evidencePhotos = (s, t) => {
    const photos = t.id === s.selectedTask && s.photos ? s.photos : s.evidence && s.evidence[t.id] && s.evidence[t.id].photos;
    return photos ? (Number(photos.before) || 0) + (Number(photos.after) || 0) : 4;
  };
  const evidenceChecks = (s, t) => (t.id === s.selectedTask && Array.isArray(s.checks) ? s.checks : s.evidence && s.evidence[t.id] && s.evidence[t.id].checks) || [true, true, true, true, true];
  const authMark = h => `<a class="auth-mark" href="#login" data-page="login" aria-label="Вектор — вход"><span class="auth-symbol">${h.icon('navigation', 24)}</span><span>ВЕКТОР<small>Выездные работы под контролем</small></span></a>`;
  const authNavigation = page => `
    <nav class="auth-navigation" aria-label="Доступ к Вектору">
      <a href="#login" data-page="login" ${page === 'login' ? 'aria-current="page"' : ''}>Вход</a>
      <a href="#register" data-page="register" ${page === 'register' ? 'aria-current="page"' : ''}>Регистрация компании</a>
    </nav>`;
  const authAside = h => `<aside class="auth-aside"><span class="eyebrow">ОДНА КОМАНДА. ОБЩИЙ РЕЗУЛЬТАТ.</span><h2>Работа на месте.<br>Всё остальное —<br>в Векторе.</h2><p>Задания, выезды и подтверждённый результат — в одном рабочем пространстве.</p><div class="auth-illustration" aria-hidden="true"><svg viewBox="0 0 380 290" fill="none"><path d="M0 212L129 112L213 180L380 55" stroke="#B7D99C" stroke-width="2" stroke-dasharray="6 8"/><path d="M26 95L129 112L158 18M213 180L245 285M213 180L366 238" stroke="white" stroke-opacity=".13" stroke-width="2"/><circle cx="129" cy="112" r="39" fill="#D9EDB3" fill-opacity=".1"/><circle cx="129" cy="112" r="22" fill="#D9EDB3"/><path d="M120 112L126 118L138 105" stroke="#1E4B40" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="213" cy="180" r="47" stroke="#D9EDB3" stroke-opacity=".18"/><circle cx="213" cy="180" r="30" fill="#D9EDB3"/><path d="M213 163C206 163 201 168 201 175C201 184 213 195 213 195S225 184 225 175C225 168 220 163 213 163Z" stroke="#1E4B40" stroke-width="2"/><circle cx="213" cy="175" r="4" stroke="#1E4B40" stroke-width="2"/><circle cx="337" cy="92" r="9" fill="#D9EDB3"/><rect x="16" y="231" width="152" height="42" rx="12" fill="white" fill-opacity=".1"/><circle cx="39" cy="252" r="5" fill="#D9EDB3"/><path d="M55 246H125M55 258H102" stroke="white" stroke-opacity=".7" stroke-width="4" stroke-linecap="round"/></svg></div><div class="auth-proof"><span class="avatar">АС</span><div><strong>Астана Сервис</strong><span>Команда, которая всегда на связи</span></div>${h.icon('check', 18)}</div></aside>`;

  Object.assign(window.VektorViews, {
    review(s, h) {
      const all = reviews(s);
      const issueId = all.length ? all[all.length - 1].id : null;
      const list = s.reviewFilter === 'issue' ? all.filter(t => t.id === issueId) : all;
      return `${header('КОНТРОЛЬ КАЧЕСТВА', 'Приёмка работ', 'Проверьте результат, пока детали ещё свежи.', h.nav('Конфликты синхронизации', 'conflicts', 'secondary', 'alert-triangle'))}
        <div class="grid-3">${stat('Ожидают решения', all.length.toString().padStart(2, '0'), 'Отчёты от вашей команды', 'clipboard-check', h)}${stat('Требует внимания', all.length ? '01' : '00', 'Проверка качества подтверждений', 'alert-circle', h)}${stat('Принято сегодня', String((s.tasks || []).filter(t => t.status === 'done').length), 'Результат подтверждён', 'check-circle', h)}</div>
        <section class="card"><div class="card-header"><div><h2>Отчёты на проверку</h2><p class="muted">Сначала — работы, срок проверки которых подходит к концу</p></div><span class="badge badge-gray">${all.length} ${all.length === 1 ? 'отчёт' : 'отчёта'}</span></div>
        <div class="tabs review-tabs" aria-label="Фильтр отчётов">${[['all', 'Все отчёты'], ['waiting', 'Ожидают приёмки'], ['issue', 'Есть замечания']].map(([key, name]) => `<button type="button" class="tab ${((s.reviewFilter || 'all') === key) ? 'active' : ''}" data-review-filter="${key}">${name}${key === 'issue' && all.length ? '<span class="tab-count">1</span>' : ''}</button>`).join('')}</div>
        <div class="review-list">${list.length ? list.map((t, i) => `<button type="button" class="review-item" data-review-task="${h.esc(t.id)}"><span class="review-preview">${h.icon('image', 28)}<span>ДО / ПОСЛЕ</span></span><span class="review-item-main"><span class="row gap-8"><span class="muted">#${h.esc(t.id)}</span>${h.badge(t.id === issueId ? 'Проверить фото' : 'Готов к приёмке', t.id === issueId ? 'amber' : 'green')}</span><strong>${h.esc(t.title)}</strong><span class="muted">${h.esc(t.object)}</span><span class="review-meta">${h.icon('user', 14)} ${h.esc(t.employee || 'Арман Садыков')}<span>·</span>${i === 0 ? '12 минут назад' : '28 минут назад'}</span></span><span class="review-item-end"><span class="muted">${evidencePhotos(s, t)} фото · чек-лист ${evidenceChecks(s, t).filter(Boolean).length}/5</span><span class="review-open">Проверить ${h.icon('arrow-right', 16)}</span></span></button>`).join('') : `<div class="empty-state">${h.icon('check-circle', 42)}<h3>Всё проверено</h3><p>Новые отчёты появятся здесь, когда сотрудники завершат работы.</p>${h.nav('Посмотреть аналитику', 'analytics')}</div>`}</div></section>
        <div class="info-box green">${h.icon('shield-check', 20)}<div><strong>Результат и доказательства — отдельно</strong><p>Если фото ещё отправляются, отчёт появится на проверке после загрузки обязательных материалов.</p></div></div>`;
    },

    inspection(s, h) {
      const t = current(s);
      const accepted = t.status === 'done';
      const checks = evidenceChecks(s, t);
      const checkedCount = checks.filter(Boolean).length;
      const reportComment = (t.id === s.selectedTask && s.reportComment) || (s.evidence && s.evidence[t.id] && s.evidence[t.id].reportComment) || 'Обслуживание выполнено. Оборудование проверено, замечаний к работе нет.';
      return `${header(`ПРИЁМКА · ЗАЯВКА #${h.esc(t.id)}`, 'Проверка результата', h.esc(t.title), h.nav('Все отчёты', 'review', 'secondary', 'arrow-left'))}
        ${accepted ? `<div class="info-box green">${h.icon('check-circle', 22)}<div><strong>Работа принята</strong><p>Решение сохранено в истории заявки. Исполнитель увидит подтверждение.</p></div></div>` : ''}
        <div class="inspection-layout"><div class="stack"><section class="card"><div class="card-header"><div><h2>Фотоотчёт</h2><p class="muted">Первый выезд · 3 ноября 2026</p></div>${h.badge('На объекте', 'green')}</div><div class="card-body"><div class="photo-grid"><div class="photo-card"><div class="row between photo-title"><strong>До выполнения</strong><span class="muted">10:18</span></div>${h.photo('before')}<p class="photo-caption">Состояние оборудования до обслуживания</p></div><div class="photo-card"><div class="row between photo-title"><strong>После выполнения</strong><span class="muted">11:02</span></div>${h.photo('after')}<p class="photo-caption">Рабочая зона очищена, узлы проверены</p></div></div><div class="info-box green compact">${h.icon('map-pin', 17)}<span>Съёмка в пределах объекта · расстояние 34 м · точность 12 м</span></div></div></section>
        <section class="card"><div class="card-header"><h2>Чек-лист работ</h2>${h.badge(`${checkedCount} из 5`, checkedCount === 5 ? 'green' : 'amber')}</div><div class="card-body stack">${checklistLabels.map((x, i) => `<div class="row gap-12 checklist-summary">${h.icon(checks[i] ? 'check-circle' : 'circle', 19)}<span>${x}</span></div>`).join('')}<div class="divider"></div><label class="field-label">Комментарий исполнителя</label><p class="report-note" style="white-space:pre-wrap;overflow-wrap:anywhere">${h.esc(reportComment)}</p></div></section></div>
        <aside class="stack"><section class="card"><div class="card-header"><h2>О выезде</h2></div><div class="card-body stack"><div class="row gap-12"><span class="avatar">АС</span><div><strong>${h.esc(t.employee || 'Арман Садыков')}</strong><div class="muted">Выездной специалист</div></div></div><div class="divider"></div><dl class="detail-list"><div><dt>Объект</dt><dd>${h.esc(t.object)}</dd></div><div><dt>Прибытие</dt><dd>10:14 · вовремя</dd></div><div><dt>Работа</dt><dd>10:20 – 11:04</dd></div><div><dt>Длительность</dt><dd>44 минуты</dd></div><div><dt>Синхронизация</dt><dd class="text-green">Полностью отправлено</dd></div></dl></div></section>
        <section class="card decision-card"><div class="card-body stack"><h2>${accepted ? 'Решение принято' : 'Подтвердите результат'}</h2><p class="muted">Принимайте работу, когда результат соответствует заданию и подтверждён отчётом.</p>${accepted ? h.nav('Следующий отчёт', 'review', 'primary', 'arrow-right') : `${h.btn('Принять работу', 'approve-report', 'primary', 'check')}${h.btn('Вернуть на доработку', 'open-reject', 'secondary', 'rotate-ccw')}`}<p class="fine-print">Причина возврата сохранится в истории и будет видна сотруднику.</p></div></section></aside></div>`;
    },

    analytics(s, h) {
      const month = s.analyticsRange === 'month';
      const total = month ? 566 : 124;
      const timely = month ? 525 : 116;
      const percentage = Math.round(timely / total * 100);
      const values = month ? [94, 104, 118, 126, 124] : [16, 20, 18, 22, 21, 13, 14];
      const late = month ? [8, 9, 9, 7, 8] : [1, 1, 2, 1, 1, 1, 1];
      const labels = month ? ['1–4 окт', '5–11', '12–18', '19–25', '26–31'] : ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
      const period = month ? '1–31 октября 2026' : '26 октября — 1 ноября';
      const max = Math.max(...values);
      return `${header('ОБЗОР РЕЗУЛЬТАТОВ', 'Аналитика команды', `${period} · Астана Сервис`, `${h.btn(month ? 'За месяц' : 'За неделю', 'toggle-analytics', 'secondary', 'calendar')}${h.btn('Выгрузить отчёт', 'export-report', 'secondary', 'download')}`)}
        <div class="grid-4">${stat('Заявок со сроком в периоде', String(total), 'Включая открытые просроченные', 'clipboard', h)}${stat('Выполнено в срок', `${percentage}%`, `${timely} из ${total} заявок`, 'clock', h)}${stat('С первого выезда', month ? '88%' : '89%', 'Среди принятых заявок', 'check-circle', h)}${stat('Среднее время работы', month ? '45 мин' : '42 мин', 'Без дороги и пауз', 'timer', h)}</div>
        <div class="analytics-grid"><section class="card"><div class="card-header"><div><h2>${month ? 'Выполнение по неделям' : 'Выполнение по дням'}</h2><p class="muted">Обязательства со сроком в выбранном периоде</p></div><div class="chart-legend"><span><i style="background:#39735e"></i>В срок</span><span><i style="background:#eab05b"></i>С задержкой</span></div></div><div class="card-body"><div class="chart-columns" style="--columns:${values.length}" role="img" aria-label="${labels.map((l,i)=>`${l}: ${values[i]-late[i]} в срок, ${late[i]} с задержкой`).join('; ')}">${values.map((value, i) => `<div class="chart-column"><span class="chart-number">${value}</span><div class="chart-track"><div class="chart-bar" style="height:${Math.round(value / max * 100)}%"><div class="chart-bar-late" style="height:${late[i] / value * 100}%"></div><div class="chart-bar-timely" style="flex:1"></div></div></div><span class="chart-label">${labels[i]}</span></div>`).join('')}</div></div></section>
        <section class="card"><div class="card-header"><div><h2>Соблюдение сроков</h2><p class="muted">Клиентский SLA</p></div>${h.icon('activity', 19)}</div><div class="card-body"><div class="donut-chart" role="img" aria-label="${percentage}% работ выполнены в срок"><svg viewBox="0 0 140 140"><circle cx="70" cy="70" r="54" fill="none" stroke="#edf0e9" stroke-width="12"/><circle cx="70" cy="70" r="54" fill="none" stroke="#39735e" stroke-width="12" stroke-linecap="round" stroke-dasharray="${percentage * 3.393} 339.3" transform="rotate(-90 70 70)"/></svg><div><strong>${percentage}%</strong><span>в срок</span></div></div><div class="row between"><span class="muted">Выполнены вовремя</span><strong>${timely}</strong></div><div class="divider"></div><div class="row between"><span class="muted">Просрочены или открыты</span><strong>${total - timely}</strong></div></div></section></div>
        <div class="grid-2"><section class="card"><div class="card-header"><div><h2>Нагрузка сотрудников</h2><p class="muted">Занятость в пределах доступной смены</p></div></div><div class="card-body stack">${[['Арман Садыков','АС',78,'5 ч 50 мин'],['Данияр Нурланов','ДН',64,'4 ч 48 мин'],['Алия Тлеуберген','АТ',86,'6 ч 27 мин'],['Тимур Омаров','ТО',42,'3 ч 09 мин']].map(([name,initials,value,time]) => `<div class="load-row"><span class="avatar">${initials}</span><div><div class="row between"><strong>${name}</strong><span>${value}%</span></div>${h.progress(value)}<small class="muted">${time} · с учётом дороги</small></div></div>`).join('')}</div></section>
        <section class="card"><div class="card-header"><div><h2>Что влияет на результат</h2><p class="muted">Причины повторных выездов</p></div></div><div class="card-body stack">${[['Нет доступа на объект',5,'amber'],['Ожидание материалов',4,'blue'],['Дополнительные работы',3,'gray'],['Доработка результата',2,'red']].map(([name,value,tone]) => `<div class="row between"><span>${name}</span>${h.badge(String(month ? value*4 : value), tone)}</div>`).join('')}<div class="divider"></div><p class="fine-print">Уважительная причина учитывается в оценке сотрудника. Фактический срок услуги остаётся в истории.</p></div></section></div>
        <p class="fine-print analytics-note">Демонстрационные показатели. Формула SLA: выполнено в срок ÷ все учитываемые заявки со сроком в периоде. Данные офлайн-выездов уточняются после синхронизации.</p>`;
    },

    conflicts(s, h) {
      return `${header('ЦЕНТР КОНТРОЛЯ', 'Конфликты данных', 'Сохраните фактическую историю и примите решение.', h.nav('Приёмка работ', 'review', 'secondary', 'arrow-left'))}
        ${s.conflictResolved ? `<section class="card"><div class="empty-state">${h.icon('check-circle', 48)}<h2>Конфликт разрешён</h2><p>Решение добавлено в историю. Действия и фотографии сотрудника сохранены.</p>${h.nav('Вернуться к работам', 'orders', 'primary', 'arrow-right')}</div></section>` : `<div class="info-box amber">${h.icon('alert-triangle', 22)}<div><strong>Отмена пересеклась с работой без сети</strong><p>Сотрудник завершил выезд, пока на сервере уже действовала отмена. Автоматически выбрать одну версию нельзя.</p></div></div>
        <section class="card"><div class="card-header"><div><div class="row gap-8"><span class="eyebrow">ЗАЯВКА #1038</span>${h.badge('Требует решения', 'amber')}</div><h2>Проверка аварийного освещения</h2><p class="muted">Музей энергии · Арман Садыков</p></div></div><div class="card-body"><div class="comparison-grid"><div class="comparison-panel"><div class="row gap-8"><span class="comparison-icon">${h.icon('cloud',22)}</span><h3>На сервере</h3></div>${h.badge('Отменена в 14:10', 'red')}<div class="timeline"><div class="timeline-item"><span class="timeline-dot"></span><div><strong>14:10 · Отмена диспетчером</strong><p>Поступила информация об изменении графика объекта.</p></div></div><div class="timeline-item"><span class="timeline-dot"></span><div><strong>14:10 · Уведомление отправлено</strong><p>Доставка на телефон не подтверждена.</p></div></div></div></div><div class="comparison-panel"><div class="row gap-8"><span class="comparison-icon">${h.icon('smartphone',22)}</span><h3>На телефоне</h3></div>${h.badge('Выполнена в 14:40', 'green')}<div class="timeline"><div class="timeline-item"><span class="timeline-dot"></span><div><strong>14:00 · Начало работы</strong><p>Интернет отсутствует. Последняя версия задания загружена в 13:32.</p></div></div><div class="timeline-item"><span class="timeline-dot"></span><div><strong>14:40 · Работа завершена</strong><p>4 фотографии и заполненный чек-лист получены в 15:20.</p></div></div></div></div></div><div class="divider"></div><fieldset class="decision-options"><legend>Как обработать результат?</legend><label class="decision-option"><input type="radio" name="conflict-resolution" value="preserve" checked><span><strong>Сохранить результат и отправить на приёмку</strong><small>Работа выполнена до получения сотрудником отмены.</small></span></label><label class="decision-option"><input type="radio" name="conflict-resolution" value="cancel"><span><strong>Подтвердить отмену заявки</strong><small>Материалы выезда останутся в истории без приёмки услуги.</small></span></label></fieldset><label class="field"><span class="field-label">Комментарий к решению</span><textarea class="textarea" id="conflict-comment" rows="3" placeholder="Объясните решение для сотрудника и диспетчера">Сотрудник не получил отмену до завершения работ. Сохранить фактически выполненный выезд.</textarea></label><div class="page-actions">${h.btn('Сохранить решение', 'resolve-conflict', 'primary', 'check')}</div></div></section>`}`;
    },

    settings(s, h) {
      const opts = s.settings || {};
      return `${header('РАБОЧЕЕ ПРОСТРАНСТВО', 'Настройки компании', 'Общие правила для диспетчеров, руководителей и сотрудников.')}
        <form id="settings-form"><div class="grid-2"><div class="stack"><section class="card"><div class="card-header"><h2>Компания</h2>${h.icon('building',20)}</div><div class="card-body stack"><label class="field"><span class="field-label">Название компании</span><input class="input" name="company" value="${h.esc(opts.company || opts.companyName || 'Астана Сервис')}" required></label><label class="field"><span class="field-label">Адрес рабочего пространства</span><div class="input-affix"><span>vektor.app /</span><input class="input" name="slug" value="${h.esc(opts.slug || opts.workspaceSlug || 'astana-service')}" aria-label="Код компании"></div></label><div class="grid-2"><label class="field"><span class="field-label">Часовой пояс</span><select class="select" name="timezone"><option>Астана · UTC+5</option></select></label><label class="field"><span class="field-label">Язык интерфейса</span><select class="select" name="language"><option ${opts.language!=='Қазақша'?'selected':''}>Русский</option><option ${opts.language==='Қазақша'?'selected':''}>Қазақша</option></select></label></div></div></section>
        <section class="card"><div class="card-header"><div><h2>Прибытие на объект</h2><p class="muted">Правила геопроверки</p></div>${h.icon('map-pin',20)}</div><div class="card-body stack"><label class="field"><span class="field-label">Радиус по умолчанию, м</span><select class="select" name="radius">${[50,100,300].map(v=>`<option value="${v}" ${Number(opts.radius || 100)===v?'selected':''}>${v} метров</option>`).join('')}</select><small class="muted">Для отдельного объекта можно задать другой радиус.</small></label><label class="field"><span class="field-label">Отметка вне радиуса</span><select class="select" name="geoPolicy"><option value="flag" ${opts.geoPolicy!=='block'?'selected':''}>Разрешить с причиной и пометкой</option><option value="block" ${opts.geoPolicy==='block'?'selected':''}>Заблокировать отметку</option></select></label><div class="info-box amber compact">${h.icon('info',18)}<p>При отсутствии GPS доступно исключение с причиной и последующей проверкой.</p></div></div></section></div>
        <div class="stack"><section class="card"><div class="card-header"><h2>Фото и уведомления</h2>${h.icon('sliders',20)}</div><div class="card-body stack"><label class="switch-row"><span><strong>Фото «до» и «после»</strong><small>Обязательны перед сдачей результата</small></span><input class="switch" type="checkbox" role="switch" name="requiredPhotos" ${opts.requiredPhotos!==false?'checked':''}></label><div class="divider"></div><label class="switch-row"><span><strong>Уведомления о задачах</strong><small>Назначения, доработка и важные изменения</small></span><input class="switch" type="checkbox" role="switch" name="notifications" ${opts.notifications!==false?'checked':''}></label><div class="divider"></div><label class="switch-row"><span><strong>Контроль долгого отсутствия связи</strong><small>Предупреждать после 30 минут без обновлений</small></span><input class="switch" type="checkbox" role="switch" name="connectionAlerts" ${opts.connectionAlerts!==false?'checked':''}></label></div></section>
        <section class="card"><div class="card-header"><h2>Доступ команды</h2>${h.nav('Сотрудники', 'team', 'ghost', 'arrow-right')}</div><div class="card-body stack">${[['Владелец','Настройки компании и управление доступом','1'],['Руководитель','Приёмка, исключения и аналитика','2'],['Диспетчер','Назначения и планирование','2'],['Сотрудник','Свои задания и фотоотчёты','8']].map(([role,desc,n])=>`<div class="row between"><div><strong>${role}</strong><p class="muted">${desc}</p></div>${h.badge(n,'gray')}</div>`).join('')}<div class="divider"></div>${h.btn('Пригласить сотрудника', 'send-invitation', 'secondary', 'user-plus')}</div></section></div></div><div class="settings-save"><p class="fine-print">Изменения действуют для будущих действий. История выполненных работ сохраняется.</p><button type="submit" class="btn btn-primary">${h.icon('check',18)}Сохранить настройки</button></div></form>`;
    },

    holidays(s, h) {
      const months = ['ЯНВ', 'ФЕВ', 'МАР', 'АПР', 'МАЙ', 'ИЮН', 'ИЮЛ', 'АВГ', 'СЕН', 'ОКТ', 'НОЯ', 'ДЕК'];
      const additions = (Array.isArray(s.customHolidays) ? s.customHolidays : [])
        .filter(event => event && /^\d{4}-\d{2}-\d{2}$/.test(String(event.date || '').slice(0, 10)))
        .map(event => ({ name: String(event.name || 'Событие компании'), date: String(event.date).slice(0, 10) }));
      const companyEvents = [{name: 'Технический день компании', date: '2026-11-20', seeded: true}, ...additions]
        .filter((event, index, list) => list.findIndex(candidate => candidate.date === event.date && candidate.name === event.name) === index);
      const listedEvents = [{name: 'Дежурная смена', date: '2026-11-07', duty: true}, ...companyEvents]
        .sort((a, b) => a.date.localeCompare(b.date));
      const cells = Array.from({length:42}, (_,i) => {
        const day = i - 5;
        const dim = day < 1 || day > 30;
        const n = day < 1 ? day + 31 : day > 30 ? day - 30 : day;
        const weekend = i % 7 > 4;
        const date = `2026-11-${String(day).padStart(2, '0')}`;
        const events = dim ? [] : companyEvents.filter(event => event.date === date);
        const tag = events.length ? (events.length > 1 ? `${events.length} события` : events[0].name) : !dim && day===3 ? 'Сегодня' : !dim && [7,14,21,28].includes(day) ? 'Дежурство' : '';
        const description = `${n} ${day < 1 ? 'октября' : day > 30 ? 'декабря' : 'ноября'}${!dim&&day===3?' · Сегодня':''}${events.length ? ` · ${events.map(event => event.name).join('; ')}` : tag ? ` · ${tag}` : ''}`;
        return `<div class="calendar-cell ${dim?'dim':''} ${weekend?'weekend':''} ${!dim&&day===3?'today':''} ${events.length?'custom-holiday':''}" title="${h.esc(description)}" aria-label="${h.esc(description)}"><span>${n}</span>${tag?`<small>${h.esc(tag)}</small>`:''}</div>`;
      }).join('');
      const eventList = listedEvents.map((event, index) => {
        const [year, month, day] = event.date.split('-');
        return `${index ? '<div class="divider"></div>' : ''}<div class="calendar-event"><span class="event-date ${event.duty?'':'amber'}"><strong>${h.esc(day)}</strong><small>${months[Number(month)-1] || h.esc(month)}</small></span><div><strong style="overflow-wrap:anywhere">${h.esc(event.name)}</strong><p class="muted">${event.duty ? '09:00–18:00 · Тимур Омаров' : `Свой выходной · ${h.esc(`${day}.${month}.${year}`)}`}</p>${h.badge(event.duty ? 'Только срочные заявки' : event.seeded ? 'Пример события компании' : 'Добавлено в макете', event.duty ? 'green' : 'amber')}</div></div>`;
      }).join('');
      return `${header('ПЛАНИРОВАНИЕ', 'Календарь компании', 'Рабочие дни, выходные и дежурные смены.', h.btn('Добавить событие', 'add-holiday', 'primary', 'plus'))}
        <div class="grid-2 calendar-layout"><section class="card"><div class="card-header"><div><h2>Ноябрь 2026</h2><p class="muted">Демонстрационный календарь организации</p></div>${h.badge('UTC+5', 'gray')}</div><div class="card-body"><div class="calendar-weekdays">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=>`<span>${x}</span>`).join('')}</div><div class="company-calendar">${cells}</div><div class="calendar-legend"><span><i style="background:#edf0e9"></i>Выходной</span><span><i style="background:#d9edb3"></i>Дежурство</span><span><i style="background:#f7dfb9"></i>Событие компании</span></div></div></section>
        <div class="stack"><section class="card"><div class="card-header"><h2>События компании</h2></div><div class="card-body stack">${eventList}</div></section><section class="card"><div class="card-header"><h2>Работы в выходной</h2></div><div class="card-body stack"><p class="muted">Политика задаётся в каждом шаблоне плановой работы.</p><div class="row gap-12">${h.icon('arrow-right',18)}<div><strong>Перенести</strong><p class="muted">На следующий рабочий день</p></div></div><div class="row gap-12">${h.icon('minus-circle',18)}<div><strong>Пропустить</strong><p class="muted">Сохранить причину пропуска</p></div></div><div class="row gap-12">${h.icon('check-circle',18)}<div><strong>Выполнить по графику</strong><p class="muted">Назначить дежурному сотруднику</p></div></div>${h.nav('Открыть планирование', 'planning', 'secondary', 'calendar')}</div></section></div></div>
        <div class="info-box green">${h.icon('info',20)}<div><strong>Срок заявки сохраняется</strong><p>Изменение календаря не переносит уже согласованные сроки автоматически. Дежурные и аварийные работы выполняются по собственному графику.</p></div></div>`;
    },

    login(s, h) {
      const ownerLogin = Boolean(window.Vektor?.ownerLoginEmployeeId);
      const companyCode = ownerLogin ? s.companyCode : new URLSearchParams(location.search).get('company');
      const demo = companyCode === null && !s.companyCode;
      const companyLabel = companyCode && companyCode === s.companyCode ? s.companyName : '';
      return `<div class="auth-layout">
        ${authAside(h)}
        <section class="auth-form">
          ${authMark(h)}
          ${authNavigation('login')}
          <div class="auth-form-heading">
            <h1>${ownerLogin ? 'Вход владельца' : 'Вход в Вектор'}</h1>
            <p class="muted">${ownerLogin ? 'Войдите с рабочей почтой и паролем, указанными при регистрации компании.' : companyLabel ? 'Компания: ' + h.esc(companyLabel) : 'Вставьте ссылку компании и введите данные для входа.'}</p>
          </div>
          <form id="login-form" class="stack">
            <p class="auth-error" id="login-error" role="alert" hidden></p>
            <label class="field"><span class="field-label">Ссылка или код компании</span><input class="input" name="company" value="${h.esc(companyCode ?? (demo ? 'astana-service' : ''))}" placeholder="Вставьте ссылку компании" autocomplete="off" required></label>
            <label class="field"><span class="field-label">Логин</span><input class="input" name="login" value="${demo ? 'a.sadykov' : ''}" placeholder="${ownerLogin ? 'Рабочая почта владельца' : 'Логин сотрудника или почта владельца'}" autocomplete="off" required></label>
            <label class="field"><span class="field-label">Пароль</span><input class="input" type="password" name="password" placeholder="${demo ? 'Можно оставить пустым в демо' : 'Введите пароль'}" autocomplete="off"></label>
            <button class="btn btn-primary" type="submit">Войти ${h.icon('arrow-right',18)}</button>
            ${h.btn('Забыли пароль?', 'forgot-password', 'ghost')}
          </form>
          ${ownerLogin ? h.nav('К карточке сотрудника', 'employee', 'ghost', 'arrow-left') : h.btn('Открыть демонстрацию', 'demo-login', 'ghost', 'play')}
          <p class="auth-demo-note">Вход в прототипе использует данные, сохранённые в этом браузере.</p>
        </section>
      </div>`;
    },

    register(s, h) {
      return `<div class="auth-layout">
        ${authAside(h)}
        <section class="auth-form">
          ${authMark(h)}
          ${authNavigation('register')}
          <div class="auth-form-heading">
            <h1>Создать компанию</h1>
            <p class="muted">Создайте аккаунт владельца и получите ссылку для сотрудников.</p>
          </div>
          <form id="register-form" class="stack" aria-describedby="register-demo-note">
            <label class="field"><span class="field-label">Название компании</span><input class="input" name="company" placeholder="Например, Астана Сервис" maxlength="80" required></label>
            <div class="grid-2">
              <label class="field"><span class="field-label">Имя</span><input class="input" name="name" placeholder="Алия" autocomplete="off" required></label>
              <label class="field"><span class="field-label">Фамилия</span><input class="input" name="surname" placeholder="Тлеуберген" autocomplete="off" required></label>
            </div>
            <label class="field"><span class="field-label">Рабочая почта</span><input class="input" type="email" name="email" placeholder="owner@example.com" required autocomplete="off"></label>
            <label class="field"><span class="field-label">Пароль</span><input class="input" type="password" name="password" minlength="6" placeholder="Минимум 6 символов" autocomplete="off" required></label>
            <button class="btn btn-primary" type="submit">Создать компанию ${h.icon('arrow-right',18)}</button>
          </form>
          <p class="auth-demo-note" id="register-demo-note">Демонстрация. Используйте вымышленные данные.</p>
        </section>
      </div>`;
    },

    'owner-recovery'(s, h) {
      return `<div class="auth-layout">
        ${authAside(h)}
        <section class="auth-form">
          ${authMark(h)}
          <div class="auth-form-heading">
            <h1>Восстановление доступа владельца</h1>
            <p class="muted">Введите рабочую почту, указанную при регистрации компании.</p>
          </div>
          <form id="owner-recovery-form" class="stack">
            <p class="auth-error" id="owner-recovery-error" role="alert" hidden></p>
            <label class="field">
              <span class="field-label">Рабочая почта</span>
              <input class="input" type="email" name="email" placeholder="owner@example.com" autocomplete="email" required>
            </label>
            <button class="btn btn-primary" type="submit">Получить демо-ссылку ${h.icon('arrow-right',18)}</button>
          </form>
          <p class="auth-demo-note">В макете ссылка появится на экране. Почта нужна для проверки аккаунта.</p>
          ${h.nav('Вернуться ко входу', 'login', 'ghost', 'arrow-left')}
        </section>
      </div>`;
    },

    'owner-reset'(s, h) {
      const valid = window.Vektor?.ownerResetTokenValid?.();
      return `<div class="auth-layout">
        ${authAside(h)}
        <section class="auth-form">
          ${authMark(h)}
          ${valid ? `
            <div class="auth-form-heading">
              <h1>Новый пароль владельца</h1>
              <p class="muted">Задайте новый пароль для входа в кабинет компании.</p>
            </div>
            <form id="owner-reset-form" class="stack">
              <p class="auth-error" id="owner-reset-error" role="alert" hidden></p>
              <label class="field">
                <span class="field-label">Новый пароль</span>
                <input class="input" type="password" name="password" minlength="6" placeholder="Минимум 6 символов" autocomplete="new-password" required>
              </label>
              <label class="field">
                <span class="field-label">Повторите новый пароль</span>
                <input class="input" type="password" name="confirmation" minlength="6" autocomplete="new-password" required>
              </label>
              <button class="btn btn-primary" type="submit">Сохранить пароль ${h.icon('arrow-right',18)}</button>
            </form>` : `
            <div class="auth-form-heading">
              <h1>Ссылка недействительна</h1>
              <p class="muted">Запросите новую ссылку в том же браузере, где зарегистрировали компанию.</p>
            </div>
            ${h.nav('Получить новую ссылку', 'owner-recovery', 'primary')}`}
          ${h.nav('Вернуться ко входу', 'login', 'ghost', 'arrow-left')}
        </section>
      </div>`;
    },

    'change-password'(s, h) {
      return `<div class="auth-layout">
        ${authAside(h)}
        <section class="auth-form">
          ${authMark(h)}
          <div class="auth-form-heading">
            <p class="eyebrow">ПЕРВЫЙ ВХОД ИЛИ СБРОС</p>
            <h1>Установите новый пароль</h1>
            <p class="muted">Замените временный пароль своим. Затем можно настроить быстрый доступ.</p>
          </div>
          <form id="change-password-form" class="stack">
            <p class="auth-error" id="change-password-error" role="alert" hidden></p>
            <label class="field">
              <span class="field-label">Новый пароль</span>
              <input class="input" type="password" name="password" minlength="6" placeholder="Минимум 6 символов" autocomplete="new-password" required>
            </label>
            <label class="field">
              <span class="field-label">Повторите новый пароль</span>
              <input class="input" type="password" name="confirmation" minlength="6" autocomplete="new-password" required>
            </label>
            <button class="btn btn-primary" type="submit">Сохранить пароль ${h.icon('arrow-right',18)}</button>
          </form>
          ${h.btn('Вернуться ко входу', 'cancel-password-change', 'ghost', 'arrow-left')}
        </section>
      </div>`;
    },

    pin(s, h) {
      return `<div class="auth-layout">${authAside(h)}<section class="auth-form">${authMark(h)}<div class="pin-hero">${h.icon('shield-check',42)}</div><div class="auth-form-heading"><p class="eyebrow">ПОСЛЕДНИЙ ШАГ</p><h1>Быстрый доступ</h1><p class="muted">Настройте PIN, чтобы быстро возвращаться к заданиям на этом устройстве.</p></div><form id="pin-form" class="stack"><label class="field"><span class="field-label">PIN из 6 цифр</span><input class="input pin-input" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" placeholder="••••••" required autocomplete="off" aria-describedby="pin-help"></label><p class="fine-print" id="pin-help">В макете можно использовать 123456. PIN не сохраняется.</p><button type="submit" class="btn btn-primary">Продолжить ${h.icon('arrow-right',18)}</button></form><div class="auth-separator"><span>Другой способ</span></div>${h.btn('Настроить Face ID или отпечаток', 'use-biometric', 'secondary', 'fingerprint')}<p class="fine-print">В макете показан сценарий настройки биометрии.</p><button type="button" class="btn btn-ghost" data-page="tasks">Настроить позже</button></section></div>`;
    }
  });
  // Keep screen-specific refinements isolated from the employee and dispatch views.
  ['review', 'inspection', 'analytics', 'conflicts', 'settings', 'holidays', 'login', 'register', 'owner-recovery', 'owner-reset', 'change-password', 'pin'].forEach(page => {
    const view = window.VektorViews[page];
    window.VektorViews[page] = (s, h) => `<div class="management-page management-page-${page}">${view(s, h)}</div>`;
  });
})();
