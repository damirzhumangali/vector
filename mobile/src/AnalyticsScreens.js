import React, { useCallback, useEffect, useState } from 'react';
import { AppState, FlatList, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import Svg, { Circle } from 'react-native-svg';
import { Icon } from './ui';
import TripExpenseReport from './TripExpenseReport';

const EMPTY_FILTERS = { employeeId: '', objectId: '', department: '', from: '', to: '' };
const STATUS_LABELS = {
  assigned: 'Назначена', unassigned: 'Без исполнителя', accepted: 'Принята сотрудником',
  travel: 'В пути', arrived: 'На объекте', work: 'В работе', review: 'На проверке',
  done: 'Работа принята', rework: 'На доработке', paused: 'Приостановлена',
  cancelled: 'Отменена', repeated: 'Назначен повторный выезд',
};
const PHOTO_LABELS = { before: 'До', after: 'После', material: 'Материал руководителя' };

function queryPath(path, filters) {
  const query = Object.entries(filters)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return query ? path + '?' + query : path;
}

function validDate(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function timeLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : String(value);
}

function percent(value) {
  return value == null ? '—' : `${Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

function duration(minutes) {
  return `${Number(minutes).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} мин`;
}

function periodLabel(from, to) {
  const date = value => new Date(value + 'T12:00:00').toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  if (from && to) return `${date(from)} — ${date(to)}`;
  if (from) return `С ${date(from)}`;
  if (to) return `По ${date(to)}`;
  return 'Всё время';
}

function Button({ children, onPress, secondary = false, disabled = false }) {
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled}
      style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, (pressed || disabled) && styles.dimmed]}
    >
      <Text style={[styles.buttonLabel, secondary && styles.buttonLabelSecondary]}>{children}</Text>
    </Pressable>
  );
}

function FilterPicker({ label, value, options, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selection = options.find(option => option.value === value);
  const rows = [{ label: 'Все', value: '' }, ...options.filter(option =>
    option.label.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU')))];
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Button secondary disabled={disabled} onPress={() => { setSearch(''); setOpen(true); }}>
        {selection?.label ?? (value || 'Все')} ⌄
      </Button>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.picker}>
            <Text accessibilityRole="header" style={styles.title}>{label}</Text>
            {options.length > 8 && <TextInput
              accessibilityLabel={`Поиск · ${label}`} placeholder="Поиск" style={styles.input}
              value={search} onChangeText={setSearch}
            />}
            <FlatList
              data={rows} keyExtractor={item => item.value} keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="radio" accessibilityState={{ checked: item.value === value }}
                  style={styles.pickerRow} onPress={() => { onChange(item.value); setOpen(false); }}
                >
                  <Text style={styles.label}>{item.label}{item.value === value ? ' ✓' : ''}</Text>
                </Pressable>
              )}
            />
            <Button secondary onPress={() => setOpen(false)}>Закрыть</Button>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function MetricGrid({ metrics }) {
  const entries = [
    ['Выполнено', metrics.completed, 'check', '#087CFF', '#EAF4FF'],
    ['Просрочки', metrics.overdue, 'clock', '#FF9E24', '#FFF4E3'],
    ['SLA по сроку', percent(metrics.slaPercent), 'chart', '#18B982', '#E9FAF2'],
    ['Повторные выезды', metrics.repeatTrips, 'refresh', '#FA6075', '#FFF0F3'],
  ];
  return (
    <View style={styles.card}>
      <View style={styles.sectionHeading}>
        <View style={styles.iconTint}><Icon name="calendar" size={21} color="#087CFF" /></View>
        <View style={styles.flex}><Text style={styles.title}>Обзор заявок</Text><Text style={styles.muted}>Показатели за выбранный период</Text></View>
      </View>
      <View style={styles.grid}>
        {entries.map(([label, value, icon, color, backgroundColor]) => (
          <View style={styles.metric} key={label}>
            <View style={[styles.metricIcon, { backgroundColor }]}><Icon name={icon} size={22} color={color} /></View>
            <View style={styles.flex}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text></View>
          </View>
        ))}
      </View>
    </View>
  );
}

function Distribution({ report }) {
  const { completed, active, unconfirmed, total } = report.metrics;
  const other = Math.max(0, total - completed - active - unconfirmed);
  const pieces = [
    ['Выполнено', completed, '#087CFF'], ['В работе', active, '#FFAC32'],
    ['На проверке', unconfirmed, '#1BC693'], ['Другие', other, '#BDCAE0'],
  ];
  const circumference = 2 * Math.PI * 54;
  let offset = 0;
  return (
    <View style={styles.card}>
      <View style={styles.sectionHeading}>
        <View style={styles.iconTint}><Icon name="chart" size={22} color="#087CFF" /></View>
        <View style={styles.flex}><Text style={styles.title}>Выполнение работ</Text><Text style={styles.muted}>Распределение заявок по статусам</Text></View>
      </View>
      <View style={styles.chartRow}>
        <View style={styles.donut} accessibilityLabel={`Всего ${total} заявок. Выполнено ${completed}, в работе ${active}, на проверке ${unconfirmed}`}>
          <Svg width={146} height={146} viewBox="0 0 146 146">
            <Circle cx="73" cy="73" r="54" stroke="#EEF3FA" strokeWidth="17" fill="none" />
            {pieces.map(([label, value, color]) => {
              const length = total ? value / total * circumference : 0;
              const start = offset;
              offset += length;
              return value > 0 && <Circle key={label} cx="73" cy="73" r="54" stroke={color} strokeWidth="17" fill="none"
                strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-start}
                rotation={-90} origin="73,73" />;
            })}
          </Svg>
          <View pointerEvents="none" style={styles.donutCenter}><Text style={styles.donutValue}>{total}</Text><Text style={styles.muted}>заявок</Text></View>
        </View>
        <View style={styles.legend}>
          {pieces.filter(([, value]) => value > 0 || total === 0).map(([label, value, color]) => (
            <View key={label} style={styles.legendRow}><View style={[styles.dot, { backgroundColor: color }]} />
              <View style={styles.flex}><Text style={styles.legendLabel}>{label}</Text><Text style={styles.muted}>{value} заявок</Text></View>
              <Text style={styles.legendPercent}>{total ? Math.round(value / total * 100) : 0}%</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function WorkloadChart({ rows }) {
  const people = [...rows].sort((a, b) => b.total - a.total).slice(0, 6);
  const max = Math.max(1, ...people.map(person => person.total));
  return (
    <View style={styles.card}>
      <View style={styles.sectionHeading}>
        <View style={styles.iconTint}><Icon name="users" size={21} color="#087CFF" /></View>
        <View><Text style={styles.title}>Нагрузка команды</Text><Text style={styles.muted}>{rows.length > 6 ? '6 самых загруженных сотрудников' : 'Заявки по сотрудникам'}</Text></View>
      </View>
      {people.length ? people.map(person => (
        <View style={styles.workloadRow} key={person.id}>
          <View style={styles.workloadLabel}><Text numberOfLines={1} style={styles.label}>{person.name}</Text><Text style={styles.label}>{person.total}</Text></View>
          <View style={styles.barTrack}><View style={[styles.barFill, { width: `${person.total / max * 100}%` }]} /></View>
        </View>
      )) : <Text style={styles.muted}>Здесь появится нагрузка сотрудников после назначения заявок.</Text>}
    </View>
  );
}

function AdditionalMetrics({ metrics }) {
  const entries = [
    ['Время в пути', duration(metrics.travelMinutes), 'clock'],
    ['Время на объекте', duration(metrics.onSiteMinutes), 'pin'],
    ['С первого выезда', percent(metrics.firstVisitPercent), 'check'],
    ['Ждут подтверждения', metrics.unconfirmed, 'clipboard'],
    ['Отклонено фото', metrics.rejectedPhotos, 'camera'],
  ];
  return <View style={styles.card}>
    <Text style={styles.title}>Дополнительные показатели</Text>
    {entries.map(([label, value, icon]) => <View style={styles.statRow} key={label}>
      <Icon name={icon} size={19} color="#087CFF" /><Text style={[styles.muted, styles.flex]}>{label}</Text><Text style={styles.label}>{value}</Text>
    </View>)}
  </View>;
}

function periodDates(period, includeUpcoming = false) {
  if (period === 'all') return { from: '', to: '' };
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  const today = date.toISOString().slice(0, 10);
  if (period === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (period === 'month') date.setUTCDate(1);
  if (period === 'year') date.setUTCMonth(0, 1);
  const from = date.toISOString().slice(0, 10);
  if (!includeUpcoming) return { from, to: today };
  if (period === 'week') date.setUTCDate(date.getUTCDate() + 6);
  if (period === 'month') date.setUTCMonth(date.getUTCMonth() + 1, 0);
  if (period === 'year') date.setUTCMonth(11, 31);
  return { from, to: date.toISOString().slice(0, 10) };
}

function Details({ title, count, children }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button" accessibilityState={{ expanded }}
        style={styles.detailHeader} onPress={() => setExpanded(!expanded)}
      >
        <Text style={styles.title}>{title} · {count}</Text>
        <Text style={styles.muted}>{expanded ? '⌃' : '⌄'}</Text>
      </Pressable>
      {expanded && (count ? children : <Text style={styles.muted}>Нет данных по выбранным фильтрам.</Text>)}
    </View>
  );
}

function TaskRows({ tasks, onOpenTask }) {
  return tasks.map(task => (
    <Pressable accessibilityRole="button" key={task.id} style={styles.line} onPress={() => onOpenTask(task.id)}>
      <Text style={styles.link}>№{task.id} · {task.title}</Text>
      <Text style={styles.muted}>{[task.employeeName, task.objectName].filter(Boolean).join(' · ')}</Text>
      <Text style={styles.muted}>{STATUS_LABELS[task.status] ?? task.status}{task.overdue ? ' · Просрочена' : ''}</Text>
      <Text style={styles.muted}>В пути · {duration(task.travelMinutes)}. На объекте · {duration(task.onSiteMinutes)}.</Text>
    </Pressable>
  ));
}

async function shareReport(file, format) {
  const extension = format === 'xlsx' ? 'xlsx' : 'pdf';
  const mimeType = format === 'xlsx'
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf';
  const validName = /^[a-z0-9._-]+$/i.test(file.filename ?? '') && file.filename.endsWith('.' + extension);
  const filename = validName ? file.filename : `qwork-analytics.${extension}`;
  if (Platform.OS === 'web') {
    const bytes = Uint8Array.from(atob(file.base64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (!await isAvailableAsync()) throw new Error('На этом устройстве недоступно меню отправки файла.');
  const folder = new Directory(Paths.cache, 'qwork-analytics', String(Date.now()));
  folder.create({ intermediates: true });
  const output = new File(folder, filename);
  try {
    await output.write(file.base64, { encoding: 'base64' });
    await shareAsync(output.uri, {
      mimeType,
      UTI: format === 'xlsx' ? 'org.openxmlformats.spreadsheetml.sheet' : 'com.adobe.pdf',
      dialogTitle: 'Сохранить отчёт qwork',
    });
  } catch (error) {
    try {
      if (folder.exists) folder.delete();
    } catch {
      // The incomplete file remains in the system cache.
    }
    throw error;
  }
}

export default function AnalyticsScreens({ request, onOpenTask }) {
  const [tab, setTab] = useState('work');
  return (
    <>
      <View accessibilityRole="tablist" accessibilityLabel="Раздел аналитики" style={styles.tabs}>
        {[['work', 'Работы'], ['trips', 'Командировки']].map(([key, label]) => (
          <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: tab === key }}
            style={[styles.tab, tab === key && styles.tabActive]} onPress={() => setTab(key)}>
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <AnalyticsReport request={request} onOpenTask={onOpenTask} active={tab === 'work'} />
      <AnalyticsReport request={request} active={tab === 'trips'} trips />
    </>
  );
}

function AnalyticsReport({ request, onOpenTask, active, trips = false }) {
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [report, setReport] = useState(null);
  const [loadedFilters, setLoadedFilters] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [exportError, setExportError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [period, setPeriod] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const change = useCallback((key, value) => setDraft(previous => ({ ...previous, [key]: value })), []);
  const invalid = !validDate(draft.from) || !validDate(draft.to)
    || Boolean(draft.from && draft.to && draft.from > draft.to);
  const dirty = Object.keys(EMPTY_FILTERS).some(key => draft[key] !== applied[key]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let running = false;
    async function load() {
      if (cancelled || running) return;
      running = true;
      try {
        const result = await request(queryPath(trips ? '/analytics/trip-expenses' : '/analytics', applied));
        if (!cancelled) {
          setReport(result);
          setLoadedFilters(applied);
          setLoadError('');
        }
      } catch (error) {
        if (!cancelled) {
          if (error.status === 401 || error.status === 403) {
            setReport(null);
            setLoadedFilters(null);
          }
          setLoadError(error.message);
        }
      } finally {
        running = false;
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void load();
    }, 15000);
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') void load();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      foreground.remove();
    };
  }, [request, applied, refresh, active, trips]);

  function choosePeriod(next) {
    if (exporting) return;
    const filters = { ...draft, ...periodDates(next, trips) };
    setPeriod(next);
    setDraft(filters);
    setApplied(filters);
    setLoading(true);
    setLoadError('');
    setRefresh(value => value + 1);
  }

  function apply() {
    if (draft.from !== applied.from || draft.to !== applied.to) setPeriod(null);
    setLoading(true);
    setLoadError('');
    setExportError('');
    setApplied(draft);
    setRefresh(value => value + 1);
  }

  async function download(format) {
    if (dirty || loading || exporting || loadError || !report || loadedFilters !== applied) return;
    setExporting(true);
    setExportError('');
    try {
      const file = await request('/analytics/export', { method: 'POST', body: { ...applied, format }, timeout: 30000 });
      await shareReport(file, format);
    } catch (error) {
      setExportError(error.message || 'Не удалось подготовить отчёт.');
    } finally {
      setExporting(false);
    }
  }

  const options = report?.options;
  const department = report?.scope?.department;
  const visibleReport = loadedFilters === applied ? report : null;
  const selectedEmployee = options?.employees.find(item => String(item.id) === applied.employeeId);
  const subtitle = trips
    ? [selectedEmployee?.name, department].filter(Boolean).join(' · ') || 'Расходы на командировки'
    : department ? `Подразделение · ${department}` : 'Статистика выездных работ';
  if (!active) return null;
  return (
    <>
      <View style={styles.periods}>
        {[['week', 'Неделя'], ['month', 'Месяц'], ['year', 'Год'], ['all', 'Всё время']].map(([key, label]) => (
          <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: period === key }}
            onPress={() => choosePeriod(key)} disabled={exporting} style={[styles.period, period === key && styles.periodActive]}>
            <Text style={[styles.periodText, period === key && styles.periodTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.filterToolbar}>
        <View style={styles.flex}><Text style={styles.label}>{periodLabel(applied.from, applied.to)}</Text>
          <Text style={styles.muted}>{subtitle}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Открыть фильтры аналитики" onPress={() => setShowFilters(value => !value)} style={styles.filterButton}>
          <Icon name="filter" color="#087CFF" size={20} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Обновить отчёт" onPress={apply} disabled={loading || invalid || exporting} style={styles.filterButton}>
          <Icon name="refresh" color="#087CFF" size={20} />
        </Pressable>
      </View>
      {showFilters && <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.title}>Фильтры</Text>
        <Text style={styles.muted}>{trips ? 'Период по плановой дате начала командировки' : 'Период по дате создания заявки'}, по времени Алматы. Пустая дата оставляет границу открытой.</Text>
        <View style={styles.columns}>
          {[['from', 'С даты'], ['to', 'По дату']].map(([key, label]) => (
            <View key={key} style={styles.dateField}>
              <Text style={styles.label}>{label}</Text>
              <TextInput
                accessibilityLabel={label} style={styles.input} placeholder="ГГГГ-ММ-ДД"
                placeholderTextColor="#66748B" value={draft[key]} maxLength={10}
                onChangeText={value => change(key, value)} autoCorrect={false} editable={!exporting}
              />
            </View>
          ))}
        </View>
        {invalid && <Text accessibilityRole="alert" style={styles.error}>Проверьте даты и порядок границ периода.</Text>}
        <FilterPicker label="Сотрудник" value={draft.employeeId}
          options={(options?.employees ?? []).map(item => ({
            value: String(item.id), label: item.department ? `${item.name} · ${item.department}` : item.name,
          }))}
          onChange={value => change('employeeId', value)} disabled={!options || exporting} />
        <FilterPicker label="Объект" value={draft.objectId}
          options={(options?.objects ?? []).map(item => ({ value: String(item.id), label: item.name }))}
          onChange={value => change('objectId', value)} disabled={!options || exporting} />
        {!department && <FilterPicker label="Подразделение" value={draft.department}
          options={(options?.departments ?? []).map(item => ({ value: item, label: item }))}
          onChange={value => change('department', value)} disabled={!options || exporting} />}
        <Button onPress={apply} disabled={loading || invalid || exporting}>{dirty ? 'Применить фильтры' : 'Обновить отчёт'}</Button>
      </View>}
      {loading && <Text accessibilityLiveRegion="polite" style={styles.muted}>Загружаем отчёт…</Text>}
      {loadError ? <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text> : null}
      {visibleReport && (trips ? <TripExpenseReport report={report} /> : (
        <>
          <MetricGrid metrics={report.metrics} />
          <Distribution report={report} />
          <WorkloadChart rows={report.workload} />
          <AdditionalMetrics metrics={report.metrics} />
          <View style={styles.card}>
            <View style={styles.sectionHeading}><View style={styles.iconTint}><Icon name="download" color="#087CFF" size={21} /></View><Text accessibilityRole="header" style={styles.title}>Выгрузить отчёт</Text></View>
            {dirty && <Text style={styles.muted}>Примените изменения фильтров перед выгрузкой.</Text>}
            <View style={styles.columns}>
              <View style={styles.dateField}><Button secondary onPress={() => download('xlsx')} disabled={dirty || loading || exporting || Boolean(loadError)}>Excel</Button></View>
              <View style={styles.dateField}><Button secondary onPress={() => download('pdf')} disabled={dirty || loading || exporting || Boolean(loadError)}>PDF</Button></View>
            </View>
            {exporting && <Text accessibilityLiveRegion="polite" style={styles.muted}>Готовим файл…</Text>}
            {exportError ? <Text accessibilityRole="alert" style={styles.error}>{exportError}</Text> : null}
          </View>
          <Details title="Нагрузка по сотрудникам" count={report.workload.length}>
            {report.workload.map(row => (
              <View key={row.id} style={styles.line}>
                <Text style={styles.label}>{row.name}{row.department ? ' · ' + row.department : ''}</Text>
                <Text style={styles.muted}>Всего {row.total} · В работе {row.active} · Выполнено {row.completed}</Text>
              </View>
            ))}
          </Details>
          <Details title="Работы на подтверждении" count={report.metrics.unconfirmed}>
            <TaskRows tasks={report.tasks.filter(task => task.status === 'review')} onOpenTask={onOpenTask} />
          </Details>
          <Details title="Отклонённые фото" count={report.rejectedPhotos.length}>
            {report.rejectedPhotos.map(photo => (
              <Pressable accessibilityRole="button" key={photo.id} style={styles.line} onPress={() => onOpenTask(photo.taskId)}>
                <Text style={styles.link}>№{photo.taskId} · {photo.taskTitle}</Text>
                <Text style={styles.muted}>{PHOTO_LABELS[photo.kind] ?? photo.kind} · {timeLabel(photo.rejectedAt)}</Text>
                {photo.reason ? <Text style={styles.label}>{photo.reason}</Text> : null}
              </Pressable>
            ))}
          </Details>
          <Details title="Заявки в отчёте" count={report.tasks.length}>
            <TaskRows tasks={report.tasks} onOpenTask={onOpenTask} />
          </Details>
        </>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { padding: 14, gap: 11, backgroundColor: '#FFFFFF', borderRadius: 15 },
  title: { color: '#142034', fontSize: 16, fontWeight: '700', flexShrink: 1, letterSpacing: -0.25 },
  label: { color: '#142034', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  muted: { color: '#8493AA', fontSize: 12, lineHeight: 17 },
  link: { color: '#087CFF', fontSize: 14, fontWeight: '600' },
  error: { color: '#ED536B', fontSize: 13, lineHeight: 18, fontWeight: '600' },
  columns: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  field: { gap: 5 },
  dateField: { flex: 1, minWidth: 104, gap: 5 },
  input: { minHeight: 46, paddingHorizontal: 12, backgroundColor: '#F5F7FC', borderColor: '#E5ECF6',
    borderWidth: 1, borderRadius: 10, fontSize: 14, color: '#142034' },
  button: { minHeight: 45, justifyContent: 'center', alignItems: 'center', backgroundColor: '#087CFF', borderRadius: 11, padding: 10 },
  buttonSecondary: { backgroundColor: '#EDF5FF' },
  buttonLabel: { color: '#FFFFFF', fontWeight: '600', fontSize: 14, textAlign: 'center' },
  buttonLabelSecondary: { color: '#087CFF' },
  dimmed: { opacity: 0.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: { width: '47%', flexGrow: 1, minWidth: 126, gap: 8, paddingVertical: 12, paddingHorizontal: 8,
    backgroundColor: '#F6F9FE', borderRadius: 12, flexDirection: 'row', alignItems: 'center' },
  metricIcon: { width: 37, height: 37, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  metricLabel: { color: '#8493AA', fontSize: 11, lineHeight: 15 },
  metricValue: { color: '#142034', fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'], marginTop: 2 },
  detailHeader: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  line: { gap: 4, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#ECF0F7' },
  backdrop: { flex: 1, padding: 22, justifyContent: 'center', backgroundColor: '#14203466' },
  picker: { maxHeight: '72%', minHeight: 160, gap: 10, padding: 18, borderRadius: 20, backgroundColor: '#FFFFFF' },
  pickerRow: { minHeight: 46, justifyContent: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ECF0F7' },
  sectionHeading: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  iconTint: { width: 36, height: 36, borderRadius: 10, backgroundColor: '#EDF6FF', alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', borderRadius: 12, padding: 4, backgroundColor: '#E8F0FA' },
  tab: { flex: 1, minHeight: 42, borderRadius: 9, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6 },
  tabActive: { backgroundColor: '#FFFFFF' },
  tabText: { color: '#526A84', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  tabTextActive: { color: '#087CFF', fontWeight: '700' },
  periods: { flexDirection: 'row', backgroundColor: '#EDF2F9', borderRadius: 10, padding: 3 },
  period: { flex: 1, minHeight: 37, alignItems: 'center', justifyContent: 'center', borderRadius: 8, paddingHorizontal: 3 },
  periodActive: { backgroundColor: '#087CFF' },
  periodText: { fontSize: 12, color: '#8493AA', fontWeight: '500', textAlign: 'center' },
  periodTextActive: { color: '#FFFFFF', fontWeight: '600' },
  filterToolbar: { flexDirection: 'row', gap: 7, alignItems: 'center', paddingHorizontal: 3, paddingVertical: 2 },
  filterButton: { width: 40, height: 40, backgroundColor: '#FFFFFF', borderRadius: 11, justifyContent: 'center', alignItems: 'center' },
  chartRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  donut: { width: 146, height: 146, alignItems: 'center', justifyContent: 'center' },
  donutCenter: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  donutValue: { fontSize: 28, fontWeight: '700', color: '#142034', letterSpacing: -0.8 },
  legend: { flex: 1, minWidth: 130, gap: 12 },
  legendRow: { flexDirection: 'row', gap: 7, alignItems: 'center' },
  dot: { width: 9, height: 9, borderRadius: 5 },
  legendLabel: { color: '#354760', fontSize: 12, fontWeight: '500' },
  legendPercent: { color: '#8493AA', fontSize: 11 },
  workloadRow: { gap: 6, paddingVertical: 3 },
  workloadLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: '#EDF4FF', overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: '#2D9BFF' },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 38,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#ECF0F7' },
});
