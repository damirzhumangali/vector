import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, BackHandler, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useLinkingURL } from 'expo-linking';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AuthScreens from './src/AuthScreens';
import OfficeScreens from './src/OfficeScreens';
import EmployeeDashboard from './src/EmployeeDashboard';
import EmailSettings from './src/EmailSettings';
import { colors as c, Icon } from './src/ui';
import { EmployeeShiftPanel, EmployeeShiftReminder } from './src/ShiftScreens';
import { EmployeeTrips } from './src/FieldOperations';
import { updateShiftReminders } from './src/shiftReminders';
import { WorkScreens } from './src/WorkScreens';
import { apiImageSource, apiOrigin, apiRequest } from './src/api';
import { openOffline } from './src/offline';
import { openOfflineMedia } from './src/offlineMedia';
import { createCompanyLink, createEmployeeInvite, parseCompanyLink, parseEmployeeInvite } from './src/companyLink';
import QuickAccess, { clearQuickAccess, readQuickAccess } from './src/QuickAccess';

const STORAGE_KEY = 'qwork.tasks.v1';
const INVITATION_KEY = 'qwork.company-link.v1';

async function locateArrival() {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) throw new Error('Разрешите доступ к геопозиции или отметьте прибытие вручную.');
  if (!(await Location.hasServicesEnabledAsync())) throw new Error('Включите геолокацию на телефоне или отметьте прибытие вручную.');
  let timeout;
  try {
    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Не удалось определить геопозицию за 20 секунд. Попробуйте ещё раз или отметьте прибытие вручную.')), 20000);
      }),
    ]);
    const { latitude, longitude, accuracy } = position.coords;
    return { latitude, longitude, accuracy, capturedAt: new Date(position.timestamp).toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}
const roles = [
  ['employee', 'Задачи', 'Сотрудник', '▤'],
  ['dispatcher', 'Диспетчер', 'Диспетчер', '⊞'],
  ['manager', 'Приёмка', 'Руководитель', '✓'],
];
const labels = {
  assigned: 'Назначена',
  accepted: 'Принята',
  travel: 'В пути',
  arrived: 'На объекте',
  work: 'В работе',
  review: 'На проверке',
  done: 'Работа принята',
  rework: 'На доработке',
  paused: 'Приостановлена',
  cancelled: 'Отменена',
  repeated: 'Назначен повторный выезд',
};
const initialTasks = [
  {
    id: '1042',
    title: 'Плановое обслуживание вентиляции',
    object: 'БЦ «Астана Тауэр»',
    address: 'проспект Кабанбай батыра, 17',
    status: 'work',
    checks: [true, true, false, false, false],
    photos: { before: 1, after: 0 },
  },
  {
    id: '1043',
    title: 'Проверить систему освещения',
    object: 'ЖК «Зелёный квартал»',
    address: 'ул. Е-10, 17',
    status: 'assigned',
    checks: [false, false, false, false, false],
    photos: { before: 0, after: 0 },
  },
  {
    id: '1038',
    title: 'Замена фильтров кондиционера',
    object: 'Музей энергии',
    address: 'проспект Мангилик Ел, 55',
    status: 'review',
    checks: [true, true, true, true, true],
    photos: { before: 1, after: 1 },
  },
];

function EmployeeHome({ tasks, onSelect }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const active = tasks.filter(task => !['review', 'done', 'cancelled', 'repeated'].includes(task.status));
  const candidates = filter === 'active' ? active : filter === 'review' ? tasks.filter(task => task.status === 'review') : tasks;
  const visible = candidates.filter(task => [task.title, task.object, task.id].some(value => String(value).toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU'))));
  const review = tasks.filter(task => task.status === 'review').length;
  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <View style={styles.pageIntro}>
        <Text accessibilityRole="header" style={styles.pageTitle}>Мои задачи</Text>
        <Text style={styles.muted}>Назначения и результаты выездных работ</Text>
      </View>
      <View style={styles.filters}>
        {[['all', 'Все'], ['active', 'В работе'], ['review', 'На проверке']].map(([key, label]) => (
          <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: key === filter }}
            onPress={() => setFilter(key)} style={[styles.filter, key === filter && styles.filterSelected]}>
            <Text style={[styles.filterText, key === filter && styles.filterSelectedText]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.search}>
        <Icon name="search" color={c.muted} size={19} />
        <TextInput accessibilityLabel="Поиск по задачам" value={query} onChangeText={setQuery} placeholder="Поиск по задачам"
          placeholderTextColor={c.muted} style={styles.searchInput} autoCorrect={false} />
        {query !== '' && <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Очистить поиск"><Icon name="close" color={c.muted} size={18} /></Pressable>}
      </View>
      <View style={styles.stats}>
        {[[tasks.length, 'Всего', 'clipboard', c.blue], [active.length, 'В работе', 'clock', c.orange], [review, 'Проверка', 'check', c.green]].map(([value, label, icon, color]) => (
          <View key={label} style={styles.stat}><View style={[styles.statIcon, {backgroundColor: color + '12'}]}><Icon name={icon} color={color} size={20} /></View>
            <View><Text style={styles.statLabel}>{label}</Text><Text style={styles.statValue}>{value}</Text></View></View>
        ))}
      </View>
      {visible.length === 0 && <View style={styles.empty}><Icon name="clipboard" size={35} color={c.muted} /><Text style={styles.taskTitle}>{query ? 'Ничего не найдено' : 'Заданий пока нет'}</Text><Text style={styles.muted}>Здесь появятся назначенные вам работы.</Text></View>}
      {visible.map(task => {
        const tone = task.overdue || task.status === 'rework' ? c.red : task.status === 'done' ? c.green : task.status === 'review' ? c.orange : c.blue;
        return (
          <Pressable key={task.id} accessibilityRole="button" onPress={() => onSelect(task.id)}
            accessibilityLabel={`Заявка ${task.id}, ${task.title}, ${labels[task.status] || task.status}`}
            style={({ pressed }) => [styles.task, pressed && styles.pressed]}>
            <View style={styles.taskTop}><Text style={styles.taskNumber}>№{task.id}</Text>
              <Text style={[styles.status, {color:tone, backgroundColor:tone+'12'}]}>{task.overdue ? 'Просрочена' : labels[task.status] || task.status}</Text>
            </View>
            <View style={styles.taskRow}><View style={styles.taskCopy}>
              <Text style={styles.taskTitle}>{task.title}</Text>
              <View style={styles.infoRow}><Icon name="pin" size={14} color={c.muted} /><Text style={styles.muted}>{task.object}</Text></View>
              {task.deadline && <View style={styles.infoRow}><Icon name="calendar" size={14} color={c.muted} /><Text style={styles.smallText}>До {new Date(task.deadline).toLocaleString('ru-RU', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</Text></View>}
            </View><Icon name="chevron-right" color={c.muted} size={18} /></View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Profile({ session, role, onSignOut, onDemoRole, onTasks, onShifts, onQuickAccess, request }) {
  const name = session?.user.name ?? roles.find(([key]) => key === role)?.[2] ?? 'qwork';
  const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.pageIntro}><Text style={styles.pageTitle}>Мой профиль</Text><Text style={styles.muted}>Рабочее пространство и доступ</Text></View>
      <View style={styles.profileIdentity}>
        <View style={styles.profileAvatar}><Text style={styles.profileInitials}>{initials}</Text></View>
        <Text style={styles.profileName}>{name}</Text>
        <Text style={styles.muted}>{session?.company.name ?? 'Демонстрация qwork'}</Text>
        <View style={styles.profileBadge}><Text style={styles.profileBadgeText}>{roles.find(([key]) => key === role)?.[2]}</Text></View>
      </View>
      <View style={styles.profileMenu}>
        {[[role === 'employee' ? 'Мои задачи' : 'Работы компании', 'clipboard', onTasks],
          ...(role === 'employee' ? [['Рабочее время', 'clock', onShifts]] : [])].map(([label, icon, onPress]) => (
          <Pressable key={label} onPress={onPress} accessibilityRole="button" style={styles.profileRow}>
            <View style={styles.profileIcon}><Icon name={icon} size={20} /></View><Text style={styles.profileRowLabel}>{label}</Text><Icon name="chevron-right" size={18} color={c.muted} />
          </Pressable>
        ))}
        {session && <View style={styles.profileRow}><View style={styles.profileIcon}><Icon name="user" size={20} /></View><View style={styles.taskCopy}><Text style={styles.smallText}>Логин</Text><Text selectable style={styles.profileRowLabel}>{session.user.login}</Text></View></View>}
        {session?.user.department ? <View style={styles.profileRow}><View style={styles.profileIcon}><Icon name="building" size={20} /></View><View style={styles.taskCopy}><Text style={styles.smallText}>Подразделение</Text><Text style={styles.profileRowLabel}>{session.user.department}</Text></View></View> : null}
        {session && <Pressable accessibilityRole="button" accessibilityLabel="Настроить быстрый вход" onPress={onQuickAccess} style={styles.profileRow}>
          <View style={styles.profileIcon}><Icon name="shield" size={20} /></View>
          <View style={styles.taskCopy}><Text style={styles.profileRowLabel}>Быстрый вход</Text><Text style={styles.smallText}>Настроить вход на этом телефоне</Text></View>
          <Icon name="chevron-right" size={18} color={c.muted} />
        </Pressable>}
      </View>
      {session && <EmailSettings user={session.user} request={request} />}
      {!session && <View style={styles.profileMenu}><Text style={styles.demoCaption}>ПОСМОТРЕТЬ ДРУГУЮ РОЛЬ</Text>{roles.map(([key,, label]) => (
        <Pressable key={key} accessibilityRole="button" onPress={() => onDemoRole(key)} style={styles.profileRow}><Text style={styles.profileRowLabel}>{label}</Text><Icon name={role === key ? 'check' : 'chevron-right'} size={18} /></Pressable>
      ))}</View>}
      <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.signOut}>
        <Icon name="logout" color={c.red} size={20} /><Text style={styles.signOutText}>Выйти из аккаунта</Text>
      </Pressable>
    </ScrollView>
  );
}

function Workspace() {
  const [role, setRole] = useState(null);
  const [demoTasks, setDemoTasks] = useState(null);
  const [session, setSession] = useState(null);
  const [setupSession, setSetupSession] = useState(null);
  const [savedQuickAccess, setSavedQuickAccess] = useState(undefined);
  const [savedInvitation, setSavedInvitation] = useState('');
  const [incomingInvitation, setIncomingInvitation] = useState('');
  const openedUrl = useLinkingURL();
  const [serverTasks, setServerTasks] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [objects, setObjects] = useState([]);
  const [networkError, setNetworkError] = useState('');
  const [savingTask, setSavingTask] = useState(false);
  const [showShifts, setShowShifts] = useState(false);
  const [page, setPage] = useState('home');
  const [navigationId, setNavigationId] = useState(0);
  const [offlineMode, setOfflineMode] = useState(false);
  const [offlineSnapshot, setOfflineSnapshot] = useState(null);
  const [materialsReady, setMaterialsReady] = useState(false);
  const offlineModeRef = useRef(false);
  const offlineRef = useRef(null);
  const offlineMediaRef = useRef(null);
  const refreshRef = useRef(null);
  const sessionRef = useRef(null);
  const revision = useRef(0);
  const savingTaskRef = useRef(false);
  const [selectedId, setSelectedId] = useState(null);
  const [storageError, setStorageError] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const request = useCallback((path, options) => {
    const token = sessionRef.current?.token;
    if (!token) return Promise.reject(new Error('Войдите в аккаунт ещё раз.'));
    return apiRequest(path, { ...options, token });
  }, []);
  const imageSource = useCallback(path => apiImageSource(path, session?.token), [session?.token]);
  const onShifts = useCallback(shifts => {
    if (session?.user.role !== 'employee') return;
    void updateShiftReminders(shifts, () => sessionRef.current === session).catch(() => {});
  }, [session]);
  const refreshWork = useCallback(() => { void refreshRef.current?.(); }, []);
  const employeeGallery = useCallback(async path => {
    const taskId = /^\/tasks\/(\d+)\/photos$/.exec(path)?.[1];
    if (!taskId) return request(path);
    const pending = () => offlineRef.current?.pendingPhotos(taskId) ?? [];
    const cached = await offlineMediaRef.current?.gallery(taskId);
    if (offlineModeRef.current) return { photos: [...(cached ?? []), ...pending()] };
    try {
      const { photos } = await request(path, { timeout: 4000 });
      const files = new Map((cached ?? []).map(photo => [photo.id, photo.localUri]));
      return { photos: [...photos.map(photo => ({ ...photo, localUri: files.get(photo.id) })), ...pending()] };
    } catch (error) {
      if (!error.network) throw error;
      if (!cached && !pending().length) throw error;
      return { photos: [...(cached ?? []), ...pending()] };
    }
  }, [request]);

  useEffect(() => {
    let mounted = true;
    readQuickAccess()
      .then(saved => { if (mounted) setSavedQuickAccess(saved); })
      .catch(() => { if (mounted) setSavedQuickAccess(null); });
    AsyncStorage.getItem(INVITATION_KEY)
      .then(url => { if (mounted && parseCompanyLink(url)) setSavedInvitation(url); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (parseEmployeeInvite(openedUrl) || parseCompanyLink(openedUrl)) setIncomingInvitation(openedUrl);
  }, [openedUrl]);

  useEffect(() => {
    let mounted = true;
    async function loadTasks() {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        const savedTasks = stored ? JSON.parse(stored) : initialTasks;
        if (!Array.isArray(savedTasks)) throw new Error('Invalid task list');
        if (mounted) setDemoTasks(savedTasks);
      } catch {
        if (mounted) {
          setStorageAvailable(false);
          setStorageError(true);
          setDemoTasks(initialTasks);
        }
      }
    }
    loadTasks();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (demoTasks === null || !storageAvailable) return;
    let current = true;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(demoTasks))
      .then(() => { if (current) setStorageError(false); })
      .catch(() => { if (current) setStorageError(true); });
    return () => { current = false; };
  }, [demoTasks, storageAvailable]);

  useEffect(() => {
    if (selectedId === null && page === 'home') return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectedId !== null) setSelectedId(null);
      else navigate('home');
      return true;
    });
    return () => back.remove();
  }, [selectedId, page]);

  useEffect(() => {
    if (!session) return;
    let running = false;
    let closed = false;
    let prefetching = false;
    const isEmployee = session.user.role === 'employee';
    const isCurrent = () => !closed && sessionRef.current === session;
    const canSync = () => isCurrent() && !offlineModeRef.current && AppState.currentState !== 'background';
    const scopedRequest = (path, options) => apiRequest(path, { ...options, token: session.token });
    const publish = snapshot => { if (isCurrent()) setOfflineSnapshot(snapshot); };
    const storePromise = isEmployee ? openOffline(session).then(store => {
      if (isCurrent()) {
        offlineRef.current = store;
        publish(store.snapshot());
      }
      return store;
    }) : null;
    const mediaPromise = isEmployee ? openOfflineMedia(
      `${apiOrigin}|${session.company.code}|${session.user.id}`, scopedRequest,
      path => apiImageSource(path, session.token),
    ).then(media => {
      if (isCurrent()) offlineMediaRef.current = media;
      return media;
    }).catch(() => null) : null;

    async function prefetch(tasks) {
      if (prefetching || !canSync()) return;
      prefetching = true;
      try {
        const media = await mediaPromise;
        if (!media) return;
        for (const task of tasks) {
          if (!canSync()) return;
          await media.prefetch(task);
        }
        if (canSync()) setMaterialsReady(true);
      } catch {
        if (isCurrent()) setMaterialsReady(false);
      } finally {
        prefetching = false;
      }
    }

    async function refresh() {
      if (!isCurrent() || running) return;
      running = true;
      const startedAt = revision.current;
      try {
        if (isEmployee) {
          const store = await storePromise;
          if (!canSync()) return;
          await store.flush(scopedRequest, publish, canSync);
          if (!canSync()) return;
          const { tasks } = await scopedRequest('/tasks', { timeout: 4000 });
          if (!canSync()) return;
          publish(await store.saveTasks(tasks));
          if (isCurrent()) setNetworkError('');
          void prefetch(tasks);
          return;
        }
        const [taskResult, teamResult] = await Promise.all([
          apiRequest('/tasks', { token: session.token }),
          session.user.role === 'dispatcher'
            ? apiRequest('/employees', { token: session.token })
            : null,
        ]);
        if (closed || sessionRef.current !== session || startedAt !== revision.current) return;
        setServerTasks(taskResult.tasks);
        if (teamResult) setEmployees(teamResult.employees);
        setNetworkError('');
      } catch (error) {
        if (!closed && sessionRef.current === session) {
          if (error.status === 401) {
            signOut();
            Alert.alert('Сеанс завершён', 'Войдите по ссылке компании с логином и паролем.');
          } else {
            setNetworkError(error.message);
          }
        }
      } finally {
        running = false;
      }
    }

    refreshRef.current = refresh;
    refresh();
    if (session.user.role === 'dispatcher') {
      apiRequest('/objects', { token: session.token })
        .then(data => {
          if (!closed && sessionRef.current === session) {
            setObjects(previous => [...data.objects, ...previous.filter(item => !data.objects.some(row => row.id === item.id))]);
          }
        })
        .catch(error => { if (!closed && sessionRef.current === session) setNetworkError(error.message); });
    }
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') refresh();
    }, 2500);
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => {
      closed = true;
      if (refreshRef.current === refresh) refreshRef.current = null;
      clearInterval(timer);
      foreground.remove();
    };
  }, [session]);

  function switchRole(nextRole) {
    setSelectedId(null);
    setShowShifts(false);
    setPage('home');
    setRole(nextRole);
  }

  function enter(nextSession) {
    sessionRef.current = nextSession;
    setServerTasks(null);
    setEmployees([]);
    setObjects([]);
    setNetworkError('');
    offlineRef.current = null;
    offlineMediaRef.current = null;
    offlineModeRef.current = false;
    setOfflineMode(false);
    setOfflineSnapshot(null);
    setMaterialsReady(false);
    setSession(nextSession);
    switchRole(nextSession.user.role);
  }

  function rememberCompany(nextSession) {
    const link = createCompanyLink(nextSession.company.code);
    if (link) {
      setSavedInvitation(link);
      AsyncStorage.setItem(INVITATION_KEY, link).catch(() => {});
    }
    setIncomingInvitation('');
  }

  async function authenticate(nextSession) {
    try {
      await clearQuickAccess();
    } catch {
      Alert.alert('Быстрый вход', 'Не удалось очистить настройки предыдущего аккаунта.');
    }
    setSavedQuickAccess(null);
    rememberCompany(nextSession);
    setSetupSession(nextSession);
  }

  async function finishSetup(nextSession) {
    setSavedQuickAccess(await readQuickAccess());
    setSetupSession(null);
    if (sessionRef.current !== nextSession) enter(nextSession);
  }

  async function unlock(nextSession) {
    try {
      await apiRequest('/tasks', { token: nextSession.token, timeout: 4000 });
    } catch (error) {
      if (error.network && nextSession.user.role === 'employee') {
        const store = await openOffline(nextSession);
        if (Array.isArray(store.snapshot().tasks)) {
          rememberCompany(nextSession);
          enter(nextSession);
          return;
        }
      }
      if (error.status !== 401) throw error;
      await clearQuickAccess();
      setSavedQuickAccess(null);
      Alert.alert('Сеанс завершён', 'Войдите с логином и паролем.');
      return;
    }
    rememberCompany(nextSession);
    enter(nextSession);
  }

  function signOut() {
    const previous = sessionRef.current;
    sessionRef.current = null;
    void updateShiftReminders([]).catch(() => {});
    offlineRef.current = null;
    offlineMediaRef.current = null;
    setOfflineSnapshot(null);
    setSavedQuickAccess(null);
    clearQuickAccess().catch(() => Alert.alert('Быстрый вход', 'Не удалось очистить настройки на устройстве.'));
    setSession(null);
    setServerTasks(null);
    setNetworkError('');
    switchRole(null);
    if (previous) apiRequest('/auth/logout', { method: 'POST', token: previous.token }).catch(() => {});
  }

  function applyServerTask(task, originalTask) {
    if (!task) return;
    revision.current += 1;
    setServerTasks(previous => {
      const rows = (previous ?? []).map(row => row.id === originalTask?.id ? originalTask : row);
      return rows.some(row => row.id === task.id)
        ? rows.map(row => row.id === task.id ? task : row)
        : [task, ...rows];
    });
  }

  async function saveServerTask(method, path, body, timeout) {
    const current = sessionRef.current;
    if (!current) throw new Error('Войдите в аккаунт ещё раз.');
    const { task, originalTask } = await apiRequest(path, { method, body, token: current.token, timeout });
    if (sessionRef.current !== current) return task;
    applyServerTask(task, originalTask);
    return task;
  }

  async function createObject(fields) {
    const current = sessionRef.current;
    const { object } = await request('/objects', { method: 'POST', body: fields });
    if (sessionRef.current === current) {
      setObjects(previous => previous.some(row => row.id === object.id) ? previous : [...previous, object]);
    }
    return object;
  }

  function uploadPhoto(taskId, fields) {
    if (sessionRef.current?.user.role === 'employee') return enqueue(taskId, 'photo', fields);
    return saveServerTask('POST', `/tasks/${encodeURIComponent(taskId)}/photos`, fields, 60000);
  }

  async function enqueue(id, kind, body, occurredAt) {
    const current = sessionRef.current;
    const store = offlineRef.current;
    if (!current || !store) throw new Error('Дождитесь загрузки заявок на телефон.');
    const snapshot = await store.enqueue(id, kind, body, occurredAt);
    if (sessionRef.current === current) {
      setOfflineSnapshot(snapshot);
      void refreshRef.current?.();
    }
    return snapshot.tasks?.find(task => task.id === id);
  }

  async function enqueueUrgentLeave(body) {
    const current = sessionRef.current;
    const store = offlineRef.current;
    if (!current || !store) throw new Error('Дождитесь загрузки локального хранилища.');
    const snapshot = await store.enqueueUrgentLeave(body);
    if (sessionRef.current === current) {
      setOfflineSnapshot(snapshot);
      void refreshRef.current?.();
    }
  }

  function toggleOffline() {
    offlineModeRef.current = !offlineModeRef.current;
    setOfflineMode(offlineModeRef.current);
    if (!offlineModeRef.current) void refreshRef.current?.();
  }

  function updateServerTask(id, fields) {
    const previous = serverTasks?.find(task => task.id === id);
    return saveServerTask('PATCH', `/tasks/${encodeURIComponent(id)}`, {
      ...fields,
      expectedRevision: previous?.revision,
    });
  }

  async function addEmployee(fields) {
    const current = sessionRef.current;
    if (!current) throw new Error('Войдите в аккаунт ещё раз.');
    const result = await apiRequest('/employees', { method: 'POST', body: fields, token: current.token });
    if (sessionRef.current === current) {
      revision.current += 1;
      setEmployees(previous => previous.some(employee => employee.id === result.employee.id)
        ? previous
        : [...previous, result.employee]);
    }
    return { ...result.employee, invitationUrl: createEmployeeInvite(result.inviteToken), password: result.temporaryPassword ?? fields.password };
  }

  async function renewInvite(id) {
    const current = sessionRef.current;
    const employee = employees.find(row => row.id === id);
    if (!current || !employee) throw new Error('Карточка сотрудника недоступна.');
    const { inviteToken } = await apiRequest(`/employees/${encodeURIComponent(id)}/invite`, {
      method: 'POST', token: current.token, body: {},
    });
    return { ...employee, invitationUrl: createEmployeeInvite(inviteToken) };
  }

  async function setEmployeeDepartment(id, department) {
    const current = sessionRef.current;
    if (!current) throw new Error('Войдите в аккаунт ещё раз.');
    const { employee } = await apiRequest(`/employees/${encodeURIComponent(id)}/department`, {
      method: 'PATCH', body: { department }, token: current.token,
    });
    if (sessionRef.current === current) {
      revision.current += 1;
      setEmployees(previous => previous.map(row => row.id === employee.id ? employee : row));
    }
    return employee;
  }

  async function resetEmployeePassword(id, password) {
    const current = sessionRef.current;
    if (!current) throw new Error('Войдите в аккаунт ещё раз.');
    const { employee, inviteToken, temporaryPassword } = await apiRequest(`/employees/${encodeURIComponent(id)}/reset-password`, {
      method: 'POST', body: password ? { password } : {}, token: current.token,
    });
    if (sessionRef.current === current) {
      revision.current += 1;
      setEmployees(previous => previous.map(row => row.id === employee.id ? employee : row));
    }
    return { ...employee, invitationUrl: createEmployeeInvite(inviteToken), password: temporaryPassword ?? password };
  }

  async function updateTask(nextTask) {
    if (!session) {
      setDemoTasks(previous => previous.map(task => task.id === nextTask.id ? nextTask : task));
      return;
    }
    if (savingTaskRef.current) return;
    savingTaskRef.current = true;
    setSavingTask(true);
    const { id, status, checks, checklist, arrival, position, result, outcome, occurredAt } = nextTask;
    const previous = offlineSnapshot?.tasks?.find(task => task.id === id);
    const statusChanged = status !== previous?.status;
    try {
      return await enqueue(id, 'patch', {
        status,
        ...(!checklist && checks ? { checks } : {}),
        ...(checklist && checklist !== previous?.checklist ? { checklist } : {}),
        ...(statusChanged && status === 'arrived' && arrival ? { arrival } : {}),
        ...(statusChanged && position ? { position } : {}),
        ...(statusChanged && status === 'review' && typeof result === 'string' ? { result } : {}),
        ...(outcome && outcome !== previous?.outcome ? { outcome } : {}),
      }, occurredAt);
    } catch (error) {
      if (sessionRef.current === session) Alert.alert('Изменение не сохранено', error.message);
    } finally {
      savingTaskRef.current = false;
      setSavingTask(false);
    }
  }

  function navigate(nextPage) {
    setPage(nextPage);
    setShowShifts(nextPage === 'shifts');
    setSelectedId(null);
    setNavigationId(value => value + 1);
  }

  function openEmployeeTask(id) {
    setPage('tasks');
    setShowShifts(false);
    setSelectedId(id);
  }

  const isEmployeeSession = session?.user.role === 'employee';
  const showOfflineIcon = offlineMode || Boolean(networkError);
  const tasks = isEmployeeSession ? offlineSnapshot?.tasks ?? null : session ? serverTasks : demoTasks;
  const selected = tasks?.find(task => task.id === selectedId);
  const quickAccess = setupSession || (savedQuickAccess && !incomingInvitation);
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="dark-content" />
      {demoTasks === null || savedQuickAccess === undefined ? (
        <View style={styles.loading}><ActivityIndicator color="#245BE8" /></View>
      ) : setupSession || (role === null && quickAccess) ? (
        <QuickAccess
          session={setupSession}
          saved={savedQuickAccess}
          onComplete={finishSetup}
          onCancel={setupSession && session === setupSession ? () => setSetupSession(null) : undefined}
          onUnlock={unlock}
          onForget={message => {
            setSavedQuickAccess(null);
            if (message) Alert.alert('Быстрый вход', message);
          }}
        />
      ) : role === null ? (
        <AuthScreens
          api={apiRequest}
          invitationUrl={incomingInvitation}
          savedCompanyUrl={savedInvitation}
          onEnter={authenticate}
          onDemo={switchRole}
        />
      ) : (
        <>
          <View style={styles.header}>
            <View style={styles.brand}>
              <View style={styles.brandMark}><Text style={styles.brandMarkText}>q</Text></View>
              <View style={styles.brandCopy}>
                <Text style={styles.logo}>qwork</Text>
                <Text numberOfLines={1} style={styles.roleCaption}>{session ? session.company.name : roles.find(([key]) => key === role)?.[2]}</Text>
              </View>
            </View>
            <View style={styles.headerActions}>
              {isEmployeeSession && (
                <Pressable
                  accessibilityRole="switch"
                  accessibilityLabel="Офлайн-режим"
                  accessibilityState={{ checked: offlineMode }}
                  accessibilityHint={offlineMode ? 'Возобновляет синхронизацию' : 'Приостанавливает синхронизацию'}
                  accessibilityValue={{ text: offlineMode ? 'Офлайн' : networkError ? 'Нет связи с сервером' : 'Онлайн' }}
                  hitSlop={3}
                  onPress={toggleOffline}
                  style={({ pressed }) => [styles.headerAvatar, showOfflineIcon && styles.offlineIcon, pressed && styles.pressed]}
                >
                  <Icon name={showOfflineIcon ? 'wifi-off' : 'wifi'} color={showOfflineIcon ? c.muted : c.blue} size={21} />
                </Pressable>
              )}
              <Pressable accessibilityRole="button" accessibilityLabel="Мой профиль" onPress={() => navigate('profile')} style={styles.headerAvatar}>
                <Icon name="user" size={22} />
              </Pressable>
            </View>
          </View>
          {!session && storageError && <Text accessibilityRole="alert" style={styles.storageWarning}>Локальное сохранение недоступно.</Text>}
          {networkError ? <Text accessibilityRole="alert" style={styles.storageWarning}>{networkError}</Text> : null}
          {isEmployeeSession && Boolean(offlineSnapshot?.issues.length) && (
            <View style={styles.syncBanner}>
              <View style={styles.syncCopy}>
                <Text accessibilityRole="alert" style={styles.muted}>{offlineSnapshot.issues[0].message}</Text>
              </View>
              <Pressable accessibilityRole="button" style={styles.exit} onPress={() => {
                const issue = offlineSnapshot.issues[0];
                const store = offlineRef.current;
                Alert.alert('Удалить действие из локальной очереди?', 'Действия, которые ещё не принял сервер, будут удалены с телефона.', [
                  { text: 'Назад', style: 'cancel' },
                  { text: 'Удалить', style: 'destructive', onPress: async () => {
                    try {
                      const snapshot = await store?.discardTask(issue.taskId);
                      if (snapshot && offlineRef.current === store) {
                        setOfflineSnapshot(snapshot);
                        void refreshRef.current?.();
                      }
                    } catch (error) {
                      Alert.alert('Не удалось очистить очередь', error.message);
                    }
                  } },
                ]);
              }}>
                <Text style={styles.exitText}>Очистить</Text>
              </Pressable>
            </View>
          )}
          {isEmployeeSession && !showShifts && (
            <EmployeeShiftReminder request={request} offline={offlineMode || Boolean(networkError)}
              onOpen={() => navigate('shifts')} onShifts={onShifts} />
          )}
          <View style={styles.body}>
            {page === 'profile' ? (
              <Profile session={session} role={role} request={request} onSignOut={signOut} onDemoRole={switchRole}
                onQuickAccess={() => setSetupSession(session)}
                onTasks={() => navigate('tasks')} onShifts={() => navigate('shifts')} />
            ) : role === 'employee' && page === 'home' ? (
              <EmployeeDashboard tasks={tasks ?? []} name={session?.user.name} onSelect={openEmployeeTask} />
            ) : role === 'employee' && page === 'shifts' && !session ? (
              <View style={styles.empty}><Icon name="calendar" size={36} /><Text style={styles.taskTitle}>Ваш рабочий график</Text><Text style={styles.muted}>Войдите в компанию, чтобы увидеть назначенные смены.</Text>
                <Pressable onPress={signOut} accessibilityRole="button" style={styles.demoEnter}><Text style={styles.demoEnterText}>Войти в аккаунт</Text></Pressable>
              </View>
            ) : isEmployeeSession && page === 'trips' ? (
              <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <Pressable accessibilityRole="button" onPress={() => navigate('shifts')} style={styles.exit}>
                  <Text style={styles.exitText}>‹ К рабочему времени</Text>
                </Pressable>
                <EmployeeTrips request={request} offline={offlineMode || Boolean(networkError)} onTask={openEmployeeTask} />
              </ScrollView>
            ) : isEmployeeSession && showShifts ? (
              <EmployeeShiftPanel request={request} offline={offlineMode || Boolean(networkError)} onChange={refreshWork}
                tasks={tasks ?? []} onUrgentLeave={enqueueUrgentLeave} onShifts={onShifts}
                onTrips={() => navigate('trips')}
                urgentLeavePending={Boolean(offlineSnapshot?.urgentLeavePending)} />
            ) : tasks === null && !networkError ? (
              <View style={styles.loading}><ActivityIndicator color="#245BE8" /></View>
            ) : role === 'employee' ? (
              selected ? (
                <WorkScreens key={selected.id} task={selected}
                  busy={savingTask || Boolean(offlineSnapshot?.urgentLeavePending)} setTask={updateTask}
                  onLocate={session ? locateArrival : undefined} onUploadPhoto={session ? uploadPhoto : undefined}
                  request={session ? employeeGallery : request} imageSource={imageSource}
                  galleryRevision={`${selected.revision}|${offlineMode}|${materialsReady}|${offlineSnapshot?.pending}`}
                  onOpenTask={id => tasks.some(task => task.id === id) && openEmployeeTask(id)}
                  onBack={() => setSelectedId(null)} />
              ) : (
                <EmployeeHome tasks={tasks ?? []} onSelect={openEmployeeTask} />
              )
            ) : (
              <OfficeScreens
                key={role}
                section={page}
                navigationId={navigationId}
                onSectionChange={setPage}
                role={role}
                tasks={tasks ?? []}
                setTasks={setDemoTasks}
                session={session}
                employees={employees}
                objects={objects}
                onCreateObject={createObject}
                request={request}
                imageSource={imageSource}
                onUploadPhoto={uploadPhoto}
                onPhotoRejected={response => applyServerTask(response?.task)}
                onCreateTask={fields => saveServerTask('POST', '/tasks', fields)}
                onUpdateTask={updateServerTask}
                onCancelTask={(id, cancelReason) => updateServerTask(id, { status: 'cancelled', cancelReason })}
                onRepeatTask={(id, fields = {}) => saveServerTask('POST', `/tasks/${encodeURIComponent(id)}/repeat`, fields)}
                onCreateEmployee={addEmployee}
                onSetDepartment={setEmployeeDepartment}
                onResetPassword={resetEmployeePassword}
                onRenewInvite={renewInvite}
              />
            )}
          </View>
          <SafeAreaView edges={['bottom']} style={styles.bottomSafe}>
            <View style={styles.roles}>
              {[
                ['home', 'Главная', 'home'],
                ['tasks', 'Задачи', 'clipboard'],
                role === 'employee' ? ['shifts', 'Рабочее время', 'clock'] : ['analytics', 'Аналитика', 'chart'],
                ['profile', 'Профиль', 'user'],
              ].map(([key, label, icon]) => {
                const active = page === key || (key === 'home' && ['team','planning','operations','field-operations'].includes(page))
                  || (key === 'shifts' && page === 'trips');
                return (
                  <Pressable key={key} accessibilityRole="tab" accessibilityLabel={label}
                    accessibilityState={{selected:active}} onPress={() => navigate(key)} style={styles.role}>
                    <Icon name={icon} color={active ? c.blue : '#9AA7BE'} size={23} strokeWidth={active ? 2.1 : 1.7} />
                    <Text style={[styles.roleText, active && styles.activeRoleText]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </SafeAreaView>
        </>
      )}
    </SafeAreaView>
  );
}

export default function App() {
  return <SafeAreaProvider><Workspace /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.canvas },
  loading: { flex: 1, justifyContent: 'center' },
  header: { paddingHorizontal: 17, paddingVertical: 9, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  brandCopy: { flex: 1, paddingRight: 10 },
  brandMark: { width: 29, height: 29, borderRadius: 9, backgroundColor: c.blue, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: '#fff', fontWeight: '800', fontSize: 21, lineHeight: 25 },
  logo: { fontSize: 17, lineHeight: 20, fontWeight: '700', color: c.ink, letterSpacing: -.5 },
  roleCaption: { color: c.muted, fontSize: 10, marginTop: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerAvatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  offlineIcon: { backgroundColor: '#E8EDF4' },
  exit: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 },
  exitText: { color: c.blue, fontWeight: '600', fontSize: 12 },
  bottomSafe: { backgroundColor: '#fff' },
  roles: { flexDirection: 'row', paddingHorizontal: 9, paddingTop: 7, paddingBottom: 2, backgroundColor: '#fff', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E1E7EF' },
  role: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingVertical: 3, gap: 3 },
  roleText: { color: '#9AA7BE', fontSize: 10, fontWeight: '500', textAlign: 'center' },
  activeRoleText: { color: c.blue, fontWeight: '600' },
  storageWarning: { color: '#BC6D21', fontSize: 12, paddingHorizontal: 17, paddingBottom: 8 },
  syncBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 9, marginHorizontal: 16, marginBottom: 7, padding: 10, borderRadius: 12, backgroundColor: c.tint },
  syncCopy: { flex: 1 },
  body: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 9, paddingBottom: 22, gap: 10 },
  pageIntro: { gap: 3, marginBottom: 5 },
  pageTitle: { color: c.ink, fontSize: 27, fontWeight: '700', letterSpacing: -.8 },
  filters: { flexDirection: 'row', padding: 3, gap: 2, borderRadius: 11, backgroundColor: '#EBF1F9' },
  filter: { flex: 1, minHeight: 36, paddingHorizontal: 7, paddingVertical: 7, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  filterSelected: { backgroundColor: c.blue },
  filterText: { color: c.muted, fontSize: 12, fontWeight: '500' },
  filterSelectedText: { color: '#fff', fontWeight: '600' },
  search: { minHeight: 43, paddingHorizontal: 12, backgroundColor: '#EAF0F8', borderRadius: 11, flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchInput: { flex: 1, color: c.ink, fontSize: 13, paddingVertical: 10 },
  stats: { flexDirection: 'row', borderRadius: 12, backgroundColor: '#fff', paddingVertical: 13, marginBottom: 2 },
  stat: { flex: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  statIcon: { width: 31, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  statLabel: { fontSize: 10, color: c.muted },
  statValue: { fontSize: 17, fontWeight: '600', color: c.ink, marginTop: 2 },
  task: { backgroundColor: '#fff', borderRadius: 13, padding: 14, gap: 8 },
  pressed: { opacity: .65 },
  taskTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  taskCopy: { flex: 1, gap: 5 },
  taskNumber: { color: c.muted, fontSize: 11 },
  status: { borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, fontWeight: '600' },
  taskTitle: { color: c.ink, fontWeight: '600', fontSize: 14, lineHeight: 20 },
  muted: { color: c.muted, fontSize: 12, lineHeight: 18 },
  smallText: { color: c.muted, fontSize: 11, lineHeight: 17 },
  infoRow: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  empty: { padding: 28, gap: 10, alignItems: 'center', backgroundColor: '#fff', borderRadius: 14, marginTop: 5 },
  profileIdentity: { padding: 22, borderRadius: 16, backgroundColor: '#fff', alignItems: 'center', gap: 7 },
  profileAvatar: { height: 70, width: 70, borderRadius: 35, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  profileInitials: { color: c.blue, fontSize: 25, fontWeight: '600' },
  profileName: { color: c.ink, fontSize: 20, fontWeight: '600' },
  profileBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7, backgroundColor: '#E4F8EF', marginTop: 3 },
  profileBadgeText: { color: c.green, fontSize: 11, fontWeight: '600' },
  profileMenu: { backgroundColor: '#fff', paddingHorizontal: 14, borderRadius: 14 },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, minHeight: 58 },
  profileIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  profileRowLabel: { color: c.ink, fontSize: 13, flex: 1, fontWeight: '500' },
  demoCaption: { color: c.muted, fontSize: 10, letterSpacing: .5, fontWeight: '600', paddingTop: 15 },
  signOut: { minHeight: 48, borderRadius: 12, backgroundColor: '#FFF0F2', flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 15, marginTop: 5 },
  signOutText: { color: c.red, fontWeight: '600', fontSize: 13 },
  demoEnter: { paddingHorizontal: 18, paddingVertical: 12, backgroundColor: c.blue, borderRadius: 10 },
  demoEnterText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
