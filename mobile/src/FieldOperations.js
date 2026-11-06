import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { colors, Icon } from './ui';
import DeadlinePicker, { deadlineToIso } from './DeadlinePicker';
import { TripBudgetFields, TripBudgetSummary, tripBudgetDraft, tripBudgetPayload } from './TripBudget';
import { KURMANGAZY_DESTINATIONS, TRIP_CITIES } from './TripDestinations';
import DispatcherTripOffer from './DispatcherTripOffer';
import { TripOfferCard, TripOfferHistory } from './TripOfferCard';
import FieldVisitsOverview, { TripOfferPreview } from './FieldVisitsOverview';
import { tripRouteTitle, TripRouteEditor, TripRouteSummary, validTripRoute } from './TripRoute';
import { TripActualExpenses } from './TripActualExpenses';
import { TripApprovalProgress, TripApprovalReview, TripApprovalSettings } from './TripApprovals';
import TripImport from './TripImport';

export const TASK_STATUS = {
  assigned: 'Назначена', unassigned: 'Без исполнителя', accepted: 'Принята сотрудником',
  travel: 'В пути', arrived: 'На объекте', work: 'В работе', paused: 'На паузе',
  review: 'Ожидает приёмки', done: 'Принята', rework: 'На доработке',
  repeated: 'Требуется повторный выезд', cancelled: 'Отменена',
  refused: 'Отказ сотрудника', declined: 'Отказ сотрудника', reopened: 'Переоткрыта',
};
const TRIP_STATUS = { planned: 'Запланирована', active: 'В командировке', finished: 'Завершена' };
const REQUEST_STATUS = { pending: 'На согласовании', approved: 'Согласована', declined: 'Отклонена' };
const DAY_FORMAT = { day: 'numeric', month: 'short', year: 'numeric' };
const ACTIVE_TASKS = new Set(['assigned', 'accepted', 'travel', 'arrived', 'work', 'paused', 'rework', 'unassigned']);
const UNLINKABLE = new Set(['unassigned', 'cancelled', 'repeated', 'refused', 'declined']);
const ALERTS = {
  unfinished: 'Не завершена к сроку',
  overdue: 'Отчёт отправлен после срока',
  representativePending: 'Ожидает подтверждения представителя',
  representativeRemark: 'Есть замечание представителя',
  missingBefore: 'Не хватает фото «до»',
  missingAfter: 'Не хватает фото «после»',
  outsideGeofence: 'Отметка за пределами геозоны',
  uncertainGeofence: 'Низкая точность геолокации',
  arrivalNoGps: 'Прибытие отмечено без GPS',
  photoNoGps: 'Фото без GPS',
  checklistProblem: 'Выявлена проблема в чек-листе',
  syncDelay: 'Отметка получена с задержкой',
};
const METRICS = [
  ['assigned', 'Назначено'], ['completed', 'Принято'], ['firstVisitCompleted', 'С первого выезда'],
  ['repeatTrips', 'Повторных выездов'], ['problems', 'Проблем в чек-листах'],
  ['pendingRepresentative', 'Ждут представителя'], ['averageWorkMinutes', 'Среднее время работы'],
  ['overdue', 'Просрочено'],
];

function formatTime(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(+date) ? date.toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : '—';
}

function formatMinutes(value) {
  if (value == null) return '—';
  if (value < 60) return `${value} мин`;
  const hours = Math.floor(value / 60);
  const minutes = Math.round((value % 60) * 10) / 10;
  return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
}

function useResource(request, path, paused = false) {
  const [value, setValue] = useState(null);
  const [failure, setFailure] = useState(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!request || !path || paused) return;
    const version = ++generation.current;
    try {
      const result = await request(path);
      if (generation.current === version) {
        setValue(result);
        setFailure(null);
      }
    } catch (reason) {
      if (generation.current === version) setFailure(reason);
    }
  }, [request, path, paused]);
  const applyUpdate = useCallback(update => {
    // A poll started before the write may still return the old report.
    generation.current++;
    setValue(current => current ? update(current) : current);
    setFailure(null);
  }, []);
  useEffect(() => {
    if (!path || paused || !request) return;
    void reload();
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') void reload(); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') void reload(); }, 15000);
    return () => {
      generation.current++;
      foreground.remove();
      clearInterval(timer);
    };
  }, [reload, path, paused, request]);
  return { value, error: failure ? failure.message || 'Не удалось получить данные.' : '',
    errorStatus: failure?.status, reload, applyUpdate };
}

function useAction() {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(operation) {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
      return true;
    } catch (reason) {
      setError(reason.message || 'Не удалось сохранить изменения.');
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run, clearError: () => setError('') };
}

function Button({ children, selected = false, disabled = false, onPress }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, selected && styles.selected, (pressed || disabled) && styles.dim]}>
      <Text style={[styles.buttonText, selected && styles.selectedText]}>{children}</Text>
    </Pressable>
  );
}

function Card({ title, children, icon }) {
  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        {icon && <Icon name={icon} size={20} />}
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function Notice({ message }) {
  return message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null;
}

function TaskLink({ task, onTask }) {
  const content = (
    <View style={styles.taskRow}>
      <View style={styles.fill}>
        <Text style={styles.label}>№{task.id} · {task.title}</Text>
        <Text style={styles.muted}>{task.object} · {TASK_STATUS[task.status] ?? task.status}</Text>
      </View>
      {onTask && <Icon name="chevron-right" size={16} color={colors.muted} />}
    </View>
  );
  return onTask ? <Pressable accessibilityRole="button" onPress={() => onTask(task.id)}>{content}</Pressable> : content;
}

function FieldBoard({ board, request, reload, onTask, onTrip }) {
  const [tab, setTab] = useState('active');
  const [fieldOnly, setFieldOnly] = useState(false);
  const action = useAction();
  const people = board.employees.filter(person => !fieldOnly || person.workMode === 'field');
  const alerts = board.tasks.filter(task => task.alerts.length);
  const tasks = tab === 'active' ? board.tasks.filter(task => ACTIVE_TASKS.has(task.status))
    : tab === 'alerts' ? alerts : board.tasks;
  function changeMode(person, mode) {
    void action.run(async () => {
      await request('/field-control/work-mode', { method: 'POST', body: { employeeId: person.id, workMode: mode } });
      await reload();
    });
  }

  return (
    <>
      <Card title="Показатели полевой работы" icon="chart">
        <View style={styles.grid}>
          {METRICS.map(([key, label]) => (
            <View key={key} style={styles.metric}>
              <Text style={styles.metricValue}>{key === 'averageWorkMinutes'
                ? formatMinutes(board.metrics[key]) : board.metrics[key]}</Text>
              <Text style={styles.muted}>{label}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.muted}>По всем заявкам компании. Среднее время учитывает рабочие этапы без дороги и пауз.</Text>
      </Card>
      <Card title="Сотрудники и последние отметки" icon="users">
        <Text style={styles.muted}>Данные на {formatTime(board.serverTime)}</Text>
        <View style={styles.choices}>
          <Button selected={!fieldOnly} onPress={() => setFieldOnly(false)}>Все сотрудники</Button>
          <Button selected={fieldOnly} onPress={() => setFieldOnly(true)}>Выездной график</Button>
        </View>
        <Notice message={action.error} />
        {people.length === 0 && <Text style={styles.muted}>Сотрудников в этом списке пока нет.</Text>}
        {people.map(person => (
          <View key={person.id} style={styles.inset}>
            <Text style={styles.label}>{person.name}{person.department ? ` · ${person.department}` : ''}</Text>
            <View style={styles.choices}>
              <Button disabled={action.busy || person.workMode === 'stationary'} selected={person.workMode === 'stationary'}
                onPress={() => changeMode(person, 'stationary')}>Стационарный</Button>
              <Button disabled={action.busy || person.workMode === 'field'} selected={person.workMode === 'field'}
                onPress={() => changeMode(person, 'field')}>Выездной</Button>
            </View>
            {person.trip && <Button onPress={() => onTrip(person.trip.id)}>
              {TRIP_STATUS[person.trip.status]} · {person.trip.destination}{person.trip.overdue ? ' · срок истёк' : ''}
            </Button>}
            {person.currentTask ? <TaskLink task={person.currentTask} onTask={onTask} />
              : <Text style={styles.muted}>Нет активных заявок</Text>}
            {person.activeAssignments > 1 && <Text style={styles.muted}>Активных заявок · {person.activeAssignments}</Text>}
            {person.lastEvent && <Text style={styles.muted}>
              Последнее действие · {TASK_STATUS[person.lastEvent.status] ?? person.lastEvent.status} · {formatTime(person.lastEvent.occurredAt)}
            </Text>}
            <Text style={styles.muted}>{person.lastReceivedAt
              ? `Последняя отметка получена · ${formatTime(person.lastReceivedAt)}`
              : person.lastLoginAt ? `Последний вход · ${formatTime(person.lastLoginAt)}` : 'Отметок и входов пока нет'}</Text>
          </View>
        ))}
      </Card>
      <Card title="Заявки и отклонения" icon="clipboard">
        <View style={styles.choices}>
          <Button selected={tab === 'active'} onPress={() => setTab('active')}>Активные</Button>
          <Button selected={tab === 'alerts'} onPress={() => setTab('alerts')}>Отклонения · {alerts.length}</Button>
          <Button selected={tab === 'all'} onPress={() => setTab('all')}>Все</Button>
        </View>
        {tasks.length === 0 && <Text style={styles.muted}>По этому фильтру заявок нет.</Text>}
        {tasks.map(task => (
          <View key={task.id} style={styles.inset}>
            <TaskLink task={task} onTask={onTask} />
            <Text style={styles.muted}>{task.assigneeName ?? 'Без исполнителя'}{task.deadline ? ` · срок ${formatTime(task.deadline)}` : ''}</Text>
            {task.representativeStatus === 'confirmed' && <Text style={styles.success}>Представитель подтвердил</Text>}
            {task.alerts.map(alert => <Text key={alert} style={styles.warning}>{ALERTS[alert] ?? alert}</Text>)}
            {task.lastEvent?.delaySeconds >= 300 && <Text style={styles.muted}>
              Действие {formatTime(task.lastEvent.occurredAt)} · получено {formatTime(task.lastEvent.receivedAt)}
            </Text>}
          </View>
        ))}
      </Card>
    </>
  );
}

function Field({ label, value, onChange, disabled, limit, placeholder, multiline = false }) {
  return (
    <View style={styles.fill}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} maxLength={limit}
        editable={!disabled} placeholder={placeholder} placeholderTextColor={colors.muted} multiline={multiline}
        style={[styles.input, multiline && styles.multiline]} />
    </View>
  );
}

function tripDay(value) {
  const day = new Date(value);
  if (!value || !Number.isFinite(+day)) return null;
  day.setHours(0, 0, 0, 0);
  return day;
}

function formatPeriod(start, end) {
  const first = tripDay(start);
  const last = tripDay(end);
  if (!first || !last) return 'Даты не указаны';
  const lastLabel = last.toLocaleDateString('ru-RU', DAY_FORMAT);
  return +first === +last ? lastLabel : `${first.toLocaleDateString('ru-RU', {
    ...DAY_FORMAT, year: first.getFullYear() !== last.getFullYear() ? 'numeric' : undefined,
  })} — ${lastLabel}`;
}

function tripPlanLabel(trip) {
  const start = new Date(trip.plannedStart);
  const end = new Date(trip.plannedEnd);
  const isFullDay = +start === +tripDay(start) && end.getHours() === 23 && end.getMinutes() === 59;
  return isFullDay ? formatPeriod(trip.plannedStart, trip.plannedEnd)
    : `${formatTime(trip.plannedStart)} — ${formatTime(trip.plannedEnd)}`;
}

function TripTaskOptions({ tasks, selected, onChange, disabled }) {
  return <>
    {tasks.length ? tasks.map(task => {
      const id = String(task.id);
      const checked = selected.includes(id);
      const blocked = disabled || (!checked && selected.length >= 50);
      return <Pressable key={id} accessibilityRole="checkbox" accessibilityState={{ checked, disabled: blocked }}
        disabled={blocked} onPress={() => onChange(checked ? selected.filter(value => value !== id) : [...selected, id])}
        style={({ pressed }) => [styles.taskOption, checked && styles.taskOptionChecked, (pressed || blocked) && styles.dim]}>
        <View style={styles.fill}>
          <Text style={styles.label}>№{id} · {task.title}</Text>
          {task.object ? <Text style={styles.muted}>{task.object}</Text> : null}
        </View>
        {checked && <Icon name="check" size={18} />}
      </Pressable>;
    }) : <Text style={styles.muted}>Нет доступных заявок.</Text>}
  </>;
}

function eligibleTripTasks(tasks, employeeId) {
  return tasks.filter(task => (employeeId == null || String(task.assigneeId) === String(employeeId))
    && !UNLINKABLE.has(task.status) && !task.tripId);
}

export function VisitOptionPicker({ label, icon, options, selected, onSelect, disabled, empty, visibleLimit = 12 }) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const multiple = Array.isArray(selected);
  const current = multiple ? null : options.find(option => option.id === selected);
  const query = search.trim().toLocaleLowerCase('ru-RU');
  const filtered = options.filter(option => `${option.label} ${option.detail ?? ''}`.toLocaleLowerCase('ru-RU').includes(query));
  const count = multiple && selected.length ? `Выбрано · ${selected.length}` : '';
  function close() {
    setSearch('');
    setExpanded(false);
  }

  return <View style={styles.picker}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded, disabled }}
      accessibilityLabel={[label, current?.label || count].filter(Boolean).join('. ')} disabled={disabled}
      onPress={() => setExpanded(!expanded)} style={({ pressed }) => [styles.pickerButton, pressed && styles.dim]}>
      <View style={styles.pickerIcon}><Icon name={icon} size={19} /></View>
      <View style={styles.fill}>
        <Text style={styles.label}>{current?.label ?? label}</Text>
        {current?.detail ? <Text style={styles.muted}>{current.detail}</Text> : null}
        {count ? <Text style={styles.muted}>{count}</Text> : null}
      </View>
      <Icon name={expanded ? 'close' : 'chevron-right'} size={17} color={colors.muted} />
    </Pressable>
    {expanded && <>
      {options.length > 5 && <TextInput accessibilityLabel={`Поиск · ${label}`} value={search}
        onChangeText={setSearch} placeholder="Поиск" placeholderTextColor={colors.muted}
        editable={!disabled} style={styles.input} />}
      {filtered.slice(0, visibleLimit).map(option => {
        const checked = multiple ? selected.includes(option.id) : selected === option.id;
        return <Pressable key={option.id} accessibilityRole={multiple ? 'checkbox' : 'radio'}
          accessibilityState={{ checked, disabled }} disabled={disabled}
          onPress={() => {
            if (multiple) onSelect(checked ? selected.filter(id => id !== option.id) : [...selected, option.id]);
            else { onSelect(option.id); close(); }
          }} style={[styles.taskOption, checked && styles.taskOptionChecked]}>
          <View style={styles.fill}><Text style={styles.label}>{option.label}</Text>
            {option.detail ? <Text style={styles.muted}>{option.detail}</Text> : null}
          </View>
          {checked && <Icon name="check" size={16} />}
        </Pressable>;
      })}
      {!filtered.length && <Text style={styles.muted}>{query ? 'По этому запросу ничего нет.' : empty}</Text>}
      {filtered.length > visibleLimit && <Text style={styles.muted}>Уточните поиск, чтобы увидеть нужный вариант.</Text>}
      {multiple && <Button onPress={close}>Готово</Button>}
    </>}
  </View>;
}

const MAX_TRIP_ORGANIZATIONS = 30;

function organizationKey(name) {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function TripForm({ request, objects = [], onCreated, onCancel, offline = false,
  companyOrganizations = [], onAddOrganization,
  loadingCapabilities = false, capabilitiesError = '', approvalSettings = null, approvalSettingsError = '' }) {
  const [objectId, setObjectId] = useState(null);
  const [placeSource, setPlaceSource] = useState('organizations');
  const [organizations, setOrganizations] = useState([]);
  const [addingOrganization, setAddingOrganization] = useState(false);
  const [newOrganization, setNewOrganization] = useState('');
  const [city, setCity] = useState('');
  const [destination, setDestination] = useState('');
  const [purpose, setPurpose] = useState('');
  const [comment, setComment] = useState('');
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  const [budgetDraft, setBudgetDraft] = useState(() => tripBudgetDraft(null));
  const [visitSchedule, setVisitSchedule] = useState([]);
  const submission = useRef(null);
  const action = useAction();
  const catalogAction = useAction();
  const busy = action.busy || catalogAction.busy;
  const blocked = offline || loadingCapabilities || Boolean(capabilitiesError);
  const catalog = new Map(KURMANGAZY_DESTINATIONS.map(option => [organizationKey(option.label), option]));
  for (const { name } of companyOrganizations) {
    const key = organizationKey(name);
    if (!catalog.has(key)) catalog.set(key, { id: name, label: name });
  }
  const organizationOptions = [...catalog.values()];
  const atLimit = organizations.length >= MAX_TRIP_ORGANIZATIONS;
  const canAddOrganization = Boolean(onAddOrganization && !blocked && !busy && !atLimit);
  const selectedObject = objects.find(object => String(object.id) === objectId);
  const cityName = city.trim();
  const manualName = destination.trim();
  let visitNames = [];
  if (placeSource === 'organizations') visitNames = organizations;
  if (placeSource === 'manual' && manualName) visitNames = [manualName];
  const withCity = name => cityName ? `${cityName} · ${name}` : name;
  const routeStops = placeSource === 'directory' && selectedObject
    ? [{ id: `object:${objectId}`, destination: withCity(selectedObject.name) }]
    : visitNames.map(name => ({ id: `${placeSource}:${name}`, destination: withCity(name) }));
  const placeTooLong = routeStops.some(stop => Array.from(stop.destination).length > 300);
  const routeNames = new Map(routeStops.map(stop => [stop.id, stop.destination]));
  const route = visitSchedule.filter(stop => routeNames.has(stop.id));
  for (const stop of routeStops) {
    if (!route.some(item => item.id === stop.id)) route.push({ id: stop.id, plannedAt: null });
  }
  let place;
  if (placeSource === 'directory' && selectedObject) {
    place = { objectId, scheduleVisit: true, ...(cityName ? { city: cityName } : {}) };
  } else if (route.length) {
    place = { destinations: route.map(stop => routeNames.get(stop.id)) };
  } else if (placeSource === 'organizations' && cityName) {
    place = { destination: cityName };
  }
  const plannedStart = deadlineToIso(start);
  const plannedEnd = deadlineToIso(end);
  const validPeriod = plannedStart && plannedEnd && end > start;
  const budget = tripBudgetPayload(budgetDraft);
  const approvedRoute = approvalSettings?.configured === true && !approvalSettingsError;
  const ready = !blocked && !busy && !placeTooLong && !(placeSource === 'organizations' && addingOrganization)
    && Boolean(place && purpose.trim() && approvedRoute && validPeriod && budget?.dailyRate != null
      && validTripRoute(route, routeStops, plannedStart, plannedEnd));

  function closeOrganizationEditor() {
    setAddingOrganization(false);
    setNewOrganization('');
    catalogAction.clearError();
  }

  function addOrganization() {
    const name = newOrganization.trim();
    if (!canAddOrganization || !name) return;
    function selectOrganization(selectedName) {
      setOrganizations(previous => previous.includes(selectedName) ? previous : [...previous, selectedName]);
      closeOrganizationEditor();
    }
    const existing = catalog.get(organizationKey(name));
    if (existing) {
      selectOrganization(existing.id);
      return;
    }
    void catalogAction.run(async () => {
      const savedName = await onAddOrganization(name);
      selectOrganization(catalog.get(organizationKey(savedName))?.id ?? savedName);
    });
  }

  function save() {
    if (!ready) return;
    void action.run(async () => {
      const body = { ...place, purpose: purpose.trim(), comment: comment.trim(), plannedStart, plannedEnd, ...budget,
        ...(route.length ? { visitTimes: route.map(stop => stop.plannedAt) } : {}) };
      const draft = JSON.stringify(body);
      if (submission.current?.draft !== draft) submission.current = { draft, requestId: randomUUID() };
      const { offer } = await request('/trip-offers', {
        method: 'POST', body: { ...body, requestId: submission.current.requestId },
      });
      onCreated(offer.id, offer);
    });
  }
  return (
    <View style={styles.screen}>
      <View style={styles.choices}><Button disabled={busy} onPress={onCancel}>‹ К выездам</Button></View>
      <Card title="Новая командировка" icon="pin">
        <Field label="Город" value={city} onChange={setCity} limit={300}
          disabled={busy} placeholder="Введите название города" />
        <View style={styles.choices}>
          {TRIP_CITIES.map(item => <Button key={item.id} selected={cityName === item.id} disabled={busy}
            onPress={() => setCity(item.id)}>{item.label}</Button>)}
        </View>
        <Text style={styles.muted}>Можно указать только город или добавить организации и объекты ниже.</Text>
        <Text style={styles.label}>Организации и объекты</Text>
        {placeSource === 'organizations' && <>
          <VisitOptionPicker label="Выбрать организации" icon="building"
            options={organizationOptions} selected={organizations}
            onSelect={value => { if (value.length <= MAX_TRIP_ORGANIZATIONS) setOrganizations(value); }}
            disabled={busy} visibleLimit={50} />
          <Text style={styles.muted}>{organizationOptions.length} организаций</Text>
          {onAddOrganization && (addingOrganization ? <View style={styles.inset}>
            <Field label="Название организации" value={newOrganization} onChange={setNewOrganization} limit={300}
              disabled={busy} placeholder="Введите полное название" />
            <Notice message={catalogAction.error} />
            <View style={styles.choices}>
              <Button selected disabled={!canAddOrganization || !newOrganization.trim()} onPress={addOrganization}>
                {catalogAction.busy ? 'Сохраняем…' : 'Сохранить организацию'}
              </Button>
              <Button disabled={busy} onPress={closeOrganizationEditor}>Отмена</Button>
            </View>
          </View> : <View style={styles.choices}>
            <Button disabled={!canAddOrganization} onPress={() => setAddingOrganization(true)}>Добавить организацию</Button>
          </View>)}
          {organizations.length > 0 && <View style={styles.inset}>
            <Text style={styles.label}>Организации в поездке</Text>
            {organizations.map(organization => <Text key={organization} style={styles.body}>
              {KURMANGAZY_DESTINATIONS.find(place => place.id === organization)?.shortLabel ?? organization}
            </Text>)}
          </View>}
          {atLimit && <Text style={styles.warning}>
            В маршруте максимум {MAX_TRIP_ORGANIZATIONS} организаций. Уберите одну, чтобы добавить другую.
          </Text>}
        </>}
        {placeSource === 'directory' && <VisitOptionPicker label="Выбрать объект" icon="building" selected={objectId} onSelect={setObjectId}
          disabled={busy} empty="В справочнике пока нет объектов."
          options={objects.map(object => ({ id: String(object.id), label: object.name, detail: object.address }))} />}
        {placeSource === 'manual' && <Field label="Объект или адрес" value={destination} onChange={setDestination} limit={300}
          disabled={busy} placeholder="Укажите место поездки" />}
        <View style={styles.choices}>
          {placeSource !== 'organizations' && <Button disabled={busy}
            onPress={() => setPlaceSource('organizations')}>Список организаций</Button>}
          {placeSource !== 'directory' && objects.length > 0 && <Button disabled={busy}
            onPress={() => setPlaceSource('directory')}>Из справочника</Button>}
          {placeSource !== 'manual' && <Button disabled={busy}
            onPress={() => setPlaceSource('manual')}>Другой объект или адрес</Button>}
        </View>
        {placeTooLong && <Text style={styles.warning}>Город и название объекта вместе должны быть не длиннее 300 символов.</Text>}
      </Card>
      <Card title="Задание поездки" icon="clipboard">
        <Field label="Что нужно сделать" value={purpose} onChange={setPurpose} limit={1000} disabled={busy}
          placeholder="Например, проверить и настроить оборудование" multiline />
        <Field label="Комментарий · необязательно" value={comment} onChange={setComment} limit={1000}
          disabled={busy} placeholder="Контакты на месте или важные детали" multiline />
      </Card>
      <Card title="Период командировки" icon="calendar">
        <DeadlinePicker label="Начало поездки" value={start} onChange={setStart} required showQuick={false}
          showHelper={false} disabled={busy} />
        <DeadlinePicker label="Окончание поездки" value={end} onChange={setEnd} required showQuick={false}
          showHelper={false} suggestedDate={start ?? undefined} minimumDate={start ?? undefined} disabled={busy} />
        {plannedStart && plannedEnd && !validPeriod && <Text style={styles.warning}>Окончание должно быть позже начала.</Text>}
      </Card>
      <TripRouteEditor stops={routeStops} value={route} onChange={setVisitSchedule}
        start={plannedStart} end={plannedEnd} disabled={busy} />
      <Card title="Ставка и расходы" icon="briefcase">
        <Text style={styles.muted}>Укажите ставку в тенге за день. Если оплата по ставке не нужна, введите 0.</Text>
        <TripBudgetFields value={budgetDraft} onChange={setBudgetDraft} start={plannedStart} end={plannedEnd}
          disabled={busy} collapseExpenses />
      </Card>
      <Card title="Маршрут согласования" icon="check">
        {approvedRoute && <Text style={styles.muted}>Заявка пройдёт эти этапы по очереди.</Text>}
        {approvalSettings?.stages?.map(stage => <View key={stage.position} style={styles.inset}>
          <Text style={styles.label}>{stage.position}. {stage.title}</Text>
          <Text style={styles.body}>{stage.approverName || 'Согласующий не назначен'}</Text>
        </View>)}
        <Notice message={approvalSettingsError} />
        {!approvalSettings && !approvalSettingsError && !offline && <Text style={styles.muted}>Загружаем маршрут согласования…</Text>}
        {approvalSettings && !approvalSettings.configured && <Text style={styles.warning}>
          Руководителю нужно настроить согласование, прежде чем вы сможете отправить командировку.
        </Text>}
      </Card>
      {offline && <Text style={styles.warning}>Подключитесь к интернету, чтобы отправить командировку.</Text>}
      {loadingCapabilities && <Text style={styles.muted}>Проверяем возможности сервера…</Text>}
      <Notice message={action.error || capabilitiesError} />
      <Button selected disabled={!ready} onPress={save}>
        {action.busy ? 'Отправляем…' : 'Отправить на согласование'}
      </Button>
    </View>
  );
}

function TripRequestDetails({ item, request, employee, tasks, onBack, onDecided, onTrip }) {
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [editingTasks, setEditingTasks] = useState(false);
  const [periodDraft, setPeriodDraft] = useState(() => ({
    start: new Date(item.plannedStart), end: new Date(item.plannedEnd),
  }));
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState(() => tripBudgetDraft(null));
  const [taskIds, setTaskIds] = useState(() => (item.taskIds ?? []).map(String));
  const action = useAction();
  const canDecide = !employee && item.status === 'pending';
  const available = eligibleTripTasks(tasks, item.employeeId);
  const plannedStart = deadlineToIso(periodDraft.start);
  const plannedEnd = deadlineToIso(periodDraft.end);
  const period = adjusting && plannedStart && plannedEnd && plannedEnd > plannedStart ? { plannedStart, plannedEnd } : null;
  const budget = tripBudgetPayload(budgetDraft);
  const conflicts = item.conflicts;
  const changedDates = item.approvedStart && item.approvedEnd
    && (item.approvedStart !== item.plannedStart || item.approvedEnd !== item.plannedEnd);

  function decide(decision) {
    void action.run(async () => {
      const body = decision === 'approve' ? {
        decision, ...period, taskIds, ...(budget && Object.keys(budget).length ? { budget } : {}),
      } : { decision, reason: reason.trim() };
      const result = await request(`/trip-requests/${encodeURIComponent(item.id)}/decision`, { method: 'POST', body });
      onDecided(result.request);
    });
  }

  return <>
    <View style={styles.choices}><Button disabled={action.busy} onPress={onBack}>К выездам</Button></View>
    <Card title={item.destination} icon="briefcase">
      <TripStatus status={item.status} isRequest />
      {!employee && <Text style={styles.label}>{item.employeeName}</Text>}
      <Text style={styles.body}>{tripPlanLabel({ plannedStart: item.approvedStart ?? item.plannedStart,
        plannedEnd: item.approvedEnd ?? item.plannedEnd })}</Text>
      {changedDates && <Text style={styles.muted}>Запрошенный период · {tripPlanLabel(item)}</Text>}
      <Text style={styles.body}>{item.purpose}</Text>
      {item.estimate ? <TripBudgetSummary title={employee ? 'Мой расчёт' : 'Расчёт сотрудника'} value={item.estimate} /> : null}
      {item.reason ? <Text style={styles.muted}>{item.status === 'declined' ? 'Причина отказа' : 'Комментарий'} · {item.reason}</Text> : null}
      {item.status === 'pending' && !adjusting && (conflicts?.shifts?.length > 0 || conflicts?.trips?.length > 0) && <View style={styles.inset}>
        <Text style={styles.label}>Пересечения в графике</Text>
        {conflicts.shifts?.map(shift => <Text key={`shift-${shift.id}`} style={styles.warning}>
          {shift.kind === 'duty' ? 'Дежурство' : 'Смена'} · {formatTime(shift.startsAt)} — {formatTime(shift.endsAt)}
        </Text>)}
        {conflicts.trips?.map(trip => <Text key={`trip-${trip.id}`} style={styles.warning}>
          {trip.destination} · {formatPeriod(trip.plannedStart, trip.plannedEnd)}
        </Text>)}
      </View>}
      {item.status === 'approved' && item.tripId && <Button selected onPress={() => onTrip(item.tripId)}>Открыть командировку</Button>}
      {canDecide && (declining ? <>
        <Field label="Причина отказа" value={reason} onChange={setReason} limit={500} disabled={action.busy} multiline />
        <Notice message={action.error} />
        <Button selected disabled={action.busy || !reason.trim()} onPress={() => decide('decline')}>Отклонить запрос</Button>
        <Button disabled={action.busy} onPress={() => setDeclining(false)}>Отмена</Button>
      </> : <>
        {adjusting && <>
          <DeadlinePicker label="Начало поездки" value={periodDraft.start} required showQuick={false} showHelper={false}
            disabled={action.busy} onChange={start => setPeriodDraft(previous => ({ ...previous, start }))} />
          <DeadlinePicker label="Окончание поездки" value={periodDraft.end} required showQuick={false} showHelper={false}
            disabled={action.busy} onChange={end => setPeriodDraft(previous => ({ ...previous, end }))} />
          {!period && <Text style={styles.warning}>Окончание должно быть позже начала.</Text>}
        </>}
        {editingTasks && <TripTaskOptions tasks={available} selected={taskIds} onChange={setTaskIds} disabled={action.busy} />}
        {editingBudget && <View style={styles.inset}>
          <Text style={styles.label}>План расходов</Text>
          {item.estimate && <Button disabled={action.busy} onPress={() => setBudgetDraft(tripBudgetDraft(item.estimate))}>
            Взять суммы из расчёта сотрудника
          </Button>}
          <TripBudgetFields value={budgetDraft} onChange={setBudgetDraft}
            start={period?.plannedStart ?? item.plannedStart} end={period?.plannedEnd ?? item.plannedEnd} disabled={action.busy} />
        </View>}
        <Notice message={action.error} />
        <Button selected disabled={action.busy || (adjusting && !period) || !budget} onPress={() => decide('approve')}>
          {adjusting ? 'Согласовать с этими датами' : 'Согласовать'}
        </Button>
        <View style={styles.choices}>
          <Button disabled={action.busy} onPress={() => setAdjusting(!adjusting)}>{adjusting ? 'Оставить исходные даты' : 'Изменить даты'}</Button>
          <Button disabled={action.busy} onPress={() => {
            if (!editingTasks) setTaskIds(taskIds.filter(id => available.some(task => String(task.id) === id)));
            setEditingTasks(!editingTasks);
          }}>{editingTasks ? 'Скрыть заявки' : `Заявки · ${taskIds.length}`}</Button>
          <Button disabled={action.busy} onPress={() => setEditingBudget(!editingBudget)}>
            {editingBudget ? 'Свернуть бюджет' : 'Указать бюджет'}
          </Button>
          <Button disabled={action.busy} onPress={() => setDeclining(true)}>Отклонить</Button>
        </View>
      </>)}
    </Card>
  </>;
}

function TripStatus({ status, isRequest }) {
  const tone = status === 'pending' ? styles.badgePending : status === 'declined' ? styles.badgeDeclined
    : ['active', 'approved'].includes(status) ? styles.badgeActive : null;
  const label = (isRequest ? REQUEST_STATUS : TRIP_STATUS)[status];
  return label ? <View style={[styles.badge, tone]}><Text style={styles.badgeText}>{label}</Text></View> : null;
}

export function EmployeeTripInbox({ request, offline, onOpen }) {
  const { value } = useResource(request, '/trip-offers', offline);
  const incoming = (value?.offers ?? []).filter(offer => !offer.selfRequested && offer.status === 'awaiting_employee');
  if (!incoming.length) return null;
  return <Card title={incoming.length === 1 ? 'Новая командировка' : `Новые командировки · ${incoming.length}`} icon="briefcase">
    <TripOfferPreview offer={incoming[0]} onOpen={() => onOpen(incoming[0].id)} />
    {incoming.length > 1 && <Button onPress={() => onOpen(null)}>Все командировки</Button>}
  </Card>;
}

function TripReport({ id, request, offline, employee, canEditBudget, onTask, onBack, onChange, tasks, offer }) {
  const report = useResource(request, `/trips/${encodeURIComponent(id)}/report`, offline);
  const action = useAction();
  const stopAction = useAction();
  const expenseAction = useAction();
  const [editingTasks, setEditingTasks] = useState(false);
  const [taskIds, setTaskIds] = useState([]);
  const [budgetDraft, setBudgetDraft] = useState(null);
  const trip = report.value?.trip;
  const stops = trip?.stops ?? [];
  const active = trip?.status === 'active';
  const stopsRemaining = stops.filter(stop => !stop.visitedAt && !stop.skippedAt).length;
  const busy = action.busy || stopAction.busy || expenseAction.busy;
  const canEditCalculation = !trip?.selfRequested && (employee ? !trip?.offerId : canEditBudget);
  const available = trip ? eligibleTripTasks(tasks, trip.employeeId) : [];
  const canAttach = !employee && trip?.status !== 'finished' && (available.length > 0 || editingTasks);
  const ownBudget = employee ? trip?.estimate : trip?.budget;
  const budgetPayload = budgetDraft ? tripBudgetPayload(budgetDraft) : null;
  const budgetTitle = employee ? 'Мой расчёт' : 'План руководителя';
  function mark(phase) {
    void action.run(async () => {
      await request(`/trips/${encodeURIComponent(id)}/${phase}`, { method: 'POST', body: {} });
      await Promise.all([report.reload(), onChange()]);
    });
  }
  function attach() {
    void action.run(async () => {
      await request(`/trips/${encodeURIComponent(id)}/tasks`, { method: 'POST', body: { taskIds } });
      setTaskIds([]);
      setEditingTasks(false);
      await Promise.all([report.reload(), onChange()]);
    });
  }
  function saveBudget(body) {
    void action.run(async () => {
      await request(`/trips/${encodeURIComponent(id)}/${employee ? 'estimate' : 'budget'}`,
        { method: 'POST', body });
      setBudgetDraft(null);
      await Promise.all([report.reload(), onChange()]);
    });
  }
  function recordStop(stopId, body) {
    return stopAction.run(async () => {
      const { stop } = await request(`/trips/${encodeURIComponent(id)}/stops/${encodeURIComponent(stopId)}`, { method: 'POST', body });
      if (stop) report.applyUpdate(current => ({
        ...current,
        trip: { ...current.trip, stops: (current.trip.stops ?? []).map(row => row.id === stop.id ? stop : row) },
      }));
      await Promise.all([report.reload(), onChange()]);
    });
  }
  function saveActualExpenses(body) {
    return expenseAction.run(async () => {
      const { actualExpenses } = await request(`/trips/${encodeURIComponent(id)}/actual-expenses`, { method: 'POST', body });
      if (actualExpenses) report.applyUpdate(current => ({ ...current, trip: { ...current.trip, actualExpenses } }));
      await report.reload();
    });
  }
  return (
    <>
      <View style={styles.choices}><Button onPress={onBack}>К выездам</Button></View>
      <Notice message={report.error || (!budgetDraft && action.error)} />
      {offline && <Text style={styles.warning}>Для обновления отчёта и отметок нужна связь.</Text>}
      {trip ? <>
        <Card title={tripRouteTitle(stops) ?? trip.destination} icon="briefcase">
          <TripStatus status={trip.status} />
          <Text style={styles.muted}>{trip.employeeName}</Text>
          {trip.address && trip.address !== trip.destination ? <Text style={styles.body}>{trip.address}</Text> : null}
          {trip.basis && <Text style={styles.body}>Основание · {trip.basis}</Text>}
          <Text style={styles.label}>Что нужно сделать</Text>
          <Text style={styles.body}>{trip.purpose}</Text>
          {trip.comment ? <>
            <Text style={styles.label}>{trip.selfRequested ? 'Комментарий сотрудника' : 'Комментарий руководителя'}</Text>
            <Text style={styles.body}>{trip.comment}</Text>
          </> : null}
          <Text style={styles.body}>План · {tripPlanLabel(trip)}</Text>
          {trip.plannedDays != null && <Text style={styles.muted}>Календарных дней по времени Алматы · {trip.plannedDays}</Text>}
          {trip.startedAt && <Text style={styles.body}>Начало · {formatTime(trip.startedAt)}</Text>}
          {trip.finishedAt && <Text style={styles.body}>Окончание · {formatTime(trip.finishedAt)}</Text>}
          {employee && trip.status !== 'finished' && <Button selected disabled={offline || busy || (active && stopsRemaining > 0)}
            onPress={() => mark(trip.status === 'planned' ? 'start' : 'finish')}>
            {trip.status === 'planned' ? 'Начать поездку' : 'Завершить поездку'}
          </Button>}
          {employee && active && stopsRemaining > 0 && <Text style={styles.muted}>
            Перед завершением отметьте все остановки ниже. Если куда-то не заехали, укажите причину.
          </Text>}
          {report.value.summary.elapsedMinutes != null && <Text style={styles.body}>
            Длительность командировки · {formatMinutes(report.value.summary.elapsedMinutes)}
          </Text>}
        </Card>
        {stops.length > 0 && <TripRouteSummary stops={stops} active={active} offline={offline}
          onMark={employee && active ? recordStop : undefined} busy={busy} error={stopAction.error} />}
        <Card title="Расходы на поездку" icon="clipboard">
          <Text style={styles.muted}>Ставка считается за календарные дни по времени Алматы. Проезд, жильё, питание и прочее указываются за всю поездку.</Text>
          {trip.budget ? <TripBudgetSummary title="План руководителя" value={trip.budget} /> : null}
          {trip.estimate ? <TripBudgetSummary title={trip.offerId ? 'Согласованная оплата'
            : employee ? 'Мой расчёт' : 'Расчёт сотрудника'} value={trip.estimate} /> : null}
          {!trip.budget && !trip.estimate && <Text style={styles.muted}>Расходы пока не указаны.</Text>}
          {canEditCalculation && (budgetDraft ? <>
            <Text style={styles.label}>{budgetTitle}</Text>
            <TripBudgetFields value={budgetDraft} onChange={setBudgetDraft}
              start={trip.plannedStart} end={trip.plannedEnd} disabled={offline || action.busy} />
            <Notice message={action.error} />
            <View style={styles.choices}>
              <Button selected disabled={offline || action.busy || !budgetPayload}
                onPress={() => saveBudget(budgetPayload)}>Сохранить расчёт</Button>
              <Button disabled={action.busy} onPress={() => setBudgetDraft(null)}>Отмена</Button>
            </View>
          </> : <Button disabled={offline || action.busy} onPress={() => setBudgetDraft(tripBudgetDraft(ownBudget))}>
            {ownBudget ? (employee ? 'Изменить мой расчёт' : 'Изменить план расходов')
              : (employee ? 'Указать мой расчёт' : 'Заполнить план расходов')}
          </Button>)}
        </Card>
        {trip.actualExpenses && <TripActualExpenses value={trip.actualExpenses} employee={employee}
          canEdit={employee && (active || trip.status === 'finished')} offline={offline} busy={busy}
          error={expenseAction.error} onSave={saveActualExpenses} />}
        {(report.value.tasks.length > 0 || canAttach) && <Card title="Связанные заявки" icon="clipboard">
          {report.value.tasks.length > 0 && <Text style={styles.muted}>
            Принято · {report.value.summary.completed}. На проверке · {report.value.summary.awaitingReview}.
          </Text>}
          {report.value.tasks.map(task => <TaskLink key={task.id} task={task}
            onTask={onTask ? taskId => onTask(taskId, { tripId: id }) : undefined} />)}
          {canAttach && (editingTasks ? <>
            <TripTaskOptions tasks={available} selected={taskIds} onChange={setTaskIds} disabled={action.busy} />
            <Button selected disabled={offline || action.busy || !taskIds.length} onPress={attach}>Сохранить связь</Button>
            <Button disabled={action.busy} onPress={() => { setTaskIds([]); setEditingTasks(false); }}>Отмена</Button>
          </> : <Button disabled={offline || action.busy} onPress={() => setEditingTasks(true)}>
            Привязать существующую заявку · необязательно
          </Button>)}
        </Card>}
        {offer?.selfRequested ? <TripApprovalProgress stages={offer.approvalStages} />
          : <TripOfferHistory history={offer?.history} />}
      </> : !offline && !report.error ? <Text style={styles.muted}>Загружаем отчёт…</Text> : null}
    </>
  );
}

function TripsPanel({ request, employee = false, tasks = [], offline = false, onTask,
  id, setId, initialOfferId = null, initialRequestId = null, canEditBudget = false, canDispatch = false,
  filter, onFilter, onControl, onCreateTask, sampleStaff }) {
  const list = useResource(request, '/trips', offline);
  const requests = useResource(request, '/trip-requests', offline);
  const offers = useResource(request, '/trip-offers', offline);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const selfService = offers.value?.supportsTripSelfService === true;
  const approval = useResource(request, '/trip-approval-settings', offline || !selfService || (!employee && !configuring));
  const destinations = useResource(request, '/trip-destinations', offline || !employee || !creating);
  const [offerId, setOfferId] = useState(initialOfferId);
  const [recentOffer, setRecentOffer] = useState(null);
  const [requestId, setRequestId] = useState(initialRequestId);
  const [recentRequest, setRecentRequest] = useState(null);
  const allRequests = requests.value?.requests ?? [];
  const listedRequest = allRequests.find(item => item.id === requestId);
  const optimistic = recentRequest?.id === requestId ? recentRequest : null;
  const chosenRequest = optimistic && (!listedRequest || (listedRequest.status === 'pending' && optimistic.status !== 'pending'))
    ? optimistic : listedRequest;
  const requestsUnavailable = requests.errorStatus === 404;
  const offersUnavailable = offers.errorStatus === 404;
  const offerError = offersUnavailable ? 'Назначения станут доступны после обновления сервера.' : offers.error;
  const canCreateTrip = Boolean(employee && request && !offline && selfService);
  const tripCreateHint = !employee || canCreateTrip ? '' : offline ? 'Для создания командировки нужен интернет.'
    : !request ? 'Войдите в компанию, чтобы создать командировку.'
      : offersUnavailable || offers.value ? 'Создание командировок станет доступно после обновления сервера.'
        : offers.error ? 'Не удалось проверить доступность командировок. Попробуйте открыть раздел снова.'
          : 'Проверяем доступность командировок…';
  const fetchedOffers = offers.value?.offers ?? [];
  const fetchedRevision = fetchedOffers.find(item => item.id === recentOffer?.id)?.revision ?? 0;
  const allOffers = recentOffer && recentOffer.revision > fetchedRevision
    ? [recentOffer, ...fetchedOffers.filter(item => item.id !== recentOffer.id)] : fetchedOffers;
  const chosenOffer = allOffers.find(item => item.id === offerId);
  async function refresh() {
    await Promise.all([list.reload(), requests.reload(), offers.reload()]);
  }
  function changeOffer(offer) {
    setRecentOffer(offer);
    void refresh();
  }
  async function addOrganization(name) {
    const { organization } = await request('/trip-organizations', { method: 'POST', body: { name } });
    const key = organizationKey(organization.name);
    offers.applyUpdate(current => {
      const existing = current.organizations ?? [];
      return existing.some(item => organizationKey(item.name) === key)
        ? current : { ...current, organizations: [...existing, organization] };
    });
    return organization.name;
  }
  function openConfirmedTrip(next) {
    setOfferId(null);
    setId(next);
  }
  if (id) return <TripReport key={id} id={id} request={request} employee={employee} offline={offline}
    canEditBudget={canEditBudget} onTask={onTask && ((taskId, options) => onTask(taskId, { ...options, view: filter }))}
    onBack={() => setId(null)} onChange={refresh} tasks={tasks}
    offer={allOffers.find(offer => offer.tripId && String(offer.tripId) === String(id))} />;
  if (offerId) {
    const selfDraft = chosenOffer?.selfRequested && chosenOffer.status === 'awaiting_employee';
    const Details = chosenOffer?.selfRequested && !selfDraft ? TripApprovalReview
      : employee ? TripOfferCard : DispatcherTripOffer;
    return chosenOffer ? <Details key={offerId} offer={chosenOffer} employee={employee} request={request}
      offline={offline} canDispatch={canDispatch} onChanged={changeOffer} onTrip={openConfirmedTrip}
      approvalSettings={approval.value} approvalSettingsError={approval.error}
      onBack={() => setOfferId(null)} /> : <Card title="Командировка" icon="briefcase">
      <Notice message={offerError || (offers.value && 'Командировка не найдена.')} />
      {!offers.value && !offerError && <Text style={styles.muted}>{offline ? 'Для просмотра нужна связь.' : 'Загружаем командировку…'}</Text>}
      <Button onPress={() => setOfferId(null)}>К выездам</Button>
    </Card>;
  }
  if (requestId) return chosenRequest ? <TripRequestDetails key={requestId} item={chosenRequest} request={request}
    employee={employee} tasks={tasks} onBack={() => { setRequestId(null); setRecentRequest(null); }}
    onTrip={next => { setRequestId(null); setRecentRequest(null); setId(next); }}
    onDecided={item => {
      if (item.tripId) { setRequestId(null); setRecentRequest(null); setId(item.tripId); }
      else setRecentRequest(item);
      void refresh();
    }} /> : <Card title="Запрос на командировку" icon="briefcase">
    <Notice message={requests.error || (requests.value && 'Запрос не найден.')} />
    {!requests.value && !requests.error && <Text style={styles.muted}>{offline ? 'Для просмотра нужна связь.' : 'Загружаем запрос…'}</Text>}
    <Button onPress={() => setRequestId(null)}>К выездам</Button>
  </Card>;
  if (creating && employee) return <TripForm request={request} objects={destinations.value?.objects ?? []} offline={offline}
    approvalSettings={approval.value} approvalSettingsError={approval.error}
    companyOrganizations={offers.value?.organizations}
    onAddOrganization={offers.value?.supportsTripOrganizations === true ? addOrganization : undefined}
    loadingCapabilities={Boolean(request && !offline && !offers.value && !offers.error)}
    capabilitiesError={!offers.value && !offersUnavailable ? offers.error : ''}
    onCancel={() => setCreating(false)} onCreated={(next, offer) => {
      setCreating(false);
      setOfferId(next);
      changeOffer(offer);
    }} />;
  if (importing && employee) return <View style={styles.screen}>
    <View style={styles.choices}><Button onPress={() => setImporting(false)}>‹ К командировкам</Button></View>
    <TripImport request={request} offline={offline} onImported={offers.reload} />
  </View>;
  if (configuring && !employee) return <TripApprovalSettings settings={approval.value} loadError={approval.error}
    offline={offline} request={request} onSaved={result => approval.applyUpdate(() => result)}
    onBack={() => setConfiguring(false)} OptionPicker={VisitOptionPicker} />;
  return <View style={styles.screen}>
    {offline && <Text style={styles.warning}>Офлайн · показываем доступные выезды. Для обновления нужна связь.</Text>}
    <Notice message={list.error || offerError || (requestsUnavailable ? '' : requests.error)} />
    <FieldVisitsOverview tasks={tasks} trips={list.value?.trips} offers={allOffers} requests={allRequests}
      taskStatuses={TASK_STATUS} employee={employee} canDispatch={canDispatch} filter={filter} onFilter={onFilter}
      loading={Boolean(request && !offline && filter !== 'assignments' && !list.value && !list.error)}
      onTask={onTask && (taskId => onTask(taskId, { view: filter }))} onTrip={setId} onOffer={setOfferId} onRequest={setRequestId}
      onCreateTask={onCreateTask} onCreateTrip={employee ? () => setCreating(true) : undefined}
      createTripDisabled={!canCreateTrip} tripCreateHint={tripCreateHint}
      onImportTrip={employee && selfService && offers.value?.supportsTripImport === true ? () => {
        onFilter('trips');
        setImporting(true);
      } : undefined} importTripDisabled={offline}
      onSetupApproval={!employee && selfService ? () => setConfiguring(true) : undefined}
      onControl={onControl} />
    {!employee && sampleStaff && <Card title="Тестовая команда" icon="users">
      <Text style={styles.muted}>{sampleStaff.names.join(' · ')}</Text>
      <Button disabled={offline || sampleStaff.busy} onPress={sampleStaff.onAdd}>
        {sampleStaff.busy ? 'Добавляем сотрудников…' : 'Добавить тестовых сотрудников'}
      </Button>
      <Notice message={sampleStaff.error} />
    </Card>}
  </View>;
}

export function EmployeeTrips({ request, offline = false, onTask, tasks = [], initialTripId = null,
  initialRequestId = null, initialOfferId = null, initialView = 'all' }) {
  const [id, setId] = useState(initialTripId);
  const [filter, setFilter] = useState(initialView);
  return <TripsPanel employee request={request} offline={offline} id={id} setId={setId} onTask={onTask}
    tasks={tasks} filter={filter} onFilter={setFilter} initialOfferId={initialOfferId} initialRequestId={initialRequestId} />;
}

export function OfficeFieldOperations({ request, tasks = [],
  onTask, onCreateTask, initialTab = 'all', initialTripId = null, onTabChange, sampleStaff }) {
  const [filter, setFilter] = useState(initialTab === 'board' ? 'all' : initialTab);
  const [control, setControl] = useState(initialTab === 'board' && !initialTripId);
  const [id, setId] = useState(initialTripId);
  const board = useResource(request, '/field-control', !control);
  function selectFilter(next) {
    setFilter(next);
    setControl(false);
    onTabChange?.(next);
  }

  if (control) return <View style={styles.screen}>
    <View style={styles.choices}><Button onPress={() => selectFilter(filter)}>‹ К выездам</Button></View>
    <Notice message={board.error} />
    {board.value ? <FieldBoard board={board.value} request={request} reload={board.reload} onTask={onTask}
      onTrip={tripId => { setId(tripId); selectFilter('trips'); }} />
      : !board.error ? <Text style={styles.muted}>Загружаем выездные работы…</Text> : null}
  </View>;

  return <TripsPanel request={request} tasks={tasks} id={id} setId={setId} onTask={onTask} canEditBudget canDispatch
    filter={filter} onFilter={selectFilter} sampleStaff={sampleStaff} onCreateTask={onCreateTask}
    onControl={() => { setControl(true); onTabChange?.('board'); }} />;
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  card: { backgroundColor: '#fff', borderColor: colors.border, borderWidth: 1, borderRadius: 16, padding: 14, gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  fill: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 3 },
  label: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  body: { color: colors.ink, fontSize: 13 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: { backgroundColor: colors.tint, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, justifyContent: 'center', minHeight: 44 },
  buttonText: { color: colors.blue, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  selected: { backgroundColor: colors.blue },
  selectedText: { color: '#fff' },
  dim: { opacity: 0.65 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  metric: { width: '47%', backgroundColor: '#F2F7FC', padding: 9, borderRadius: 9, gap: 3 },
  metricValue: { color: colors.ink, fontWeight: '700', fontSize: 17 },
  inset: { backgroundColor: '#F8FAFD', borderRadius: 9, padding: 10, gap: 7 },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 7, borderTopColor: colors.border, borderTopWidth: 1, paddingVertical: 8 },
  badge: { alignSelf: 'flex-start', backgroundColor: colors.tint, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4 },
  badgePending: { backgroundColor: '#FFF1D9' },
  badgeDeclined: { backgroundColor: '#FDEDEF' },
  badgeActive: { backgroundColor: '#E8F9F0' },
  badgeText: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  input: { minHeight: 42, color: colors.ink, fontSize: 14, backgroundColor: '#F4F7FB', paddingHorizontal: 10, borderRadius: 8 },
  multiline: { minHeight: 74, paddingVertical: 10, textAlignVertical: 'top' },
  taskOption: { flexDirection: 'row', alignItems: 'center', minHeight: 44, borderWidth: 1, borderColor: colors.border,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, gap: 8 },
  taskOptionChecked: { backgroundColor: colors.tint, borderColor: colors.blue },
  picker: { gap: 7 },
  pickerButton: { flexDirection: 'row', alignItems: 'center', minHeight: 54, gap: 9,
    padding: 9, borderRadius: 10, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.border },
  pickerIcon: { width: 34, height: 34, borderRadius: 9, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' },
  error: { color: '#AA262A', backgroundColor: '#FFF1F3', borderRadius: 8, padding: 8, fontSize: 13 },
  warning: { color: '#825114', fontSize: 12 },
  success: { color: '#166947', fontSize: 12 },
});
