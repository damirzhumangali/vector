import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TripOfferAction, TripOfferReasonForm, TripOfferTerms, useTripOfferAction } from './TripOfferCard';
import { TripRouteSummary, tripRouteTitle } from './TripRoute';
import { colors } from './ui';

const labels = { approved: 'Согласовано', rejected: 'Отклонено', waiting: 'На рассмотрении', pending: 'Ожидает своей очереди' };
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const threeStageTemplate = ['Директор', 'Заместитель директора', 'Главный бухгалтер']
  .map((title, index) => ({ position: index + 1, title }));

function Card({ children, title }) {
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    {children}
  </View>;
}

function ErrorMessage({ message }) {
  return message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null;
}

export function TripApprovalProgress({ stages, renderActions }) {
  if (!stages?.length) return null;
  const stopped = stages.some(stage => stage.status === 'rejected');
  return <Card title="Маршрут согласования">
    {stages.map(stage => <View key={stage.position} style={styles.stage}>
      <View style={[styles.marker, stage.status === 'approved' && styles.markerApproved,
        stage.status === 'rejected' && styles.markerRejected]}>
        <Text style={styles.number}>{stage.position}</Text>
      </View>
      <View style={styles.stageText}>
        <Text style={styles.label}>{stage.title}</Text>
        <Text style={styles.body}>{stage.approverName}</Text>
        <Text style={[styles.muted, stage.status === 'approved' && styles.approved,
          stage.status === 'rejected' && styles.rejected]}>
          {stopped && stage.status === 'pending' ? 'Не рассматривалось' : labels[stage.status]}
          {stage.decidedAt ? ` · ${dateFormat.format(new Date(stage.decidedAt))}` : ''}
        </Text>
        {stage.reason ? <Text style={styles.body}>Причина · {stage.reason}</Text> : null}
        {renderActions?.(stage)}
      </View>
    </View>)}
  </Card>;
}

export function TripApprovalReview({ offer, request, employee = false, offline, onChanged, onTrip, onBack }) {
  const { current, busy, error, submit, clearError } = useTripOfferAction(offer, request, onChanged);
  const [rejection, setRejection] = useState(null);
  const stops = current.stops ?? [];
  const pending = current.approvalStages?.find(stage => stage.status === 'waiting');
  const showActions = !employee && current.status === 'awaiting_approval';
  const canDecide = showActions && current.canDecideApproval && Boolean(pending);
  const showReason = canDecide && pending.position === rejection?.position;
  const confirmed = current.status === 'confirmed';
  const rejected = current.status === 'rejected';

  function approve() {
    if (canDecide && !offline) return submit('approval', { stage: pending.position, action: 'approve' });
  }

  async function reject(reason) {
    if (showReason && !offline && await submit('approval', {
      stage: rejection.position, action: 'reject', reason,
    }, rejection.revision)) setRejection(null);
  }

  function renderActions(stage) {
    const active = canDecide && stage.position === pending.position;
    const disabled = !active || busy || offline;
    if (active && showReason) return <View style={styles.stageDecision}>
      {offline && <Text style={styles.muted}>Для решения нужен интернет.</Text>}
      <TripOfferReasonForm title="Отклонить командировку"
        hint="Сотрудник увидит причину отклонения." actionLabel="Отклонить командировку" busy={busy} offline={offline}
        onCancel={() => { setRejection(null); clearError(); }} onSubmit={reject} />
      <ErrorMessage message={error} />
    </View>;
    return <View style={styles.stageDecision}>
      <View style={styles.stageActions}>
        <TripOfferAction primary icon="check" style={styles.stageAction}
          accessibilityLabel={`Согласовать · ${stage.title}`} disabled={disabled} onPress={approve}>
          {active && busy ? 'Согласовываем…' : 'Согласовать'}
        </TripOfferAction>
        <TripOfferAction icon="close" danger style={styles.stageAction}
          accessibilityLabel={`Отклонить · ${stage.title}`} disabled={disabled} onPress={() => {
            if (!disabled) {
              clearError();
              setRejection({ position: stage.position, revision: current.revision });
            }
          }}>Отклонить</TripOfferAction>
      </View>
      {active && offline ? <Text style={styles.muted}>Для решения нужен интернет.</Text> : null}
      {active && <ErrorMessage message={error} />}
    </View>;
  }

  return <View style={styles.screen}>
    <TripOfferAction disabled={busy} onPress={onBack}>‹ К выездам</TripOfferAction>
    <Card title={tripRouteTitle(stops) ?? stops[0]?.destination ?? current.destination}>
      <Text accessibilityLiveRegion="polite" style={[styles.badge, confirmed && styles.approved,
        rejected && styles.rejected]}>
        {confirmed ? 'Согласована' : rejected ? 'Отклонена' : 'На согласовании'}
      </Text>
      <Text style={styles.label}>Сотрудник</Text>
      <Text style={styles.body}>{current.employeeName}</Text>
      {current.address && current.address !== current.destination ? <Text style={styles.muted}>{current.address}</Text> : null}
      <Text style={styles.label}>Что нужно сделать</Text>
      <Text style={styles.body}>{current.purpose}</Text>
      {current.comment ? <>
        <Text style={styles.label}>Комментарий сотрудника</Text>
        <Text style={styles.body}>{current.comment}</Text>
      </> : null}
      {pending && !canDecide && <Text style={styles.muted}>Ожидает решения · {pending.approverName}</Text>}
    </Card>
    <TripOfferTerms offer={current} title={confirmed ? 'Согласованные условия' : 'Условия поездки'} />
    {stops.length > 0 && <TripRouteSummary stops={stops} />}
    <TripApprovalProgress stages={current.approvalStages} renderActions={showActions ? renderActions : undefined} />
    {!canDecide && <ErrorMessage message={error} />}
    {confirmed && current.tripId ? <TripOfferAction primary onPress={() => onTrip(current.tripId)}>
      Открыть командировку
    </TripOfferAction> : null}
  </View>;
}

export function TripApprovalSettings({ settings, loadError, offline, request, onSaved, onBack, OptionPicker }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const stages = settings?.stages ?? [];
  const supportsSingle = settings?.supportsSingleApprover === true;
  const initialCount = supportsSingle && !settings.configured ? 1 : stages.length;
  const count = draft?.length ?? initialCount;
  const single = count === 1;
  const original = count === stages.length
    ? stages.map(stage => stage.approverId == null ? null : String(stage.approverId))
    : Array(count).fill(null);
  const selected = draft ?? original;
  const choices = (settings?.candidates ?? []).map(person => ({ id: String(person.id), label: person.name }));
  const changed = !settings?.configured || count !== initialCount || original.some((value, index) => value !== selected[index]);
  const valid = (single || count === 3) && selected.every(Boolean) && new Set(selected).size === count;
  const canSave = settings?.canEdit && changed && valid && !busy && !offline;
  const canSwitch = supportsSingle && settings.canEdit && (!single || choices.length >= 3 || initialCount === 3);
  const displayedStages = stages.length === 3 ? stages : threeStageTemplate;

  function select(index, id) {
    setDraft(selected.map((value, position) => {
      if (position === index) return id;
      return value === id ? selected[index] : value;
    }));
    setError('');
    setSaved(false);
  }

  function switchCount() {
    const nextCount = single ? 3 : 1;
    setDraft(nextCount === initialCount ? null : Array(nextCount).fill(null));
    setError('');
    setSaved(false);
  }

  async function save() {
    if (!canSave || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await request('/trip-approval-settings', { method: 'POST', body: { approverIds: selected } });
      onSaved(result);
      setDraft(null);
      setSaved(true);
    } catch (failure) {
      setError(failure.message || 'Не удалось сохранить согласование.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <View style={styles.screen}>
    <TripOfferAction disabled={busy} onPress={onBack}>‹ К выездам</TripOfferAction>
    <Card title="Настройка согласования">
      {!settings && !loadError && !offline && <Text style={styles.muted}>Загружаем маршрут согласования…</Text>}
      {offline && <Text style={styles.muted}>Для изменения настроек нужен интернет.</Text>}
      {settings && !settings.canEdit && <Text style={styles.muted}>Назначить ответственных может владелец компании.</Text>}
      {settings && <Text style={styles.muted}>{single
        ? 'Выбранный руководитель будет согласовывать новые командировки.'
        : 'Командировки проходят три этапа по порядку. Изменения применяются к новым заявкам.'}</Text>}
      {settings?.canEdit && !single && choices.length < 3 && <Text style={styles.muted}>
        Для настройки нужны три разных руководителя с аккаунтами в компании.
      </Text>}
      {settings && single && (settings.canEdit ? <OptionPicker label="Выбрать согласующего" icon="user"
        options={choices} selected={selected[0]} onSelect={id => select(0, id)} disabled={busy || offline}
        empty="Нет доступных руководителей." /> : <Text style={styles.body}>
        {settings.configured ? stages[0]?.approverName : 'Согласующий не назначен'}
      </Text>)}
      {settings && !single && displayedStages.map((stage, index) => <View key={stage.position} style={styles.stage}>
        <View style={styles.marker}><Text style={styles.number}>{stage.position}</Text></View>
        <View style={styles.stageText}>
          <Text style={styles.label}>{stage.title}</Text>
          {settings.canEdit ? <OptionPicker label={`Выбрать · ${stage.title}`} icon="user"
            options={choices}
            selected={selected[index]} onSelect={id => select(index, id)} disabled={busy || offline}
            empty="Нет доступных руководителей." /> : <Text style={styles.body}>{stage.approverName || 'Не назначен'}</Text>}
          {!selected[index] && stage.exampleName && <Text style={styles.muted}>Например, {stage.exampleName}</Text>}
        </View>
      </View>)}
      <ErrorMessage message={error || loadError} />
      {saved && <Text accessibilityLiveRegion="polite" style={styles.approved}>Маршрут сохранён.</Text>}
      {canSwitch && <TripOfferAction disabled={busy || offline} onPress={switchCount}>
        {single ? (initialCount === 3 ? 'Вернуться к трём этапам' : 'Настроить три этапа')
          : (initialCount === 1 ? 'Вернуться к одному согласующему' : 'Перейти на одного согласующего')}
      </TripOfferAction>}
      {settings?.canEdit && <TripOfferAction primary disabled={!canSave} onPress={save}>
        {busy ? 'Сохраняем…' : 'Сохранить согласование'}
      </TripOfferAction>}
    </Card>
  </View>;
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  card: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14, gap: 9 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  label: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  body: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  muted: { color: '#536680', fontSize: 13, lineHeight: 18 },
  stage: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 5 },
  stageText: { flex: 1, minWidth: 0, gap: 4 },
  stageDecision: { marginTop: 4, gap: 8 },
  stageActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stageAction: { flexBasis: 120, flexGrow: 1 },
  marker: { backgroundColor: colors.tint, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  markerApproved: { backgroundColor: '#E5F7ED' },
  markerRejected: { backgroundColor: '#FFECEF' },
  number: { color: colors.ink, fontWeight: '700' },
  badge: { alignSelf: 'flex-start', backgroundColor: colors.tint, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8,
    color: '#125DB1', fontSize: 13, fontWeight: '700' },
  approved: { color: '#166A4B' },
  rejected: { color: '#A53146' },
  error: { color: '#A53146', backgroundColor: '#FFF1F3', padding: 9, borderRadius: 8, fontSize: 13, lineHeight: 18 },
});
