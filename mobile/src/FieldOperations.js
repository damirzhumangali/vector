import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, Icon } from './ui';

const TASK_STATUS = {
  assigned: 'Назначена', unassigned: 'Без исполнителя', accepted: 'Принята сотрудником',
  travel: 'В пути', arrived: 'На объекте', work: 'В работе', paused: 'На паузе',
  review: 'Ожидает приёмки', done: 'Принята', rework: 'На доработке',
  repeated: 'Требуется повторный выезд', cancelled: 'Отменена',
  refused: 'Отказ сотрудника', declined: 'Отказ сотрудника',
};
const TRIP_STATUS = { planned: 'Запланирована', active: 'В командировке', finished: 'Завершена' };
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
  const [error, setError] = useState('');
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!request || !path || paused) return;
    const version = ++generation.current;
    try {
      const result = await request(path);
      if (generation.current === version) {
        setValue(result);
        setError('');
      }
    } catch (reason) {
      if (generation.current === version) setError(reason.message || 'Не удалось получить данные.');
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
  return { value, error, reload };
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

function Field({ label, value, onChange, disabled, limit, placeholder }) {
  return (
    <View style={styles.fill}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} maxLength={limit}
        editable={!disabled} placeholder={placeholder} placeholderTextColor={colors.muted} style={styles.input} />
    </View>
  );
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

function TripReport({ id, request, offline, employee, onTask, onBack, onChange }) {
  const report = useResource(request, `/trips/${encodeURIComponent(id)}/report`, offline);
  const action = useAction();
  const trip = report.value?.trip;
  function mark(phase) {
    void action.run(async () => {
      await request(`/trips/${encodeURIComponent(id)}/${phase}`, { method: 'POST', body: {} });
      await Promise.all([report.reload(), onChange()]);
    });
  }
  return (
    <>
      <View style={styles.choices}><Button onPress={onBack}>К командировкам</Button></View>
      <Notice message={report.error || action.error} />
      {offline && <Text style={styles.warning}>Для обновления отчёта и отметок нужна связь.</Text>}
      {trip ? (
        <Card title="Отчёт по командировке" icon="briefcase">
          <Text style={styles.label}>{trip.destination} · {TRIP_STATUS[trip.status]}</Text>
          <Text style={styles.muted}>{trip.employeeName}</Text>
          <Text style={styles.body}>Основание · {trip.basis}</Text>
          <Text style={styles.body}>Цель · {trip.purpose}</Text>
          <Text style={styles.body}>План · {formatTime(trip.plannedStart)} — {formatTime(trip.plannedEnd)}</Text>
          <Text style={styles.body}>Начало · {formatTime(trip.startedAt)}. Окончание · {formatTime(trip.finishedAt)}</Text>
          {report.value.summary.elapsedMinutes != null && <Text style={styles.body}>
            Длительность командировки · {formatMinutes(report.value.summary.elapsedMinutes)}
          </Text>}
          <Text style={styles.label}>Заявки · {trip.taskCount}</Text>
          <Text style={styles.muted}>Принято · {report.value.summary.completed}. На проверке · {report.value.summary.awaitingReview}.</Text>
          {report.value.tasks.map(task => <TaskLink key={task.id} task={task} onTask={onTask} />)}
          {employee && trip.status === 'planned' && <Button selected disabled={offline || action.busy}
            onPress={() => mark('start')}>Отметить начало</Button>}
          {employee && trip.status === 'active' && <Button selected disabled={offline || action.busy}
            onPress={() => mark('finish')}>Отметить окончание</Button>}
        </Card>
      ) : !offline && !report.error ? <Text style={styles.muted}>Загружаем отчёт…</Text> : null}
    </>
  );
}

function TripsPanel({ request, employee = false, employees = [], tasks = [], offline = false, onTask, id, setId, onChange }) {
  const list = useResource(request, '/trips', offline);
  const [creating, setCreating] = useState(false);
  async function refresh() {
    await Promise.all([list.reload(), onChange?.()]);
  }
  if (id) return <TripReport key={id} id={id} request={request} employee={employee} offline={offline}
    onTask={onTask} onBack={() => setId(null)} onChange={refresh} />;
  if (creating) return <TripForm request={request} employees={employees} tasks={tasks}
    onCancel={() => setCreating(false)} onCreated={next => { setCreating(false); setId(next); void refresh(); }} />;
  return (
    <Card title="Командировки" icon="briefcase">
      {employee && list.value?.workMode && <Text style={styles.muted}>
        График · {list.value.workMode === 'field' ? 'выездной' : 'стационарный'}
      </Text>}
      {!employee && <Button selected disabled={!employees.length} onPress={() => setCreating(true)}>Добавить командировку</Button>}
      {offline && <Text style={styles.warning}>Для обновления командировок нужна связь.</Text>}
      <Notice message={list.error} />
      {list.value ? (
        list.value.trips.length ? list.value.trips.map(trip => (
          <Pressable key={trip.id} accessibilityRole="button" onPress={() => setId(trip.id)} style={styles.taskRow}>
            <View style={styles.fill}>
              <Text style={styles.label}>{trip.destination} · {TRIP_STATUS[trip.status]}</Text>
              {!employee && <Text style={styles.muted}>{trip.employeeName}</Text>}
              <Text style={styles.muted}>{formatTime(trip.plannedStart)} — {formatTime(trip.plannedEnd)} · заявок {trip.taskCount}</Text>
            </View>
            <Icon name="chevron-right" size={16} color={colors.muted} />
          </Pressable>
        )) : <Text style={styles.muted}>Командировок пока нет.</Text>
      ) : !offline && !list.error ? <Text style={styles.muted}>Загружаем командировки…</Text> : null}
    </Card>
  );
}

export function EmployeeTrips({ request, offline = false, onTask }) {
  const [id, setId] = useState(null);
  return <TripsPanel employee request={request} offline={offline} id={id} setId={setId} onTask={onTask} />;
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
  button: { backgroundColor: colors.tint, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, justifyContent: 'center', minHeight: 38 },
  buttonText: { color: colors.blue, fontSize: 12, fontWeight: '600' },
  selected: { backgroundColor: colors.blue },
  selectedText: { color: '#fff' },
  dim: { opacity: 0.65 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  metric: { width: '47%', backgroundColor: '#F2F7FC', padding: 9, borderRadius: 9, gap: 3 },
  metricValue: { color: colors.ink, fontWeight: '700', fontSize: 17 },
  inset: { backgroundColor: '#F8FAFD', borderRadius: 9, padding: 10, gap: 7 },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 7, borderTopColor: colors.border, borderTopWidth: 1, paddingVertical: 8 },
  input: { minHeight: 42, color: colors.ink, fontSize: 14, backgroundColor: '#F4F7FB', paddingHorizontal: 10, borderRadius: 8 },
  error: { color: '#AA262A', backgroundColor: '#FFF1F3', borderRadius: 8, padding: 8, fontSize: 13 },
  warning: { color: '#825114', fontSize: 12 },
  success: { color: '#166947', fontSize: 12 },
});
