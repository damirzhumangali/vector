import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Circle as ArrivalCircle, Marker } from 'react-native-maps';
import { DispatcherPhotoPicker, TaskPhotoGallery } from './TaskPhotos';
import { OfficeShiftPanel, TaskTransfer } from './ShiftScreens';
import PlanningScreens from './PlanningScreens';
import AnalyticsScreens from './AnalyticsScreens';
import DeadlinePicker, { deadlineToIso } from './DeadlinePicker';
import FieldReport, { PRIORITY_LABELS } from './FieldReport';
import { OfficeFieldOperations } from './FieldOperations';
import RepresentativeReview from './RepresentativeReview';
import { Icon, colors } from './ui';

const MATERIAL_KINDS = ['material'];
const REPORT_KINDS = ['before', 'after', 'checklist'];
const CONFLICT_REFRESH_MS = 15000;

const statusLabels = {
  assigned: 'Создана',
  unassigned: 'Без исполнителя',
  accepted: 'Принята сотрудником',
  travel: 'В пути',
  arrived: 'На объекте',
  work: 'В работе',
  review: 'Выполнена · на проверке',
  done: 'Работа принята',
  rework: 'На доработке',
  paused: 'Приостановлена',
  cancelled: 'Отменена',
  repeated: 'Назначен повторный выезд',
};

const repeatableStatuses = ['review', 'done', 'rework', 'paused', 'cancelled'];
const closedStatuses = ['done', 'cancelled', 'repeated'];

const staffRoles = [
  ['employee', 'Сотрудник'],
  ['manager', 'Руководитель'],
  ['dispatcher', 'Диспетчер'],
];

function RequestError({ message }) {
  return message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null;
}

function Choice({ children, selected, onPress }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceSelected]}
    >
      <Text style={styles.choiceLabel}>{children}</Text>
      {selected && <Icon name="check" size={17} color={colors.blue} />}
    </Pressable>
  );
}

function Button({ children, onPress, secondary = false, disabled = false }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        (pressed || disabled) && styles.dimmed,
      ]}
    >
      <Text style={[styles.buttonLabel, secondary && styles.buttonLabelSecondary]}>
        {children}
      </Text>
    </Pressable>
  );
}

function Status({ status }) {
  const accepted = status === 'done';
  return (
    <View style={[
      styles.status,
      accepted && styles.statusAccepted,
      status === 'rework' && styles.statusAttention,
    ]}>
      <Text style={[
        styles.statusText,
        accepted && styles.statusTextAccepted,
        status === 'rework' && styles.statusTextAttention,
      ]}>
        {statusLabels[status] || 'Новая заявка'}
      </Text>
    </View>
  );
}

function TaskCard({ task, onPress }) {
  const initials = (task.assigneeName || 'Исполнитель').split(/\s+/).slice(0, 2).map(name => name[0]).join('');
  const content = (
    <>
      <View style={styles.cardTop}>
        <Text style={styles.reference}>№{task.id}{task.repeatOf ? ' · Повторный выезд' : ''}</Text>
        {task.overdue ? <View style={[styles.status, styles.statusDanger]}><Text style={styles.statusTextDanger}>Просрочена</Text></View> : <Status status={task.status} />}
      </View>
      <View style={styles.taskTitleRow}>
        <Text style={[styles.cardTitle, styles.flex]}>{task.title}</Text>
        {onPress && <Icon name="chevron-right" size={18} color={colors.muted} />}
      </View>
      <View style={styles.taskMetadata}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
        <View style={styles.flex}>
          {task.assigneeName && <Text style={styles.muted}>{task.assigneeName}</Text>}
          <View style={styles.inline}><Icon name="pin" size={13} color={colors.muted} /><Text style={[styles.muted, styles.flex]}>{task.object}</Text></View>
          {task.deadline && <View style={styles.inline}><Icon name="calendar" size={13} color={colors.muted} /><Text style={styles.muted}>Срок · {formatDate(task.deadline)}</Text></View>}
        </View>
      </View>
    </>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={`Заявка ${task.id}, ${task.title}`} onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.dimmed]}>{content}</Pressable>
  ) : <View style={styles.card}>{content}</View>;
}

function TaskMetrics({ tasks, manager = false }) {
  const inWork = tasks.filter(task => ['accepted', 'travel', 'arrived', 'work', 'rework', 'paused'].includes(task.status)).length;
  const waiting = tasks.filter(task => task.status === 'review').length;
  const today = new Date().toDateString();
  const dueToday = tasks.filter(task => task.deadline && new Date(task.deadline).toDateString() === today).length;
  return <View style={styles.summaryStrip}>
    {[
      ['clipboard', 'Всего', tasks.length, colors.blue, '#EAF3FF'],
      ['clock', 'В работе', inWork, colors.blue, '#EAF3FF'],
      [manager ? 'check' : 'calendar', manager ? 'На проверке' : 'На сегодня', manager ? waiting : dueToday, '#F29A26', '#FFF4E4'],
    ].map(([icon, label, value, color, backgroundColor]) => <View key={label} style={styles.summaryItem}>
      <View style={[styles.summaryIcon, { backgroundColor }]}><Icon name={icon} size={20} color={color} /></View>
      <View><Text style={styles.summaryLabel}>{label}</Text><Text style={styles.summaryValue}>{value}</Text></View>
    </View>)}
  </View>;
}

function Dashboard({ tasks, employees, session, manager, onOpen, onTask }) {
  const pending = tasks.filter(task => task.status === 'review');
  const active = tasks.filter(task => !closedStatuses.includes(task.status));
  const features = manager ? [
    ['check', 'Приёмка работ', `${pending.length} на проверке`, 'tasks', '#E9F3FF', colors.blue],
    ['chart', 'Аналитика', 'Показатели и отчёты', 'analytics', '#E8F9F0', '#1FB87D'],
    ['calendar', 'Смены и ситуации', 'График и согласования', 'operations', '#FFF1E8', '#F28B39'],
    ['pin', 'Выездной контроль', 'Доска и командировки', 'field-operations', '#EAF4FF', colors.blue],
  ] : [
    ['clipboard', 'Заявки', `${active.length} активных работ`, 'tasks', '#E9F3FF', colors.blue],
    ['users', 'Команда', `${employees.filter(person => person.role === 'employee').length} сотрудников`, 'team', '#E8F9F0', '#1FB87D'],
    ['calendar', 'Плановые работы', 'Шаблоны и импорт Excel', 'planning', '#FFF1E8', '#F28B39'],
    ['clock', 'Смены и ситуации', 'График и дежурства', 'operations', '#FFF8E3', '#E7A314'],
    ['pin', 'Выездной контроль', 'Доска и командировки', 'field-operations', '#EAF4FF', colors.blue],
  ];
  return <>
    <View style={styles.todayCard}>
      <View style={styles.todayIcon}><Icon name="calendar" size={25} color={colors.blue} /></View>
      <View style={styles.flex}><Text style={styles.label}>Сегодня</Text><Text style={styles.muted}>{new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' })}</Text></View>
      <View style={styles.status}><Text style={styles.statusText}>{manager ? 'Руководитель' : 'Диспетчер'}</Text></View>
    </View>
    <TaskMetrics tasks={tasks} manager={manager} />
    <View style={styles.quickGrid}>
      {features.map(([icon, title, detail, destination, backgroundColor, color]) => <Pressable key={title} accessibilityRole="button"
        onPress={() => onOpen(destination)} style={({ pressed }) => [styles.quickTile, { backgroundColor }, pressed && styles.dimmed]}>
        <Icon name={icon} size={28} color={color} />
        <View style={styles.taskTitleRow}><Text style={[styles.quickTitle, styles.flex]}>{title}</Text><Icon name="chevron-right" size={17} color={colors.ink} /></View>
        <Text style={styles.quickDetail}>{detail}</Text>
      </Pressable>)}
    </View>
    {!manager && <Pressable accessibilityRole="button" onPress={() => onOpen('analytics')} style={styles.navigationRow}>
      <View style={styles.todayIcon}><Icon name="chart" size={25} color={colors.blue} /></View>
      <View style={styles.flex}><Text style={styles.label}>Аналитика</Text><Text style={styles.muted}>Выполнение, сроки и нагрузка</Text></View>
      <Icon name="chevron-right" size={18} color={colors.muted} />
    </Pressable>}
    <View style={styles.sectionRow}><Text style={styles.sectionTitle}>{manager ? 'Ждут проверки' : 'Последние заявки'}</Text><Pressable onPress={() => onOpen('tasks')} accessibilityRole="button"><Text style={styles.link}>Все заявки</Text></Pressable></View>
    {(manager ? pending : tasks).slice(0, 3).map(task => <TaskCard key={task.id} task={task} onPress={() => onTask(task.id)} />)}
    {!(manager ? pending : tasks).length && <View style={styles.emptyCard}><Icon name="clipboard" size={30} color={colors.blue} /><Text style={styles.label}>{manager ? 'Новых отчётов пока нет' : 'Здесь появятся ваши заявки'}</Text><Text style={styles.muted}>{manager ? 'Выполненные работы поступят сюда на проверку.' : 'Создайте заявку и назначьте исполнителя.'}</Text></View>}
  </>;
}

const ARRIVAL_AREAS = [
  { meters: 100, title: 'Здание', detail: 'У входа или рядом со зданием · до 100 м' },
  { meters: 300, title: 'Территория', detail: 'Двор или комплекс зданий · до 300 м' },
  { meters: 1000, title: 'Большая площадка', detail: 'Протяжённое место работ · до 1 км' },
];

function ArrivalSettings({ value, onChange, disabled = false }) {
  const [expanded, setExpanded] = useState(false);
  const selected = ARRIVAL_AREAS.find(option => option.meters === value);
  return <View style={styles.arrivalSettings}>
    <View style={styles.arrivalHeading}>
      <Icon name="pin" size={21} color={colors.blue} />
      <View style={styles.flex}>
        <Text style={styles.cardTitle}>Отметка «Я на месте»</Text>
        <Text style={styles.muted}>{onChange
          ? `${selected?.title ?? 'Здание'} · ${value === 100 ? 'подходит для большинства заявок' : 'выбранный тип места'}`
          : 'Настроена для выбранного объекта'}</Text>
      </View>
      {onChange && <Pressable accessibilityRole="button"
        accessibilityLabel={expanded ? 'Свернуть настройку прибытия' : 'Изменить место отметки прибытия'}
        accessibilityState={{ expanded, disabled }} disabled={disabled}
        onPress={() => setExpanded(current => !current)} style={styles.arrivalToggle}>
        <Text style={styles.link}>{expanded ? 'Скрыть' : 'Изменить'}</Text>
      </Pressable>}
    </View>
    <Text style={styles.muted}>Сотрудник сможет отметить прибытие, когда будет рядом с местом работы.</Text>
    {expanded && onChange && <>
      <Text style={styles.label}>Где выполняют работу?</Text>
      {ARRIVAL_AREAS.map(option => <Pressable key={option.meters} accessibilityRole="radio"
        accessibilityLabel={`${option.title}. ${option.detail}`}
        accessibilityState={{ checked: value === option.meters, disabled }} disabled={disabled}
        onPress={() => { if (!disabled) onChange(option.meters); }}
        style={[styles.arrivalChoice, value === option.meters && styles.choiceSelected]}>
        <View style={styles.flex}><Text style={styles.choiceLabel}>{option.title}</Text>
          <Text style={styles.muted}>{option.detail}</Text></View>
        {value === option.meters && <Icon name="check" size={18} color={colors.blue} />}
      </Pressable>)}
    </>}
  </View>;
}

function TaskForm({ onCreate, onCancel, employees, objects, onCreateObject, request, server, busy, error }) {
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [priority, setPriority] = useState(2);
  const [managerId, setManagerId] = useState(undefined);
  const [assignmentRules, setAssignmentRules] = useState(null);
  const [rulesError, setRulesError] = useState('');
  const [rulesBusy, setRulesBusy] = useState(false);
  const [showRuleSettings, setShowRuleSettings] = useState(false);
  const [showReportSettings, setShowReportSettings] = useState(false);
  const [checklistText, setChecklistText] = useState('');
  const [pairText, setPairText] = useState('');
  const [object, setObject] = useState('');
  const [address, setAddress] = useState('');
  const [objectId, setObjectId] = useState(null);
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState(null);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [radius, setRadius] = useState(100);
  const [deadlineValue, setDeadlineValue] = useState(null);
  const [validation, setValidation] = useState('');
  const objectInput = useRef(null);
  const descriptionInput = useRef(null);
  const selectedObject = objects.find((item) => item.id === objectId);
  const selectedAssignee = employees.find(employee => employee.id === assigneeId);
  const department = selectedAssignee?.department?.trim();
  const objectRule = selectedObject && assignmentRules?.defaults?.find(rule => rule.objectId === selectedObject.id);
  const departmentRule = department && assignmentRules?.defaults?.find(rule => rule.department === department);
  const defaultRule = objectRule || departmentRule;
  const selectedManager = managerId === undefined ? defaultRule?.managerId : managerId;
  const ruleOptions = [
    ...(selectedObject ? [{ key: 'object', field: { objectId: selectedObject.id }, label: selectedObject.name, rule: objectRule }] : []),
    ...(department ? [{ key: 'department', field: { department }, label: department, rule: departmentRule }] : []),
  ];
  const lat = Number(latitude.replace(',', '.'));
  const lon = Number(longitude.replace(',', '.'));
  const meters = Number(radius);
  const hasPoint = Boolean(latitude.trim() && longitude.trim()
    && Number.isFinite(lat) && Math.abs(lat) <= 90
    && Number.isFinite(lon) && Math.abs(lon) <= 180);
  const location = hasPoint && Number.isFinite(meters) && meters >= 1 && meters <= 10000
    ? { latitude: lat, longitude: lon, radius: meters } : null;
  const canCreate = Boolean(title.trim() && (server
    ? purpose.trim() && (selectedObject || location) && selectedAssignee
    : object.trim()));

  useEffect(() => {
    if (!server || !request) return;
    let active = true;
    request('/field-work/defaults').then(data => {
      if (active) setAssignmentRules(data);
    }).catch(failure => {
      if (active) setRulesError(failure.message || 'Не удалось загрузить руководителей.');
    });
    return () => { active = false; };
  }, [request, server]);

  async function saveRule(field, nextManagerId) {
    if (!request || busy || rulesBusy) return;
    setRulesBusy(true);
    setRulesError('');
    try {
      const updated = await request('/field-work/defaults', {
        method: 'POST', body: { ...field, managerId: nextManagerId },
      });
      setAssignmentRules(updated);
    } catch (failure) {
      setRulesError(failure.message || 'Не удалось сохранить руководителя по умолчанию.');
    } finally {
      setRulesBusy(false);
    }
  }

  function setPin(event) {
    const { latitude: nextLat, longitude: nextLon } = event.nativeEvent.coordinate;
    setLatitude(nextLat.toFixed(6));
    setLongitude(nextLon.toFixed(6));
    setValidation('');
  }

  async function saveObject() {
    if (!onCreateObject || !location || !object.trim() || busy) return;
    setValidation('');
    const saved = await onCreateObject({ name: object.trim(), address: address.trim(), location });
    if (saved?.id) setObjectId(saved.id);
  }

  function submit() {
    if (!canCreate || busy || rulesBusy) return;
    const deadline = deadlineToIso(deadlineValue);
    if (deadlineValue && (!deadline || +deadlineValue <= Date.now())) {
      setValidation('Выберите дату и время позже текущего.');
      return;
    }
    const itemTitles = checklistText.split('\n').map(value => value.trim()).filter(Boolean);
    const pairLabels = pairText.split('\n').map(value => value.trim()).filter(Boolean);
    if (itemTitles.length > 20 || itemTitles.some(value => value.length > 160)) {
      setValidation('Добавьте не более 20 пунктов чек-листа по 160 символов.');
      return;
    }
    if (pairLabels.length > 7 || pairLabels.some(value => value.length > 100)) {
      setValidation('Добавьте не более 7 дополнительных пар по 100 символов.');
      return;
    }
    setValidation('');
    Keyboard.dismiss();
    const fields = {
      title: title.trim(), description: description.trim(), purpose: purpose.trim(), priority,
      ...(selectedObject
        ? { objectId: selectedObject.id }
        : { object: object.trim(), address: address.trim(), ...(location && { location }) }),
      ...(deadline && { deadline }),
    };
    onCreate(server ? {
      ...fields,
      assigneeId,
      ...(managerId !== undefined && { managerId }),
      ...(itemTitles.length && { checklist: itemTitles.map((title, index) => ({ id: `step-${index + 1}`, title })) }),
      ...(pairLabels.length && { photoPairs: pairLabels.map((label, index) => ({ key: `pair-${index + 1}`, label })) }),
    } : fields);
  }

  return (
    <>
      <Button onPress={() => { Keyboard.dismiss(); onCancel(); }} disabled={busy} secondary>‹ К заявкам</Button>
      <View style={styles.card}>
        <Text style={styles.label}>Название работы</Text>
        <TextInput
          accessibilityLabel="Название работы"
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="Например, проверить освещение"
          placeholderTextColor="#64718A"
          maxLength={120}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => descriptionInput.current?.focus()}
        />
        <Text style={styles.label}>Цель выезда</Text>
        <TextInput accessibilityLabel="Цель выезда" value={purpose} onChangeText={setPurpose}
          style={styles.input} placeholder="Например, подтвердить исправность освещения" placeholderTextColor="#64718A"
          editable={!busy} maxLength={500} />
        <Text style={styles.label}>Приоритет</Text>
        {[1, 2, 3].map(value => (
          <Choice key={value} selected={priority === value} onPress={() => { if (!busy) setPriority(value); }}>
            {PRIORITY_LABELS[value]}
          </Choice>
        ))}
        <Text style={styles.label}>Описание (необязательно)</Text>
        <TextInput
          accessibilityLabel="Описание работы"
          ref={descriptionInput}
          multiline
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Что нужно сделать на объекте"
          placeholderTextColor="#64718A"
          maxLength={500}
        />
      </View>
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.cardTitle}>Место работы</Text>
        {server && (
          <>
            <Text style={styles.muted}>Выберите объект из справочника или отметьте место на карте.</Text>
            {objects.map((item) => (
              <Choice key={item.id} selected={item.id === objectId} onPress={() => setObjectId(item.id)}>
                {item.name}{item.address ? ` · ${item.address}` : ''}
              </Choice>
            ))}
            <Choice selected={!selectedObject} onPress={() => setObjectId(null)}>Точка на карте</Choice>
          </>
        )}
        {selectedObject ? (
          <ArrivalSettings value={selectedObject.location.radius} />
        ) : (
          <>
            <Text style={styles.label}>Название места{server ? ' (необязательно)' : ''}</Text>
            <TextInput ref={objectInput} accessibilityLabel="Название места" style={styles.input}
              value={object} onChangeText={setObject} placeholder="Название объекта" maxLength={160} />
            {server && (
              <>
                <Text style={styles.label}>Адрес (необязательно)</Text>
                <TextInput accessibilityLabel="Адрес" style={styles.input} value={address}
                  onChangeText={setAddress} maxLength={240} />
                <MapView
                  style={styles.map}
                  accessibilityLabel="Карта для выбора места заявки"
                  initialRegion={{
                    latitude: hasPoint ? lat : 51.1694,
                    longitude: hasPoint ? lon : 71.4491,
                    latitudeDelta: 0.08,
                    longitudeDelta: 0.08,
                  }}
                  onPress={setPin}
                >
                  {hasPoint && <>
                    <ArrivalCircle center={{ latitude: lat, longitude: lon }} radius={meters}
                      strokeColor="#087CFF" fillColor="rgba(8,124,255,0.12)" strokeWidth={1} />
                    <Marker coordinate={{ latitude: lat, longitude: lon }} title="Место выполнения заявки" />
                  </>}
                </MapView>
                <Text style={styles.muted}>{hasPoint
                  ? 'Место выбрано. Коснитесь карты, чтобы передвинуть отметку.'
                  : 'Коснитесь карты, чтобы выбрать место выполнения заявки.'}</Text>
                <ArrivalSettings value={radius} onChange={setRadius} disabled={busy} />
                {onCreateObject && <Button onPress={saveObject} disabled={!location || !object.trim() || busy} secondary>
                  Сохранить место в справочник
                </Button>}
              </>
            )}
          </>
        )}
      </View>
      <View style={styles.card}>
        <DeadlinePicker value={deadlineValue} disabled={busy}
          onChange={value => { setDeadlineValue(value); setValidation(''); }} />
      </View>
      {server && (
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.cardTitle}>Исполнитель</Text>
          {employees.length ? employees.map((employee) => (
            <Choice
              key={employee.id}
              selected={employee.id === assigneeId}
              onPress={() => setAssigneeId(employee.id)}
            >
              {employee.name}
            </Choice>
          )) : (
            <Text style={styles.muted}>Чтобы назначить заявку, диспетчер, создавший компанию, должен добавить сотрудника.</Text>
          )}
        </View>
      )}
      {server && request && (
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.cardTitle}>Ответственный руководитель</Text>
          <Choice selected={managerId === undefined} onPress={() => setManagerId(undefined)}>
            {defaultRule ? `По настройкам · ${defaultRule.managerName}` : 'По настройкам объекта или подразделения'}
          </Choice>
          {assignmentRules?.managers?.map(person => (
            <Choice key={person.id} selected={managerId === person.id} onPress={() => setManagerId(person.id)}>
              {person.name}
            </Choice>
          ))}
          <Choice selected={managerId === null} onPress={() => setManagerId(null)}>Без руководителя для этой заявки</Choice>
          <RequestError message={rulesError} />
          <Button secondary disabled={rulesBusy || busy} onPress={() => setShowRuleSettings(value => !value)}>
            {showRuleSettings ? 'Скрыть настройки' : 'Настроить назначение по умолчанию'}
          </Button>
          {showRuleSettings && (
            <>
              <Text style={styles.muted}>Выберите руководителя выше. При назначении настройка объекта имеет приоритет над подразделением.</Text>
              {ruleOptions.length ? ruleOptions.map(({ key, field, label, rule }) => (
                <View key={key} style={styles.formGroup}>
                  <Text style={styles.label}>{key === 'object' ? 'Объект' : 'Подразделение'} · {label}</Text>
                  <Text style={styles.muted}>{rule?.managerName ?? 'Руководитель по умолчанию не задан.'}</Text>
                  <Button secondary disabled={busy || rulesBusy || !selectedManager || rule?.managerId === selectedManager}
                    onPress={() => saveRule(field, selectedManager)}>Назначить по умолчанию</Button>
                  {rule && <Button secondary disabled={busy || rulesBusy} onPress={() => saveRule(field, null)}>
                    Удалить настройку
                  </Button>}
                </View>
              )) : <Text style={styles.muted}>Выберите объект из справочника или сотрудника с подразделением.</Text>}
            </>
          )}
        </View>
      )}
      {server && (
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.cardTitle}>Содержание отчёта</Text>
          <Text style={styles.muted}>По умолчанию будут стандартный чек-лист и одна пара фото «до» и «после».</Text>
          <Button secondary disabled={busy} onPress={() => setShowReportSettings(value => !value)}>
            {showReportSettings ? 'Скрыть настройки отчёта' : 'Настроить чек-лист и пары фото'}
          </Button>
          {showReportSettings && (
            <>
              <Text style={styles.label}>Свои пункты чек-листа</Text>
              <TextInput accessibilityLabel="Свои пункты чек-листа" multiline editable={!busy}
                value={checklistText} onChangeText={setChecklistText}
                placeholder="Один пункт на строку. Оставьте пустым для стандартных пунктов."
                placeholderTextColor="#64718A" maxLength={3220} style={[styles.input, styles.multiline]} />
              <Text style={styles.label}>Дополнительные пары «До / После»</Text>
              <TextInput accessibilityLabel="Дополнительные пары «До / После»" multiline editable={!busy}
                value={pairText} onChangeText={setPairText}
                placeholder="Укажите зону или пункт чек-листа, для которого нужна пара. Одна пара на строку."
                placeholderTextColor="#64718A" maxLength={707} style={[styles.input, styles.multiline]} />
            </>
          )}
        </View>
      )}
      <RequestError message={validation || error} />
      <Button onPress={submit} disabled={!canCreate || busy || rulesBusy}>{busy ? 'Создаём…' : 'Создать заявку'}</Button>
    </>
  );
}

function formatDate(value) {
  const date = new Date(value);
  return date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function conflictAction(conflict) {
  if (conflict.kind === 'photo') {
    if (conflict.photoKind === 'before') return 'Фото «до»';
    if (conflict.photoKind === 'after') return 'Фото «после»';
    return 'Загрузка фото';
  }
  const nextStatus = statusLabels[conflict.requestedStatus];
  return nextStatus ? `Обновление до статуса «${nextStatus}»` : 'Изменение отчёта или чек-листа';
}

function SyncConflicts({ request, tasks, onOpenTask }) {
  const [conflicts, setConflicts] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resolving, setResolving] = useState(null);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const activeRefresh = useRef(false);
  const activeResolution = useRef(false);
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    if (activeRefresh.current || activeResolution.current) return;
    activeRefresh.current = true;
    const version = ++requestVersion.current;
    setRefreshing(true);
    try {
      const { conflicts: rows } = await request('/sync/conflicts');
      if (mounted.current && version === requestVersion.current) {
        setConflicts(rows);
        setError('');
      }
    } catch (failure) {
      if (mounted.current && version === requestVersion.current) {
        setError(failure.message || 'Не удалось загрузить конфликты.');
      }
    } finally {
      activeRefresh.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, [request]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') refresh();
    }, CONFLICT_REFRESH_MS);
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      mounted.current = false;
      clearInterval(timer);
      foreground.remove();
    };
  }, [refresh]);

  async function resolve(eventId) {
    if (activeResolution.current) return;
    activeResolution.current = true;
    ++requestVersion.current;
    setResolving(eventId);
    setError('');
    try {
      const { conflict } = await request(`/sync/conflicts/${encodeURIComponent(eventId)}/resolve`, { method: 'POST' });
      if (mounted.current) {
        setConflicts((previous) => previous?.map((row) => row.eventId === eventId ? conflict : row));
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message || 'Не удалось отметить конфликт.');
    } finally {
      activeResolution.current = false;
      if (mounted.current) setResolving(null);
    }
  }

  const openCount = conflicts?.filter((conflict) => !conflict.resolvedAt).length;
  return (
    <>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Конфликты синхронизации{openCount != null ? ` · ${openCount} к проверке` : ''}
      </Text>
      <RequestError message={error} />
      <Button secondary disabled={refreshing || resolving !== null} onPress={refresh}>
        {refreshing ? 'Обновляем…' : 'Обновить конфликты'}
      </Button>
      {conflicts?.length === 0 && (
        <View style={styles.card}><Text style={styles.muted}>Конфликтов пока нет.</Text></View>
      )}
      {conflicts && [...conflicts.filter((row) => !row.resolvedAt), ...conflicts.filter((row) => row.resolvedAt)].map((conflict) => {
        const task = tasks.find((row) => row.id === String(conflict.taskId));
        const status = task?.status || conflict.serverStatus;
        return (
          <View key={conflict.eventId} style={styles.card}>
            <View style={styles.cardTop}>
              <Text style={styles.reference}>ЗАЯВКА №{conflict.taskId}</Text>
              <Text style={conflict.resolvedAt ? styles.statusTextAccepted : styles.statusTextAttention}>
                {conflict.resolvedAt ? 'Просмотрен' : 'Требует проверки'}
              </Text>
            </View>
            <Text style={styles.cardTitle}>{conflict.taskTitle || task?.title || 'Заявка'}</Text>
            <Text style={styles.label}>{conflictAction(conflict)}</Text>
            {conflict.employeeName ? <Text style={styles.muted}>Сотрудник · {conflict.employeeName}</Text> : null}
            {conflict.occurredAt ? <Text style={styles.muted}>Время действия · {formatDate(conflict.occurredAt)}</Text> : null}
            {conflict.receivedAt ? <Text style={styles.muted}>Получено сервером · {formatDate(conflict.receivedAt)}</Text> : null}
            {statusLabels[status] ? <Text style={styles.muted}>Статус заявки · {statusLabels[status]}</Text> : null}
            {conflict.reason ? <Text style={styles.muted}>{conflict.reason}</Text> : null}
            {conflict.resolvedAt ? (
              <Text style={styles.muted}>
                Просмотрено · {formatDate(conflict.resolvedAt)}{conflict.resolvedByName ? ` · ${conflict.resolvedByName}` : ''}
              </Text>
            ) : null}
            {task && <Button secondary onPress={() => onOpenTask(task.id)}>Открыть заявку</Button>}
            {!conflict.resolvedAt && (
              <Button onPress={() => resolve(conflict.eventId)} disabled={resolving !== null}>
                {resolving === conflict.eventId ? 'Сохраняем…' : 'Отметить как просмотренный'}
              </Button>
            )}
          </View>
        );
      })}
    </>
  );
}

function TaskDetails({ task }) {
  const { arrival, location, history = [] } = task;
  return (
    <>
      <TaskCard task={task} />
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.cardTitle}>Детали заявки</Text>
        {task.purpose ? <Text style={styles.muted}>Цель выезда · {task.purpose}</Text> : null}
        {task.priority ? <Text style={styles.muted}>Приоритет · {PRIORITY_LABELS[task.priority]}</Text> : null}
        {task.managerName ? <Text style={styles.muted}>Руководитель · {task.managerName}</Text> : null}
        {task.representativeDecision ? (
          <Text style={styles.label}>{task.representativeDecision === 'confirmed' ? 'Подтверждено представителем' : 'Есть замечание'}</Text>
        ) : null}
        {task.repeatReason ? <Text style={styles.muted}>Причина повторного выезда · {task.repeatReason}</Text> : null}
        {task.address && task.address !== task.object ? <Text style={styles.muted}>{task.address}</Text> : null}
        {task.description ? <Text style={styles.muted}>{task.description}</Text> : null}
        {task.deadline ? <Text style={styles.muted}>Выполнить до · {formatDate(task.deadline)}</Text> : null}
        {task.result || task.reportComment ? (
          <>
            <Text style={styles.label}>Результат работы</Text>
            <Text style={styles.muted}>{task.result || task.reportComment}</Text>
          </>
        ) : null}
        {location && <Text style={styles.muted}>Сотрудник может отметить прибытие рядом с объектом.</Text>}
        {arrival && (
          <>
            <Text style={styles.label}>Отметка о прибытии</Text>
            {arrival.capturedAt && <Text style={styles.muted}>{formatDate(arrival.capturedAt)}</Text>}
            {arrival.latitude != null && arrival.longitude != null && (
              <Text style={styles.muted}>{arrival.latitude}, {arrival.longitude}</Text>
            )}
            {arrival.distance != null && <Text style={styles.muted}>До объекта · {Math.round(arrival.distance)} м</Text>}
            {arrival.accuracy != null && <Text style={styles.muted}>Точность GPS · {Math.round(arrival.accuracy)} м</Text>}
            {arrival.reason && <Text style={styles.muted}>Ручная отметка · {arrival.reason}</Text>}
          </>
        )}
        {task.cancelReason ? <Text style={styles.muted}>Причина отмены · {task.cancelReason}</Text> : null}
        {!task.description && !task.deadline && !location && !arrival && !task.cancelReason && !task.address
          && !task.result && !task.reportComment && (
          <Text style={styles.muted}>Объект указан в карточке заявки.</Text>
        )}
      </View>
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.cardTitle}>История заявки</Text>
        {history.length === 0 && <Text style={styles.muted}>В истории пока нет записей.</Text>}
        {history.map((event, index) => (
          <View key={index} style={styles.staffRow}>
            <Text style={styles.label}>{statusLabels[event.status] || event.status}</Text>
            <Text style={styles.muted}>
              {[event.actorName, event.createdAt && formatDate(event.createdAt)].filter(Boolean).join(' · ')}
            </Text>
            {event.reason && <Text style={styles.muted}>{event.reason}</Text>}
            {event.position && <Text style={styles.muted}>{event.position.latitude}, {event.position.longitude}</Text>}
          </View>
        ))}
      </View>
    </>
  );
}

function TaskActions({ task, onCancelTask, onRepeatTask, busy, error }) {
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const [deadlineValue, setDeadlineValue] = useState(null);
  const [validation, setValidation] = useState('');
  const canCancel = !closedStatuses.includes(task.status);
  const canRepeat = Boolean(onRepeatTask) && repeatableStatuses.includes(task.status);
  if (!canCancel && !canRepeat) return null;

  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.cardTitle}>Управление заявкой</Text>
      <RequestError message={action && error} />
      {action === 'cancel' && canCancel ? (
        <>
          <Text style={styles.label}>Причина отмены</Text>
          <TextInput
            accessibilityLabel="Причина отмены"
            multiline
            style={[styles.input, styles.multiline]}
            value={reason}
            onChangeText={setReason}
            placeholder="Укажите, почему отменяете заявку"
            placeholderTextColor="#64718A"
            maxLength={500}
          />
          <Button disabled={busy || !reason.trim()} onPress={() => {
            Keyboard.dismiss();
            onCancelTask(task.id, reason.trim());
          }}>Подтвердить отмену</Button>
          <Button disabled={busy} onPress={() => setAction(null)} secondary>Назад</Button>
        </>
      ) : action === 'repeat' && canRepeat ? (
        <>
          <Text style={styles.muted}>
            Создадим связанную заявку с тем же объектом и исполнителем.
          </Text>
          <Text style={styles.label}>Причина повторного выезда</Text>
          <TextInput accessibilityLabel="Причина повторного выезда" editable={!busy} multiline
            style={[styles.input, styles.multiline]} value={reason} onChangeText={setReason}
            placeholder="Укажите, зачем нужно вернуться на объект" placeholderTextColor="#64718A" maxLength={1000} />
          <DeadlinePicker value={deadlineValue} disabled={busy}
            onChange={value => { setDeadlineValue(value); setValidation(''); }} />
          <RequestError message={validation} />
          <Button disabled={busy || !reason.trim()} onPress={() => {
            const deadline = deadlineToIso(deadlineValue);
            if (deadlineValue && (!deadline || +deadlineValue <= Date.now())) {
              setValidation('Выберите дату и время позже текущего.');
              return;
            }
            setValidation('');
            Keyboard.dismiss();
            onRepeatTask(task.id, { reason: reason.trim(), ...(deadline && { deadline }) });
          }}>Создать повторный выезд</Button>
          <Button disabled={busy} onPress={() => setAction(null)} secondary>Назад</Button>
        </>
      ) : (
        <>
          {canCancel && <Button disabled={busy} onPress={() => { setReason(''); setAction('cancel'); }} secondary>Отменить заявку</Button>}
          {canRepeat && <Button disabled={busy} onPress={() => { setReason(''); setAction('repeat'); }} secondary>Повторный выезд</Button>}
        </>
      )}
    </View>
  );
}

function Review({ task, onDecision, busy, error }) {
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  const completed = task.checklist ? task.checklist.filter(item => item.status).length : task.checks.filter(Boolean).length;
  const total = task.checklist?.length ?? task.checks.length;
  const before = task.photoPairs?.filter(pair => pair.before).length ?? task.photos.before;
  const after = task.photoPairs?.filter(pair => pair.after).length ?? task.photos.after;

  function decide(status, comment = '') {
    if (busy) return;
    Keyboard.dismiss();
    onDecision(task.id, status, comment);
  }

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Материалы отчёта</Text>
        <View style={styles.metrics}>
          {[
            ['Заполнено пунктов', `${completed}/${total}`],
            ['Фото до', before],
            ['Фото после', after],
          ].map(([label, value]) => (
            <View key={label} style={styles.metric} accessibilityLabel={`${label} · ${value}`}>
              <Text style={styles.metricValue}>{value}</Text>
              <Text style={styles.metricLabel}>{label}</Text>
            </View>
          ))}
        </View>
      </View>
      {onDecision && task.status === 'review' && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Проверка отчёта</Text>
          <RequestError message={error} />
          {returning ? (
            <>
              <Text style={styles.label}>Причина доработки</Text>
              <TextInput
                accessibilityLabel="Причина доработки"
                multiline
                style={[styles.input, styles.multiline]}
                value={reason}
                onChangeText={setReason}
                placeholder="Опишите, что нужно исправить"
                placeholderTextColor="#64718A"
                maxLength={500}
              />
              <Button
                onPress={() => decide('rework', reason.trim())}
                disabled={!reason.trim() || busy}
              >
                Отправить на доработку
              </Button>
              <Button onPress={() => setReturning(false)} disabled={busy} secondary>Отмена</Button>
            </>
          ) : (
            <>
              <Button onPress={() => decide('done')} disabled={busy}>{busy ? 'Сохраняем…' : 'Принять работу'}</Button>
              <Button onPress={() => setReturning(true)} disabled={busy} secondary>Вернуть на доработку</Button>
            </>
          )}
        </View>
      )}
    </>
  );
}

function StaffForm({ onCreate, onCancel, busy, error }) {
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [login, setLogin] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('employee');
  const username = login.trim();
  const validLogin = /^[a-zA-Z0-9._-]{3,40}$/.test(username);
  const address = email.trim();
  const validEmail = !address || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
  const canCreate = Boolean(name.trim() && validLogin && validEmail);

  function submit() {
    if (!canCreate || busy) return;
    Keyboard.dismiss();
    onCreate({ name: name.trim(), login: username, email: address, role, department: department.trim() });
  }

  return (
    <>
      <Button onPress={onCancel} disabled={busy} secondary>‹ К заявкам</Button>
      <View style={styles.card}>
        <Text style={styles.label}>Имя</Text>
        <TextInput accessibilityLabel="Имя" style={styles.input} value={name} onChangeText={setName} maxLength={100} editable={!busy} />
        <Text style={styles.label}>Подразделение (необязательно)</Text>
        <TextInput accessibilityLabel="Подразделение" style={styles.input} value={department}
          onChangeText={setDepartment} placeholder="Например, Служба эксплуатации" maxLength={120} editable={!busy} />
        <Text style={styles.label}>Логин</Text>
        <TextInput
          accessibilityLabel="Логин без почты"
          style={styles.input}
          value={login}
          onChangeText={setLogin}
          placeholder="Например, ivan.petrov"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={40}
          editable={!busy}
        />
        <Text style={styles.muted}>Логин должен быть уникальным во всём qwork. От 3 до 40 символов: латинские буквы, цифры, точка, дефис или подчёркивание.</Text>
        {username && !validLogin ? <RequestError message="Проверьте логин. Адрес почты использовать нельзя." /> : null}
        <Text style={styles.label}>Почта (необязательно)</Text>
        <TextInput accessibilityLabel="Почта сотрудника (необязательно)" style={styles.input}
          value={email} onChangeText={setEmail} placeholder="Например, ivan@example.com"
          keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
          textContentType="emailAddress" maxLength={254} editable={!busy} />
        {address && !validEmail ? <RequestError message="Проверьте адрес почты." /> : null}
        <Text style={styles.muted}>Укажите почту сотрудника, которая не используется в другом аккаунте qwork. После подтверждения по ней можно будет входить. Без почты сотрудник сможет пользоваться логином.</Text>
        <View style={styles.infoBanner}>
          <Icon name="shield" size={20} color={colors.blue} />
          <Text style={[styles.muted, styles.flex]}>qwork создаст временный пароль автоматически. Он появится вместе с приглашением после создания аккаунта. При активации сотрудник установит личный пароль.</Text>
        </View>
        <Text style={styles.label}>Роль</Text>
        {staffRoles.map(([value, label]) => (
          <Choice key={value} selected={role === value} onPress={() => { if (!busy) setRole(value); }}>{label}</Choice>
        ))}
      </View>
      <RequestError message={error} />
      <Button onPress={submit} disabled={!canCreate || busy}>{busy ? 'Создаём…' : 'Создать аккаунт'}</Button>
    </>
  );
}

function StaffHandoff({ credentials, onClose }) {
  const [shareError, setShareError] = useState('');
  const { login, password, invitationUrl, email } = credentials;
  let title = password ? 'Аккаунт создан' : 'Приглашение обновлено';
  if (credentials.reset) title = 'Пароль сброшен';

  async function shareInvitation() {
    setShareError('');
    const lines = ['Приглашение в qwork', invitationUrl, 'Логин — ' + login];
    if (password) {
      lines.push('Временный пароль — ' + password);
      lines.push('Откройте ссылку, введите логин и временный пароль, затем установите свой пароль.');
    } else {
      lines.push('Войдите по ссылке со своим логином и паролем.');
    }
    try {
      await Share.share({ message: lines.join('\n') });
    } catch {
      setShareError('Не удалось открыть меню отправки. Скопируйте ссылку из этого экрана.');
    }
  }

  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.cardTitle}>{title}</Text>
      <Text style={styles.muted}>{password
        ? 'qwork уже создал временный пароль. Передайте сотруднику ссылку, логин и пароль из этого экрана. При первом входе он установит личный пароль.'
        : 'Отправьте новую ссылку сотруднику. Он сможет войти с прежним логином и паролем.'}</Text>
      {credentials.reset && <Text style={styles.muted}>Предыдущий пароль и открытые сеансы больше не действуют.</Text>}
      <View style={styles.accessCredentials}>
        <Text style={styles.accessCaption}>ЛОГИН СОТРУДНИКА</Text>
        <Text selectable style={styles.accessValue}>{login}</Text>
        {password ? <>
          <Text style={styles.accessCaption}>ВРЕМЕННЫЙ ПАРОЛЬ · СОЗДАН QWORK</Text>
          <Text selectable style={styles.accessValue}>{password}</Text>
          <Text style={styles.muted}>Именно этот пароль сотрудник вводит при первом входе.</Text>
        </> : null}
      </View>
      {email ? <Text selectable style={styles.muted}>Дополнительная почта · {email}</Text> : null}
      {invitationUrl ? (
        <>
          <Text style={styles.label}>Персональная ссылка для входа</Text>
          <Text selectable style={styles.link}>{invitationUrl}</Text>
          <Text style={styles.muted}>Ссылка действует 7 дней и используется один раз.</Text>
          <Button onPress={shareInvitation} secondary>{password ? 'Отправить ссылку, логин и пароль' : 'Поделиться ссылкой и логином'}</Button>
        </>
      ) : (
        <RequestError message="Не удалось сформировать ссылку для приглашения." />
      )}
      <RequestError message={shareError} />
      <Button onPress={onClose}>Готово</Button>
    </View>
  );
}

function StaffPasswordForm({ employee, onReset, onCancel, busy, error }) {
  function submit() {
    if (busy) return;
    Keyboard.dismiss();
    onReset();
  }

  return (
    <>
      <Button onPress={onCancel} disabled={busy} secondary>‹ К команде</Button>
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.cardTitle}>Сброс пароля</Text>
        <Text style={styles.label}>{employee.name}</Text>
        <Text selectable style={styles.muted}>Логин · {employee.login}</Text>
        <Text style={styles.muted}>qwork создаст новый временный пароль и персональное приглашение. Передайте их сотруднику, чтобы он установил личный пароль.</Text>
        <Text style={styles.muted}>Текущий пароль и открытые сеансы сотрудника перестанут действовать.</Text>
        <RequestError message={error} />
        <Button onPress={submit} disabled={busy}>{busy ? 'Создаём…' : 'Создать новый пароль и ссылку'}</Button>
      </View>
    </>
  );
}

function DepartmentForm({ employee, onSave, onCancel, busy, error }) {
  const [department, setDepartment] = useState(employee.department ?? '');
  return (
    <>
      <Button onPress={onCancel} disabled={busy} secondary>‹ К заявкам</Button>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{employee.name}</Text>
        <Text style={styles.label}>Подразделение</Text>
        <TextInput accessibilityLabel="Подразделение" style={styles.input} value={department}
          onChangeText={setDepartment} maxLength={120} editable={!busy} />
        <Text style={styles.muted}>Оставьте поле пустым, чтобы убрать подразделение.</Text>
        <RequestError message={error} />
        <Button onPress={() => { Keyboard.dismiss(); onSave(department.trim()); }}
          disabled={busy || department.trim() === (employee.department ?? '')}>Сохранить подразделение</Button>
      </View>
    </>
  );
}

function StaffDirectory({ employees, onRenew, onEditDepartment, onResetPassword, busy }) {
  return (
    <View style={styles.staffDirectory}>
      <Text accessibilityRole="header" style={styles.cardTitle}>Сотрудники · {employees.length}</Text>
      {employees.length === 0 && <Text style={styles.muted}>Учётных записей пока нет.</Text>}
      {employees.map((employee) => {
        const roleLabel = employee.isOwner
          ? 'Диспетчер'
          : (staffRoles.find(([value]) => value === employee.role)?.[1] ?? employee.role);
        const lastLogin = employee.lastLoginAt ? new Date(employee.lastLoginAt) : null;
        const lastLoginLabel = lastLogin && !Number.isNaN(lastLogin.getTime())
          ? lastLogin.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : null;
        const accessConfirmed = Boolean(lastLoginLabel && !employee.invitePending);
        let accessLabel = lastLoginLabel ? 'Вход выполнен' : 'Ещё не входил';
        if (employee.invitePending) {
          accessLabel = lastLoginLabel ? 'Ожидает повторной активации' : 'Ожидает первого входа';
        }
        return (
          <View key={employee.id} style={styles.staffRow}>
            <View style={styles.staffIdentity}><View style={styles.staffAvatar}><Text style={styles.staffAvatarText}>{employee.name.split(/\s+/).slice(0, 2).map(name => name[0]).join('')}</Text></View><View style={styles.flex}><Text style={styles.label}>{employee.name}</Text><Text style={styles.muted}>{roleLabel}</Text></View></View>
            <Text selectable style={styles.muted}>{employee.login} · {roleLabel}</Text>
            {employee.email ? <>
              <Text selectable style={styles.muted}>{employee.email}</Text>
              <Text style={styles.muted}>Дополнительная почта · {employee.emailVerified ? 'подтверждена' : 'не подтверждена'}</Text>
            </> : null}
            {employee.department ? <Text style={styles.muted}>Подразделение · {employee.department}</Text> : null}
            <View accessibilityLiveRegion="polite" style={styles.staffAccess}>
              <View style={[styles.status, accessConfirmed ? styles.statusAccepted : styles.statusAttention]}>
                <Text style={[styles.statusText, accessConfirmed ? styles.statusTextAccepted : styles.statusTextAttention]}>
                  {accessLabel}
                </Text>
              </View>
              {lastLoginLabel && <Text style={styles.muted}>Последний вход · {lastLoginLabel}</Text>}
            </View>
            {!employee.isOwner && onRenew && (
              <Button onPress={() => onRenew(employee.id)} disabled={busy} secondary>Выпустить новую ссылку</Button>
            )}
            {!employee.isOwner && onResetPassword && (
              <Button onPress={() => onResetPassword(employee.id)} disabled={busy} secondary>
                {employee.invitePending ? 'Выдать новый временный пароль' : 'Сбросить пароль'}
              </Button>
            )}
            {!employee.isOwner && onEditDepartment && (
              <Button onPress={() => onEditDepartment(employee.id)} disabled={busy} secondary>
                {employee.department ? 'Изменить подразделение' : 'Указать подразделение'}
              </Button>
            )}
          </View>
        );
      })}
    </View>
  );
}

export default function OfficeScreens({
  role, tasks, setTasks, session, employees = [], onCreateTask, onUpdateTask, onCreateEmployee,
  onCancelTask, onRepeatTask, onRenewInvite, onSetDepartment, onResetPassword, objects = [], onCreateObject,
  request, imageSource, onUploadPhoto, onPhotoRejected, section = 'home', onSectionChange, navigationId = 0,
}) {
  const [creating, setCreating] = useState(section === 'home' ? 'overview' : section === 'tasks' ? null : section);
  const internalNavigation = useRef(null);
  const lastNavigationId = useRef(navigationId);
  const [search, setSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState('all');
  const [credentials, setCredentials] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const server = Boolean(session);
  const assignees = employees.filter((employee) => employee.role === 'employee');
  const [selectedId, setSelectedId] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [departmentEmployeeId, setDepartmentEmployeeId] = useState(null);
  const [passwordEmployeeId, setPasswordEmployeeId] = useState(null);
  const manager = role === 'manager';
  const canReview = manager || role === 'dispatcher';
  const operations = creating === 'operations';
  const planning = creating === 'planning';
  const analytics = creating === 'analytics';
  const fieldOperations = creating === 'field-operations';
  const departmentEmployee = employees.find(employee => employee.id === departmentEmployeeId);
  const passwordEmployee = employees.find(employee => employee.id === passwordEmployeeId);
  const selected = tasks.find((task) => task.id === selectedId);
  const repeat = selected && tasks.find((task) => task.id === selected.repeatTaskId || task.repeatOf === selected.id);
  const original = selected?.repeatOf && tasks.find((task) => task.id === selected.repeatOf);
  const pending = tasks.filter((task) => task.status === 'review');
  const accepted = tasks.filter((task) => task.status === 'done');
  const needsRework = tasks.filter((task) => task.status === 'rework');
  const visibleTasks = tasks.filter(task => {
    const matchesText = `${task.title} ${task.object} ${task.assigneeName || ''} ${task.id}`.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU'));
    const matchesFilter = taskFilter === 'all' || (taskFilter === 'active' ? !['done', 'cancelled', 'repeated', 'review'].includes(task.status) : taskFilter === 'overdue' ? task.overdue : task.status === 'review');
    return matchesText && matchesFilter;
  });

  useEffect(() => {
    const fromTab = lastNavigationId.current !== navigationId;
    lastNavigationId.current = navigationId;
    if (!fromTab && internalNavigation.current === section) {
      internalNavigation.current = null;
      return;
    }
    internalNavigation.current = null;
    setCreating(section === 'home' ? 'overview' : section === 'tasks' ? null : section);
    setSelectedId(null);
    setReportOpen(false);
    setError('');
  }, [section, navigationId]);

  function navigate(next) {
    const destination = next === 'overview' ? 'home' : next === null ? 'tasks' : next;
    if (['home', 'tasks', 'team', 'operations', 'planning', 'analytics', 'field-operations'].includes(destination)) {
      internalNavigation.current = destination;
      onSectionChange?.(destination);
    }
    setCreating(next);
    setSelectedId(null);
    setReportOpen(false);
    setError('');
  }

  async function submit(work) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(failure.message || 'Не удалось сохранить данные. Повторите попытку.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function openForm(next) {
    setError('');
    navigate(next);
  }

  function createStaff(fields) {
    return submit(async () => {
      const result = await onCreateEmployee(fields);
      setCredentials({ login: result.login, email: result.email, password: result.password ?? result.temporaryPassword, invitationUrl: result.invitationUrl });
      setCreating('handoff');
    });
  }

  function renewStaffInvite(employeeId) {
    return submit(async () => {
      const result = await onRenewInvite(employeeId);
      setCredentials({ login: result.login, invitationUrl: result.invitationUrl });
      setCreating('handoff');
    });
  }

  function editStaffDepartment(employeeId) {
    setDepartmentEmployeeId(employeeId);
    openForm('department');
  }

  function saveStaffDepartment(department) {
    return submit(async () => {
      await onSetDepartment(departmentEmployeeId, department);
      openForm('team');
    });
  }

  function openStaffPassword(employeeId) {
    setPasswordEmployeeId(employeeId);
    openForm('password');
  }

  function resetStaffPassword() {
    return submit(async () => {
      const result = await onResetPassword(passwordEmployeeId);
      setCredentials({ login: result.login, email: result.email, password: result.password ?? result.temporaryPassword, invitationUrl: result.invitationUrl, reset: true });
      setPasswordEmployeeId(null);
      setCreating('handoff');
    });
  }

  function createTask(fields) {
    if (server) {
      return submit(async () => {
        const result = await onCreateTask(fields);
        openTask(result?.task?.id ?? result?.id ?? null);
      });
    }
    setTasks((previous) => {
      const nextId = Math.max(1000, ...previous.map((task) => Number(task.id) || 0)) + 1;
      const task = {
        ...fields,
        id: String(nextId),
        status: 'assigned',
        checks: [false, false, false, false, false],
        photos: { before: 0, after: 0 },
      };
      return [task, ...previous];
    });
    openForm(null);
  }

  function decide(id, status, reworkReason) {
    if (server) {
      return submit(async () => {
        await onUpdateTask(id, { status, reworkReason });
        setSelectedId(null);
      });
    }
    setTasks((previous) =>
      previous.map((task) =>
        task.id === id && task.status === 'review' ? { ...task, status, reworkReason } : task,
      ),
    );
    setSelectedId(null);
  }

  function openTask(id) {
    navigate(null);
    setSelectedId(id);
  }

  function cancelTask(id, reason) {
    return submit(async () => {
      await onCancelTask(id, reason);
    });
  }

  function repeatTask(id, fields) {
    return submit(async () => {
      const result = await onRepeatTask(id, fields);
      openTask(result?.task?.id ?? result?.id ?? null);
    });
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        key={selectedId || creating || 'list'}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heading}>
          <View style={styles.headingCopy}>
            <Text accessibilityRole="header" style={styles.title}>
              {selected ? 'Карточка заявки' : creating === 'overview' ? 'Главная' : analytics ? 'Аналитика' : planning ? 'Плановые работы' : operations ? 'Рабочее время' : fieldOperations ? 'Выездной контроль' : creating === 'team' ? 'Команда' : creating === 'task' ? 'Новая заявка' : creating ? 'Доступ сотрудника' : manager ? 'Приёмка работ' : 'Заявки'}
            </Text>
            <Text style={styles.subtitle}>
              {selected ? `Заявка №${selected.id}` : creating === 'overview' ? 'Все рабочие дела в одном месте' : analytics ? 'Статистика выполнения и выездов' : planning ? 'Повторяющиеся работы и автоназначение' : operations ? 'График, дежурства и согласования' : fieldOperations ? 'Отметки сотрудников, отклонения и командировки' : creating === 'team' ? 'Сотрудники и доступ к компании' : creating === 'task' ? 'Поставьте задачу сотруднику' : creating ? 'Настройте доступ к рабочему пространству' : manager ? 'Проверяйте отчёты сотрудников' : 'Постановка и контроль выездных работ'}
            </Text>
          </View>
          {!manager && !creating && !selected && <Pressable accessibilityRole="button" accessibilityLabel="Создать заявку" onPress={() => openForm('task')} style={styles.addButton}><Icon name="plus" color="#FFFFFF" size={24} /></Pressable>}
        </View>

        {creating === 'overview' && !selected && <Dashboard tasks={tasks} employees={employees} session={session} manager={manager}
          onOpen={destination => openForm(destination === 'tasks' ? null : destination)} onTask={openTask} />}

        {creating === 'team' && !manager && server && <>
          {session.user.isOwner && <Button onPress={() => openForm('staff')}>Добавить сотрудника</Button>}
          <StaffDirectory employees={employees}
            onRenew={session.user.isOwner && onRenewInvite ? renewStaffInvite : undefined}
            onResetPassword={session.user.isOwner && onResetPassword ? openStaffPassword : undefined}
            onEditDepartment={session.user.isOwner && onSetDepartment ? editStaffDepartment : undefined} busy={busy} />
          <RequestError message={error} />
        </>}

        {!server && ['team', 'operations', 'planning', 'analytics', 'field-operations'].includes(creating) && <View style={styles.emptyCard}><Icon name="shield" size={30} color={colors.blue} /><Text style={styles.label}>Войдите в рабочее пространство</Text><Text style={styles.muted}>Этот раздел использует данные вашей компании.</Text><Button onPress={() => openForm(null)} secondary>К демонстрационным заявкам</Button></View>}

        {selected && (
          <>
            <Button onPress={() => openTask(null)} disabled={busy} secondary>
              {manager ? '‹ К списку отчётов' : '‹ К заявкам'}
            </Button>
            <TaskDetails task={selected} />
            <Button onPress={() => setReportOpen(true)} disabled={busy} secondary>Открыть отчёт по выезду</Button>
            {reportOpen && (
              <FieldReport task={selected} request={server ? request : undefined} imageSource={imageSource}
                onClose={() => setReportOpen(false)} canReject={canReview && selected.status === 'review' && !busy}
                onRejected={onPhotoRejected}>
                {server && request && (
                  <RepresentativeReview task={selected} request={request} imageSource={imageSource}
                    onRework={canReview ? reason => decide(selected.id, 'rework', reason) : null} />
                )}
                <RequestError message={error} />
              </FieldReport>
            )}
            {server && request && imageSource && (
              <>
                <View style={styles.card}>
                  <Text accessibilityRole="header" style={styles.cardTitle}>Материалы диспетчера</Text>
                  <TaskPhotoGallery taskId={selected.id} request={request} imageSource={imageSource}
                    kinds={MATERIAL_KINDS} revision={selected.revision} />
                  {!manager && onUploadPhoto && !closedStatuses.includes(selected.status) && (
                    <DispatcherPhotoPicker key={selected.id} disabled={busy}
                      onUpload={(payload) => onUploadPhoto(selected.id, payload)} />
                  )}
                </View>
                <View style={styles.card}>
                  <Text accessibilityRole="header" style={styles.cardTitle}>Фотоотчёт сотрудника</Text>
                  <TaskPhotoGallery taskId={selected.id} request={request} imageSource={imageSource}
                    kinds={REPORT_KINDS} revision={selected.revision} checklist={selected.checklist}
                    canReject={canReview && selected.status === 'review' && !busy}
                    onRejected={onPhotoRejected} />
                </View>
              </>
            )}
            {original && (
              <Button onPress={() => openTask(original.id)} disabled={busy} secondary>
                Исходная заявка №{original.id}
              </Button>
            )}
            {repeat && (
              <Button onPress={() => openTask(repeat.id)} disabled={busy} secondary>
                Повторный выезд №{repeat.id}
              </Button>
            )}
            {['review', 'done'].includes(selected.status) && (
              <Review
                task={selected}
                onDecision={canReview ? decide : null}
                busy={busy}
                error={error}
              />
            )}
            {server && (
              <TaskActions
                task={selected}
                onCancelTask={cancelTask}
                onRepeatTask={!manager && !repeat ? repeatTask : null}
                busy={busy}
                error={error}
              />
            )}
            {server && !manager && request && ['paused', 'unassigned'].includes(selected.status) && (
              <TaskTransfer task={selected} request={request} employees={assignees} />
            )}
          </>
        )}

        {operations && server && request && (
          <>
            <Button onPress={() => openForm(null)} secondary>{manager ? '‹ К приёмке' : '‹ К заявкам'}</Button>
            <OfficeShiftPanel request={request} role={role} employees={employees} tasks={tasks} />
          </>
        )}

        {fieldOperations && server && request && (
          <>
            <Button onPress={() => openForm('overview')} secondary>‹ На главную</Button>
            <OfficeFieldOperations request={request} tasks={tasks} onTask={id => openTask(String(id))} />
          </>
        )}

        {planning && !manager && server && request && (
          <>
            <Button onPress={() => openForm(null)} secondary>‹ К заявкам</Button>
            <PlanningScreens request={request} objects={objects} tasks={tasks}
              onOpenTask={id => { openForm(null); openTask(id); }} />
          </>
        )}

        {analytics && server && request && (
          <>
            <Button onPress={() => openForm(null)} secondary>{manager ? '‹ К приёмке' : '‹ К заявкам'}</Button>
            <AnalyticsScreens request={request} onOpenTask={id => { openForm(null); openTask(String(id)); }} />
          </>
        )}

        {manager && !selected && !creating && (
          <>
            <TaskMetrics tasks={tasks} manager />
            {server && request && <SyncConflicts request={request} tasks={tasks} onOpenTask={openTask} />}
            <Text accessibilityRole="header" style={styles.sectionTitle}>На проверке · {pending.length}</Text>
            {pending.length ? pending.map((task) => (
              <TaskCard key={task.id} task={task} onPress={() => openTask(task.id)} />
            )) : (
              <View style={styles.card}><Text style={styles.muted}>Отчёты пока не поступили.</Text></View>
            )}
            {accepted.length > 0 && (
              <>
                <Text accessibilityRole="header" style={styles.sectionTitle}>Принятые · {accepted.length}</Text>
                {accepted.map((task) => (
                  <TaskCard key={task.id} task={task} onPress={() => openTask(task.id)} />
                ))}
              </>
            )}
            {needsRework.length > 0 && (
              <>
                <Text accessibilityRole="header" style={styles.sectionTitle}>На доработке · {needsRework.length}</Text>
                {needsRework.map((task) => (
                  <TaskCard key={task.id} task={task} onPress={() => openTask(task.id)} />
                ))}
              </>
            )}
          </>
        )}

        {!manager && creating === 'task' && (
          <TaskForm
            onCreate={createTask}
            onCancel={() => openForm(null)}
            employees={assignees}
            objects={objects}
            request={request}
            onCreateObject={onCreateObject ? async (fields) => {
              let result;
              await submit(async () => { result = await onCreateObject(fields); });
              return result?.object ?? result;
            } : null}
            server={server}
            busy={busy}
            error={error}
          />
        )}

        {!manager && creating === 'staff' && (
          <StaffForm onCreate={createStaff} onCancel={() => openForm('team')} busy={busy} error={error} />
        )}

        {!manager && creating === 'department' && departmentEmployee && (
          <DepartmentForm employee={departmentEmployee} onSave={saveStaffDepartment}
            onCancel={() => openForm('team')} busy={busy} error={error} />
        )}

        {!manager && creating === 'password' && passwordEmployee && (
          <StaffPasswordForm key={passwordEmployee.id} employee={passwordEmployee} onReset={resetStaffPassword}
            onCancel={() => openForm('team')} busy={busy} error={error} />
        )}

        {!manager && creating === 'handoff' && credentials && (
          <StaffHandoff
            credentials={credentials}
            onClose={() => { setCredentials(null); openForm('team'); }}
          />
        )}

        {!manager && !creating && !selected && (
          <>
            <View style={styles.segmented}>
              {[['all', 'Все'], ['active', 'В работе'], ['review', 'На проверке'], ['overdue', 'Просрочены']].map(([key, label]) => <Pressable
                accessibilityRole="tab" accessibilityState={{ selected: taskFilter === key }} key={key} onPress={() => setTaskFilter(key)}
                style={[styles.segment, taskFilter === key && styles.segmentActive]}><Text style={[styles.segmentText, taskFilter === key && styles.segmentTextActive]}>{label}</Text></Pressable>)}
            </View>
            <View style={styles.searchBar}><Icon name="search" size={19} color={colors.muted} /><TextInput
              accessibilityLabel="Поиск по заявкам" value={search} onChangeText={setSearch} placeholder="Поиск по заявкам" placeholderTextColor={colors.muted}
              style={styles.searchInput} autoCorrect={false} clearButtonMode="while-editing" /></View>
            <TaskMetrics tasks={tasks} />
            {visibleTasks.length ? visibleTasks.map(task => <TaskCard key={task.id} task={task} onPress={() => openTask(task.id)} />) :
              <View style={styles.emptyCard}><Icon name="search" size={28} color={colors.blue} /><Text style={styles.label}>{search || taskFilter !== 'all' ? 'Заявки не найдены' : 'Заявок пока нет'}</Text><Text style={styles.muted}>{search || taskFilter !== 'all' ? 'Попробуйте другой запрос или фильтр.' : 'Создайте первую заявку и выберите исполнителя.'}</Text></View>}
          </>
        )}

      </ScrollView>
      {!manager && !creating && !selected && (
        <View style={styles.bottomAction}>
          <Button onPress={() => openForm('task')}>＋ Создать заявку</Button>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  infoBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, backgroundColor: '#EAF4FF', padding: 12, borderRadius: 11 },
  arrivalSettings: { backgroundColor: '#F5F9FF', borderRadius: 12, padding: 12, gap: 8 },
  arrivalHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  arrivalToggle: { minHeight: 44, justifyContent: 'center', paddingLeft: 4 },
  arrivalChoice: { minHeight: 60, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12,
    borderWidth: 1, borderColor: '#E6ECF5', flexDirection: 'row', alignItems: 'center', gap: 8 },
  map: { width: '100%', height: 240, borderRadius: 12 },
  screen: { flex: 1, backgroundColor: '#F5F7FC' },
  scroll: { flex: 1 },
  content: { gap: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 2, paddingBottom: 8 },
  title: { color: '#142034', fontSize: 27, fontWeight: '700', letterSpacing: -0.8 },
  subtitle: { color: '#8190AA', fontSize: 12, lineHeight: 18, marginTop: 3 },
  sectionTitle: { color: '#142034', fontSize: 17, fontWeight: '700', marginTop: 4 },
  card: {
    backgroundColor: '#FFFFFF',
    borderWidth: 0,
    borderRadius: 14,
    gap: 8,
    padding: 14,
  },
  cardTop: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  reference: { color: '#586780', fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  status: { borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: '#EDF5FF' },
  statusAccepted: { backgroundColor: '#E5F5EC' },
  statusAttention: { backgroundColor: '#FFF1DA' },
  statusText: { color: '#087CFF', fontSize: 11, fontWeight: '600' },
  statusTextAccepted: { color: '#166947' },
  statusTextAttention: { color: '#825114' },
  cardTitle: { color: '#142034', fontSize: 15, fontWeight: '700', lineHeight: 21 },
  muted: { color: '#8190AA', fontSize: 12, lineHeight: 18 },
  link: { color: '#087CFF', fontSize: 14, fontWeight: '700' },
  label: { color: '#142034', fontSize: 14, fontWeight: '700', marginTop: 4 },
  staffDirectory: { gap: 8, marginTop: 4 },
  accessCredentials: { backgroundColor: '#EDF5FF', borderRadius: 12, padding: 13, gap: 8 },
  accessCaption: { color: '#647A98', fontSize: 10, fontWeight: '600', letterSpacing: 0.5 },
  accessValue: { color: '#142034', fontSize: 17, fontWeight: '700', lineHeight: 24 },
  staffRow: { backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14, gap: 5 },
  staffAccess: { alignItems: 'flex-start', gap: 4, marginTop: 6, marginBottom: 6 },
  input: {
    backgroundColor: '#F5F7FC',
    borderWidth: 1,
    borderColor: '#E6ECF5',
    borderRadius: 10,
    color: '#142034',
    fontSize: 14,
    paddingHorizontal: 13,
    paddingVertical: 12,
    minHeight: 46,
  },
  multiline: { minHeight: 92, textAlignVertical: 'top' },
  formGroup: { gap: 7, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  error: { color: '#982F36', fontWeight: '700', fontSize: 14, lineHeight: 20 },
  choice: {
    minHeight: 48, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12,
    borderWidth: 1, borderColor: '#E6ECF5', flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', gap: 8,
  },
  choiceSelected: { borderColor: '#087CFF', backgroundColor: '#EDF5FF' },
  choiceLabel: { color: '#142034', fontSize: 15, fontWeight: '600', flexShrink: 1 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: { flexGrow: 1, minWidth: 76, gap: 4, borderRadius: 12, backgroundColor: '#F5F7FC', padding: 10 },
  metricValue: { color: '#142034', fontSize: 21, fontWeight: '700' },
  metricLabel: { color: '#8190AA', fontSize: 12, lineHeight: 16 },
  bottomAction: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E0E7F2',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  button: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#087CFF',
  },
  buttonSecondary: { backgroundColor: '#EDF5FF' },
  buttonLabel: { color: '#FFFFFF', textAlign: 'center', fontSize: 14, fontWeight: '600' },
  buttonLabelSecondary: { color: '#087CFF' },
  flex: { flex: 1 },
  headingCopy: { flex: 1 },
  addButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#087CFF', alignItems: 'center', justifyContent: 'center' },
  taskTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  taskMetadata: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#E5F1FC', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#5D89A8', fontSize: 11, fontWeight: '700' },
  statusDanger: { backgroundColor: '#FFECEF' },
  statusTextDanger: { color: '#F36273', fontSize: 11, fontWeight: '600' },
  summaryStrip: { paddingVertical: 13, paddingHorizontal: 10, borderRadius: 13, backgroundColor: '#FFFFFF', flexDirection: 'row', gap: 6 },
  summaryItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 },
  summaryIcon: { width: 32, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  summaryLabel: { color: '#8190AA', fontSize: 10, lineHeight: 14 },
  summaryValue: { color: '#142034', fontSize: 17, fontWeight: '700', lineHeight: 21 },
  todayCard: { backgroundColor: '#FFFFFF', borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  todayIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EDF5FF' },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  quickTile: { flexGrow: 1, flexBasis: '46%', borderRadius: 14, padding: 13, gap: 7, minHeight: 130 },
  quickTitle: { color: '#142034', fontSize: 14, fontWeight: '700', lineHeight: 18 },
  quickDetail: { color: '#8190AA', fontSize: 12, lineHeight: 17 },
  navigationRow: { backgroundColor: '#FFFFFF', borderRadius: 13, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 1 },
  emptyCard: { padding: 24, alignItems: 'center', gap: 10, borderRadius: 14, backgroundColor: '#FFFFFF' },
  segmented: { flexDirection: 'row', backgroundColor: '#ECF1F8', borderRadius: 10, padding: 3 },
  segment: { flex: 1, minHeight: 35, alignItems: 'center', justifyContent: 'center', borderRadius: 8, paddingHorizontal: 3 },
  segmentActive: { backgroundColor: '#087CFF' },
  segmentText: { color: '#8190AA', fontSize: 11, fontWeight: '600' },
  segmentTextActive: { color: '#FFFFFF' },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 11, backgroundColor: '#ECF1F8', paddingHorizontal: 11, minHeight: 43 },
  searchInput: { flex: 1, color: '#142034', fontSize: 13, paddingVertical: 9 },
  staffIdentity: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  staffAvatar: { width: 45, height: 45, borderRadius: 23, backgroundColor: '#E7F2FE', alignItems: 'center', justifyContent: 'center' },
  staffAvatarText: { color: '#087CFF', fontSize: 16, fontWeight: '700' },
  dimmed: { opacity: 0.58 },
});
