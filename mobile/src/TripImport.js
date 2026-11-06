import React, { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { pickWorkbook } from './PlanningScreens';
import { colors, Icon } from './ui';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const rowStatuses = { created: 'Черновик', duplicate: 'Уже есть', error: 'Ошибка' };

function Action({ children, icon, onPress, disabled, secondary }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.action, secondary && styles.secondary,
      (pressed || disabled) && styles.dim]}>
    {icon && <Icon name={icon} size={18} color={secondary ? '#185DB0' : '#fff'} />}
    <Text style={[styles.actionText, secondary && styles.secondaryText]}>{children}</Text>
  </Pressable>;
}

function ImportResult({ result }) {
  const counts = [
    ['Создано', result.createdCount],
    ['Уже есть', result.duplicateCount],
    ['Ошибки', result.errorCount],
  ];
  return <View style={styles.result}>
    <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.title}>Результат импорта</Text>
    <View style={styles.counts}>
      {counts.map(([label, count]) => <View key={label} style={styles.counter}>
        <Text style={styles.count}>{count}</Text>
        <Text style={styles.muted}>{label}</Text>
      </View>)}
    </View>
    {result.errorCount > 0 && <Text style={styles.muted}>
      Исправьте отмеченные строки и загрузите файл снова. Уже импортированные строки будут пропущены.
    </Text>}
    {result.createdCount > 0 && <Text style={styles.muted}>
      Откройте черновики в списке выездов, заполните даты, время посещений и расходы, затем отправьте на согласование.
    </Text>}
    {result.rows.map(row => <View key={row.row} style={styles.row}>
      <Text style={styles.label}>Строка {row.row}</Text>
      <Text style={[styles.rowStatus, row.status === 'error' && styles.error, row.status === 'duplicate' && styles.warning]}>
        {rowStatuses[row.status]}{row.offerId != null ? ' · №' + row.offerId : ''}
      </Text>
      {row.message ? <Text style={styles.muted}>{row.message}</Text> : null}
    </View>)}
  </View>;
}

async function saveTemplate({ base64, filename, mimeType }) {
  if (typeof base64 !== 'string' || !base64 || (mimeType && mimeType !== XLSX_MIME)) {
    throw new Error('Сервер вернул некорректный шаблон Excel.');
  }
  const name = /^[a-z0-9._-]+\.xlsx$/i.test(filename ?? '') ? filename : 'qwork-trip-import.xlsx';
  if (Platform.OS === 'web') {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return;
  }

  if (!await isAvailableAsync()) throw new Error('На этом устройстве недоступно меню сохранения файла.');
  const folder = new Directory(Paths.cache, 'qwork-trip-template', randomUUID());
  const file = new File(folder, name);
  let shared = false;
  try {
    folder.create({ intermediates: true });
    await file.write(base64, { encoding: 'base64' });
    await shareAsync(file.uri, {
      mimeType: XLSX_MIME, UTI: 'org.openxmlformats-officedocument.spreadsheetml.sheet',
      dialogTitle: 'Сохранить шаблон командировок',
    });
    shared = true;
  } finally {
    // Android can hand the URI to a recipient that reads it after the chooser closes.
    if (!shared || Platform.OS !== 'android') {
      try {
        if (folder.exists) folder.delete();
      } catch {
        // The system can evict files from the cache.
      }
    }
  }
}

export default function TripImport({ request, offline = false, onImported }) {
  const [phase, setPhase] = useState(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState(null);
  const [failedWorkbook, setFailedWorkbook] = useState(null);
  const [importError, setImportError] = useState('');
  const [templateError, setTemplateError] = useState('');
  const locked = useRef(false);
  const canConnect = !offline && typeof request === 'function';
  const connection = useRef(canConnect);
  connection.current = canConnect;
  const disabled = !canConnect || phase !== null;

  async function run(nextPhase, operation) {
    if (!connection.current || locked.current) return;
    locked.current = true;
    setPhase(nextPhase);
    try {
      await operation();
    } finally {
      locked.current = false;
      setPhase(null);
    }
  }

  async function importWorkbook(workbook) {
    setFileName(workbook.name);
    setResult(null);
    setFailedWorkbook(null);
    setImportError('');
    if (!connection.current) {
      setFailedWorkbook(workbook);
      setImportError('Подключитесь к интернету и повторите отправку.');
      return;
    }
    setPhase('upload');
    let response;
    try {
      response = await request('/trip-offers/import', {
        method: 'POST', body: { base64: workbook.base64 }, timeout: 60000,
      });
      const counts = [response?.createdCount, response?.duplicateCount, response?.errorCount];
      if (!counts.every(count => Number.isSafeInteger(count) && count >= 0) || !Array.isArray(response?.rows)) {
        throw new Error('Сервер вернул неожиданный результат импорта.');
      }
    } catch (failure) {
      setImportError(failure?.message || 'Не удалось импортировать файл.');
      const status = failure?.status;
      if (!status || status === 408 || status === 429 || status >= 500) setFailedWorkbook(workbook);
      return;
    }
    setResult(response);
    // Import is committed even if refreshing another screen later fails.
    if (onImported) void Promise.resolve().then(() => onImported(response)).catch(() => {});
  }

  function selectWorkbook() {
    return run('picker', async () => {
      let workbook;
      try {
        workbook = await pickWorkbook();
      } catch (failure) {
        setImportError(failure?.message || 'Не удалось открыть файл.');
        return;
      }
      if (workbook) await importWorkbook(workbook);
    });
  }

  function retryWorkbook() {
    if (failedWorkbook) return run('upload', () => importWorkbook(failedWorkbook));
  }

  function downloadTemplate() {
    return run('template', async () => {
      setTemplateError('');
      try {
        await saveTemplate(await request('/trip-offers/import/template'));
      } catch (failure) {
        setTemplateError(failure?.message || 'Не удалось скачать шаблон.');
      }
    });
  }

  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>Импорт командировок из Excel</Text>
    <Text style={styles.muted}>
      В первой строке укажите «Логин сотрудника», «Город», «Организации», «Задание» и «Комментарий».
    </Text>
    <Text style={styles.muted}>
      Одна строка создаёт черновик поездки. Укажите свой логин qwork, задание и город или организации.
      Несколько организаций разделите точкой с запятой (;). Комментарий необязателен.
    </Text>
    <Text style={styles.muted}>Формат .xlsx, до 2 МБ и 200 строк. Импорт начнётся сразу после выбора файла.</Text>
    {offline ? <Text style={styles.warning}>Для импорта и скачивания шаблона нужен интернет.</Text> : null}
    <Action secondary icon="download" disabled={disabled} onPress={downloadTemplate}>
      {phase === 'template' ? 'Готовим шаблон…' : 'Скачать шаблон'}
    </Action>
    {templateError ? <Text accessibilityRole="alert" style={styles.error}>{templateError}</Text> : null}
    {failedWorkbook && <Action disabled={disabled} onPress={retryWorkbook}>Повторить отправку</Action>}
    <Action icon="upload" secondary={Boolean(failedWorkbook)} disabled={disabled} onPress={selectWorkbook}>
      {phase === 'picker' ? 'Выбираем файл…' : phase === 'upload' ? 'Импортируем…'
        : failedWorkbook || result ? 'Выбрать другой Excel-файл' : 'Выбрать Excel-файл'}
    </Action>
    {fileName ? <Text style={styles.label} selectable>{fileName}</Text> : null}
    {importError ? <Text accessibilityRole="alert" style={styles.error}>{importError}</Text> : null}
    {result ? <ImportResult result={result} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 14, gap: 9 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  label: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  muted: { color: '#536680', fontSize: 13, lineHeight: 18 },
  action: { minHeight: 44, justifyContent: 'center', alignItems: 'center', flexDirection: 'row',
    gap: 7, borderRadius: 9, backgroundColor: '#136BC9', paddingHorizontal: 10, paddingVertical: 8 },
  secondary: { backgroundColor: colors.tint },
  actionText: { flexShrink: 1, color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  secondaryText: { color: '#185DB0' },
  dim: { opacity: 0.55 },
  result: { gap: 8, borderTopWidth: 1, borderColor: colors.border, paddingTop: 8 },
  counts: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  counter: { flexGrow: 1, backgroundColor: colors.canvas, borderRadius: 8, padding: 8, gap: 3 },
  count: { color: colors.ink, fontSize: 18, fontWeight: '700' },
  row: { borderTopWidth: 1, borderColor: colors.border, paddingTop: 8, gap: 4 },
  rowStatus: { color: '#176443', fontSize: 13, fontWeight: '600' },
  warning: { color: '#80550F', fontSize: 13, lineHeight: 18 },
  error: { color: '#9F2329', fontSize: 13, lineHeight: 18 },
});
