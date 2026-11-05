import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, Icon } from './ui';

const TASK_STATUS = {
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
  return { value, error: failure ? failure.message || 'Не удалось получить данные.' : '', errorStatus: failure?.status, reload };
}

function useAction() {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(operation) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (reason) {
      setError(reason.message || 'Не удалось сохранить изменения.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run };
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

function localDateTime(date) {
  const parts = [date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0'));
  return `${date.getFullYear()}-${parts[0]}-${parts[1]} ${parts[2]}:${parts[3]}`;
}

function toIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hours, minutes] = match.map(Number);
  const date = new Date(year, month - 1, day, hours, minutes);
  return localDateTime(date) === value ? date.toISOString() : null;
}

function defaultPeriod() {
  const start = new Date();
  start.setHours(start.getHours() + 1, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: localDateTime(start), end: localDateTime(end) };
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

function tripPeriod(start, end) {
  if (!start || !end || start > end) return null;
  const last = new Date(end);
  last.setHours(23, 59, 59, 999);
  return { plannedStart: start.toISOString(), plannedEnd: last.toISOString() };
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

function TripDates({ days, onChange, disabled = false }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(null);
  const insets = useSafeAreaInsets();
  const close = () => setEditing(null);

  function open(key) {
    Keyboard.dismiss();
    setDraft(days[key] ?? days.start ?? tripDay(new Date()));
    setEditing(key);
  }

  function commit(value) {
    const date = tripDay(value);
    if (!date || !editing || disabled) return;
    if (editing === 'start') {
      onChange({ start: date, end: days.end && days.end >= date ? days.end : date });
    } else {
      onChange({ start: days.start && days.start <= date ? days.start : date, end: date });
    }
    close();
  }

  const picker = editing && draft ? <DateTimePicker value={draft} mode="date"
    display={Platform.OS === 'ios' ? 'inline' : 'default'} locale="ru-RU" themeVariant="light"
    minimumDate={editing === 'end' ? days.start ?? undefined : undefined}
    style={styles.nativeDatePicker} onChange={(event, value) => {
      if (Platform.OS === 'android') {
        if (event.type === 'set') commit(value);
        else close();
      } else if (value) setDraft(value);
    }} /> : null;

  return <>
    <View style={styles.dateRow}>
      {[['start', 'Начало'], ['end', 'Окончание']].map(([key, label]) => (
        <Pressable key={key} accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }}
          onPress={() => open(key)} style={({ pressed }) => [styles.dateField, (pressed || disabled) && styles.dim]}>
          <Icon name="calendar" size={17} />
          <View style={styles.fill}>
            <Text style={styles.muted}>{label}</Text>
            <Text style={styles.label}>{days[key]?.toLocaleDateString('ru-RU', DAY_FORMAT) ?? 'Выбрать дату'}</Text>
          </View>
        </Pressable>
      ))}
    </View>
    {Platform.OS === 'ios' ? <Modal transparent animationType="slide" visible={Boolean(editing)} onRequestClose={close}>
      <View style={styles.dateOverlay}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Закрыть календарь" onPress={close} />
        <View accessibilityViewIsModal style={[styles.dateSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.dateToolbar}>
            <Button onPress={close}>Отмена</Button>
            <Text accessibilityRole="header" style={styles.label}>{editing === 'end' ? 'Окончание' : 'Начало'}</Text>
            <Button selected disabled={disabled} onPress={() => commit(draft)}>Готово</Button>
          </View>
          {picker}
        </View>
      </View>
    </Modal> : picker}
  </>;
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

function TripRequestForm({ request, tasks, trips, offline, unavailable, onCancel, onSubmitted }) {
  const [destination, setDestination] = useState('');
  const [purpose, setPurpose] = useState('');
  const [days, setDays] = useState({ start: null, end: null });
  const [taskIds, setTaskIds] = useState([]);
  const [showTasks, setShowTasks] = useState(false);
  const schedule = useResource(request, '/shifts', offline);
  const action = useAction();
  const period = tripPeriod(days.start, days.end);
  const overlaps = (start, end) => period && +new Date(start) <= +new Date(period.plannedEnd)
    && +new Date(end) > +new Date(period.plannedStart);
  const shifts = (schedule.value?.shifts ?? []).filter(shift => !shift.finishedAt && overlaps(shift.startsAt, shift.endsAt));
  const matchingTrips = trips.filter(trip => trip.status !== 'finished' && overlaps(trip.plannedStart, trip.plannedEnd));

  function submit() {
    void action.run(async () => {
      const result = await request('/trip-requests', { method: 'POST', body: {
        destination: destination.trim(), purpose: purpose.trim(), ...period, taskIds,
      } });
      onSubmitted(result.request);
    });
  }

  return <Card title="Запросить командировку" icon="briefcase">
    <Text style={styles.muted}>Укажите место, даты и цель поездки. Запрос появится у руководителя и диспетчера.</Text>
    <Field label="Куда" value={destination} onChange={setDestination} disabled={action.busy} limit={300}
      placeholder="Город или объект" />
    <TripDates days={days} onChange={setDays} disabled={action.busy} />
    {period && (schedule.value || matchingTrips.length > 0) && <View style={styles.inset}>
      <Text style={styles.label}>График на выбранные даты</Text>
      {shifts.slice(0, 3).map(shift => <Text key={shift.id} style={styles.muted}>
        {shift.kind === 'duty' ? 'Дежурство' : 'Смена'} · {formatTime(shift.startsAt)} — {formatTime(shift.endsAt)}
      </Text>)}
      {matchingTrips.slice(0, 3).map(trip => <Text key={`trip-${trip.id}`} style={styles.warning}>
        Командировка · {trip.destination} · {formatPeriod(trip.plannedStart, trip.plannedEnd)}
      </Text>)}
      {!shifts.length && !matchingTrips.length && <Text style={styles.muted}>На эти даты в графике пока ничего нет.</Text>}
      {(shifts.length > 3 || matchingTrips.length > 3) && <Text style={styles.muted}>Другие записи есть в графике.</Text>}
    </View>}
    <Field label="Зачем" value={purpose} onChange={setPurpose} disabled={action.busy} limit={1000}
      placeholder="Например, обследовать оборудование" multiline />
    <Button disabled={action.busy} onPress={() => setShowTasks(!showTasks)}>
      {showTasks ? 'Скрыть заявки' : taskIds.length ? `Связанные заявки · ${taskIds.length}` : 'Привязать заявки · необязательно'}
    </Button>
    {showTasks && <TripTaskOptions tasks={eligibleTripTasks(tasks)} selected={taskIds} onChange={setTaskIds} disabled={action.busy} />}
    {offline && <Text style={styles.warning}>Подключитесь к интернету, чтобы отправить запрос.</Text>}
    {unavailable && <Text style={styles.warning}>Запросы станут доступны после обновления сервера.</Text>}
    <Notice message={action.error} />
    <Button selected disabled={offline || unavailable || action.busy || !period || !destination.trim() || !purpose.trim()} onPress={submit}>
      {action.busy ? 'Отправляем…' : 'Отправить запрос'}
    </Button>
    <Button disabled={action.busy} onPress={onCancel}>К командировкам</Button>
  </Card>;
}

function TripForm({ request, employees, tasks, onCreated, onCancel }) {
  const [employeeId, setEmployeeId] = useState(null);
  const [selectedTasks, setSelectedTasks] = useState([]);
  const [destination, setDestination] = useState('');
  const [basis, setBasis] = useState('');
  const [purpose, setPurpose] = useState('');
  const [period, setPeriod] = useState(defaultPeriod);
  const action = useAction();
  const eligible = tasks.filter(task => task.assigneeId === employeeId && !UNLINKABLE.has(task.status) && !task.tripId);
  const plannedStart = toIso(period.start.trim());
  const plannedEnd = toIso(period.end.trim());
  const validPeriod = plannedStart && plannedEnd && plannedEnd > plannedStart;
  const ready = employeeId && destination.trim() && basis.trim() && purpose.trim() && validPeriod && selectedTasks.length > 0;
  function save() {
    void action.run(async () => {
      const { trip } = await request('/trips', { method: 'POST', body: {
        employeeId, destination: destination.trim(), basis: basis.trim(), purpose: purpose.trim(),
        plannedStart, plannedEnd, taskIds: selectedTasks,
      } });
      onCreated(trip.id);
    });
  }
  return (
    <Card title="Новая командировка" icon="briefcase">
      <Text style={styles.label}>Сотрудник</Text>
      <View style={styles.choices}>
        {employees.map(person => <Button key={person.id} selected={employeeId === person.id} disabled={action.busy}
          onPress={() => { setEmployeeId(person.id); setSelectedTasks([]); }}>{person.name}</Button>)}
      </View>
      <Field label="Место назначения" value={destination} onChange={setDestination} limit={300} disabled={action.busy} />
      <Field label="Основание" value={basis} onChange={setBasis} limit={500} disabled={action.busy} placeholder="Например, приказ №17" />
      <Field label="Цель командировки" value={purpose} onChange={setPurpose} limit={1000} disabled={action.busy} />
      <Field label="Плановое начало" value={period.start} onChange={start => setPeriod(previous => ({ ...previous, start }))}
        limit={16} disabled={action.busy} placeholder="ГГГГ-ММ-ДД ЧЧ:ММ" />
      <Field label="Плановое окончание" value={period.end} onChange={end => setPeriod(previous => ({ ...previous, end }))}
        limit={16} disabled={action.busy} placeholder="ГГГГ-ММ-ДД ЧЧ:ММ" />
      {!validPeriod && <Text style={styles.warning}>Укажите даты в формате ГГГГ-ММ-ДД ЧЧ:ММ. Окончание должно быть позже начала.</Text>}
      <Text style={styles.label}>Связанные заявки · {selectedTasks.length}</Text>
      <View style={styles.choices}>
        {eligible.map(task => <Button key={task.id} selected={selectedTasks.includes(task.id)}
          disabled={action.busy || (selectedTasks.length >= 50 && !selectedTasks.includes(task.id))}
          onPress={() => setSelectedTasks(previous => previous.includes(task.id)
            ? previous.filter(id => id !== task.id) : [...previous, task.id])}>№{task.id} · {task.title}</Button>)}
      </View>
      {!eligible.length && <Text style={styles.muted}>{employeeId
        ? 'У сотрудника нет свободных заявок. Назначьте заявку перед созданием командировки.' : 'Выберите сотрудника.'}</Text>}
      <Notice message={action.error} />
      <View style={styles.choices}>
        <Button selected disabled={!ready || action.busy} onPress={save}>Создать командировку</Button>
        <Button disabled={action.busy} onPress={onCancel}>Отмена</Button>
      </View>
    </Card>
  );
}

function TripRequestDetails({ item, request, employee, tasks, onBack, onDecided, onTrip }) {
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [editingTasks, setEditingTasks] = useState(false);
  const [days, setDays] = useState(() => ({ start: tripDay(item.plannedStart), end: tripDay(item.plannedEnd) }));
  const [taskIds, setTaskIds] = useState(() => (item.taskIds ?? []).map(String));
  const action = useAction();
  const canDecide = !employee && item.status === 'pending';
  const available = eligibleTripTasks(tasks, item.employeeId);
  const period = adjusting ? tripPeriod(days.start, days.end) : null;
  const conflicts = item.conflicts;
  const changedDates = item.approvedStart && item.approvedEnd
    && (item.approvedStart !== item.plannedStart || item.approvedEnd !== item.plannedEnd);

  function decide(decision) {
    void action.run(async () => {
      const body = decision === 'approve' ? { decision, ...period, taskIds } : { decision, reason: reason.trim() };
      const result = await request(`/trip-requests/${encodeURIComponent(item.id)}/decision`, { method: 'POST', body });
      onDecided(result.request);
    });
  }

  return <>
    <View style={styles.choices}><Button disabled={action.busy} onPress={onBack}>К командировкам</Button></View>
    <Card title={item.destination} icon="briefcase">
      <TripStatus status={item.status} isRequest />
      {!employee && <Text style={styles.label}>{item.employeeName}</Text>}
      <Text style={styles.body}>{formatPeriod(item.approvedStart ?? item.plannedStart, item.approvedEnd ?? item.plannedEnd)}</Text>
      {changedDates && <Text style={styles.muted}>Запрошенные даты · {formatPeriod(item.plannedStart, item.plannedEnd)}</Text>}
      <Text style={styles.body}>{item.purpose}</Text>
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
        {adjusting && <TripDates days={days} onChange={setDays} disabled={action.busy} />}
        {editingTasks && <TripTaskOptions tasks={available} selected={taskIds} onChange={setTaskIds} disabled={action.busy} />}
        <Notice message={action.error} />
        <Button selected disabled={action.busy || (adjusting && !period)} onPress={() => decide('approve')}>
          {adjusting ? 'Согласовать с этими датами' : 'Согласовать'}
        </Button>
        <View style={styles.choices}>
          <Button disabled={action.busy} onPress={() => setAdjusting(!adjusting)}>{adjusting ? 'Оставить исходные даты' : 'Изменить даты'}</Button>
          <Button disabled={action.busy} onPress={() => {
            if (!editingTasks) setTaskIds(taskIds.filter(id => available.some(task => String(task.id) === id)));
            setEditingTasks(!editingTasks);
          }}>{editingTasks ? 'Скрыть заявки' : `Заявки · ${taskIds.length}`}</Button>
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

function TripRow({ item, isRequest = false, employee, onPress }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.tripRow, pressed && styles.dim]}>
    <View style={styles.fill}>
      <Text style={styles.label}>{item.destination}</Text>
      {!employee && <Text style={styles.muted}>{item.employeeName}</Text>}
      <Text style={styles.muted}>{formatPeriod(item.plannedStart, item.plannedEnd)}{!isRequest ? ` · заявок ${item.taskCount}` : ''}</Text>
      <TripStatus status={item.status} isRequest={isRequest} />
    </View>
    <Icon name="chevron-right" size={17} color={colors.muted} />
  </Pressable>;
}

function TripReport({ id, request, offline, employee, onTask, onBack, onChange, tasks }) {
  const report = useResource(request, `/trips/${encodeURIComponent(id)}/report`, offline);
  const action = useAction();
  const [editingTasks, setEditingTasks] = useState(false);
  const [taskIds, setTaskIds] = useState([]);
  const trip = report.value?.trip;
  const available = trip ? eligibleTripTasks(tasks, trip.employeeId) : [];
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
  return (
    <>
      <View style={styles.choices}><Button onPress={onBack}>К командировкам</Button></View>
      <Notice message={report.error || action.error} />
      {offline && <Text style={styles.warning}>Для обновления отчёта и отметок нужна связь.</Text>}
      {trip ? (
        <Card title={trip.destination} icon="briefcase">
          <TripStatus status={trip.status} />
          <Text style={styles.muted}>{trip.employeeName}</Text>
          {trip.basis && <Text style={styles.body}>Основание · {trip.basis}</Text>}
          <Text style={styles.body}>Цель · {trip.purpose}</Text>
          <Text style={styles.body}>План · {tripPlanLabel(trip)}</Text>
          {trip.startedAt && <Text style={styles.body}>Начало · {formatTime(trip.startedAt)}</Text>}
          {trip.finishedAt && <Text style={styles.body}>Окончание · {formatTime(trip.finishedAt)}</Text>}
          {employee && trip.status !== 'finished' && <Button selected disabled={offline || action.busy}
            onPress={() => mark(trip.status === 'planned' ? 'start' : 'finish')}>
            {trip.status === 'planned' ? 'Начать поездку' : 'Завершить поездку'}
          </Button>}
          {report.value.summary.elapsedMinutes != null && <Text style={styles.body}>
            Длительность командировки · {formatMinutes(report.value.summary.elapsedMinutes)}
          </Text>}
          <Text style={styles.label}>Заявки · {trip.taskCount}</Text>
          {report.value.tasks.length > 0 && <Text style={styles.muted}>
            Принято · {report.value.summary.completed}. На проверке · {report.value.summary.awaitingReview}.
          </Text>}
          {report.value.tasks.map(task => <TaskLink key={task.id} task={task} onTask={onTask} />)}
          {!employee && trip.status !== 'finished' && <>
            {editingTasks ? <>
              <TripTaskOptions tasks={available} selected={taskIds} onChange={setTaskIds} disabled={action.busy} />
              <Button selected disabled={action.busy || !taskIds.length} onPress={attach}>Сохранить заявки</Button>
              <Button disabled={action.busy} onPress={() => { setTaskIds([]); setEditingTasks(false); }}>Отмена</Button>
            </> : <Button onPress={() => setEditingTasks(true)}>Добавить заявки</Button>}
          </>}
        </Card>
      ) : !offline && !report.error ? <Text style={styles.muted}>Загружаем отчёт…</Text> : null}
    </>
  );
}

function TripsPanel({ request, employee = false, employees = [], tasks = [], offline = false, onTask,
  id, setId, onChange, initialView = 'list', initialRequestId = null }) {
  const list = useResource(request, '/trips', offline);
  const requests = useResource(request, '/trip-requests', offline);
  const [creating, setCreating] = useState(initialView === 'request');
  const [requestId, setRequestId] = useState(initialRequestId);
  const [recentRequest, setRecentRequest] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const allRequests = requests.value?.requests ?? [];
  const listedRequest = allRequests.find(item => item.id === requestId);
  const optimistic = recentRequest?.id === requestId ? recentRequest : null;
  const chosenRequest = optimistic && (!listedRequest || (listedRequest.status === 'pending' && optimistic.status !== 'pending'))
    ? optimistic : listedRequest;
  const requestsUnavailable = requests.errorStatus === 404;
  async function refresh() {
    await Promise.all([list.reload(), requests.reload(), onChange?.()]);
  }
  if (id) return <TripReport key={id} id={id} request={request} employee={employee} offline={offline}
    onTask={onTask} onBack={() => setId(null)} onChange={refresh} tasks={tasks} />;
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
    <Button onPress={() => setRequestId(null)}>К командировкам</Button>
  </Card>;
  if (creating && employee) return <TripRequestForm request={request} tasks={tasks} trips={list.value?.trips ?? []}
    offline={offline} unavailable={requestsUnavailable}
    onCancel={() => setCreating(false)} onSubmitted={item => {
      setRecentRequest(item);
      setRequestId(item.id);
      setCreating(false);
      void refresh();
    }} />;
  if (creating) return <TripForm request={request} employees={employees} tasks={tasks}
    onCancel={() => setCreating(false)} onCreated={next => { setCreating(false); setId(next); void refresh(); }} />;
  const trips = list.value?.trips ?? [];
  const now = Date.now();
  const current = trips.filter(trip => trip.status !== 'finished').sort((a, b) => {
    if ((a.status === 'active') !== (b.status === 'active')) return a.status === 'active' ? -1 : 1;
    const overdueA = +new Date(a.plannedEnd) < now;
    const overdueB = +new Date(b.plannedEnd) < now;
    if (overdueA !== overdueB) return overdueA ? 1 : -1;
    return a.plannedStart.localeCompare(b.plannedStart);
  });
  const otherTrips = employee ? current.slice(1) : current;
  const pending = allRequests.filter(item => item.status === 'pending');
  const history = [
    ...trips.filter(trip => trip.status === 'finished').map(item => ({ item, isRequest: false })),
    ...allRequests.filter(item => item.status === 'declined').map(item => ({ item, isRequest: true })),
  ].sort((a, b) => (b.item.finishedAt ?? b.item.decidedAt ?? b.item.plannedStart)
    .localeCompare(a.item.finishedAt ?? a.item.decidedAt ?? a.item.plannedStart));
  return (
    <View style={styles.screen}>
      <Card title={employee ? 'Мои командировки' : 'Командировки'} icon="briefcase">
        {employee && <Text style={styles.muted}>Ближайшие поездки и запросы на согласовании.</Text>}
        {offline && <Text style={styles.warning}>Для обновления командировок нужна связь.</Text>}
        <Notice message={list.error || (requestsUnavailable ? 'Запросы станут доступны после обновления сервера.' : requests.error)} />
        {employee && current[0] && <View style={styles.inset}>
          <Text style={styles.muted}>{current[0].status === 'active' ? 'Текущая поездка'
            : +new Date(current[0].plannedEnd) < now ? 'Срок поездки прошёл' : 'Ближайшая поездка'}</Text>
          <TripRow item={current[0]} employee onPress={() => setId(current[0].id)} />
        </View>}
        <Button selected disabled={offline || (employee ? !requests.value : !employees.length)} onPress={() => setCreating(true)}>
          {employee ? 'Запросить командировку' : 'Добавить командировку'}
        </Button>
      </Card>
      {pending.length > 0 && <Card title={`На согласовании · ${pending.length}`} icon="clock">
        {pending.map(item => <TripRow key={item.id} item={item} isRequest employee={employee} onPress={() => setRequestId(item.id)} />)}
      </Card>}
      {otherTrips.length > 0 && <Card title={employee ? 'Другие поездки' : 'Текущие и запланированные'} icon="calendar">
        {otherTrips.map(item => <TripRow key={item.id} item={item} employee={employee} onPress={() => setId(item.id)} />)}
      </Card>}
      {history.length > 0 && <Card title="История" icon="clipboard">
        <Button onPress={() => setShowHistory(!showHistory)}>{showHistory ? 'Свернуть историю' : `Показать историю · ${history.length}`}</Button>
        {showHistory && history.map(({ item, isRequest }) => <TripRow key={`${isRequest ? 'request' : 'trip'}-${item.id}`}
          item={item} isRequest={isRequest} employee={employee} onPress={() => (isRequest ? setRequestId : setId)(item.id)} />)}
      </Card>}
      {list.value && (requests.value || requestsUnavailable) && !current.length && !pending.length && !history.length
        && <Text style={styles.muted}>Командировок пока нет.</Text>}
      {!list.value && !offline && !list.error && <Text style={styles.muted}>Загружаем командировки…</Text>}
    </View>
  );
}

export function EmployeeTrips({ request, offline = false, onTask, tasks = [], initialView = 'list',
  initialTripId = null, initialRequestId = null }) {
  const [id, setId] = useState(initialTripId);
  return <TripsPanel employee request={request} offline={offline} id={id} setId={setId} onTask={onTask}
    tasks={tasks} initialView={initialView} initialRequestId={initialRequestId} />;
}

export function OfficeFieldOperations({ request, tasks, onTask }) {
  const [tab, setTab] = useState('board');
  const [id, setId] = useState(null);
  const board = useResource(request, '/field-control');
  const tripsTasks = board.value?.tasks ?? tasks ?? [];
  function openTrip(tripId) {
    setId(tripId);
    setTab('trips');
  }
  return (
    <View style={styles.screen}>
      <View style={styles.choices}>
        <Button selected={tab === 'board'} onPress={() => setTab('board')}>Доска контроля</Button>
        <Button selected={tab === 'trips'} onPress={() => setTab('trips')}>Командировки</Button>
      </View>
      <Notice message={board.error} />
      {tab === 'board' ? (
        board.value ? <FieldBoard board={board.value} request={request} reload={board.reload} onTask={onTask} onTrip={openTrip} />
          : !board.error ? <Text style={styles.muted}>Загружаем полевые работы…</Text> : null
      ) : <TripsPanel request={request} employees={board.value?.employees} tasks={tripsTasks}
        id={id} setId={setId} onTask={onTask} onChange={board.reload} />}
    </View>
  );
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
  tripRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, minHeight: 48 },
  badge: { alignSelf: 'flex-start', backgroundColor: colors.tint, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4 },
  badgePending: { backgroundColor: '#FFF1D9' },
  badgeDeclined: { backgroundColor: '#FDEDEF' },
  badgeActive: { backgroundColor: '#E8F9F0' },
  badgeText: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  input: { minHeight: 42, color: colors.ink, fontSize: 14, backgroundColor: '#F4F7FB', paddingHorizontal: 10, borderRadius: 8 },
  multiline: { minHeight: 74, paddingVertical: 10, textAlignVertical: 'top' },
  dateRow: { flexDirection: 'row', gap: 8 },
  dateField: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 55, padding: 9,
    borderRadius: 8, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.border },
  dateOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(20,32,52,0.35)' },
  dateSheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 12 },
  dateToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, gap: 8 },
  nativeDatePicker: { alignSelf: 'stretch', height: 336 },
  taskOption: { flexDirection: 'row', alignItems: 'center', minHeight: 44, borderWidth: 1, borderColor: colors.border,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, gap: 8 },
  taskOptionChecked: { backgroundColor: colors.tint, borderColor: colors.blue },
  error: { color: '#AA262A', backgroundColor: '#FFF1F3', borderRadius: 8, padding: 8, fontSize: 13 },
  warning: { color: '#825114', fontSize: 12 },
  success: { color: '#166947', fontSize: 12 },
});
