import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Icon, colors } from './ui';

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ZONE = 'Asia/Almaty';
const FREQUENCIES = [
  ['once', 'Один раз'],
  ['daily', 'По дням'],
  ['weekly', 'По неделям'],
  ['monthly', 'По месяцам'],
];
const HOLIDAY_RULES = [
  ['skip', 'Пропустить'],
  ['move', 'Перенести'],
  ['run', 'Выполнить'],
];
const JOB_STATUSES = { waiting: 'Ждёт исполнителя', scheduled: 'Запланирована', assigned: 'Назначена' };
const LINKED_STATUSES = {
  unassigned: 'Без исполнителя', cancelled: 'Отменена', done: 'Принята', review: 'На проверке',
  paused: 'Приостановлена', repeated: 'Назначен повторный выезд',
};

function Action({ children, onPress, secondary = false, disabled = false }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary && styles.actionSecondary,
        (pressed || disabled) && styles.dimmed,
      ]}
    >
      <Text style={[styles.actionText, secondary && styles.actionTextSecondary]}>{children}</Text>
    </Pressable>
  );
}

function Choices({ value, items, onChange }) {
  return (
    <View style={styles.choices}>
      {items.map(([id, label]) => (
        <Pressable
          key={id}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === id }}
          style={[styles.choice, value === id && styles.choiceActive]}
          onPress={() => onChange(id)}
        >
          <Text style={value === id ? styles.activeText : styles.label}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Field({ label, ...props }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#64718A"
        style={[styles.input, props.multiline && styles.multiline]}
        {...props}
      />
    </View>
  );
}

function Toggle({ label, value, onChange, disabled }) {
  return (
    <View style={styles.toggle}>
      <Text style={[styles.label, styles.toggleLabel]}>{label}</Text>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled} />
    </View>
  );
}

function integerBetween(value, min, max) {
  return /^\d+$/.test(String(value)) && Number(value) >= min && Number(value) <= max;
}

function calendarToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = type => parts.find(item => item.type === type).value;
  return [part('year'), part('month'), part('day')].join('-');
}

function emptyTemplate() {
  return {
    title: '', description: '', objectId: null, startDate: calendarToday(), time: '09:00', zone: ZONE,
    frequency: 'weekly', interval: 1, horizonDays: 7, holidayRule: 'move', priority: 3,
    enabled: true, durationMinutes: 120,
  };
}

function TemplateForm({ template, objects, busy, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({ ...emptyTemplate(), ...template }));
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const valid = form.title.trim() && form.objectId
    && /^\d{4}-\d{2}-\d{2}$/.test(form.startDate)
    && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(form.time)
    && (form.frequency === 'once' || integerBetween(form.interval, 1, 30))
    && integerBetween(form.horizonDays, 0, 90)
    && integerBetween(form.durationMinutes, 1, 10080);

  function save() {
    onSave({
      ...form,
      title: form.title.trim(),
      description: form.description.trim(),
      interval: form.frequency === 'once' ? 1 : Number(form.interval),
      horizonDays: Number(form.horizonDays),
      durationMinutes: Number(form.durationMinutes),
    });
  }

  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>{template ? 'Изменить шаблон' : 'Новый шаблон'}</Text>
      <Field label="Название" value={form.title} onChangeText={value => change('title', value)} maxLength={160} />
      <Field label="Описание" value={form.description} onChangeText={value => change('description', value)}
        multiline maxLength={2000} />
      <Text style={styles.label}>Объект</Text>
      {objects.length ? (
        <Choices value={String(form.objectId)} items={objects.map(item => [String(item.id), item.name])}
          onChange={id => change('objectId', id)} />
      ) : <Text style={styles.muted}>Добавьте объект в форме создания заявки.</Text>}
      <Field label="Дата начала" placeholder="ГГГГ-ММ-ДД" maxLength={10} value={form.startDate}
        onChangeText={value => change('startDate', value)} />
      <Field label={`Время начала · ${form.zone}`} placeholder="ЧЧ:ММ" maxLength={5} value={form.time}
        onChangeText={value => change('time', value)} />
      <Text style={styles.label}>Повтор</Text>
      <Choices value={form.frequency} items={FREQUENCIES} onChange={value => change('frequency', value)} />
      {form.frequency !== 'once' && (
        <Field label="Интервал повтора · 1–30" keyboardType="number-pad" maxLength={2}
          value={String(form.interval)} onChangeText={value => change('interval', value)} />
      )}
      <Field label="Создавать заранее · 0–90 дней" keyboardType="number-pad" maxLength={2}
        value={String(form.horizonDays)} onChangeText={value => change('horizonDays', value)} />
      <Field label="Срок после начала · 1–10 080 минут" keyboardType="number-pad" maxLength={5}
        value={String(form.durationMinutes)} onChangeText={value => change('durationMinutes', value)} />
      <Text style={styles.label}>Если по календарю компании выходной</Text>
      <Choices value={form.holidayRule} items={HOLIDAY_RULES} onChange={value => change('holidayRule', value)} />
      <Text style={styles.label}>Приоритет · 5 самый высокий</Text>
      <Choices value={form.priority} items={[1, 2, 3, 4, 5].map(number => [number, String(number)])}
        onChange={value => change('priority', value)} />
      <Toggle label="Шаблон активен" value={form.enabled} onChange={value => change('enabled', value)} disabled={busy} />
      <Action onPress={save} disabled={!valid || busy}>Сохранить шаблон</Action>
      <Action onPress={onCancel} disabled={busy} secondary>Отмена</Action>
    </View>
  );
}

async function pickWorkbook() {
  const result = await getDocumentAsync({
    type: '*/*',
    base64: true,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  const file = asset.file ? null : new File(asset.uri);
  try {
    if (!/\.xlsx$/i.test(asset.name)) throw new Error('Выберите файл Excel в формате .xlsx.');
    if ((asset.size ?? file?.size ?? 0) > MAX_FILE_SIZE) throw new Error('Файл должен быть не больше 2 МБ.');
    const base64 = file ? await file.base64() : asset.base64?.split(',', 2)[1];
    if (!base64) throw new Error('Файл пуст.');
    if (base64.length > 4 * Math.ceil(MAX_FILE_SIZE / 3)) throw new Error('Файл должен быть не больше 2 МБ.');
    return { name: asset.name, base64 };
  } finally {
    try {
      if (file?.exists) file.delete();
      if (asset.file) URL.revokeObjectURL(asset.uri);
    } catch {
      // The copied file is in the system cache and will be evicted.
    }
  }
}

function ImportPanel({ objects, request, busy, run, direct, onImportedTasks, onBackToTasks }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [imported, setImported] = useState(false);
  const [showObjects, setShowObjects] = useState(false);
  const rows = result?.rows ?? [];
  const validCount = rows.filter(row => !row.error && !row.duplicate).length;

  async function submitWorkbook(workbook, previewOnly) {
    const body = { base64: workbook.base64, fileName: workbook.name };
    if (direct) body.mode = 'tasks';
    const response = await request(previewOnly ? '/planning/import/preview' : '/planning/import', {
      method: 'POST', body, timeout: 60000,
    });
    if (direct && response.mode !== 'tasks') {
      throw new Error('Для импорта в список заявок нужно обновить сервер qwork.');
    }
    return response;
  }

  function preview() {
    run(async () => {
      try {
        const next = await pickWorkbook();
        if (!next) return;
        setImported(false);
        setResult(null);
        setFile(next);
        setResult(await submitWorkbook(next, true));
      } catch (failure) {
        setImported(false);
        setFile(null);
        setResult(null);
        throw failure;
      }
    });
  }

  function commit() {
    if (!file || !validCount || imported) return;
    run(async () => {
      const response = await submitWorkbook(file, false);
      if (direct) onImportedTasks?.(response.tasks);
      setResult(response);
      setImported(true);
      setFile({ name: file.name });
    });
  }

  return (
    <View style={styles.card}>
      {!direct && <Text accessibilityRole="header" style={styles.title}>Импорт в план</Text>}
      {direct ? (
        <>
          <Text style={styles.muted}>Первая строка листа должна содержать «Название», «Дата», «Время» и одну из колонок «Объект» или «ID объекта». Укажите название объекта из справочника.</Text>
          <Text style={styles.muted}>Дата и время задают плановое начало. Срок рассчитывается по длительности. Если её не указать, на выполнение будет 120 минут.</Text>
          <Text style={styles.muted}>Можно добавить «Описание», «Приоритет» от 1 до 5, «Длительность, мин» и «Логин исполнителя». Если логин пуст, назначьте сотрудника позже в карточке заявки.</Text>
        </>
      ) : (
        <Text style={styles.muted}>
          Первая строка листа должна содержать колонки «Название», «ID объекта», «Дата», «Время».
          Можно добавить «Описание», «Приоритет» и «Длительность, мин».
        </Text>
      )}
      <Text style={styles.muted}>
        Дата и время принимаются как ячейки Excel или текст. Форматы даты {direct ? 'ДД.ММ.ГГГГ и ГГГГ-ММ-ДД' : 'ГГГГ-ММ-ДД'}, времени ЧЧ:ММ.
        Файл .xlsx до 2 МБ и 200 строк.
      </Text>
      <Action secondary onPress={() => setShowObjects(!showObjects)}>{showObjects ? 'Скрыть ID объектов' : 'Показать ID объектов'}</Action>
      {showObjects && (objects.length ? objects.map(object => (
        <Text key={object.id} selectable style={styles.muted}>{object.id} · {object.name}</Text>
      )) : <Text style={styles.muted}>В справочнике пока нет объектов.</Text>)}
      <Action onPress={preview} disabled={busy}>Выбрать Excel-файл</Action>
      {file && <Text style={styles.label}>{file.name}</Text>}
      {result && (
        <>
          <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.title}>
            {imported
              ? `${direct ? 'Создано заявок' : 'Импортировано в план'} · ${result.imported}`
              : `Предпросмотр · ${validCount} к импорту из ${rows.length}`}
          </Text>
          {direct && imported && result.imported > 0 && <Action onPress={onBackToTasks}>Перейти к заявкам</Action>}
          {direct && !imported && (
            <Action onPress={commit} disabled={busy || !validCount}>Создать заявки · {validCount}</Action>
          )}
          {rows.map(row => (
            <View key={row.row} style={styles.row}>
              <Text style={styles.label}>Строка {row.row}{row.title ? ` · ${row.title}` : ''}</Text>
              <Text style={styles.muted}>
                {[row.startDate, row.time, row.objectName || (row.objectId ? `объект №${row.objectId}` : null)]
                  .filter(Boolean).join(' · ')}
              </Text>
              {direct && !row.error && !row.duplicate && (
                <Text style={styles.muted}>{row.assigneeName || row.assigneeLogin || 'Без исполнителя'}</Text>
              )}
              <Text style={row.error ? styles.error : row.duplicate ? styles.warning : styles.success}>
                {row.error || (row.duplicate ? 'Уже импортирована' : imported ? 'Добавлена' : 'Готова к импорту')}
              </Text>
            </View>
          ))}
          {!direct && !imported && <Action onPress={commit} disabled={busy || !validCount}>Импортировать корректные строки</Action>}
        </>
      )}
    </View>
  );
}

function timeLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function ImportJournal({ imports, busy, onRefresh }) {
  const [expanded, setExpanded] = useState(null);
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>Журнал импортов</Text>
      <Text style={styles.muted}>Последние 25 загрузок в вашей компании.</Text>
      {imports?.length === 0 && <Text style={styles.muted}>Загрузок пока нет.</Text>}
      {imports?.map(entry => (
        <View key={entry.id} style={styles.row}>
          <Text style={styles.label}>{entry.fileName}</Text>
          <Text style={styles.muted}>
            {entry.mode === 'tasks' ? 'В заявки' : 'В план'} · {entry.actorName} · {new Date(entry.createdAt).toLocaleString('ru-RU')}
          </Text>
          <Text style={styles.muted}>Строк · {entry.total}  Добавлено · {entry.imported}  Дубли · {entry.duplicates}  Ошибки · {entry.invalid}</Text>
          {entry.errors.length > 0 && (
            <>
              <Action secondary onPress={() => setExpanded(current => current === entry.id ? null : entry.id)}>
                {expanded === entry.id ? 'Скрыть ошибки' : 'Показать ошибки'}
              </Action>
              {expanded === entry.id && entry.errors.map(error => (
                <Text key={error.row} style={styles.error}>Строка {error.row} · {error.message}</Text>
              ))}
            </>
          )}
        </View>
      ))}
      <Action secondary onPress={onRefresh} disabled={busy}>Обновить журнал</Action>
    </View>
  );
}

function AssignmentPanel({ settings, jobs, busy, onSave, onAssign, onRefresh, onOpenTask, taskIds }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [maxActive, setMaxActive] = useState(String(settings.maxActiveTasks));
  const [filter, setFilter] = useState('all');
  const saved = settings.enabled === enabled && String(settings.maxActiveTasks) === maxActive;
  const visibleJobs = jobs.filter(job => filter === 'all' || (filter === 'overdue' ? job.overdue : job.status === filter));

  return (
    <>
      <View style={styles.card}>
        <View style={styles.cardHeading}><View style={styles.iconTile}><Icon name="refresh" size={22} color={colors.blue} /></View><View style={styles.flex}><Text accessibilityRole="header" style={styles.title}>Автоназначение</Text><Text style={styles.muted}>Распределение плановых работ</Text></View></View>
        <Text style={styles.muted}>Заявки с высоким приоритетом идут первыми. Сервер учитывает смену, доступность, нагрузку и последние известные координаты.</Text>
        <Toggle label="Распределять автоматически" value={enabled} onChange={setEnabled} disabled={busy} />
        <Field label="Лимит активных заявок на сотрудника" value={maxActive} onChangeText={setMaxActive}
          keyboardType="number-pad" maxLength={2} />
        <Action onPress={() => onSave({ enabled, maxActiveTasks: Number(maxActive) })}
          disabled={busy || saved || !integerBetween(maxActive, 1, 50)}>Сохранить настройки</Action>
        <Action onPress={onAssign} disabled={busy} secondary>Распределить сейчас</Action>
      </View>
      <View style={styles.card}>
        <View style={styles.cardHeading}><View style={styles.iconTile}><Icon name="calendar" size={22} color={colors.blue} /></View><Text accessibilityRole="header" style={[styles.title, styles.flex]}>Плановые заявки · {jobs.length}</Text></View>
        <Choices value={filter} items={[
          ['all', 'Все'], ['scheduled', 'Предстоящие'], ['waiting', 'В очереди'],
          ['overdue', 'Просрочены'], ['assigned', 'Назначены'],
        ]} onChange={setFilter} />
        {!visibleJobs.length && <Text style={styles.muted}>Заявок с таким статусом пока нет.</Text>}
        {visibleJobs.map(job => (
          <View key={job.id} style={styles.row}>
            <Text style={styles.label}>{job.title}</Text>
            <Text style={styles.muted}>{job.objectName || `Объект №${job.objectId}`} · Приоритет {job.priority}</Text>
            <Text style={styles.muted}>Начало · {timeLabel(job.scheduledAt)}. Срок · {timeLabel(job.deadline)}</Text>
            <Text style={job.overdue ? styles.warning : styles.muted}>
              {LINKED_STATUSES[job.taskStatus] || JOB_STATUSES[job.status] || job.status}{job.overdue ? ' · Просрочена' : ''}
              {job.assigneeName && job.taskStatus !== 'unassigned' ? ` · ${job.assigneeName}` : ''}
            </Text>
            {job.taskId && taskIds.has(String(job.taskId)) && (
              <Action onPress={() => onOpenTask(String(job.taskId))} secondary>Открыть заявку №{job.taskId}</Action>
            )}
          </View>
        ))}
        <Action onPress={onRefresh} disabled={busy} secondary>Обновить список</Action>
      </View>
    </>
  );
}

export default function PlanningScreens({ request, objects, tasks, onOpenTask, direct = false, onImportedTasks, onBackToTasks }) {
  const [tab, setTab] = useState(direct ? 'import' : 'jobs');
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [imports, setImports] = useState(null);
  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);

  async function run(work) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
    } catch (failure) {
      setError(failure.message || 'Не удалось выполнить действие. Попробуйте ещё раз.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function fetchJobs() {
    const data = await request('/planning/jobs');
    setJobs(data.jobs);
  }

  async function fetchAssignment() {
    const [data, nextSettings] = await Promise.all([
      request('/planning/jobs'),
      request('/planning/assignment-settings'),
    ]);
    setJobs(data.jobs);
    setSettings(nextSettings);
  }

  async function fetchTemplates() {
    const data = await request('/planning/templates');
    setTemplates(data.templates);
  }

  async function fetchImports() {
    const data = await request('/planning/imports');
    setImports(data.imports);
  }

  function refresh() {
    if (tab === 'jobs') run(fetchAssignment);
    if (tab === 'templates') run(fetchTemplates);
    if (tab === 'journal') run(fetchImports);
  }

  useEffect(() => {
    refresh();
  }, [tab]);

  function selectTab(value) {
    if (busy || tab === value) return;
    setError('');
    setMessage('');
    setEditor(null);
    setTab(value);
  }

  function saveTemplate(fields) {
    run(async () => {
      const { id, ...body } = fields;
      const url = id ? `/planning/templates/${encodeURIComponent(id)}` : '/planning/templates';
      const result = await request(url, { method: id ? 'PATCH' : 'POST', body });
      setEditor(null);
      setTemplates(current => id
        ? current.map(item => item.id === id ? result.template : item)
        : [...current, result.template]);
      setMessage(`Шаблон сохранён. Добавлено плановых заявок · ${result.generated}`);
    });
  }

  function generate() {
    run(async () => {
      const result = await request('/planning/generate', { method: 'POST', body: {} });
      setMessage(`Добавлено плановых заявок · ${result.generated}`);
    });
  }

  function saveAssignment(body) {
    run(async () => {
      setSettings(await request('/planning/assignment-settings', { method: 'POST', body }));
      setMessage('Настройки сохранены.');
    });
  }

  function assign() {
    run(async () => {
      const result = await request('/planning/assign', { method: 'POST', body: {} });
      await fetchJobs();
      setMessage(`Назначено · ${result.assigned}. Ожидают исполнителя · ${result.waiting}.`);
    });
  }

  return (
    <>
      <Choices value={tab} items={direct
        ? [['import', 'Импорт Excel'], ['journal', 'Журнал']]
        : [['jobs', 'Очередь'], ['templates', 'Шаблоны'], ['import', 'Импорт Excel'], ['journal', 'Журнал']]}
        onChange={selectTab} />
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {message ? <Text accessibilityLiveRegion="polite" style={styles.success}>{message}</Text> : null}
      {busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>Загрузка…</Text>}
      {tab === 'jobs' && (settings ? (
        <AssignmentPanel settings={settings} jobs={jobs} busy={busy} onSave={saveAssignment} onAssign={assign}
          onRefresh={refresh} onOpenTask={onOpenTask} taskIds={new Set(tasks.map(task => String(task.id)))} />
      ) : !busy && <Action onPress={refresh} secondary>Загрузить очередь</Action>)}
      {tab === 'templates' && (editor ? (
        <TemplateForm template={editor === 'new' ? null : editor} objects={objects} busy={busy}
          onSave={saveTemplate} onCancel={() => setEditor(null)} />
      ) : (
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.title}>Шаблоны</Text>
          {templates && (
            <>
              <Action onPress={() => setEditor('new')} disabled={busy}>Новый шаблон</Action>
              <Action onPress={generate} disabled={busy} secondary>Создать заявки по шаблонам</Action>
              {!templates.length && <Text style={styles.muted}>Шаблонов пока нет.</Text>}
              {templates.map(template => (
                <View key={template.id} style={styles.row}>
                  <Text style={styles.label}>{template.title}</Text>
                  <Text style={styles.muted}>
                    {FREQUENCIES.find(([id]) => id === template.frequency)?.[1]} · {template.time} · {template.enabled ? 'Активен' : 'Выключен'}
                  </Text>
                  <Action onPress={() => setEditor(template)} disabled={busy} secondary>Изменить шаблон</Action>
                </View>
              ))}
            </>
          )}
          {!templates && !busy && <Action onPress={refresh} secondary>Загрузить шаблоны</Action>}
        </View>
      ))}
      {tab === 'import' && <ImportPanel objects={objects} request={request} busy={busy} run={run}
        direct={direct} onImportedTasks={onImportedTasks} onBackToTasks={onBackToTasks} />}
      {tab === 'journal' && <ImportJournal imports={imports} busy={busy} onRefresh={refresh} />}
    </>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFF', borderRadius: 14, gap: 12, padding: 14 },
  title: { color: '#142034', fontSize: 16, fontWeight: '700' },
  label: { color: '#142034', fontSize: 14, fontWeight: '700' },
  muted: { color: '#8190AA', fontSize: 12, lineHeight: 18 },
  error: { color: '#982F36', fontSize: 14, fontWeight: '700' },
  warning: { color: '#825114', fontSize: 14, fontWeight: '700' },
  success: { color: '#166947', fontSize: 14, fontWeight: '700' },
  row: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E6ECF5', paddingTop: 10, gap: 5 },
  field: { gap: 6 },
  input: {
    borderWidth: 1, borderColor: '#E6ECF5', borderRadius: 10, backgroundColor: '#F5F7FC',
    color: '#142034', fontSize: 14, padding: 12, minHeight: 48,
  },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  toggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  toggleLabel: { flexShrink: 1 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, backgroundColor: '#EDF1F8', borderRadius: 10, padding: 3 },
  choice: {
    flexGrow: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, minHeight: 38,
  },
  choiceActive: { backgroundColor: '#087CFF' },
  activeText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  action: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10, padding: 10, backgroundColor: '#087CFF' },
  actionSecondary: { backgroundColor: '#EDF5FF' },
  actionText: { color: '#FFF', textAlign: 'center', fontSize: 15, fontWeight: '700' },
  actionTextSecondary: { color: '#087CFF' },
  cardHeading: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  iconTile: { width: 38, height: 38, borderRadius: 11, backgroundColor: '#EDF5FF', alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  dimmed: { opacity: 0.58 },
});
