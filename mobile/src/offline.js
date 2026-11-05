import AsyncStorage from '@react-native-async-storage/async-storage';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

const openStores = new Map();
const version = 1;
const leaveQueueKey = '@urgent-leave';

function replaceTask(tasks, task) {
  if (!task) return tasks;
  const previous = tasks.find(row => row.id === task.id);
  if (previous && previous.revision > task.revision) return tasks;
  return previous ? tasks.map(row => row.id === task.id ? task : row) : [task, ...tasks];
}

function optimisticTasks(state) {
  const byId = new Map(state.tasks.map(task => [task.id, task]));
  const blocked = new Set();
  for (const event of state.queue) {
    if (event.issue) blocked.add(event.taskId);
    const task = byId.get(event.taskId);
    if (!task || blocked.has(event.taskId) || task.revision !== event.body.expectedRevision) continue;
    const { status, checks, checklist, arrival, result, outcome, position } = event.body;
    const optimistic = { ...task, revision: task.revision + 1, offlinePending: true };
    if (event.kind === 'photo') {
      const { kind, pairKey = 'main' } = event.body;
      if (kind === 'before' || kind === 'after') {
        if (pairKey === 'main') optimistic.photos = { ...task.photos, [kind]: 1 };
        if (task.photoPairs) {
          optimistic.photoPairs = task.photoPairs.map(pair => pair.key === pairKey ? { ...pair, [kind]: true } : pair);
        }
      }
    } else {
      if (status !== undefined) optimistic.status = status;
      if (task.status === 'rework' && status === 'travel') optimistic.arrival = null;
      if (checks !== undefined) optimistic.checks = checks;
      if (checklist !== undefined) optimistic.checklist = checklist;
      if (arrival !== undefined) optimistic.arrival = arrival;
      if (result !== undefined) optimistic.result = result;
      if (outcome !== undefined) {
        optimistic.outcome = outcome;
        if (typeof outcome.work === 'string') optimistic.result = outcome.work;
      }
      if (status !== undefined && status !== task.status) {
        optimistic.history = [...(task.history ?? []), {
          status, createdAt: event.occurredAt, receivedAt: null,
          position: position ?? (arrival?.latitude != null ? arrival : null),
          reason: arrival?.reason,
        }];
      }
    }
    byId.set(task.id, optimistic);
  }
  return [...byId.values()];
}

function isPermanent(error) {
  const { status } = error;
  return status >= 400 && status < 500 && ![401, 408, 425, 429].includes(status);
}

function isReplaceablePhoto(event) {
  return event.kind === 'photo' && event.issue && !event.issue.conflict && event.issue.replaceable !== false;
}

function safeDelete(file) {
  try {
    if (file.exists) file.delete();
  } catch {
    // The event is already durable or acknowledged. Do not undo it on cleanup failure.
  }
}

async function loadStore(scope) {
  const key = `qwork.offline.v${version}.${scope}`;
  const folder = new Directory(Paths.document, 'qwork-offline', scope);
  const stored = await AsyncStorage.getItem(key);
  let state = stored ? JSON.parse(stored) : { tasks: [], queue: [] };
  if (!Array.isArray(state.tasks) || !Array.isArray(state.queue)) {
    throw new Error('Локальные данные qwork недоступны.');
  }
  let writes = Promise.resolve();
  let flushing = null;
  const photoName = event => `${event.eventId}.${event.photoExtension === 'png' ? 'png' : 'jpg'}`;
  const photo = event => new File(folder, photoName(event));

  // File writes happen before queue commits. An app interruption may leave only an orphan file.
  if (folder.exists) {
    const retained = new Set(state.queue.filter(row => row.kind === 'photo').map(photoName));
    try {
      for (const item of folder.list()) {
        if (item instanceof File && !retained.has(item.name)) safeDelete(item);
      }
    } catch {
      // Retain orphan files if the directory cannot be inspected.
    }
  }

  function serialized(operation) {
    const next = writes.then(operation);
    writes = next.catch(() => {});
    return next;
  }

  async function commit(next) {
    await AsyncStorage.setItem(key, JSON.stringify(next));
    state = next;
  }

  async function savePhoto(event) {
    const { body } = event;
    if (typeof body.imageBase64 !== 'string' || !body.imageBase64.length) {
      throw new Error('Фотография недоступна.');
    }
    // Expo may supply either format, so choose the suffix from the file signature.
    event.photoExtension = body.imageBase64.startsWith('iVBORw0KGgo') ? 'png' : 'jpg';
    folder.create({ intermediates: true, idempotent: true });
    const file = photo(event);
    try {
      file.create();
      await file.write(body.imageBase64, { encoding: 'base64' });
      delete body.imageBase64;
      return file;
    } catch (error) {
      safeDelete(file);
      throw error;
    }
  }

  function snapshot() {
    const issues = state.queue.filter(row => row.issue).map(row => ({
      eventId: row.eventId, taskId: row.taskId, kind: row.kind,
      taskTitle: state.tasks.find(task => task.id === row.taskId)?.title,
      ...row.issue,
      replaceable: Boolean(isReplaceablePhoto(row)),
      photoKind: row.kind === 'photo' ? row.body.kind : undefined,
      pairKey: row.body.pairKey,
      checklistId: row.body.checklistId,
    }));
    return { tasks: optimisticTasks(state), pending: state.queue.length, issues,
      urgentLeavePending: state.queue.some(row => row.kind === 'urgent_leave' && !row.issue) };
  }

  function saveTasks(tasks) {
    return serialized(async () => {
      const previous = new Map(state.tasks.map(task => [task.id, task]));
      const latest = tasks.map(task => previous.get(task.id)?.revision > task.revision ? previous.get(task.id) : task);
      if (JSON.stringify(latest) !== JSON.stringify(state.tasks)) {
        await commit({ ...state, tasks: latest });
      }
      return snapshot();
    });
  }

  function enqueue(taskId, kind, input, occurredAt = new Date().toISOString()) {
    return serialized(async () => {
      if (state.queue.some(row => row.kind === 'urgent_leave' && !row.issue)) {
        throw new Error('Срочный уход ожидает отправки. Дождитесь синхронизации.');
      }
      if (state.queue.some(row => row.taskId === taskId && row.issue)) {
        throw new Error('Сначала разберите изменения, которые не удалось отправить для этой заявки.');
      }
      const task = optimisticTasks(state).find(row => row.id === taskId);
      if (!task || !Number.isSafeInteger(task.revision)) {
        throw new Error('Обновите заявку перед изменением.');
      }
      if (['cancelled', 'done', 'repeated'].includes(task.status)) {
        throw new Error('Эта заявка уже закрыта.');
      }
      const eventId = randomUUID();
      const body = { ...input, expectedRevision: task.revision };
      const event = { eventId, taskId, occurredAt, kind, body };
      let file;
      try {
        if (kind === 'photo') file = await savePhoto(event);
        await commit({ ...state, queue: [...state.queue, event] });
      } catch (error) {
        if (file) safeDelete(file);
        throw error;
      }
      return snapshot();
    });
  }

  function replacePhoto(taskId, eventId, input) {
    return serialized(async () => {
      const previous = state.queue.find(row => row.taskId === taskId && row.eventId === eventId);
      if (!previous || !isReplaceablePhoto(previous) || !state.tasks.some(task => task.id === taskId)) {
        throw new Error('Этот снимок уже недоступен для замены.');
      }
      const { imageBase64, capturedAt, latitude, longitude, accuracy } = input;
      const body = { ...previous.body, imageBase64, capturedAt, latitude, longitude, accuracy };
      // Retain the queued action's time and revision. The replacement has its own capture time and ID.
      const event = { taskId, kind: 'photo', eventId: randomUUID(), occurredAt: previous.occurredAt, body };
      const file = await savePhoto(event);
      try {
        await commit({ ...state, queue: state.queue.map(row => row === previous ? event : row) });
      } catch (error) {
        safeDelete(file);
        throw error;
      }
      safeDelete(photo(previous));
      return snapshot();
    });
  }

  function enqueueUrgentLeave(input) {
    return serialized(async () => {
      if (state.queue.some(row => row.kind === 'urgent_leave')) {
        throw new Error('Срочный уход уже находится в очереди.');
      }
      const event = { eventId: randomUUID(), taskId: leaveQueueKey, kind: 'urgent_leave',
        occurredAt: new Date().toISOString(), body: { ...input } };
      await commit({ ...state, queue: [...state.queue, event] });
      return snapshot();
    });
  }

  function pendingPhotos(taskId) {
    return state.queue.filter(row => row.taskId === taskId && row.kind === 'photo').map(row => ({
      id: row.eventId, kind: row.body.kind, localUri: photo(row).uri, pending: true,
      caption: row.body.caption, capturedAt: row.body.capturedAt ?? row.occurredAt,
      pairKey: row.body.pairKey ?? 'main', checklistId: row.body.checklistId,
      latitude: row.body.latitude, longitude: row.body.longitude, accuracy: row.body.accuracy,
      issue: row.issue?.message,
    }));
  }

  function discardTask(taskId) {
    return serialized(async () => {
      const discard = state.queue.filter(row => row.taskId === taskId);
      if (!discard.some(row => row.issue)) return snapshot();
      await commit({ ...state, queue: state.queue.filter(row => row.taskId !== taskId) });
      for (const row of discard) {
        if (row.kind === 'photo') safeDelete(photo(row));
      }
      return snapshot();
    });
  }

  async function applyResult(event, response, issue) {
    return serialized(async () => {
      const tasks = response?.taskRemoved ? state.tasks.filter(task => task.id !== event.taskId)
        : replaceTask(state.tasks, response?.task);
      const queue = issue
        ? state.queue.map(row => row.eventId === event.eventId ? { ...row, issue } : row)
        : state.queue.filter(row => row.eventId !== event.eventId);
      await commit({ tasks, queue });
      if (!issue && event.kind === 'photo') safeDelete(photo(event));
      return snapshot();
    });
  }

  async function sendAll(request, onChange, shouldContinue) {
    while (shouldContinue()) {
      const blocked = new Set(state.queue.filter(row => row.issue).map(row => row.taskId));
      const event = state.queue.find(row => !blocked.has(row.taskId));
      if (!event) break;
      const body = { ...event.body };
      if (event.kind === 'photo') {
        try {
          body.imageBase64 = await photo(event).base64();
          if (!body.imageBase64) throw new Error('Файл фотографии пуст.');
        } catch {
          const next = await applyResult(event, null, {
            message: 'Файл фотографии недоступен. Сделайте снимок ещё раз.', replaceable: true,
          });
          onChange?.(next);
          continue;
        }
      }
      if (!shouldContinue()) break;
      let response;
      let issue;
      try {
        const leave = event.kind === 'urgent_leave';
        response = await request(leave ? '/incidents' : '/sync/events', {
          method: 'POST',
          body: leave ? { ...body, kind: 'urgent_leave', eventId: event.eventId, occurredAt: event.occurredAt }
            : { eventId: event.eventId, taskId: event.taskId, kind: event.kind, occurredAt: event.occurredAt, body },
          timeout: event.kind === 'photo' ? 60000 : 10000,
        });
        if (response.conflict) {
          const conflict = response.conflict;
          issue = {
            conflict,
            message: conflict.message || conflict.reason || 'Действие передано руководителю для проверки.',
          };
        } else if (leave ? !response.incident : !response.task && !response.taskRemoved && !response.duplicate) {
          // Retrying the same ID can recover if the response was incomplete.
          throw new Error('Сервер не подтвердил синхронизацию.');
        }
      } catch (error) {
        if (!isPermanent(error)) throw error;
        issue = {
          message: error.message || 'Сервер отклонил изменение.',
          replaceable: error.code === 'photo_replaceable' || error.status === 413,
        };
      }
      const next = await applyResult(event, response, issue);
      onChange?.(next);
    }
    return snapshot();
  }

  function flush(request, onChange, shouldContinue = () => true) {
    if (flushing) return flushing;
    flushing = sendAll(request, onChange, shouldContinue).finally(() => { flushing = null; });
    return flushing;
  }

  return { snapshot, saveTasks, enqueue, replacePhoto, enqueueUrgentLeave, pendingPhotos, discardTask, flush };
}

export async function openOffline(session) {
  const origin = (process.env.EXPO_PUBLIC_QWORK_API_URL ?? '').trim().replace(/\/+$/, '');
  const scope = await digestStringAsync(CryptoDigestAlgorithm.SHA256,
    JSON.stringify([origin, session.company.code, session.user.id]));
  if (!openStores.has(scope)) {
    openStores.set(scope, loadStore(scope).catch(error => {
      openStores.delete(scope);
      throw error;
    }));
  }
  return openStores.get(scope);
}
