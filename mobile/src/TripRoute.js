import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import DeadlinePicker, { deadlineToIso } from './DeadlinePicker';
import { splitTripDestination } from './TripDestinations';
import { colors, Icon } from './ui';

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function timestamp(value) {
  return value ? +new Date(value) : NaN;
}

function dateLabel(value) {
  const time = timestamp(value);
  return Number.isFinite(time) ? dateFormat.format(time) : null;
}

export function tripRouteTitle(stops = []) {
  const count = stops.length;
  if (count < 2) return null;
  const last = count % 10;
  const teens = count % 100 >= 11 && count % 100 <= 14;
  const noun = !teens && last === 1 ? 'организация'
    : !teens && last >= 2 && last <= 4 ? 'организации' : 'организаций';
  return `Маршрут · ${count} ${noun}`;
}

function routeError(value, stops, start, end) {
  if (!stops.length) return value.length ? 'Уберите точки, которых нет в задании.' : '';
  const ids = new Set(stops.map(stop => String(stop.id)));
  if (value.length !== ids.size || value.some(stop => !ids.delete(String(stop.id)))) {
    return 'В маршруте должны быть все точки задания по одному разу.';
  }
  const beginning = timestamp(start);
  const finish = timestamp(end);
  if (!Number.isFinite(beginning) || !Number.isFinite(finish) || finish <= beginning) {
    return 'Сначала укажите начало и окончание командировки.';
  }
  const times = value.map(stop => timestamp(stop.plannedAt));
  const scheduled = times.filter(Number.isFinite);
  if (new Set(scheduled).size !== scheduled.length) {
    return 'У нескольких объектов совпадают дата и время. Укажите разное время посещения.';
  }
  if (scheduled.length !== times.length) return stops.length === 1
    ? 'Выберите дату и время посещения объекта.' : 'Выберите дату и время каждой точки.';
  if (times.some(time => time < beginning || time > finish)) return stops.length === 1
    ? 'Время посещения объекта должно быть в периоде поездки.' : 'Время каждой точки должно быть в периоде поездки.';
  if (times.some((time, index) => index > 0 && time < times[index - 1])) {
    return 'Измените время посещения, чтобы обновить порядок маршрута.';
  }
  return '';
}

export function validTripRoute(value = [], stops = [], start, end) {
  return routeError(value, stops, start, end) === '';
}

function RouteButton({ children, label, onPress, primary, disabled }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [styles.button, primary && styles.primary, (disabled || pressed) && styles.dim]}>
    <Text style={[styles.buttonText, primary && styles.primaryText]}>{children}</Text>
  </Pressable>;
}

function StopHeading({ index, destination, multiple }) {
  const { city, name } = splitTripDestination(destination);
  return <View style={styles.heading}>
    {multiple && <Text style={styles.index}>{index + 1}</Text>}
    <View style={styles.stopTitle}>
      {city ? <Text style={styles.muted}>{city}</Text> : null}
      <Text accessibilityRole="header" numberOfLines={2} ellipsizeMode="tail" style={styles.stopName}>{name}</Text>
    </View>
  </View>;
}

export function TripRouteEditor({ stops = [], value = [], onChange, start, end, disabled = false }) {
  const [openId, setOpenId] = useState(null);
  if (!stops.length) return null;
  const multiple = stops.length > 1;
  const assigned = new Map(stops.map(stop => [String(stop.id), stop]));
  const route = value.length ? value : stops.map(({ id, plannedAt }) => ({ id, plannedAt: plannedAt ?? null }));
  const warning = routeError(route, stops, start, end);
  const startAt = timestamp(start);
  const endAt = timestamp(end);
  const validPeriod = Number.isFinite(startAt) && endAt > startAt;
  const canPickTime = !disabled && validPeriod;
  const firstDate = validPeriod ? new Date(startAt) : undefined;
  const lastDate = validPeriod ? new Date(endAt) : undefined;

  function setTime(id, date) {
    if (!canPickTime) return;
    const plannedAt = deadlineToIso(date);
    const next = route.map(item => item.id === id ? { ...item, plannedAt } : item);
    next.sort((left, right) => {
      const first = timestamp(left.plannedAt);
      const second = timestamp(right.plannedAt);
      if (Number.isNaN(first)) return Number.isNaN(second) ? 0 : 1;
      return Number.isNaN(second) ? -1 : first - second;
    });
    onChange(next);
  }

  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>{multiple ? 'Время посещения объектов' : 'Время посещения объекта'}</Text>
    <Text style={styles.muted}>{multiple
      ? 'Укажите дату и время каждого визита. Объекты выстроятся по времени посещения.'
      : 'Выберите дату и время визита на объект в пределах периода поездки.'}</Text>
    {route.map(({ id, plannedAt }, index) => {
      const destination = assigned.get(String(id))?.destination;
      const planned = dateLabel(plannedAt);
      const open = !multiple || openId === id;
      return <View key={id} style={styles.stop}>
        <StopHeading index={index} destination={destination} multiple={multiple} />
        {multiple && <Pressable accessibilityRole="button" accessibilityLabel={'Дата и время · ' + destination}
          accessibilityState={{ expanded: open, disabled: !canPickTime }} disabled={!canPickTime}
          onPress={() => setOpenId(open ? null : id)} style={styles.schedule}>
          <Icon name="calendar" size={18} />
          <Text style={styles.scheduleText}>{planned ? 'Посещение · ' + planned : 'Выбрать дату и время посещения'}</Text>
          <Icon name={open ? 'close' : 'chevron-right'} size={17} />
        </Pressable>}
        {open && <DeadlinePicker label="Плановое посещение" value={planned ? new Date(plannedAt) : null}
          suggestedDate={firstDate} minimumDate={firstDate} maximumDate={lastDate}
          onChange={date => setTime(id, date)} required showQuick={false} showHelper={false} disabled={!canPickTime} />}
      </View>;
    })}
    {warning ? <Text accessibilityLiveRegion="polite" style={styles.warning}>{warning}</Text> : null}
  </View>;
}

export function TripRouteSummary({ stops = [], active = false, onMark, busy = false, offline = false, error }) {
  const [skipId, setSkipId] = useState(null);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  if (!stops.length) return null;
  const multiple = stops.length > 1;
  const canMark = active && typeof onMark === 'function';
  const disabled = busy || offline || sending;
  const visited = stops.filter(stop => stop.visitedAt).length;
  const skipped = stops.filter(stop => stop.skippedAt).length;
  const skipOpen = stops.some(stop => stop.id === skipId && !stop.visitedAt && !stop.skippedAt);

  function closeSkip() {
    setSkipId(null);
    setReason('');
  }

  async function mark(id, outcome) {
    if (!canMark || disabled || inFlight.current) return;
    const text = reason.trim();
    if (outcome === 'skipped' && (id !== skipId || !text)) return;
    inFlight.current = true;
    setSending(true);
    try {
      const saved = await onMark(id, outcome === 'skipped' ? { outcome, reason: text } : { outcome });
      if (saved && outcome === 'skipped') closeSkip();
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>{multiple ? 'Маршрут поездки' : 'Посещение объекта'}</Text>
    {multiple && <Text style={styles.muted}>Посещено {visited} из {stops.length}
      {skipped > 0 ? ' · Пропущено ' + skipped : ''}</Text>}
    {canMark && offline && <Text style={styles.muted}>Для отметки точек нужна связь.</Text>}
    {stops.map((stop, index) => {
      const planned = dateLabel(stop.plannedAt);
      const actual = dateLabel(stop.visitedAt || stop.skippedAt);
      const done = stop.visitedAt || stop.skippedAt;
      const enteringReason = canMark && !done && stop.id === skipId;
      return <View key={stop.id} style={styles.stop}>
        <StopHeading index={index} destination={stop.destination} multiple={multiple} />
        <Text style={styles.muted}>{planned ? 'По плану · ' + planned : 'Время посещения ещё не согласовано'}</Text>
        <Text style={[styles.badge, stop.visitedAt && styles.visited, stop.skippedAt && styles.skipped]}>
          {stop.visitedAt ? (multiple ? 'Посещена' : 'Посещение отмечено')
            : stop.skippedAt ? (multiple ? 'Пропущена' : 'Посещение пропущено') : 'Ожидает посещения'}
        </Text>
        {actual ? <Text style={styles.muted}>Отметка · {actual}</Text> : null}
        {stop.skipReason ? <Text style={styles.body}>Причина · {stop.skipReason}</Text> : null}
        {canMark && !done && !skipOpen ? <View style={styles.actions}>
          <RouteButton label={'Точка посещена · ' + stop.destination} primary disabled={disabled}
            onPress={() => { void mark(stop.id, 'visited'); }}>Посетил</RouteButton>
          <RouteButton label={'Пропустить точку · ' + stop.destination} disabled={disabled}
            onPress={() => { setSkipId(stop.id); setReason(''); }}>Пропустить</RouteButton>
        </View> : null}
        {enteringReason ? <>
          <TextInput accessibilityLabel="Причина пропуска" value={reason} onChangeText={setReason}
            maxLength={500} multiline editable={!disabled} placeholder="Укажите причину пропуска"
            placeholderTextColor={colors.muted} style={styles.reason} />
          <View style={styles.actions}>
            <RouteButton primary disabled={disabled || !reason.trim()}
              onPress={() => { void mark(stop.id, 'skipped'); }}>Сохранить пропуск</RouteButton>
            <RouteButton disabled={busy || sending} onPress={closeSkip}>Отмена</RouteButton>
          </View>
        </> : null}
      </View>;
    })}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 14, gap: 9 },
  stop: { borderTopWidth: 1, borderColor: colors.border, paddingTop: 10, gap: 7 },
  heading: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  index: { backgroundColor: colors.tint, color: '#185DB0', fontSize: 14, minWidth: 26, minHeight: 26,
    paddingHorizontal: 5, paddingTop: 4, textAlign: 'center', borderRadius: 7, fontWeight: '700' },
  title: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  stopTitle: { flex: 1, gap: 2 },
  stopName: { color: colors.ink, fontSize: 14, fontWeight: '700', lineHeight: 20 },
  body: { color: colors.ink, fontSize: 14, lineHeight: 19 },
  muted: { color: '#536680', fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  button: { backgroundColor: colors.tint, borderRadius: 9, minHeight: 44,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 11, paddingVertical: 7 },
  primary: { backgroundColor: '#136BC9' },
  buttonText: { color: '#185DB0', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  primaryText: { color: '#fff' },
  dim: { opacity: 0.55 },
  schedule: { minHeight: 46, backgroundColor: colors.canvas, borderRadius: 9,
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 9, paddingVertical: 7 },
  scheduleText: { flex: 1, color: colors.ink, fontSize: 14 },
  warning: { color: '#80550F', backgroundColor: '#FFF6E6', borderRadius: 8, padding: 8, fontSize: 13, lineHeight: 18 },
  badge: { alignSelf: 'flex-start', color: '#185DB0', backgroundColor: colors.tint, borderRadius: 7,
    paddingHorizontal: 8, paddingVertical: 5, fontSize: 12, fontWeight: '700' },
  visited: { color: '#176443', backgroundColor: '#EAF8F0' },
  skipped: { color: '#80550F', backgroundColor: '#FFF6E6' },
  reason: { minHeight: 72, padding: 9, color: colors.ink, textAlignVertical: 'top',
    borderWidth: 1, borderColor: colors.border, borderRadius: 9, backgroundColor: colors.canvas },
  error: { color: '#9F2329', fontSize: 13, lineHeight: 18 },
});
