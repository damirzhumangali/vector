import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Icon } from './ui';

const EMPTY = {
  shifts: [], days: [], reminders: [], incidents: [], unavailableEmployeeIds: [], scheduleLoaded: false,
  trips: [], tripRequests: [], tripsLoaded: false,
};
const CLOSED_TASKS = new Set(['done', 'cancelled', 'repeated', 'review']);
const INCIDENT_NAMES = {
  urgent_leave: 'Срочный уход', lateness: 'Опоздание', emergency: 'Аварийное назначение',
};
const STATUS = {
  open: 'Ожидает решения', returned: 'Сотрудник вернулся', approved: 'Подтверждено',
  rejected: 'Отклонено', accepted: 'Принято', declined: 'Отказ', transferred: 'Заявки переданы',
  assigned: 'Создана', unassigned: 'Без исполнителя', paused: 'Приостановлена',
};
const SHIFT_DECISIONS = {
  continue: 'Продолжить работу', pause: 'Приостановить', transfer: 'Передать', finish: 'Завершить смену',
};

function localDate(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-');
}

function timeLabel(value) {
  const date = new Date(value);
  return value && Number.isFinite(+date)
    ? date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
}

function shiftPeriod(shift, today) {
  const start = new Date(shift.startsAt);
  const end = new Date(shift.endsAt);
  const time = date => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const startDay = localDate(start);
  const startLabel = startDay === today ? time(start) : timeLabel(shift.startsAt);
  const endLabel = localDate(end) === startDay ? time(end) : timeLabel(shift.endsAt);
  return `${startLabel} — ${endLabel}`;
}

function tripPeriod({ plannedStart, plannedEnd }) {
  const start = new Date(plannedStart);
  const end = new Date(plannedEnd);
  const format = date => date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return localDate(start) === localDate(end) ? format(start) : `${format(start)} — ${format(end)}`;
}

function periodCoversDay(startsAt, endsAt, date) {
  const start = new Date(`${date}T00:00:00`);
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return +new Date(startsAt) < +next && +new Date(endsAt) > +start;
}

function isoDateTime(date, time) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(date + ' ' + time);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const result = new Date(year, month - 1, day, hour, minute);
  if (localDate(result) !== date || result.getHours() !== hour || result.getMinutes() !== minute) return null;
  return result.toISOString();
}

function Card({ title, children, warning = false }) {
  return (
    <View style={[styles.card, warning && styles.warning]}>
      {title ? <View style={styles.sectionHeading}>
        <View style={[styles.cardIcon, warning && styles.cardIconWarning]}><Icon name={title.includes('алендар') || title === 'График' ? 'calendar' : title.includes('уход') || title.includes('внимания') ? 'alert' : 'clipboard'} size={20} color={warning ? '#FF9E24' : '#087CFF'} /></View>
        <Text accessibilityRole="header" style={[styles.heading, styles.flex]}>{title}</Text>
      </View> : null}
      {children}
    </View>
  );
}

function Action({ children, onPress, disabled = false, primary = false, selected = false }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled}
      onPress={onPress} style={({ pressed }) => [
        styles.button, primary && styles.primary, selected && styles.selected, (pressed || disabled) && styles.dim,
      ]}>
      <Text style={[styles.buttonText, (primary || selected) && styles.primaryText]}>{children}</Text>
    </Pressable>
  );
}

function ActionRow({ title, detail, icon, onPress, expanded, disabled = false, warning = false }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled, expanded }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.actionRow, (pressed || disabled) && styles.dim]}>
      <View style={[styles.cardIcon, warning && styles.cardIconWarning]}>
        <Icon name={icon} size={19} color={warning ? '#AB600D' : '#087CFF'} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={styles.label}>{title}</Text>
        {detail ? <Text style={styles.muted}>{detail}</Text> : null}
      </View>
      <Icon name="chevron-right" size={17} color="#667E9E" style={expanded && styles.chevronDown} />
    </Pressable>
  );
}

function Field({ label, value, onChange, placeholder, numeric = false, limit = 1000 }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={placeholder}
        keyboardType={numeric ? 'number-pad' : 'default'} maxLength={limit} style={styles.input} />
    </View>
  );
}

function Choices({ rows, selected, onSelect, empty = 'Нет доступных вариантов' }) {
  if (!rows.length) return <Text style={styles.muted}>{empty}</Text>;
  return (
    <View style={styles.choices}>
      {rows.map(({ id, label }) => (
        <Action key={id} selected={String(selected) === String(id)} onPress={() => onSelect(id)}>{label}</Action>
      ))}
    </View>
  );
}

function useShiftData(request, offline, onShifts, includeIncidents = true, includeTrips = false) {
  const [data, setData] = useState(EMPTY);
  const [error, setError] = useState('');
  const [tripError, setTripError] = useState('');
  const current = useRef(0);
  const callback = useRef(onShifts);
  useEffect(() => { callback.current = onShifts; }, [onShifts]);
  const reload = useCallback(async () => {
    if (!request || offline) return;
    const version = ++current.current;
    const schedule = Promise.allSettled([
      request('/shifts'),
      includeIncidents ? request('/incidents') : Promise.resolve(null),
    ]);
    const tripsUpdate = includeTrips ? Promise.allSettled([request('/trips'), request('/trip-requests')])
      .then(([trip, tripRequest]) => {
        if (current.current !== version) return;
        const tripList = trip.status === 'fulfilled' ? trip.value?.trips : null;
        const requests = tripRequest.status === 'fulfilled' ? tripRequest.value?.requests : null;
        setData(previous => ({
          ...previous,
          trips: tripList ?? previous.trips,
          tripRequests: requests ?? previous.tripRequests,
          tripsLoaded: previous.tripsLoaded || Array.isArray(tripList),
        }));
        setTripError(trip.status === 'rejected' ? trip.reason?.message || 'Не удалось загрузить командировки.' : '');
      }) : null;
    const [shift, incident] = await schedule;
    if (current.current !== version) return;
    const shifts = shift.status === 'fulfilled' ? shift.value : null;
    const incidents = incident.status === 'fulfilled' ? incident.value?.incidents : null;
    setData(previous => ({
      ...previous,
      shifts: shifts?.shifts ?? previous.shifts,
      days: shifts?.days ?? previous.days,
      reminders: shifts?.reminders ?? previous.reminders,
      incidents: incidents ?? previous.incidents,
      unavailableEmployeeIds: shifts?.unavailableEmployeeIds ?? previous.unavailableEmployeeIds,
      scheduleLoaded: previous.scheduleLoaded || Array.isArray(shifts?.shifts),
    }));
    if (shifts?.shifts) callback.current?.(shifts.shifts);
    setError([shift, incident].find(result => result.status === 'rejected')?.reason?.message ?? '');
    await tripsUpdate;
  }, [request, offline, includeIncidents, includeTrips]);

  useEffect(() => {
    void reload();
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') void reload(); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') void reload(); }, 15000);
    return () => {
      current.current++;
      foreground.remove();
      clearInterval(timer);
    };
  }, [reload]);
  return { data, reload, error, tripError };
}

function useAction(reload, onChange) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const run = async (operation, message = 'Изменения сохранены') => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await operation();
      setNotice({ message });
      onChange?.();
      void reload();
      return true;
    } catch (error) {
      setNotice({ message: error.message || 'Не удалось сохранить изменение.', error: true });
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { busy, notice, run };
}

function Notice({ notice, error }) {
  if (!notice && !error) return null;
  return (
    <View style={styles.field}>
      {notice && <Text accessibilityRole={notice.error ? 'alert' : undefined}
        style={notice.error ? styles.error : styles.success}>{notice.message}</Text>}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  );
}

function post(request, path, body) {
  return request(path, { method: 'POST', body });
}

function ShiftSummary({ shift }) {
  return (
    <View style={styles.listItem}>
      <View style={styles.summaryRow}>
        <View style={styles.cardIcon}><Icon name={shift.kind === 'duty' ? 'shield' : 'clock'} size={21} color="#087CFF" /></View>
        <View style={styles.flex}>
          <Text style={styles.label}>{shift.kind === 'duty' ? 'Дежурство' : 'Рабочая смена'}{shift.employeeName ? ' · ' + shift.employeeName : ''}</Text>
          <Text style={styles.muted}>{timeLabel(shift.startsAt)} — {timeLabel(shift.endsAt)}</Text>
        </View>
      </View>
      {shift.decision && <Text style={styles.shiftBadge}>{SHIFT_DECISIONS[shift.decision] || shift.decision}</Text>}
      {shift.finishedAt && <Text style={styles.muted}>Завершена {timeLabel(shift.finishedAt)}</Text>}
      {(shift.finishedAt || shift.overtimeMinutes > 0) && <Text style={styles.overtime}>Сверхурочные · {shift.overtimeMinutes ?? 0} мин</Text>}
    </View>
  );
}

function ShiftOverview({ shift, nextShift, now, scheduleLoaded, scheduleUnavailable, children }) {
  const date = new Date(now);
  const today = localDate(date);
  let status = 'На сегодня смены нет';
  if (shift?.finishedAt) status = 'Смена завершена';
  else if (shift && +new Date(shift.startsAt) > now) status = 'Смена запланирована';
  else if (shift && +new Date(shift.endsAt) <= now) status = 'Плановое время закончилось';
  else if (shift) status = 'Смена идёт';
  else if (!scheduleLoaded) status = scheduleUnavailable ? 'График недоступен' : 'Загружаем график…';

  return (
    <Card>
      <View style={styles.summaryRow}>
        <View style={styles.cardIcon}><Icon name="calendar" size={22} /></View>
        <View style={styles.flex}>
          <Text accessibilityRole="header" style={styles.heading}>Сегодня</Text>
          <Text style={styles.muted}>{date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' })}</Text>
        </View>
        {shift && <Text style={styles.shiftBadge}>{shift.kind === 'duty' ? 'Дежурство' : 'Рабочий день'}</Text>}
      </View>
      <View style={styles.shiftStatusPanel}>
        <Text style={styles.shiftStatus}>{status}</Text>
        {shift && <Text style={styles.shiftPeriod}>{shiftPeriod(shift, today)}</Text>}
        {shift?.finishedAt && <Text style={styles.muted}>Отметка о завершении · {timeLabel(shift.finishedAt)}</Text>}
      </View>
      {children}
      {nextShift && (
        <View style={styles.summaryRow}>
          <View style={styles.cardIcon}><Icon name="clock" size={19} /></View>
          <View style={styles.flex}>
            <Text style={styles.label}>{nextShift.kind === 'duty' ? 'Ближайшее дежурство' : 'Ближайшая смена'}</Text>
            <Text style={styles.muted}>{shiftPeriod(nextShift, today)}</Text>
          </View>
        </View>
      )}
      {shift?.overtimeMinutes > 0 && <Text style={styles.overtime}>Сверхурочные · {shift.overtimeMinutes} мин</Text>}
    </Card>
  );
}

function Reminder({ reminder, children }) {
  return (
    <Card title={reminder.kind === 'ending' ? 'Скоро конец смены' : 'Смена требует внимания'} warning>
      <Text style={styles.muted}>{reminder.employeeName ? reminder.employeeName + ' · ' : ''}До {timeLabel(reminder.endsAt)}</Text>
      {reminder.tasks?.map(task => <Text key={task.id} style={styles.label}>№{task.id} · {task.title}</Text>)}
      {children}
    </Card>
  );
}

export function EmployeeShiftReminder({ request, offline = false, onOpen, onShifts }) {
  const { data } = useShiftData(request, offline, onShifts, false);
  const reminder = data.reminders[0];
  if (!reminder) return null;
  return (
    <View style={styles.banner}>
      <Text style={styles.label}>{reminder.kind === 'ending' ? 'Скоро конец смены' : 'Смена требует внимания'}</Text>
      <Action onPress={onOpen}>Открыть смену</Action>
    </View>
  );
}

const leaveReasons = ['Здоровье', 'Семейные обстоятельства', 'Транспорт', 'Другая причина'];

function UrgentLeave({ request, onUrgentLeave, offline, incident, pending, busy, run, opened, onToggle }) {
  const [reason, setReason] = useState('');
  const [safe, setSafe] = useState(null);
  if (!incident && !pending && !opened) return (
    <ActionRow title="Сообщить о срочном уходе" icon="alert" warning expanded={false}
      disabled={busy || (offline && !onUrgentLeave)} onPress={onToggle} />
  );
  return (
    <View style={styles.requestForm}>
      {incident || pending ? <Text style={styles.label}>Срочный уход</Text> : (
        <ActionRow title="Срочный уход" icon="alert" warning expanded disabled={busy} onPress={onToggle} />
      )}
      {incident ? (
        <>
          <Text style={styles.muted}>Вы недоступны для новых назначений. {incident.reason}</Text>
          <Action disabled={busy || offline}
            onPress={() => run(() => post(request, `/incidents/${incident.id}/decision`, { action: 'return' }), 'Возвращение подтверждено')}>
            Я вернулся
          </Action>
        </>
      ) : pending ? (
        <Text style={styles.muted}>Срочный уход сохранён на телефоне и ожидает отправки.</Text>
      ) : (
        <>
          <Text style={styles.muted}>Неначатые заявки вернутся диспетчеру. Уже начатая работа будет приостановлена с сохранением отчёта.</Text>
          <Choices rows={leaveReasons.map(label => ({ id: label, label }))} selected={reason} onSelect={setReason} />
          <Text style={styles.label}>Объект оставлен безопасно?</Text>
          <Choices rows={[{ id: 'yes', label: 'Да, безопасно' }, { id: 'no', label: 'Нет, нужна помощь' }]}
            selected={safe} onSelect={setSafe} />
          <Action primary disabled={busy || !reason || safe === null} onPress={async () => {
            const body = { kind: 'urgent_leave', reason, safe: safe === 'yes' };
            if (await run(
              () => onUrgentLeave ? onUrgentLeave(body) : post(request, '/incidents', { ...body, eventId: randomUUID() }),
              onUrgentLeave ? 'Сообщение сохранено и будет отправлено при связи.' : 'Срочный уход зарегистрирован',
            )) {
              onToggle();
              setReason('');
              setSafe(null);
            }
          }}>Подтвердить срочный уход</Action>
          <Action disabled={busy} onPress={onToggle}>Отмена</Action>
        </>
      )}
    </View>
  );
}

function LatenessForm({ request, tasks, busy, run, offline, opened, onToggle }) {
  const [taskId, setTaskId] = useState(null);
  const [minutes, setMinutes] = useState('');
  const [reason, setReason] = useState('');
  const duration = Number(minutes);
  if (!opened) return (
    <ActionRow title="Сообщить об опоздании" icon="clock" expanded={false} disabled={busy || offline} onPress={onToggle} />
  );
  return (
    <View style={styles.requestForm}>
      <ActionRow title="Опоздание" icon="clock" expanded disabled={busy} onPress={onToggle} />
      <Field label="На сколько минут" value={minutes} onChange={setMinutes} numeric limit={4} />
      <Field label="Причина опоздания" value={reason} onChange={setReason} limit={500} />
      <Text style={styles.label}>Связанная заявка (необязательно)</Text>
      <Choices rows={[{ id: '', label: 'Без заявки' }, ...tasks.filter(task => !CLOSED_TASKS.has(task.status))
        .map(task => ({ id: task.id, label: '№' + task.id + ' · ' + task.title }))]}
        selected={taskId ?? ''} onSelect={setTaskId} />
      <Action primary disabled={busy || offline || !Number.isInteger(duration) || duration < 1 || duration > 1440 || !reason.trim()}
        onPress={async () => {
          if (await run(() => post(request, '/incidents', {
            kind: 'lateness', minutes: duration, reason: reason.trim(), ...(taskId ? { taskId } : {}),
          }), 'Опоздание передано руководителю')) {
            onToggle();
            setMinutes('');
            setReason('');
            setTaskId(null);
          }
        }}>Отправить</Action>
      <Action disabled={busy} onPress={onToggle}>Отмена</Action>
    </View>
  );
}

function IncidentSummary({ incident }) {
  return (
    <>
      <Text style={styles.label}>{INCIDENT_NAMES[incident.kind] || incident.kind} · {STATUS[incident.status] || incident.status}</Text>
      {incident.employeeName && <Text style={styles.muted}>{incident.employeeName} · {timeLabel(incident.occurredAt || incident.createdAt)}</Text>}
      {incident.taskTitle && <Text style={styles.muted}>Заявка · {incident.taskTitle}</Text>}
      {incident.minutes != null && <Text style={styles.muted}>Опоздание · {incident.minutes} мин</Text>}
      {incident.reason && <Text style={styles.muted}>{incident.reason}</Text>}
      {incident.kind === 'urgent_leave' && (
        <Text style={incident.safe ? styles.success : styles.error}>{incident.safe ? 'Объект оставлен безопасно' : 'Объект требует срочной проверки'}</Text>
      )}
      {incident.decisionReason && <Text style={styles.muted}>Решение · {incident.decisionReason}</Text>}
    </>
  );
}

function EmployeeEmergency({ incident, request, busy, offline, run }) {
  const [reason, setReason] = useState(null);
  return (
    <Card title="Аварийное назначение" warning>
      <IncidentSummary incident={incident} />
      {reason === null ? (
        <>
          <Action primary disabled={busy || offline} onPress={() => run(() => post(request, `/incidents/${incident.id}/decision`, {
            action: 'accept',
          }), 'Аварийное назначение принято')}>Принять</Action>
          <Action disabled={busy || offline} onPress={() => setReason('')}>Не могу выполнить</Action>
        </>
      ) : (
        <>
          <Field label="Причина отказа" value={reason} onChange={setReason} limit={500} />
          <Action disabled={busy || offline || !reason.trim()} onPress={() => run(() => post(request, `/incidents/${incident.id}/decision`, {
            action: 'decline', reason: reason.trim(),
          }), 'Отказ отправлен диспетчеру')}>Подтвердить отказ</Action>
          <Action disabled={busy} onPress={() => setReason(null)}>Назад</Action>
        </>
      )}
    </Card>
  );
}

function ShiftChoice({ shift, reminder, tasks, request, busy, offline, run }) {
  const [taskId, setTaskId] = useState(null);
  const available = reminder?.tasks ?? tasks.filter(task => !shift.handledTaskIds?.includes(task.id)
    && ['assigned', 'accepted', 'travel', 'arrived', 'work', 'rework', 'paused'].includes(task.status));
  const currentTask = available.find(task => task.id === taskId) ?? (available.length === 1 ? available[0] : null);
  const selected = currentTask?.id;
  const canPause = currentTask && ['work', 'rework', 'paused'].includes(currentTask.status);
  const decisionReady = Date.now() >= +new Date(shift.endsAt) - 30 * 60 * 1000;
  const submit = decision => run(() => post(request, `/shifts/${shift.id}/decision`, {
    decision, ...((decision === 'pause' || decision === 'transfer') && selected ? { taskId: selected } : {}),
  }));
  return (
    <>
      {decisionReady && available.length > 1 && <Choices rows={available.map(task => ({ id: task.id, label: '№' + task.id + ' · ' + task.title }))}
        selected={selected} onSelect={setTaskId} />}
      {decisionReady && !shift.decision && available.length > 0 && (
        <Action disabled={busy || offline} onPress={() => submit('continue')}>Продолжить работу</Action>
      )}
      {decisionReady && available.length > 0 && (
        <>
          {canPause && <Action disabled={busy || offline} onPress={() => submit('pause')}>Приостановить заявку</Action>}
          <Action disabled={busy || offline || !selected} onPress={() => submit('transfer')}>Запросить передачу</Action>
        </>
      )}
      {!available.length && <Action primary disabled={busy || offline} onPress={() => submit('finish')}>Завершить смену</Action>}
    </>
  );
}

function TripOverview({ trip, pending, loaded, offline, error, onTrips }) {
  const active = trip?.status === 'active';
  const detail = trip ? `${trip.destination} · ${tripPeriod(trip)}`
    : offline ? 'Для обновления нужна связь.'
      : loaded ? 'Согласованные поездки появятся здесь.' : error ? undefined : 'Загружаем поездки…';
  return (
    <Card>
      <ActionRow title={active ? 'Текущая командировка' : trip ? 'Ближайшая командировка' : 'Мои командировки'}
        detail={detail} icon="briefcase" onPress={() => onTrips(trip ? { tripId: trip.id } : {})} />
      {pending.length > 0 && <ActionRow title="На согласовании" detail={pending.length === 1
        ? `${pending[0].destination} · ${tripPeriod(pending[0])}` : `Запросов: ${pending.length}`}
        icon="clock" onPress={() => onTrips(pending.length === 1 ? { requestId: pending[0].id } : {})} />}
      {trip && <Action onPress={() => onTrips({})}>Все командировки</Action>}
      {error && !offline && <Text style={styles.muted}>Не удалось обновить командировки.</Text>}
    </Card>
  );
}

export function EmployeeShiftPanel({ request, onUrgentLeave, offline = false, onChange, onShifts, tasks = [],
  urgentLeavePending = false, onTrips }) {
  const { data, reload, error, tripError } = useShiftData(request, offline, onShifts, true, Boolean(onTrips));
  const { busy, notice, run } = useAction(reload, onChange);
  const [now, setNow] = useState(Date.now);
  const [openRequest, setOpenRequest] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleDate, setScheduleDate] = useState(localDate);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const urgent = data.incidents.find(incident => incident.kind === 'urgent_leave' && ['open', 'transferred'].includes(incident.status));
  const emergencies = data.incidents.filter(incident => incident.kind === 'emergency' && incident.status === 'open');
  const today = localDate(new Date(now));
  const latestShift = [...data.shifts].reverse().find(shift => +new Date(shift.startsAt) <= now);
  const activeShift = latestShift?.finishedAt ? null : latestShift;
  const upcomingShift = data.shifts.find(shift => !shift.finishedAt && +new Date(shift.startsAt) > now);
  const todayUpcoming = upcomingShift && localDate(new Date(upcomingShift.startsAt)) === today ? upcomingShift : null;
  const todayFinished = latestShift?.finishedAt && localDate(new Date(latestShift.finishedAt)) === today ? latestShift : null;
  const displayedShift = activeShift ?? todayUpcoming ?? todayFinished;
  const showShiftChoice = activeShift && !data.reminders.some(reminder => reminder.shiftId === activeShift.id);
  const nextTrip = data.trips.find(trip => trip.status === 'active') ?? data.trips
    .filter(trip => trip.status === 'planned' && +new Date(trip.plannedEnd) > now)
    .sort((a, b) => +new Date(a.plannedStart) - +new Date(b.plannedStart))[0];
  const pendingTrips = data.tripRequests.filter(trip => trip.status === 'pending');
  const scheduledShifts = data.shifts.filter(shift => periodCoversDay(shift.startsAt, shift.endsAt, scheduleDate));
  const scheduledTrips = data.trips.filter(trip => periodCoversDay(trip.plannedStart, trip.plannedEnd, scheduleDate));
  const pendingIncidents = data.incidents.filter(incident => incident.status === 'open').length;
  const toggleRequest = key => setOpenRequest(current => current === key ? null : key);
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.pageHeading}>
        <Text accessibilityRole="header" style={styles.title}>Рабочее время</Text>
        <Text style={styles.muted}>Смены, дежурства и поездки</Text>
      </View>
      <ShiftOverview shift={displayedShift} nextShift={upcomingShift === displayedShift ? null : upcomingShift}
        now={now} scheduleLoaded={data.scheduleLoaded} scheduleUnavailable={offline || Boolean(error)}>
        {showShiftChoice && <ShiftChoice key={activeShift.id} shift={activeShift}
          tasks={tasks} request={request} busy={busy} offline={offline} run={run} />}
      </ShiftOverview>
      <Notice notice={notice} error={error} />
      {offline && <Text style={styles.muted}>Срочный уход можно сохранить без связи. Остальные действия доступны после подключения.</Text>}
      {data.reminders.map(reminder => (
        <Reminder key={reminder.shiftId} reminder={reminder}>
          {activeShift?.id === reminder.shiftId && <ShiftChoice shift={activeShift} reminder={reminder}
            tasks={tasks} request={request} busy={busy} offline={offline} run={run} />}
        </Reminder>
      ))}
      {emergencies.map(incident => <EmployeeEmergency key={incident.id} incident={incident}
        request={request} busy={busy} offline={offline} run={run} />)}
      {onTrips && <TripOverview trip={nextTrip} pending={pendingTrips} loaded={data.tripsLoaded} offline={offline}
        error={tripError} onTrips={onTrips} />}
      <Text accessibilityRole="header" style={styles.sectionTitle}>Мои обращения</Text>
      <Card>
        <UrgentLeave request={request} onUrgentLeave={onUrgentLeave} offline={offline} incident={urgent}
          pending={urgentLeavePending} busy={busy} run={run} opened={openRequest === 'leave'} onToggle={() => toggleRequest('leave')} />
        <View style={styles.rowDivider} />
        <LatenessForm request={request} tasks={tasks} busy={busy} run={run} offline={offline}
          opened={openRequest === 'lateness'} onToggle={() => toggleRequest('lateness')} />
        {data.incidents.length > 0 && <>
          <View style={styles.rowDivider} />
          <ActionRow title="История обращений" icon="clipboard" expanded={showHistory}
            detail={pendingIncidents > 0 ? `Ожидают решения: ${pendingIncidents}` : undefined}
            onPress={() => setShowHistory(value => !value)} />
          {showHistory && data.incidents.map(incident => <View key={incident.id} style={styles.listItem}><IncidentSummary incident={incident} /></View>)}
        </>}
      </Card>
      {(data.scheduleLoaded || data.tripsLoaded) && <Card>
        <ActionRow title="Мой график" icon="calendar" detail="Смены, дежурства и командировки" expanded={showSchedule}
          onPress={() => setShowSchedule(value => !value)} />
        {showSchedule && <>
          <MonthCalendar date={scheduleDate} onSelect={setScheduleDate} days={data.days} shifts={data.shifts} trips={data.trips} />
          <View style={styles.calendarLegend}>
            <View style={styles.legendItem}><View style={styles.calendarDot} /><Text style={styles.muted}>Смена или дежурство</Text></View>
            <View style={styles.legendItem}><View style={[styles.calendarDot, styles.tripDot]} /><Text style={styles.muted}>Командировка</Text></View>
          </View>
          <Text style={styles.label}>{new Date(`${scheduleDate}T12:00:00`).toLocaleDateString('ru-RU', {
            weekday: 'long', day: 'numeric', month: 'long',
          })}</Text>
          {scheduledShifts.map(shift => <ShiftSummary key={shift.id} shift={shift} />)}
          {scheduledTrips.map(trip => <ActionRow key={trip.id} title={trip.destination} icon="briefcase"
            detail={`Командировка · ${tripPeriod(trip)}`} onPress={() => onTrips?.({ tripId: trip.id })} />)}
          {!scheduledShifts.length && !scheduledTrips.length && <Text style={styles.muted}>На этот день ничего не запланировано.</Text>}
        </>}
      </Card>}
    </ScrollView>
  );
}

function MonthCalendar({ date, onSelect, days, shifts, trips }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const today = new Date();
  const month = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const total = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const first = (month.getDay() + 6) % 7;
  const cells = Array.from({ length: Math.ceil((first + total) / 7) * 7 }, (_, index) => {
    const day = index - first + 1;
    if (day < 1 || day > total) return null;
    const value = localDate(new Date(month.getFullYear(), month.getMonth(), day));
    return { day, value, schedule: days.find(row => row.date === value),
      count: shifts.filter(shift => trips ? periodCoversDay(shift.startsAt, shift.endsAt, value)
        : (shift.date ?? localDate(new Date(shift.startsAt))) === value).length,
      trip: trips?.some(trip => periodCoversDay(trip.plannedStart, trip.plannedEnd, value)) };
  });
  return (
    <>
      <View style={styles.calendarTitle}>
        <Pressable accessibilityRole="button" accessibilityLabel="Предыдущий месяц" onPress={() => setMonthOffset(value => value - 1)} style={styles.calendarArrow}><Icon name="chevron-left" size={20} color="#526B94" /></Pressable>
        <Text style={styles.heading}>{month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Следующий месяц" onPress={() => setMonthOffset(value => value + 1)} style={styles.calendarArrow}><Icon name="chevron-right" size={20} color="#526B94" /></Pressable>
      </View>
      <View style={styles.calendarGrid}>
        {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => (
          <View key={day} style={styles.calendarCell}><Text style={styles.muted}>{day}</Text></View>
        ))}
        {cells.map((cell, index) => cell ? (
          <Pressable accessibilityRole="button" accessibilityLabel={cell.trip ? `${cell.value}, командировка` : cell.value}
            accessibilityState={{ selected: date === cell.value }}
            key={cell.value} style={[styles.calendarCell, styles.calendarDay,
              cell.schedule?.type === 'holiday' && styles.warning, date === cell.value && styles.selected]}
            onPress={() => onSelect(cell.value)}>
            <Text style={[styles.label, cell.schedule?.type === 'holiday' && styles.holidayText, date === cell.value && styles.primaryText]}>{cell.day}</Text>
            {(cell.count > 0 || cell.trip) && <View style={styles.calendarDots}>
              {cell.count > 0 && <View style={[styles.calendarDot, date === cell.value && styles.whiteDot]} />}
              {cell.trip && <View style={[styles.calendarDot, styles.tripDot, date === cell.value && styles.selectedTripDot]} />}
            </View>}
          </Pressable>
        ) : <View key={'blank-' + index} style={styles.calendarCell} />)}
      </View>
    </>
  );
}

function ScheduleEditor({ data, request, assignees, busy, run, editable }) {
  const [date, setDate] = useState(localDate());
  const [mode, setMode] = useState(null);
  const [employee, setEmployee] = useState(null);
  const [kind, setKind] = useState('normal');
  const [starts, setStarts] = useState('09:00');
  const [ends, setEnds] = useState('18:00');
  const [overnight, setOvernight] = useState(false);
  const [dayType, setDayType] = useState('holiday');
  const [dayLabel, setDayLabel] = useState('');
  const startsAt = isoDateTime(date, starts);
  const nextDay = new Date(date + 'T12:00:00');
  nextDay.setDate(nextDay.getDate() + 1);
  const endsAt = isoDateTime(overnight ? localDate(nextDay) : date, ends);
  const day = data.days.find(row => row.date === date);
  const shifts = data.shifts.filter(shift => (shift.date ?? localDate(new Date(shift.startsAt))) === date);

  return (
    <Card title="Календарь компании">
      <MonthCalendar date={date} onSelect={setDate} days={data.days} shifts={data.shifts} />
      <Text style={styles.label}>{timeLabel(isoDateTime(date, '12:00')).split(',')[0]}{day ? ' · ' + (day.type === 'holiday' ? 'Выходной' : 'Рабочий день') : ''}</Text>
      {day?.label && <Text style={styles.muted}>{day.label}</Text>}
      {shifts.length ? shifts.map(shift => <ShiftSummary key={shift.id} shift={shift} />)
        : <Text style={styles.muted}>На этот день смены и дежурства не назначены.</Text>}
      {editable && mode === null && (
        <>
          <Action onPress={() => setMode('shift')}>Назначить смену или дежурство</Action>
          <Action onPress={() => setMode('day')}>Указать рабочий день или выходной</Action>
        </>
      )}
      {editable && mode === 'shift' && (
        <>
          <Text style={styles.label}>Сотрудник</Text>
          <Choices rows={assignees} selected={employee} onSelect={setEmployee} />
          <Choices rows={[{ id: 'normal', label: 'Смена' }, { id: 'duty', label: 'Дежурство' }]} selected={kind} onSelect={setKind} />
          <Field label="Начало · ЧЧ:ММ" value={starts} onChange={setStarts} placeholder="09:00" limit={5} />
          <Field label="Конец · ЧЧ:ММ" value={ends} onChange={setEnds} placeholder="18:00" limit={5} />
          <Action selected={overnight} onPress={() => setOvernight(value => !value)}>
            {overnight ? '✓ Конец на следующий день' : 'Конец на следующий день'}
          </Action>
          <Text style={styles.muted}>Время вводится в часовом поясе этого телефона.</Text>
          <Action primary disabled={busy || !employee || !startsAt || !endsAt || startsAt >= endsAt}
            onPress={async () => {
              if (await run(() => post(request, '/shifts', { employeeId: employee, date, startsAt, endsAt, kind }))) setMode(null);
            }}>Сохранить график</Action>
          <Action disabled={busy} onPress={() => setMode(null)}>Отмена</Action>
        </>
      )}
      {editable && mode === 'day' && (
        <>
          <Choices rows={[{ id: 'holiday', label: 'Выходной' }, { id: 'working', label: 'Рабочий день' }]}
            selected={dayType} onSelect={setDayType} />
          <Field label="Название или примечание" value={dayLabel} onChange={setDayLabel} limit={120} />
          <Action primary disabled={busy} onPress={async () => {
            if (await run(() => post(request, '/shifts/calendar', { date, type: dayType, label: dayLabel.trim() }))) {
              setMode(null);
              setDayLabel('');
            }
          }}>Сохранить день</Action>
          <Action disabled={busy} onPress={() => setMode(null)}>Отмена</Action>
        </>
      )}
    </Card>
  );
}

function TransferForm({ assignees, busy, onTransfer, label = 'Выбрать нового исполнителя' }) {
  const [employee, setEmployee] = useState(null);
  const [open, setOpen] = useState(false);
  if (!open) return <Action disabled={busy} onPress={() => setOpen(true)}>{label}</Action>;
  return (
    <>
      <Choices rows={assignees} selected={employee} onSelect={setEmployee} />
      <Action primary disabled={busy || !employee} onPress={async () => {
        if (await onTransfer(employee)) {
          setOpen(false);
          setEmployee(null);
        }
      }}>Передать заявку</Action>
      <Action disabled={busy} onPress={() => setOpen(false)}>Отмена</Action>
    </>
  );
}

export function TaskTransfer({ task, request, employees }) {
  const { busy, notice, run } = useAction(() => {});
  const assignees = employees
    .filter(user => user.role === 'employee' && (task.status === 'unassigned' || String(user.id) !== String(task.assigneeId)))
    .map(user => ({ id: user.id, label: user.name }));
  return (
    <Card title="Передача заявки">
      <TransferForm assignees={assignees} busy={busy}
        onTransfer={assigneeId => run(() => post(request, `/tasks/${task.id}/transfer`, { assigneeId }), 'Заявка передана')} />
      <Notice notice={notice} />
    </Card>
  );
}

function EmergencyForm({ request, tasks, assignees, busy, run }) {
  const [opened, setOpened] = useState(false);
  const [task, setTask] = useState(null);
  const [employee, setEmployee] = useState(null);
  const [reason, setReason] = useState('');
  return (
    <Card title="Аварийное назначение">
      {!opened ? <Action onPress={() => setOpened(true)}>Предложить аварийный выезд</Action> : (
        <>
          <Text style={styles.label}>Аварийная заявка</Text>
          <Choices rows={tasks.filter(row => row.status === 'assigned').map(row => ({ id: row.id, label: '№' + row.id + ' · ' + row.title }))}
            selected={task} onSelect={setTask} empty="Сначала создайте заявку для аварийного выезда." />
          <Text style={styles.label}>Кому предложить</Text>
          <Choices rows={assignees} selected={employee} onSelect={setEmployee} />
          <Field label="Причина аварийного назначения" value={reason} onChange={setReason} limit={500} />
          <Action primary disabled={busy || !task || !employee || !reason.trim()} onPress={async () => {
            if (await run(() => post(request, '/incidents', { kind: 'emergency', taskId: task, assigneeId: employee, reason: reason.trim() }),
              'Предложение отправлено сотруднику')) {
              setOpened(false);
              setTask(null);
              setEmployee(null);
              setReason('');
            }
          }}>Предложить выезд</Action>
          <Action disabled={busy} onPress={() => setOpened(false)}>Отмена</Action>
        </>
      )}
    </Card>
  );
}

function ManagerLateness({ incident, request, busy, run }) {
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  if (!action) return (
    <>
      <Action disabled={busy} onPress={() => setAction('approve')}>Подтвердить опоздание</Action>
      <Action disabled={busy} onPress={() => setAction('reject')}>Отклонить</Action>
    </>
  );
  return (
    <>
      <Field label={action === 'reject' ? 'Причина отказа' : 'Комментарий руководителя'} value={reason} onChange={setReason} limit={500} />
      <Action primary disabled={busy || (action === 'reject' && !reason.trim())} onPress={() => run(() => post(request,
        `/incidents/${incident.id}/decision`, { action, reason: reason.trim() }))}>Сохранить решение</Action>
      <Action disabled={busy} onPress={() => setAction(null)}>Назад</Action>
    </>
  );
}

function OfficeIncident({ incident, request, assignees, manager, busy, run }) {
  return (
    <Card warning={incident.kind === 'urgent_leave' && incident.status === 'open' && incident.safe === false}>
      <IncidentSummary incident={incident} />
      {incident.kind === 'lateness' && incident.status === 'open' && manager && (
        <ManagerLateness incident={incident} request={request} busy={busy} run={run} />
      )}
      {incident.kind === 'urgent_leave' && incident.affectedTasks?.map(task => (
        <View key={task.taskId} style={styles.listItem}>
          <Text style={styles.label}>№{task.taskId} · {task.title}</Text>
          <Text style={styles.muted}>{task.transferred ? 'Передана' : STATUS[task.status] || task.status}</Text>
          {!manager && !task.transferred && ['paused', 'unassigned'].includes(task.status) && (
            <TransferForm assignees={assignees.filter(row => String(row.id) !== String(incident.employeeId))}
              busy={busy} onTransfer={assigneeId => run(() => post(request, `/incidents/${incident.id}/transfer`,
                { taskId: task.taskId, assigneeId }), 'Заявка передана')} />
          )}
        </View>
      ))}
    </Card>
  );
}

export function OfficeShiftPanel({ request, role, employees = [], tasks = [] }) {
  const [screen, setScreen] = useState('incidents');
  const { data, reload, error } = useShiftData(request, false);
  const { busy, notice, run } = useAction(reload);
  const manager = role === 'manager';
  const assignees = employees.filter(user => user.role === 'employee').map(user => ({ id: user.id, label: user.name }));
  const available = assignees.filter(row => !data.unavailableEmployeeIds.includes(String(row.id)));
  const attention = data.incidents.filter(incident => incident.status === 'open').length;
  return (
    <View style={styles.group}>
      <View style={styles.officeToolbar}>
        <View style={[styles.officeTabs, styles.flex]}>
          {[['incidents', attention ? 'Ситуации · ' + attention : 'Ситуации'], ['schedule', 'Календарь']].map(([key, label]) => <Pressable key={key}
            accessibilityRole="tab" accessibilityState={{ selected: screen === key }} onPress={() => setScreen(key)} style={[styles.officeTab, screen === key && styles.selected]}>
            <Text style={[styles.buttonText, screen === key && styles.primaryText]}>{label}</Text>
          </Pressable>)}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Обновить смены" disabled={busy} onPress={reload} style={styles.calendarArrow}><Icon name="refresh" size={20} color="#087CFF" /></Pressable>
      </View>
      <View>
        <Notice notice={notice} error={error} />
      </View>
      {data.reminders.map(reminder => <Reminder key={reminder.shiftId} reminder={reminder} />)}
      {data.shifts.flatMap(shift => (shift.transferTaskIds ?? (shift.transferTaskId ? [shift.transferTaskId] : []))
        .map(taskId => (
          <Card key={shift.id + ':' + taskId} title="Запрошена передача">
            <ShiftSummary shift={shift} />
            <Text style={styles.muted}>Заявка №{taskId}{tasks.find(task => task.id === taskId)?.title
              ? ' · ' + tasks.find(task => task.id === taskId).title : ''}</Text>
            {!manager && (
              <TransferForm assignees={available.filter(row => String(row.id) !== String(shift.employeeId))} busy={busy}
                onTransfer={assigneeId => run(() => post(request, `/shifts/${shift.id}/transfer`, { taskId, assigneeId }), 'Заявка передана')} />
            )}
          </Card>
        )))}
      {screen === 'schedule' ? (
        <ScheduleEditor data={data} request={request} assignees={assignees} busy={busy} run={run} editable={!manager} />
      ) : (
        <>
          {!manager && <EmergencyForm request={request} tasks={tasks} assignees={available} busy={busy} run={run} />}
          {data.incidents.length === 0 && <Card><Text style={styles.muted}>Ситуаций пока нет.</Text></Card>}
          {data.incidents.map(incident => <OfficeIncident key={incident.id} incident={incident}
            request={request} assignees={available} manager={manager} busy={busy} run={run} />)}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 30, gap: 12, backgroundColor: '#F5F7FC' },
  group: { gap: 12 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14, gap: 11 },
  warning: { backgroundColor: '#FFF5E9' },
  banner: { marginHorizontal: 16, backgroundColor: '#FFF5E9', padding: 10, borderRadius: 11,
    flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 6 },
  title: { color: '#142034', fontSize: 27, fontWeight: '700', letterSpacing: -0.7 },
  pageHeading: { gap: 4, paddingVertical: 4 },
  heading: { color: '#142034', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  sectionTitle: { color: '#142034', fontSize: 17, fontWeight: '700', marginTop: 4 },
  label: { color: '#142034', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  muted: { color: '#8493AA', fontSize: 12, lineHeight: 17 },
  success: { color: '#18AD7B', fontSize: 13, fontWeight: '600' },
  error: { color: '#ED536B', fontSize: 13, lineHeight: 18, fontWeight: '600' },
  button: { minHeight: 43, paddingVertical: 9, paddingHorizontal: 12,
    borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EDF5FF', flexShrink: 1 },
  primary: { backgroundColor: '#087CFF' },
  selected: { backgroundColor: '#087CFF' },
  dim: { opacity: 0.5 },
  buttonText: { color: '#087CFF', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  primaryText: { color: '#FFFFFF' },
  field: { gap: 6 },
  input: { minHeight: 46, color: '#142034', backgroundColor: '#F5F7FC', borderWidth: 1, borderColor: '#E5ECF6',
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, fontSize: 14 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  listItem: { gap: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#ECF0F7', paddingTop: 10 },
  summaryRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  actionRow: { minHeight: 48, paddingVertical: 4, flexDirection: 'row', gap: 10, alignItems: 'center' },
  rowCopy: { flex: 1, minWidth: 0, gap: 3 },
  chevronDown: { transform: [{ rotate: '90deg' }] },
  rowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E3EAF4' },
  requestForm: { gap: 9 },
  sectionHeading: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  cardIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#EDF5FF', alignItems: 'center', justifyContent: 'center' },
  cardIconWarning: { backgroundColor: '#FFF0D8' },
  calendarTitle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  calendarArrow: { width: 40, height: 40, borderRadius: 11, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', backgroundColor: '#F7F9FD', padding: 4, borderRadius: 12 },
  calendarCell: { width: '14.28%', minHeight: 31, alignItems: 'center', justifyContent: 'center' },
  calendarDay: { borderRadius: 9, minHeight: 39, gap: 3 },
  calendarCount: { color: '#087CFF', fontSize: 10, fontWeight: '600' },
  calendarDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#087CFF' },
  calendarDots: { flexDirection: 'row', gap: 4 },
  calendarLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  legendItem: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  tripDot: { backgroundColor: '#16865F' },
  selectedTripDot: { backgroundColor: '#A7F2D5' },
  whiteDot: { backgroundColor: '#FFFFFF' },
  holidayText: { color: '#ED6781' },
  shiftBadge: { color: '#087CFF', fontSize: 12, backgroundColor: '#EDF5FF', alignSelf: 'flex-start', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 4 },
  overtime: { color: '#18AD7B', fontSize: 12, fontWeight: '600' },
  shiftStatusPanel: { backgroundColor: '#F1F6FF', borderRadius: 11, padding: 13, gap: 5 },
  shiftStatus: { color: '#142034', fontSize: 19, fontWeight: '700', letterSpacing: -0.4 },
  shiftPeriod: { color: '#087CFF', fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  officeToolbar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  officeTabs: { flexDirection: 'row', borderRadius: 11, padding: 3, backgroundColor: '#ECF2FA' },
  officeTab: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 9, paddingVertical: 11 },
});
