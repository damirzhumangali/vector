import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { EmployeeCamera, TaskPhotoGallery } from './TaskPhotos';
import FieldReport, { CHECKLIST_OUTCOMES, DEFAULT_CHECKLIST_TITLES, PRIORITY_LABELS, RESULT_FIELDS } from './FieldReport';
import { Icon } from './ui';

const palette = {
  canvas: '#F5F7FC',
  paper: '#FFFFFF',
  ink: '#142034',
  muted: '#8493AA',
  accent: '#087CFF',
  accentSoft: '#EAF4FF',
  line: '#E8EEF7',
};

const stages = ['assigned', 'accepted', 'travel', 'arrived', 'work', 'review', 'done'];
const stageLabels = {
  assigned: 'Назначено',
  accepted: 'Принято',
  travel: 'В пути',
  arrived: 'На объекте',
  work: 'В работе',
  review: 'На проверке',
  done: 'Работа принята',
  paused: 'На паузе',
  rework: 'На доработке',
  cancelled: 'Отменена',
  repeated: 'Назначен повторный выезд',
  refused: 'Сотрудник отказался',
  reopened: 'Заявка переоткрыта',
};
function Action({ children, onPress, disabled = false, secondary = false }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary && styles.secondary,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.actionText, secondary && styles.secondaryText, disabled && styles.disabledText]}>{children}</Text>
    </Pressable>
  );
}

function SectionHeading({ children, icon = 'clipboard' }) {
  return (
    <View style={styles.sectionHeading}>
      <View style={styles.sectionIcon}><Icon name={icon} color={palette.accent} size={19} /></View>
      <Text accessibilityRole="header" style={styles.heading}>{children}</Text>
    </View>
  );
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
}

export function WorkScreens({ task, setTask, onBack, onOpenTask, onLocate, onUploadPhoto, request, imageSource,
  galleryRevision = task.revision, busy = false, canRefuseTask = false, backLabel = 'Задачи' }) {
  const [locating, setLocating] = useState(false);
  const [manualArrival, setManualArrival] = useState(false);
  const [arrivalReason, setArrivalReason] = useState('');
  const [arrivalError, setArrivalError] = useState('');
  const [result, setResult] = useState(task.result ?? '');
  const [checklistDraft, setChecklistDraft] = useState(null);
  const [outcomeDraft, setOutcomeDraft] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [refusalReason, setRefusalReason] = useState('');
  const status = task.status ?? 'assigned';
  const stageIndex = stages.indexOf(status);
  const due = task.deadline ? formatTime(task.deadline) : task.due;
  const scheduled = task.scheduledAt ? formatTime(task.scheduledAt) : '';
  const checks = DEFAULT_CHECKLIST_TITLES.map((_, index) => Boolean(task.checks?.[index]));
  const checkedCount = checks.filter(Boolean).length;
  const before = Boolean(task.photos?.before);
  const after = Boolean(task.photos?.after);
  const photoPairs = task.photoPairs?.length
    ? task.photoPairs
    : [{ key: 'main', label: 'Общий вид', before, after }];
  const hasBeforePhotos = photoPairs.every(pair => pair.before);
  const checklist = checklistDraft ?? task.checklist;
  const outcome = outcomeDraft ?? { ...task.outcome, work: task.outcome?.work ?? task.result ?? '' };
  const marked = checklist?.filter(item => item.status).length;
  const ready = (checklist ? marked === checklist.length : checkedCount === checks.length)
    && photoPairs.every(pair => pair.before && pair.after);
  const reportLocked = ['review', 'done'].includes(status);

  const update = (values) => setTask({ ...task, ...values });
  const addPhoto = (kind) => update({ photos: { ...task.photos, [kind]: 1 } });
  const toggleCheck = (index) => {
    const nextChecks = [...checks];
    nextChecks[index] = !nextChecks[index];
    update({ checks: nextChecks });
  };
  const editChecklist = (id, values) => {
    setChecklistDraft(current => (current ?? task.checklist).map(item => item.id === id ? { ...item, ...values } : item));
  };
  const reportValues = () => ({
    checklist: checklist.map(({ id, status: itemStatus, comment }) => ({ id, status: itemStatus ?? null, comment: (comment ?? '').trim() })),
    outcome: Object.fromEntries(RESULT_FIELDS.map(([key]) => [key, (outcome[key] ?? '').trim()])),
  });
  const saveDraft = async () => {
    if (await update(reportValues())) {
      setChecklistDraft(null);
      setOutcomeDraft(null);
    }
  };
  const openRelatedTask = (id) => {
    if (onOpenTask(id) === false) {
      Alert.alert('Заявка недоступна', 'Открыть можно только заявки, назначенные вам.');
    }
  };

  const primaryAction = {
    assigned: ['Принять задачу', 'accepted'],
    accepted: ['Выехать на объект', 'travel'],
    travel: [manualArrival ? 'Подтвердить без GPS' : 'Я на месте', 'arrived'],
    arrived: ['Начать работу', 'work'],
    paused: ['Продолжить работу', 'work'],
    rework: ['Начать доработку', 'work'],
    work: ['Передать на проверку', 'review'],
  }[status];
  let actionHint = '';
  if (!hasBeforePhotos && (status === 'arrived' || (onUploadPhoto && ['paused', 'rework'].includes(status)))) {
    actionHint = 'Добавьте фото «до» для каждой пары, чтобы начать работу.';
  } else if (status === 'work' && !ready) {
    actionHint = 'Заполните чек-лист и добавьте снимки «до» и «после» для каждой пары.';
  } else if (status === 'work' && !(checklist ? outcome.work : result).trim()) {
    actionHint = 'Заполните поле «Что сделано».';
  }
  const actionDisabled = busy || locating || Boolean(actionHint)
    || (status === 'travel' && manualArrival && !arrivalReason.trim());

  const advance = async (nextStatus = primaryAction[1]) => {
    setArrivalError('');
    const occurredAt = new Date().toISOString();
    if (status === 'travel' && manualArrival) {
      return update({ status: nextStatus, occurredAt, arrival: { reason: arrivalReason.trim() } });
    }
    let position;
    if (onLocate) {
      setLocating(true);
      try {
        const location = await onLocate();
        if (Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude)) {
          position = location;
        }
      } catch {
        // Other transitions may proceed if the device cannot report its location.
      } finally {
        setLocating(false);
      }
      if (status === 'travel') {
        if (!position) {
          setManualArrival(true);
          return;
        }
        if (task.location) {
          const radians = value => value * Math.PI / 180;
          const lat1 = radians(task.location.latitude);
          const lat2 = radians(position.latitude);
          const longitude = radians(position.longitude - task.location.longitude);
          const arc = Math.sin((lat2 - lat1) / 2) ** 2
            + Math.cos(lat1) * Math.cos(lat2) * Math.sin(longitude / 2) ** 2;
          const distance = 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, arc)));
          if (distance > task.location.radius) {
            setArrivalError(`Вы вне радиуса объекта. Расстояние: ${Math.round(distance)} м.`);
            return;
          }
        }
        return update({ status: nextStatus, occurredAt, arrival: position });
      }
    }
    const changes = { status: nextStatus, position, occurredAt };
    if (status === 'rework') {
      if (nextStatus === 'travel') {
        changes.arrival = null;
        setManualArrival(false);
        setArrivalReason('');
      } else {
        changes.photos = { ...task.photos, after: 0 };
      }
    } else if (nextStatus === 'review') {
      if (checklist) Object.assign(changes, reportValues());
      else changes.result = result.trim();
    }
    return update(changes);
  };

  const refuse = async () => {
    if (await update({ status: 'refused', refusalReason: refusalReason.trim(), occurredAt: new Date().toISOString() })) {
      onBack();
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.navigation}>
        <Pressable accessibilityRole="button" accessibilityLabel={backLabel === 'Выезды' ? 'Вернуться к выездам' : 'Вернуться к моим задачам'} onPress={onBack} style={styles.back}>
          <Icon name="chevron-left" color={palette.ink} size={22} />
          <Text style={styles.backText}>{backLabel}</Text>
        </Pressable>
        <Text style={styles.navigationTitle}>Карточка задания</Text>
        <View style={styles.navigationSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <Text style={styles.eyebrow}>ЗАЯВКА №{task.id}</Text>
            <Text style={styles.badge}>{stageLabels[status] ?? 'Задание'}</Text>
            {task.priority && <Text style={styles.badge}>Приоритет · {PRIORITY_LABELS[task.priority]}</Text>}
            {task.overdue ? <Text style={[styles.badge, styles.overdueBadge]}>Просрочена</Text> : null}
          </View>
          <Text accessibilityRole="header" style={styles.title}>{task.title}</Text>
          <View style={styles.metadata}>
            <View style={styles.metaItem}>
              <View style={styles.metaLabel}><Icon name="pin" color={palette.accent} size={16} /><Text style={styles.eyebrow}>Объект</Text></View>
              <Text style={styles.metaValue}>{task.object}</Text>
              {task.address ? <Text style={styles.body}>{task.address}</Text> : null}
            </View>
            {scheduled ? (
              <View style={styles.metaItem}>
                <View style={styles.metaLabel}><Icon name="calendar" color={palette.accent} size={16} /><Text style={styles.eyebrow}>Начало по плану</Text></View>
                <Text style={styles.metaValue}>{scheduled}</Text>
              </View>
            ) : null}
            {due ? (
              <View style={styles.metaItem}>
                <View style={styles.metaLabel}><Icon name="calendar" color={palette.accent} size={16} /><Text style={styles.eyebrow}>Срок выполнения</Text></View>
                <Text style={styles.metaValue}>{due}</Text>
              </View>
            ) : null}
            {task.managerName ? (
              <View style={styles.metaItem}>
                <View style={styles.metaLabel}><Icon name="user" color={palette.accent} size={16} /><Text style={styles.eyebrow}>Руководитель</Text></View>
                <Text style={styles.metaValue}>{task.managerName}</Text>
              </View>
            ) : null}
            {task.purpose ? (
              <View style={styles.metaItem}>
                <View style={styles.metaLabel}><Icon name="clipboard" color={palette.accent} size={16} /><Text style={styles.eyebrow}>Цель выезда</Text></View>
                <Text style={styles.metaValue}>{task.purpose}</Text>
              </View>
            ) : null}
          </View>
          {stageIndex >= 0 ? (
            <View accessible accessibilityLabel={`Этап ${stageIndex + 1} из ${stages.length}`} style={styles.progressGroup}>
              <View style={styles.progress}>
                {stages.map((stage, index) => (
                  <View key={stage} style={[styles.progressBar, index <= stageIndex && styles.progressFilled]} />
                ))}
              </View>
              <Text style={styles.progressText}>Этап {stageIndex + 1} из {stages.length}</Text>
            </View>
          ) : null}
          {task.repeatOf ? (
            onOpenTask ? <Action secondary onPress={() => openRelatedTask(task.repeatOf)}>Исходная заявка №{task.repeatOf}</Action>
              : <Text style={styles.body}>Исходная заявка №{task.repeatOf}</Text>
          ) : null}
          {task.repeatTaskId ? (
            onOpenTask ? <Action secondary onPress={() => openRelatedTask(task.repeatTaskId)}>Повторный выезд №{task.repeatTaskId}</Action>
              : <Text style={styles.body}>Повторный выезд №{task.repeatTaskId}</Text>
          ) : null}
          {task.repeatReason ? <Text style={styles.body}>Причина повторного выезда · {task.repeatReason}</Text> : null}
          <Action secondary onPress={() => setReportOpen(true)}>Открыть отчёт по выезду</Action>
        </View>

        {task.description ? (
          <View style={styles.card}>
            <SectionHeading icon="clipboard">Что нужно сделать</SectionHeading>
            <Text style={styles.body}>{task.description}</Text>
          </View>
        ) : null}

        {(status === 'rework' || (['travel', 'arrived', 'work'].includes(status) && task.reworkReason)) ? (
          <View style={styles.card}>
            <SectionHeading icon="alert">Что нужно исправить</SectionHeading>
            <Text style={styles.body}>{task.reworkReason || task.reviewComment || 'Отчёт возвращён на доработку.'}</Text>
          </View>
        ) : null}

        {status === 'cancelled' ? (
          <View style={styles.card}>
            <SectionHeading icon="close">Задача отменена</SectionHeading>
            {task.cancelReason ? <Text style={styles.body}>{task.cancelReason}</Text> : null}
          </View>
        ) : null}

        {status === 'travel' ? (
          <View style={styles.card}>
            <SectionHeading icon="pin">Прибытие на объект</SectionHeading>
            <Text style={styles.body}>
              {onLocate
                ? manualArrival
                  ? 'GPS недоступен. Укажите причину ручной отметки.'
                  : 'Приложение определит ваше местоположение при отметке прибытия.'
                : 'Отметьте прибытие, чтобы перейти к работе. В демо геопозиция имитируется.'}
            </Text>
            {arrivalError ? <Text accessibilityRole="alert" style={styles.body}>{arrivalError}</Text> : null}
            {manualArrival ? (
              <>
                <TextInput
                  accessibilityLabel="Причина ручной отметки"
                  placeholder="Например, в подвале нет сигнала"
                  placeholderTextColor={palette.muted}
                  editable={!busy}
                  value={arrivalReason}
                  onChangeText={setArrivalReason}
                  maxLength={500}
                  style={styles.input}
                />
                <Action secondary disabled={busy} onPress={() => setManualArrival(false)}>Повторить проверку GPS</Action>
              </>
            ) : null}
          </View>
        ) : null}

        {task.arrival ? (
          <View style={styles.card}>
            <SectionHeading icon="pin">Отметка прибытия</SectionHeading>
            {task.arrival.reason ? (
              <Text style={styles.body}>Без GPS · {task.arrival.reason}</Text>
            ) : (
              <>
                {task.arrival.capturedAt ? <Text style={styles.body}>{formatTime(task.arrival.capturedAt)}</Text> : null}
                {Number.isFinite(task.arrival.distance) ? (
                  <Text style={styles.body}>Расстояние до объекта · {task.arrival.distance} м</Text>
                ) : null}
                {Number.isFinite(task.arrival.accuracy) ? (
                  <Text style={styles.body}>Точность GPS · {Math.round(task.arrival.accuracy)} м</Text>
                ) : null}
              </>
            )}
          </View>
        ) : null}

        {onUploadPhoto ? (
          <View style={styles.card}>
            <SectionHeading icon="briefcase">Материалы диспетчера</SectionHeading>
            <TaskPhotoGallery taskId={task.id} request={request} imageSource={imageSource}
              kinds={['material']} revision={galleryRevision} />
          </View>
        ) : null}

        {['arrived', 'work', 'paused', 'rework', 'review', 'done'].includes(status) && onUploadPhoto ? (
          <View style={styles.card}>
            <SectionHeading icon="camera">Фотоотчёт</SectionHeading>
            {photoPairs.map(pair => (
              <View key={pair.key} style={styles.checkItem}>
                <Text style={styles.metaValue}>{pair.label}</Text>
                <Text style={styles.photoState}>До работы · {pair.before ? 'Добавлено' : 'Нет снимка'}</Text>
                {!pair.before && ['arrived', 'work', 'rework', 'paused'].includes(status) ? (
                  <EmployeeCamera kind="before" pairKey={pair.key} onLocate={onLocate} disabled={busy}
                    onUpload={fields => onUploadPhoto(task.id, fields)} />
                ) : null}
                <Text style={styles.photoState}>После работы · {pair.after ? 'Добавлено' : 'Нет снимка'}</Text>
                {!pair.after && status === 'work' ? (
                  <EmployeeCamera kind="after" pairKey={pair.key} onLocate={onLocate} disabled={busy}
                    onUpload={fields => onUploadPhoto(task.id, fields)} />
                ) : null}
              </View>
            ))}
            <TaskPhotoGallery taskId={task.id} request={request} imageSource={imageSource}
              kinds={['before', 'after']} photoPairs={photoPairs}
              revision={galleryRevision} />
          </View>
        ) : ['arrived', 'work', 'paused', 'review', 'done'].includes(status) && !onUploadPhoto ? (
          <View style={styles.card}>
            <SectionHeading icon="camera">Фотоотчёт</SectionHeading>
            <Text style={styles.body}>Демонстрационные снимки до и после работы.</Text>
            <Text style={styles.photoState}>До работы · {before ? 'Добавлено' : 'Нет снимка'}</Text>
            {!before && !reportLocked ? (
              <Action secondary disabled={busy} onPress={() => addPhoto('before')}>Добавить фото «до»</Action>
            ) : null}
            <Text style={styles.photoState}>После работы · {after ? 'Добавлено' : 'Нет снимка'}</Text>
            {!after && status === 'work' ? (
              <Action secondary disabled={busy} onPress={() => addPhoto('after')}>Добавить фото «после»</Action>
            ) : null}
          </View>
        ) : null}

        {checklist && ['work', 'paused', 'rework', 'review', 'done'].includes(status) ? (
          <View style={styles.card}>
            <SectionHeading icon="clipboard">Чек-лист работ</SectionHeading>
            <Text style={styles.body}>{marked} из {checklist.length} пунктов заполнено</Text>
            {checklist.map(item => (
              <View key={item.id} style={styles.checkItem}>
                <Text style={styles.metaValue}>{item.title}</Text>
                {status === 'work' ? (
                  <>
                    <View accessibilityRole="radiogroup" accessibilityLabel={item.title} style={styles.outcomes}>
                      {Object.entries(CHECKLIST_OUTCOMES).map(([value, label]) => (
                        <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: item.status === value, disabled: busy }}
                          disabled={busy} onPress={() => editChecklist(item.id, { status: value })}
                          style={[styles.outcomeOption, item.status === value && styles.outcomeOptionSelected]}>
                          <Text style={[styles.outcomeText, item.status === value && styles.outcomeTextSelected]}>{label}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <TextInput accessibilityLabel={`Комментарий к пункту «${item.title}»`} placeholder="Комментарий"
                      placeholderTextColor={palette.muted} editable={!busy} multiline maxLength={1000}
                      style={[styles.input, styles.commentInput]} value={item.comment ?? ''}
                      onChangeText={comment => editChecklist(item.id, { comment })} />
                    {onUploadPhoto && <EmployeeCamera kind="checklist" checklistId={item.id}
                      onLocate={onLocate} disabled={busy} onUpload={fields => onUploadPhoto(task.id, fields)} />}
                  </>
                ) : (
                  <>
                    <Text style={styles.body}>{CHECKLIST_OUTCOMES[item.status] || 'Без отметки'}</Text>
                    {item.comment ? <Text style={styles.body}>{item.comment}</Text> : null}
                  </>
                )}
              </View>
            ))}
            {onUploadPhoto && <TaskPhotoGallery taskId={task.id} request={request} imageSource={imageSource}
              kinds={['checklist']} checklist={checklist} revision={galleryRevision} />}
          </View>
        ) : !checklist && ['work', 'paused', 'review', 'done'].includes(status) ? (
          <View style={styles.card}>
            <SectionHeading icon="clipboard">Чек-лист работ</SectionHeading>
            <Text style={styles.body}>{checkedCount} из {checks.length} выполнено</Text>
            {DEFAULT_CHECKLIST_TITLES.map((label, index) => (
              <Pressable
                key={label}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: checks[index], disabled: busy || status !== 'work' }}
                disabled={busy || status !== 'work'}
                onPress={() => toggleCheck(index)}
                style={styles.checkRow}
              >
                <View style={[styles.checkbox, checks[index] && styles.checkboxSelected]}>
                  {checks[index] ? <Icon name="check" color={palette.paper} size={16} /> : null}
                </View>
                <Text style={styles.checkText}>{label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {status === 'work' && checklist ? (
          <View style={styles.card}>
            <SectionHeading icon="check">Итог выезда</SectionHeading>
            {RESULT_FIELDS.map(([key, label, limit]) => (
              <View key={key} style={styles.metaItem}>
                <Text style={styles.metaValue}>{label}</Text>
                <TextInput
                  accessibilityLabel={label}
                  placeholder={key === 'work' ? 'Кратко опишите выполненные работы' : 'Если применимо'}
                  placeholderTextColor={palette.muted}
                  editable={!busy && !locating}
                  value={outcome[key] ?? ''}
                  onChangeText={value => setOutcomeDraft(current => ({ ...(current ?? outcome), [key]: value }))}
                  maxLength={limit}
                  multiline
                  style={[styles.input, styles.commentInput]}
                />
              </View>
            ))}
            <Action secondary disabled={busy || locating || !(checklistDraft || outcomeDraft)} onPress={saveDraft}>
              Сохранить черновик
            </Action>
          </View>
        ) : status === 'work' ? (
          <View style={styles.card}>
            <SectionHeading icon="check">Результат работы</SectionHeading>
            <TextInput
              accessibilityLabel="Результат работы"
              placeholder="Опишите, что сделали и что проверили"
              placeholderTextColor={palette.muted}
              editable={!busy && !locating}
              value={result}
              onChangeText={setResult}
              maxLength={2000}
              multiline
              style={[styles.input, styles.resultInput]}
            />
          </View>
        ) : null}

        {status !== 'work' && task.result ? (
          <View style={styles.card}>
            <SectionHeading icon="check">Результат работы</SectionHeading>
            <Text style={styles.body}>{task.result}</Text>
          </View>
        ) : null}

        {reportLocked ? (
          <View style={styles.card}>
            <SectionHeading icon="check">{status === 'review' ? 'Отчёт отправлен' : 'Работа принята'}</SectionHeading>
            <Text style={styles.body}>
              {status === 'review' ? 'Диспетчер проверит отчёт и примет работу или вернёт её на доработку.' : 'Результат проверен и принят.'}
            </Text>
          </View>
        ) : null}

        {task.history?.length ? (
          <View style={styles.card}>
            <SectionHeading icon="clock">История задания</SectionHeading>
            {[...task.history].reverse().map((event, index) => (
              <View key={`${event.createdAt}-${index}`} style={styles.event}>
                <View style={styles.eventRail}>
                  <View style={[styles.eventDot, index === 0 && styles.eventDotCurrent]} />
                  {index < task.history.length - 1 && <View style={styles.eventLine} />}
                </View>
                <View style={styles.eventCopy}>
                  <Text style={styles.metaValue}>{stageLabels[event.status] ?? event.status}</Text>
                  <Text style={styles.body}>
                    {[event.createdAt ? formatTime(event.createdAt) : '', event.actorName].filter(Boolean).join(' · ')}
                  </Text>
                  {event.reason ? <Text style={styles.body}>{event.reason}</Text> : null}
                  {event.position ? (
                  <Text style={styles.body}>
                    Координаты · {event.position.latitude.toFixed(5)}, {event.position.longitude.toFixed(5)}
                  </Text>
                ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {reportOpen && <FieldReport task={task} request={request} imageSource={imageSource}
        revision={galleryRevision} onClose={() => setReportOpen(false)} />}

      {status === 'assigned' && refusing ? (
        <View style={styles.footer}>
          <TextInput accessibilityLabel="Причина отказа" placeholder="Укажите причину отказа"
            placeholderTextColor={palette.muted} editable={!busy} multiline maxLength={1000}
            style={[styles.input, styles.commentInput]} value={refusalReason} onChangeText={setRefusalReason} />
          <Action disabled={busy || !refusalReason.trim()} onPress={refuse}>Подтвердить отказ</Action>
          <Action secondary disabled={busy} onPress={() => setRefusing(false)}>Назад</Action>
        </View>
      ) : primaryAction ? (
        <View style={styles.footer}>
          {actionHint ? <Text style={styles.footerHint}>{actionHint}</Text> : null}
          <Action disabled={actionDisabled} onPress={() => advance()}>
            {busy ? 'Сохраняем…' : locating ? 'Определяем местоположение…' : primaryAction[0]}
          </Action>
          {status === 'assigned' && canRefuseTask ? (
            <Action secondary disabled={busy || locating} onPress={() => setRefusing(true)}>Отказаться от заявки</Action>
          ) : null}
          {status === 'rework' ? (
            <Action secondary disabled={busy || locating} onPress={() => advance('travel')}>Выехать на доработку</Action>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.canvas },
  navigation: { minHeight: 46, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: palette.canvas },
  back: { flexBasis: 82, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 3 },
  backText: { color: palette.ink, fontWeight: '500', fontSize: 14 },
  navigationTitle: { flex: 1, textAlign: 'center', color: palette.ink, fontSize: 14, fontWeight: '600' },
  navigationSpacer: { flexBasis: 82 },
  content: { gap: 11, padding: 16, paddingTop: 5, paddingBottom: 20 },
  hero: { padding: 16, backgroundColor: palette.paper, borderRadius: 16, gap: 12 },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  eyebrow: { color: palette.muted, fontWeight: '500', fontSize: 12 },
  badge: { color: palette.accent, backgroundColor: palette.accentSoft, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, fontWeight: '600', fontSize: 11 },
  overdueBadge: { color: '#ED5267', backgroundColor: '#FFF0F2' },
  title: { color: palette.ink, fontWeight: '700', fontSize: 23, lineHeight: 29, letterSpacing: -0.45 },
  metadata: { gap: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  metaLabel: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  metaItem: { gap: 2 },
  metaValue: { color: palette.ink, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  progressGroup: { gap: 7, paddingTop: 3 },
  progress: { flexDirection: 'row', gap: 3 },
  progressBar: { flex: 1, height: 4, borderRadius: 3, backgroundColor: palette.line },
  progressFilled: { backgroundColor: palette.accent },
  progressText: { color: palette.muted, fontSize: 11 },
  card: { padding: 14, borderRadius: 15, gap: 9, backgroundColor: palette.paper },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 2 },
  sectionIcon: { height: 34, width: 34, borderRadius: 10, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' },
  heading: { flex: 1, fontSize: 15, fontWeight: '600', color: palette.ink },
  body: { fontSize: 13, color: palette.muted, lineHeight: 19 },
  input: { minHeight: 46, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.canvas, borderRadius: 10, paddingHorizontal: 12, color: palette.ink, fontSize: 14 },
  resultInput: { minHeight: 96, paddingVertical: 11, textAlignVertical: 'top' },
  event: { flexDirection: 'row', gap: 10, minHeight: 59 },
  eventRail: { width: 18, alignItems: 'center', paddingTop: 4 },
  eventDot: { height: 10, width: 10, borderRadius: 5, backgroundColor: '#B7D9FF' },
  eventDotCurrent: { height: 12, width: 12, borderRadius: 6, backgroundColor: palette.accent },
  eventLine: { flex: 1, width: 1.5, backgroundColor: '#CDE4FF', marginTop: 5 },
  eventCopy: { flex: 1, gap: 2, paddingBottom: 10 },
  photoState: { fontSize: 13, color: palette.ink, fontWeight: '500', marginTop: 4 },
  footer: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, gap: 6, backgroundColor: palette.paper, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  footerHint: { color: palette.muted, fontSize: 12, textAlign: 'center' },
  action: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, justifyContent: 'center', alignItems: 'center', backgroundColor: palette.accent, borderRadius: 11 },
  actionText: { color: palette.paper, fontWeight: '600', fontSize: 15, textAlign: 'center' },
  secondary: { minHeight: 44, backgroundColor: palette.accentSoft },
  secondaryText: { color: palette.accent, fontSize: 13 },
  pressed: { opacity: 0.8 },
  disabled: { backgroundColor: '#EAF0F8' },
  disabledText: { color: palette.muted },
  checkRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  checkbox: { width: 22, height: 22, borderWidth: 1, borderColor: '#BED1EA', borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { borderColor: palette.accent, backgroundColor: palette.accent },
  checkText: { flex: 1, color: palette.ink, fontSize: 13, lineHeight: 18 },
  checkItem: { gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  outcomes: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  outcomeOption: { paddingHorizontal: 10, minHeight: 44, justifyContent: 'center', borderRadius: 10, backgroundColor: palette.canvas },
  outcomeOptionSelected: { backgroundColor: palette.accent },
  outcomeText: { fontSize: 12, color: palette.ink, fontWeight: '500' },
  outcomeTextSelected: { color: palette.paper },
  commentInput: { minHeight: 60, paddingVertical: 9, textAlignVertical: 'top' },
});
