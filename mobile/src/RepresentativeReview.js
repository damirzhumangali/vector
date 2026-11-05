import React, { useEffect, useState } from 'react';
import { Image, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { apiOrigin } from './api';
import { colors } from './ui';

function Action({ children, onPress, disabled }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }}
      onPress={onPress} disabled={disabled} style={[styles.button, disabled && styles.disabled]}>
      <Text style={styles.buttonText}>{children}</Text>
    </Pressable>
  );
}

function Decision({ review, path, imageSource }) {
  const decision = review.decision === 'remark' ? 'Есть замечание' : 'Подтверждено представителем';
  return (
    <View style={styles.decision}>
      <Text style={styles.label}>{decision}</Text>
      <Text style={styles.muted}>{review.name} · {new Date(review.decidedAt).toLocaleString('ru-RU')} · По ссылке</Text>
      {review.reason ? <Text style={styles.label}>{review.reason}</Text> : null}
      {review.comment ? <Text style={styles.muted}>{review.comment}</Text> : null}
      {review.hasPhoto && imageSource ? (
        <Image source={imageSource(`${path}/${encodeURIComponent(review.id)}/photo`)}
          accessibilityLabel="Фото замечания представителя" resizeMode="contain" style={styles.photo} />
      ) : null}
    </View>
  );
}

export default function RepresentativeReview({ task, request, imageSource, onRework }) {
  const [data, setData] = useState(null);
  const [link, setLink] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [editingReason, setEditingReason] = useState(false);
  const [reload, setReload] = useState(0);
  const path = `/tasks/${encodeURIComponent(task.id)}/representative`;
  const reviewable = ['review', 'done'].includes(task.status);

  useEffect(() => {
    let active = true;
    let reading = false;
    async function load() {
      if (reading) return;
      reading = true;
      try {
        const result = await request(path);
        if (active) {
          setData(result);
          if (result.current?.decision || !result.eligible) setLink(null);
        }
      } catch (failure) {
        if (active) setError(failure.message);
      } finally {
        reading = false;
      }
    }
    setError('');
    void load();
    const timer = reviewable ? setInterval(load, 15000) : null;
    return () => {
      active = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [path, request, task.revision, reviewable, reload]);

  async function issue() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { token, expiresAt } = await request(path, { method: 'POST' });
      setLink({ url: `${apiOrigin}/representative#${token}`, expiresAt });
      setReload(value => value + 1);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function rework() {
    if (!reason.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onRework(reason.trim());
      setEditingReason(false);
      setReason('');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const current = data?.current;
  const history = data?.history?.filter(item => item.id !== current?.id) ?? [];
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>Подтверждение представителя</Text>
      {current?.decision ? <Decision review={current} path={path} imageSource={imageSource} /> : (
        <Text style={styles.muted}>{data?.eligible ? 'Ожидает ответа представителя.' :
          data ? 'Ссылка доступна после отправки отчёта.' : 'Загружаем отметку…'}</Text>
      )}
      {data?.eligible && apiOrigin ? (
        <Action disabled={busy} onPress={issue}>{link || current ? 'Выпустить новую ссылку' : 'Создать одноразовую ссылку'}</Action>
      ) : null}
      {link && data?.eligible ? (
        <>
          <Text selectable style={styles.link}>{link.url}</Text>
          <Text style={styles.muted}>Действует до {new Date(link.expiresAt).toLocaleString('ru-RU')}</Text>
          <Action onPress={() => Share.share({ message: link.url }).catch(failure => setError(failure.message))}>Поделиться ссылкой</Action>
        </>
      ) : null}
      {task.status === 'done' && current?.decision === 'remark' && onRework ? (
        editingReason ? (
          <>
            <TextInput accessibilityLabel="Причина доработки" placeholder="Что нужно исправить"
              value={reason} onChangeText={setReason} multiline maxLength={1000} style={styles.input} />
            <Action disabled={busy || !reason.trim()} onPress={rework}>Вернуть на доработку</Action>
          </>
        ) : (
          <Action onPress={() => {
            setReason(current.reason);
            setEditingReason(true);
          }}>Назначить доработку</Action>
        )
      ) : null}
      {history.length > 0 ? <Text style={styles.label}>Ответы к прежним версиям отчёта</Text> : null}
      {history.map(review => <Decision key={review.id} review={review} path={path} imageSource={imageSource} />)}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, gap: 10 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  decision: { backgroundColor: colors.canvas, padding: 12, borderRadius: 10, gap: 6 },
  label: { color: colors.ink, fontWeight: '600', fontSize: 14 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  link: { color: colors.blue, fontSize: 13 },
  button: { alignItems: 'center', justifyContent: 'center', minHeight: 44, padding: 8, backgroundColor: colors.tint, borderRadius: 10 },
  buttonText: { color: colors.blue, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  disabled: { opacity: .5 },
  input: { color: colors.ink, minHeight: 60, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10 },
  photo: { height: 200, width: '100%', backgroundColor: colors.tint, borderRadius: 9 },
  error: { color: '#a4253a', fontSize: 13 },
});
