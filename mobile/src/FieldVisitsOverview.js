import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { KURMANGAZY_DESTINATIONS, TRIP_CITIES } from './TripDestinations';
import { tripRouteTitle } from './TripRoute';
import { colors, Icon } from './ui';

const filters = [['all', 'Все'], ['assignments', 'На объектах'], ['trips', 'Командировки']];
const taskHistory = new Set(['done', 'cancelled', 'repeated', 'refused', 'declined']);
const taskInProgress = new Set(['travel', 'arrived', 'work', 'paused']);
const shortNames = new Map(KURMANGAZY_DESTINATIONS.map(place => [place.label, place.shortLabel]));
const dateTime = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
const money = new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', maximumFractionDigits: 0 });

function time(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function when(value) {
  const timestamp = time(value);
  return timestamp == null ? '' : dateTime.format(timestamp);
}

function period(start, end) {
  return [when(start), when(end)].filter(Boolean).join(' — ');
}

function tripPlace(destination, stops = []) {
  const routeTitle = tripRouteTitle(stops);
  for (const city of TRIP_CITIES) {
    const prefix = `${city.label} · `;
    if (!destination?.startsWith(prefix)) continue;
    const name = destination.slice(prefix.length);
    return { title: routeTitle ?? shortNames.get(name) ?? name, place: city.label };
  }
  return { title: routeTitle ?? shortNames.get(destination) ?? destination };
}

function offerEntry(offer, employee, canDispatch, open) {
  if (offer.selfRequested) {
    const draft = offer.status === 'awaiting_employee';
    const rejected = offer.status === 'rejected';
    const stages = offer.approvalStages ?? [];
    const pending = stages.find(stage => stage.status === 'waiting');
    const action = draft && employee ? 'Заполнить черновик'
      : !employee && offer.status === 'awaiting_approval' && offer.canDecideApproval ? 'Рассмотреть командировку' : '';
    return {
      key: `offer-${offer.id}`, kind: 'trips', icon: 'briefcase', ...tripPlace(offer.destination, offer.stops),
      person: employee ? null : offer.employeeName,
      description: rejected ? stages.find(stage => stage.status === 'rejected')?.reason ?? offer.purpose : offer.purpose,
      date: period(offer.plannedStart, offer.plannedEnd), amount: offer.estimate?.total,
      status: draft ? 'Черновик' : rejected ? 'Отклонена'
        : pending ? `Согласование · ${pending.position} из ${stages.length}` : 'На согласовании',
      action, open, bucket: rejected ? 'history' : action ? 'action' : 'waiting',
      time: time(offer.updatedAt ?? offer.proposedAt ?? offer.createdAt),
    };
  }
  const declined = offer.status === 'declined';
  const needsEmployee = offer.status === 'awaiting_employee';
  const needsOffice = offer.status === 'awaiting_confirmation';
  const action = employee && needsEmployee ? (offer.revisionReason ? 'Уточнить даты и ставку' : 'Предложить даты и ставку')
    : canDispatch && needsOffice ? 'Согласовать условия' : '';
  const status = declined ? (employee ? 'Вы отказались' : 'Сотрудник отказался')
    : needsEmployee ? (offer.revisionReason ? 'На уточнении' : employee ? 'Ждёт вашего ответа' : 'Ждёт ответа сотрудника')
      : 'Ждёт согласования';
  return {
    key: `offer-${offer.id}`, kind: 'trips', icon: 'briefcase', ...tripPlace(offer.destination, offer.stops),
    person: employee ? null : offer.employeeName, description: declined ? offer.declineReason : offer.purpose,
    date: period(offer.plannedStart, offer.plannedEnd), amount: needsOffice ? offer.estimate?.total : null,
    status, action, open, bucket: declined ? 'history' : action ? 'action' : 'waiting',
    time: time(offer.updatedAt ?? offer.proposedAt ?? offer.createdAt),
  };
}

function tripEntry(trip, employee, open, stops) {
  const finished = trip.status === 'finished';
  const active = trip.status === 'active';
  const end = time(trip.plannedEnd);
  const overdue = !finished && !active && end != null && end < Date.now();
  const visited = stops.filter(stop => stop.visitedAt).length;
  const skipped = stops.filter(stop => stop.skippedAt).length;
  const description = [stops.length ? `Посещено ${visited} из ${stops.length}` : '',
    skipped ? `Пропущено · ${skipped}` : '', trip.taskCount > 0 ? `Заявок · ${trip.taskCount}` : ''].filter(Boolean).join(' · ');
  return {
    key: `trip-${trip.id}`, kind: 'trips', icon: 'briefcase', ...tripPlace(trip.destination, stops),
    person: employee ? null : trip.employeeName, date: period(trip.plannedStart, trip.plannedEnd),
    description,
    status: finished ? 'Завершена' : active ? 'В поездке' : overdue ? 'Срок прошёл' : 'Запланирована', active, overdue,
    next: employee && !finished ? 'Открыть поездку' : '', open,
    bucket: finished ? 'history' : 'upcoming', time: time(trip.finishedAt ?? trip.plannedStart),
  };
}

function requestEntry(item, employee, open) {
  const pending = item.status === 'pending';
  const action = pending && !employee ? 'Рассмотреть запрос' : '';
  return {
    key: `request-${item.id}`, kind: 'trips', icon: 'briefcase', ...tripPlace(item.destination),
    person: employee ? null : item.employeeName, description: item.reason ?? item.purpose,
    date: period(item.plannedStart, item.plannedEnd), status: pending ? 'Ранее поданный запрос' : 'Запрос отклонён',
    action, open, bucket: pending ? (action ? 'action' : 'waiting') : 'history',
    time: time(item.decidedAt ?? item.plannedStart),
  };
}

function taskEntry(task, employee, status, open) {
  const starts = Boolean(task.scheduledAt);
  const date = when(task.scheduledAt ?? task.deadline);
  const action = employee && task.status === 'assigned' ? 'Открыть назначение'
    : employee && task.status === 'rework' ? 'Открыть доработку'
      : !employee && task.status === 'review' ? 'Проверить отчёт' : '';
  return {
    key: `task-${task.id}`, kind: 'assignments', icon: 'pin', title: task.title,
    place: task.object || task.address || 'Точка на карте', person: employee ? null : task.assigneeName || 'Без исполнителя',
    date: date ? `${starts ? 'Начало' : 'Срок'} · ${date}` : '', status: status ?? 'Задание',
    action, open, active: taskInProgress.has(task.status),
    bucket: taskHistory.has(task.status) ? 'history' : action ? 'action' : 'upcoming',
    time: time(task.finishedAt ?? task.scheduledAt ?? task.deadline),
  };
}

function VisitRow({ entry }) {
  const action = entry.action || entry.next;
  const content = <>
    <View style={styles.cardTop}>
      <View style={styles.icon}><Icon name={entry.icon} size={19} /></View>
      <Text style={styles.kind}>{entry.kind === 'trips' ? 'Командировка' : 'На объекте'}</Text>
      <Text style={[styles.badge, entry.bucket === 'action' && styles.badgeAction,
        entry.active && styles.badgeActive, entry.overdue && styles.badgeAction]}>{entry.status}</Text>
      {entry.open && !action && <Icon name="chevron-right" size={16} color="#64748B" />}
    </View>
    <Text style={styles.title}>{entry.title}</Text>
    {entry.place || entry.person ? <Text style={styles.meta}>{[entry.place, entry.person].filter(Boolean).join(' · ')}</Text> : null}
    {entry.date ? <Text style={styles.meta}>{entry.date}</Text> : null}
    {entry.amount != null ? <Text style={styles.title}>{money.format(entry.amount)}</Text> : null}
    {entry.description ? <Text style={styles.meta} numberOfLines={2}>{entry.description}</Text> : null}
    {action ? <View style={[styles.next, entry.action && styles.primaryNext]}>
      <Text style={[styles.nextText, entry.action && styles.primaryNextText]}>{action}</Text>
      <Icon name="arrow-right" size={17} color={entry.action ? '#fff' : '#125DB1'} />
    </View> : null}
  </>;
  return entry.open ? <Pressable accessibilityRole="button" onPress={entry.open}
    style={({ pressed }) => [styles.card, entry.action && styles.actionCard, pressed && styles.pressed]}>
    {content}
  </Pressable> : <View style={styles.card}>{content}</View>;
}

export function TripOfferPreview({ offer, onOpen }) {
  return <VisitRow entry={offerEntry(offer, true, false, onOpen)} />;
}

function Section({ title, entries }) {
  return entries.length > 0 && <View style={styles.section}>
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.count}>{entries.length}</Text>
    </View>
    {entries.map(entry => <VisitRow key={entry.key} entry={entry} />)}
  </View>;
}

function Shortcut({ title, subtitle, icon, primary, expanded, disabled, onPress }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.shortcut, primary && styles.primaryNext, (pressed || disabled) && styles.pressed]}>
    <Icon name={icon} size={20} color={primary ? '#fff' : '#125DB1'} />
    <View style={styles.shortcutLabel}>
      <Text style={[styles.nextText, primary && styles.primaryNextText]}>{title}</Text>
      {subtitle ? <Text style={styles.meta}>{subtitle}</Text> : null}
    </View>
    {subtitle ? <Icon name="chevron-right" size={16} color="#64748B" /> : null}
  </Pressable>;
}

export default function FieldVisitsOverview({ tasks = [], trips = [], offers = [], requests = [], employee = false,
  canDispatch = false, filter = 'all', onFilter, onTask, onTrip, onOffer, onRequest, onCreateTask, onCreateTrip,
  createTripDisabled, tripCreateHint, onImportTrip, importTripDisabled, onSetupApproval, onControl,
  taskStatuses = {}, loading = false }) {
  const [showHistory, setShowHistory] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const tripById = new Map(trips.map(trip => [String(trip.id), trip]));
  const routeByTrip = new Map(offers.filter(offer => offer.tripId && offer.stops?.length)
    .map(offer => [String(offer.tripId), offer.stops]));
  const standaloneTasks = tasks.filter(task => {
    const trip = tripById.get(String(task.tripId));
    if (trip && (trip.status !== 'finished' || taskHistory.has(task.status))) return false;
    return !employee || (task.status !== 'unassigned' && (task.object || task.address || task.objectId || task.location));
  });
  const entries = [
    ...offers.filter(offer => offer.status !== 'confirmed' && (employee || !offer.selfRequested || offer.status !== 'awaiting_employee'))
      .map(offer => offerEntry(offer, employee, canDispatch, () => onOffer(offer.id))),
    ...requests.filter(item => item.status !== 'approved').map(item => requestEntry(item, employee, () => onRequest(item.id))),
    ...trips.map(trip => tripEntry(trip, employee, () => onTrip(trip.id), routeByTrip.get(String(trip.id)) ?? [])),
    ...standaloneTasks.map(task => taskEntry(task, employee, taskStatuses[task.status], onTask && (() => onTask(task.id)))),
  ].filter(entry => filter === 'all' || entry.kind === filter);
  const action = entries.filter(entry => entry.bucket === 'action');
  const upcoming = entries.filter(entry => entry.bucket === 'upcoming').sort((a, b) =>
    Number(Boolean(b.active)) - Number(Boolean(a.active)) || Number(Boolean(a.overdue)) - Number(Boolean(b.overdue))
    || (a.time ?? Infinity) - (b.time ?? Infinity));
  const waiting = entries.filter(entry => entry.bucket === 'waiting');
  const history = entries.filter(entry => entry.bucket === 'history').sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const showTripActions = filter !== 'assignments';
  const createTrip = showTripActions ? onCreateTrip : null;
  const createTask = filter !== 'trips' ? onCreateTask : null;
  const importTrip = showTripActions ? onImportTrip : null;
  const setup = showTripActions ? onSetupApproval : null;

  return <View style={styles.screen}>
    <View style={styles.filters}>
      {filters.map(([key, label]) => <Pressable key={key} accessibilityRole="tab"
        accessibilityState={{ selected: filter === key }} onPress={() => { setChoosing(false); onFilter(key); }}
        style={[styles.filter, filter === key && styles.filterActive]}>
        <Text style={[styles.filterText, filter === key && styles.filterTextActive]}>{label}</Text>
      </Pressable>)}
    </View>
    {(createTrip || createTask || importTrip || setup || onControl) && <View style={styles.shortcuts}>
      {createTrip && createTask ? <Shortcut title="Создать" icon="plus" primary
        expanded={choosing} onPress={() => setChoosing(value => !value)} />
        : createTrip ? <Shortcut title="Новая командировка" icon="plus" primary
          disabled={createTripDisabled} onPress={createTrip} />
          : createTask ? <Shortcut title="Новое выездное задание" icon="plus" primary onPress={createTask} /> : null}
      {importTrip && <Shortcut title="Импорт Excel" icon="upload" disabled={importTripDisabled} onPress={importTrip} />}
      {setup && <Shortcut title="Настроить согласование" icon="settings" onPress={setup} />}
      {onControl && <Shortcut title="Контроль" icon="chart" onPress={onControl} />}
    </View>}
    {createTrip && tripCreateHint ? <Text accessibilityLiveRegion="polite" style={styles.meta}>{tripCreateHint}</Text> : null}
    {choosing && <View style={styles.section}>
      {onCreateTask && <Shortcut title="Выездное задание" subtitle="Работа на объекте в назначенное время" icon="pin"
        onPress={onCreateTask} />}
      {onCreateTrip && <Shortcut title="Командировка" subtitle="Поездка с согласованием дат и оплаты" icon="briefcase"
        disabled={createTripDisabled} onPress={onCreateTrip} />}
    </View>}
    <Section title="Нужно действие" entries={action} />
    <Section title="Сегодня и ближайшие" entries={upcoming} />
    <Section title="Ожидают ответа" entries={waiting} />
    {history.length > 0 && <View style={styles.section}>
      <Shortcut title={`История · ${history.length}`} icon="clock" expanded={showHistory}
        onPress={() => setShowHistory(value => !value)} />
      {showHistory && history.map(entry => <VisitRow key={entry.key} entry={entry} />)}
    </View>}
    {!entries.length && <View style={styles.empty}>
      <Icon name={loading ? 'clock' : 'briefcase'} size={24} />
      <Text style={styles.title}>{loading ? 'Загружаем выезды…' : filter === 'trips' ? 'Командировок пока нет'
        : filter === 'assignments' ? 'Выездных заданий пока нет' : 'Выездов пока нет'}</Text>
      {!loading && employee && <Text style={styles.meta}>{filter === 'assignments'
        ? 'Здесь появятся выезды, которые назначит руководитель.' : 'Здесь появятся ваши заявки на командировку и выезды.'}</Text>}
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  screen: { gap: 15 },
  filters: { flexDirection: 'row', backgroundColor: '#E8EEF7', borderRadius: 12, padding: 4, gap: 4 },
  filter: { flex: 1, minHeight: 44, padding: 5, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  filterActive: { backgroundColor: '#fff' },
  filterText: { color: '#52647D', fontSize: 13, textAlign: 'center', fontWeight: '600' },
  filterTextActive: { color: '#125DB1', fontWeight: '700' },
  section: { gap: 8 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '800', flexShrink: 1 },
  count: { backgroundColor: colors.tint, color: '#125DB1', paddingVertical: 3, paddingHorizontal: 8,
    borderRadius: 10, fontSize: 12, fontWeight: '700' },
  card: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12, gap: 5 },
  actionCard: { borderColor: '#BAD8FF' },
  cardTop: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  icon: { width: 32, height: 32, borderRadius: 9, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' },
  kind: { flexGrow: 1, color: '#52647D', fontSize: 12, fontWeight: '600' },
  badge: { maxWidth: '100%', borderRadius: 8, color: '#475A73', backgroundColor: '#EDF2F9', fontSize: 11,
    fontWeight: '700', paddingHorizontal: 7, paddingVertical: 5 },
  badgeAction: { color: '#795100', backgroundColor: '#FFF1D9' },
  badgeActive: { color: '#166947', backgroundColor: '#E8F9F0' },
  title: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  meta: { color: '#52647D', fontSize: 13, lineHeight: 18 },
  next: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, minHeight: 40,
    gap: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.tint, borderRadius: 9 },
  nextText: { flexShrink: 1, color: '#125DB1', fontSize: 14, fontWeight: '700' },
  primaryNext: { backgroundColor: '#166BD6' },
  primaryNextText: { color: '#fff' },
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  shortcut: { flexDirection: 'row', alignItems: 'center', minHeight: 44, padding: 10, gap: 8,
    borderRadius: 10, backgroundColor: colors.tint },
  shortcutLabel: { flexShrink: 1, gap: 2 },
  pressed: { opacity: 0.7 },
  empty: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14, gap: 7 },
});
