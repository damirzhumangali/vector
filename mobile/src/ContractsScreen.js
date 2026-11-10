import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import DeadlinePicker from './DeadlinePicker';
import { colors, Icon } from './ui';

const numberFormat = new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const receiptDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit',
});
const paymentModes = [['combined', 'Одним платежом'], ['separate', 'Раздельно']];
const maxInstallments = 60;
const maxObjects = 50;

function money(value) {
  return `${numberFormat.format(value)} ₸`;
}

function amount(text, maxDigits = 12) {
  const normalized = text.replace(/\s/g, '');
  if (!normalized) return 0;
  return normalized.length <= maxDigits && /^\d+$/.test(normalized) ? Number(normalized) : null;
}

function calendarDay(date) {
  return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}

function dateFromDay(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year === 0) return null;
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(year, month - 1, day);
  return calendarDay(date) === value ? date : null;
}

function displayDate(value) {
  const date = dateFromDay(value);
  return date ? dateFormat.format(date) : '—';
}

function receiptToday() {
  const parts = Object.fromEntries(receiptDateFormat.formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formDraft(contract) {
  const combined = contract?.paymentMode === 'combined' ? contract.payments[0] : null;
  const separate = contract?.paymentMode === 'separate' ? contract.payments : [];
  const installments = separate.filter(payment => payment.supportAmount > 0);
  return {
    number: contract?.number ?? '',
    signedOn: contract?.signedOn ?? calendarDay(new Date()),
    customer: contract?.customer ?? '',
    legalEntity: contract?.legalEntity ?? '',
    objectIds: contract?.objectIds.map(String) ?? [],
    installationAmount: contract?.installationAmount ? String(contract.installationAmount) : '',
    supportAmount: contract?.supportAmount ? String(contract.supportAmount) : '',
    paymentMode: contract?.paymentMode ?? 'combined',
    combinedDue: combined?.dueOn ?? '',
    installationDue: separate.find(payment => payment.installationAmount > 0)?.dueOn ?? combined?.dueOn ?? '',
    installments: installments.length ? installments.map((payment, key) => ({
      key, dueOn: payment.dueOn, value: String(payment.supportAmount),
    })) : [{ key: 0, dueOn: combined?.dueOn ?? '', value: '' }],
  };
}

function formPayload(form) {
  const number = form.number.trim();
  const customer = form.customer.trim();
  const legalEntity = form.legalEntity.trim();
  if (!number || !customer || !legalEntity) throw new Error('Укажите номер договора, заказчика и наше ТОО.');
  if (!dateFromDay(form.signedOn)) throw new Error('Выберите дату договора.');
  const installationAmount = amount(form.installationAmount);
  const supportAmount = amount(form.supportAmount);
  if (installationAmount === null || supportAmount === null) {
    throw new Error('Укажите суммы работ в целых тенге, не более 12 цифр.');
  }
  if (installationAmount + supportAmount <= 0) throw new Error('Укажите стоимость монтажа или сопровождения.');

  const payments = [];
  function add(dueOn, installationAmount, supportAmount, label) {
    if (!dateFromDay(dueOn)) throw new Error(`Выберите дату платежа «${label}».`);
    if (dueOn < form.signedOn) throw new Error(`Дата платежа «${label}» раньше даты договора.`);
    payments.push({ dueOn, installationAmount, supportAmount });
  }

  if (form.paymentMode === 'combined') {
    add(form.combinedDue, installationAmount, supportAmount, 'Общий платёж');
  } else {
    if (installationAmount > 0) add(form.installationDue, installationAmount, 0, 'Монтаж');
    if (supportAmount > 0) {
      const allocations = form.installments.length === 1
        ? [supportAmount] : form.installments.map(row => amount(row.value));
      if (allocations.some(value => value === null || value <= 0)) {
        throw new Error('Укажите положительную сумму в целых тенге для каждого платежа за сопровождение.');
      }
      if (allocations.reduce((sum, value) => sum + value, 0) !== supportAmount) {
        throw new Error('Сумма платежей за сопровождение должна совпадать со стоимостью сопровождения.');
      }
      form.installments.forEach((row, index) => add(row.dueOn, 0, allocations[index],
        form.installments.length === 1 ? 'Сопровождение' : `Сопровождение, платёж ${index + 1}`));
    }
  }

  return { number, customer, legalEntity, signedOn: form.signedOn, objectIds: form.objectIds,
    installationAmount, supportAmount, paymentMode: form.paymentMode, payments };
}

function Button({ children, onPress, secondary = false, disabled = false }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary,
      (disabled || pressed) && styles.dim]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{children}</Text>
  </Pressable>;
}

function Section({ title, icon, children }) {
  return <View style={styles.card}>
    <View style={styles.row}>
      {icon && <Icon name={icon} size={20} />}
      <Text accessibilityRole="header" style={[styles.cardTitle, styles.flex]}>{title}</Text>
    </View>
    {children}
  </View>;
}

function ErrorText({ message }) {
  return message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null;
}

function Status({ status }) {
  return <Text style={[styles.status, status === 'active' && styles.activeStatus]}>
    {status === 'active' ? 'Действует' : 'Черновик'}
  </Text>;
}

function Field({ label, value, onChange, maxLength, disabled, isAmount = false, placeholder }) {
  return <View style={styles.fieldGroup}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.inputRow}>
      <TextInput accessibilityLabel={isAmount ? `${label}, сумма в тенге` : label}
        value={value} onChangeText={onChange} maxLength={maxLength} editable={!disabled}
        keyboardType={isAmount ? 'number-pad' : 'default'} autoCorrect={!isAmount}
        placeholder={placeholder ?? (isAmount ? '0' : undefined)} placeholderTextColor={colors.muted}
        style={[styles.input, styles.flex]} />
      {isAmount && <Text style={styles.muted}>₸</Text>}
    </View>
  </View>;
}

function DateField({ label, value, minimum, maximum, disabled, onChange }) {
  const minimumDate = dateFromDay(minimum);
  return <DeadlinePicker label={label} value={dateFromDay(value)} dateOnly required disabled={disabled}
    minimumDate={minimumDate ?? undefined} maximumDate={dateFromDay(maximum) ?? undefined}
    suggestedDate={minimumDate ?? undefined}
    onChange={date => onChange(calendarDay(date))} />;
}

function ObjectFields({ objects, selected, onChange, disabled }) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const names = new Map(objects.map(object => [String(object.id), object.name]));
  const matches = objects.filter(object => `${object.name} ${object.address ?? ''}`
    .toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  function toggle(id) {
    if (selected.includes(id)) onChange(selected.filter(value => value !== id));
    else if (selected.length < maxObjects) onChange([...selected, id]);
  }

  return <View style={styles.fieldGroup}>
    <Text style={styles.label}>Объекты</Text>
    {selected.length > 0 && <Text style={styles.muted}>{selected.map(id => names.get(id) ?? `Объект №${id}`).join(' · ')}</Text>}
    {objects.length ? <Pressable accessibilityRole="button" accessibilityState={{ expanded, disabled }} disabled={disabled}
      onPress={() => setExpanded(value => !value)} style={styles.touchLink}>
      <Text style={styles.secondaryText}>{expanded ? 'Готово' : selected.length ? `Изменить выбор · ${selected.length}` : 'Выбрать из справочника'}</Text>
    </Pressable> : <Text style={styles.muted}>В справочнике пока нет объектов. Это поле можно пропустить.</Text>}
    {expanded && objects.length > 0 && <>
      {objects.length > 20 && <Field label="Поиск объектов" value={search} onChange={setSearch} disabled={disabled} />}
      {matches.length === 0 && <Text style={styles.muted}>Объекты не найдены.</Text>}
      {matches.slice(0, 20).map(object => {
        const id = String(object.id);
        const checked = selected.includes(id);
        const unavailable = disabled || (!checked && selected.length >= maxObjects);
        return <Pressable key={id} accessibilityRole="checkbox" accessibilityState={{ checked, disabled: unavailable }}
          disabled={unavailable} onPress={() => toggle(id)} style={[styles.choice, checked && styles.chosen,
            unavailable && styles.dim]}>
          <View style={styles.flex}>
            <Text style={styles.label}>{object.name}</Text>
            {Boolean(object.address) && <Text style={styles.muted}>{object.address}</Text>}
          </View>
          {checked && <Icon name="check" size={18} />}
        </Pressable>;
      })}
      {matches.length > 20 && <Text style={styles.muted}>Уточните поиск, чтобы увидеть другие объекты.</Text>}
    </>}
  </View>;
}

function ContractForm({ contract, objects, offline, onCancel, onSave }) {
  const [form, setForm] = useState(() => formDraft(contract));
  const nextKey = useRef(form.installments.length);
  const locked = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const installation = amount(form.installationAmount) ?? 0;
  const support = amount(form.supportAmount) ?? 0;
  const singleSupport = form.installments.length === 1;
  const scheduledSupport = singleSupport ? support : form.installments.reduce((sum, row) => sum + (amount(row.value) ?? 0), 0);
  const update = (field, value) => setForm(current => ({ ...current, [field]: value }));

  function changeInstallment(key, field, value) {
    setForm(current => ({ ...current, installments: current.installments.map(row =>
      row.key === key ? { ...row, [field]: value } : row) }));
  }

  async function submit() {
    if (offline || locked.current) return;
    locked.current = true;
    setSaving(true);
    setError('');
    try {
      const body = formPayload(form);
      if (contract) body.revision = contract.revision;
      await onSave(body);
    } catch (failure) {
      setError(failure.message || 'Не удалось сохранить договор.');
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  return <>
    <Button secondary onPress={onCancel} disabled={saving}>{contract ? '‹ К карточке' : '‹ К договорам'}</Button>
    <Section title={contract ? 'Редактировать договор' : 'Новый договор'} icon="clipboard">
      <Field label="Номер договора" value={form.number} maxLength={80} disabled={saving}
        onChange={value => update('number', value)} />
      <DateField label="Дата договора" value={form.signedOn} disabled={saving} onChange={value => update('signedOn', value)} />
      <Field label="Заказчик" value={form.customer} maxLength={200} disabled={saving}
        onChange={value => update('customer', value)} />
      <Field label="Наше ТОО" value={form.legalEntity} maxLength={200} disabled={saving}
        onChange={value => update('legalEntity', value)} />
      <ObjectFields objects={objects} selected={form.objectIds} onChange={ids => update('objectIds', ids)} disabled={saving} />
    </Section>
    <Section title="Стоимость работ">
      <Field label="Монтаж" value={form.installationAmount} isAmount maxLength={19} disabled={saving}
        onChange={value => update('installationAmount', value)} />
      <Field label="Сопровождение" value={form.supportAmount} isAmount maxLength={19} disabled={saving}
        onChange={value => update('supportAmount', value)} />
      <AmountLine label="Итого по договору" value={installation + support} />
    </Section>
    <Section title="График оплаты" icon="calendar">
      <View style={styles.segment}>
        {paymentModes.map(([id, label]) => {
          const selected = form.paymentMode === id;
          return <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected, disabled: saving }}
            key={id} disabled={saving} onPress={() => update('paymentMode', id)}
            style={[styles.segmentChoice, selected && styles.segmentSelected]}>
            <Text style={[styles.segmentText, selected && styles.secondaryText]}>{label}</Text>
          </Pressable>;
        })}
      </View>
      {form.paymentMode === 'combined' ? <>
        <AmountLine label="Общий платёж" value={installation + support} />
        <DateField label="Срок оплаты" value={form.combinedDue} minimum={form.signedOn} disabled={saving}
          onChange={value => update('combinedDue', value)} />
      </> : <>
        {installation + support === 0 && <Text style={styles.muted}>Укажите стоимость работ, чтобы добавить даты платежей.</Text>}
        {installation > 0 && <View style={styles.installment}>
          <AmountLine label="Платёж за монтаж" value={installation} />
          <DateField label="Срок оплаты монтажа" value={form.installationDue} minimum={form.signedOn} disabled={saving}
            onChange={value => update('installationDue', value)} />
        </View>}
        {support > 0 && <>
          {form.installments.map((row, index) => <View style={styles.installment} key={row.key}>
            {singleSupport ? <AmountLine label="Платёж за сопровождение" value={support} /> : <>
              <View style={styles.row}>
                <Text style={[styles.label, styles.flex]}>Сопровождение · платёж {index + 1}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`Удалить платёж ${index + 1} за сопровождение`}
                  accessibilityState={{ disabled: saving }} disabled={saving} style={styles.touchLink}
                  onPress={() => update('installments', form.installments.filter(value => value.key !== row.key))}>
                  <Text style={styles.secondaryText}>Удалить</Text>
                </Pressable>
              </View>
              <Field label={`Сумма платежа ${index + 1}`} value={row.value} isAmount maxLength={19} disabled={saving}
                onChange={value => changeInstallment(row.key, 'value', value)} />
            </>}
            <DateField label={singleSupport ? 'Срок оплаты сопровождения' : `Срок оплаты · платёж ${index + 1}`}
              value={row.dueOn} minimum={form.signedOn} disabled={saving}
              onChange={value => changeInstallment(row.key, 'dueOn', value)} />
          </View>)}
          {!singleSupport && <Text style={styles.muted} accessibilityLiveRegion="polite">
            Запланировано {money(scheduledSupport)} из {money(support)} за сопровождение
          </Text>}
          {form.installments.length < maxInstallments && <Button secondary disabled={saving} onPress={() => {
            const key = nextKey.current++;
            setForm(current => ({ ...current, installments: [...current.installments, { key, dueOn: '', value: '' }] }));
          }}>Добавить платёж за сопровождение</Button>}
        </>}
      </>}
    </Section>
    <ErrorText message={error} />
    {offline && <Text style={styles.muted}>Подключитесь к интернету, чтобы сохранить договор.</Text>}
    <Button onPress={submit} disabled={saving || offline}>{saving ? 'Сохраняем…' : 'Сохранить черновик'}</Button>
  </>;
}

function AmountLine({ label, value }) {
  return <View style={styles.amountLine}>
    <Text style={[styles.muted, styles.flex]}>{label}</Text>
    <Text style={styles.amount}>{money(value)}</Text>
  </View>;
}

function paymentLabel(payment) {
  if (payment.installationAmount > 0 && payment.supportAmount > 0) return 'Монтаж и сопровождение';
  return payment.installationAmount > 0 ? 'Монтаж' : 'Сопровождение';
}

function ReceiptForm({ contract, payment, offline, onCancel, onSave }) {
  const today = receiptToday();
  const [receivedOn, setReceivedOn] = useState(receiptToday);
  const [enteredAmount, setEnteredAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const submission = useRef(null);

  async function submit() {
    if (offline || locked.current) return;
    const value = amount(enteredAmount, 13);
    if (!value) {
      setError('Укажите сумму поступления в целых тенге.');
      return;
    }
    if (value > payment.outstandingAmount) {
      setError('Сумма поступления превышает остаток по платежу.');
      return;
    }
    if (!dateFromDay(receivedOn) || receivedOn > today) {
      setError('Укажите дату поступления не позднее сегодняшнего дня.');
      return;
    }

    locked.current = true;
    setSaving(true);
    setError('');
    try {
      const draft = `${receivedOn}:${value}`;
      if (submission.current?.draft !== draft) submission.current = { draft, requestId: randomUUID() };
      await onSave({ paymentIndex: payment.paymentIndex, amount: value, receivedOn,
        requestId: submission.current.requestId });
    } catch (failure) {
      setError(failure.message || 'Не удалось сохранить поступление.');
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  return <>
    <Button secondary onPress={onCancel} disabled={saving}>‹ К договору</Button>
    <Section title="Поступление оплаты" icon="calendar">
      <Text style={styles.label}>Договор {contract.number} · {paymentLabel(payment)}</Text>
      <Text style={styles.muted}>Срок по графику · {displayDate(payment.dueOn)}</Text>
      <AmountLine label="Осталось по платежу" value={payment.outstandingAmount} />
      <Field label="Полученная сумма" value={enteredAmount} isAmount maxLength={20} disabled={saving}
        onChange={value => { setEnteredAmount(value); setError(''); }} />
      <DateField label="Дата поступления" value={receivedOn} maximum={today} disabled={saving}
        onChange={value => { setReceivedOn(value); setError(''); }} />
      <ErrorText message={error} />
      {offline && <Text style={styles.muted}>Подключитесь к интернету, чтобы сохранить поступление.</Text>}
      <Button onPress={submit} disabled={offline || saving}>{saving ? 'Сохраняем…' : 'Сохранить поступление'}</Button>
    </Section>
  </>;
}

function ContractDetails({ contract, objects, offline, activating, refreshing, error, onBack, onEdit, onActivate,
  onRecordPayment, onRefresh }) {
  const objectNames = new Map(objects.map(object => [String(object.id), object.name]));
  const rows = [...contract.payments].sort((left, right) => left.dueOn.localeCompare(right.dueOn));
  const total = contract.installationAmount + contract.supportAmount;
  const active = contract.status === 'active';
  const busy = activating || refreshing;
  return <>
    <View style={styles.row}>
      <View style={styles.flex}><Button secondary onPress={onBack} disabled={busy}>‹ К договорам</Button></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Обновить карточку договора"
        accessibilityState={{ disabled: busy || offline }} disabled={busy || offline} onPress={onRefresh}
        style={[styles.touchLink, (busy || offline) && styles.dim]}>
        <Text style={styles.secondaryText}>{refreshing ? 'Обновляем…' : 'Обновить'}</Text>
      </Pressable>
    </View>
    <Section title={`Договор ${contract.number}`} icon="clipboard">
      <View style={styles.statusRow}><Status status={contract.status} /></View>
      <Text style={styles.muted}>Дата договора · {displayDate(contract.signedOn)}</Text>
      <Text style={styles.label}>Заказчик</Text>
      <Text style={styles.muted}>{contract.customer}</Text>
      <Text style={styles.label}>Наше ТОО</Text>
      <Text style={styles.muted}>{contract.legalEntity}</Text>
      {contract.objectIds.length > 0 && <>
        <Text style={styles.label}>Объекты</Text>
        {contract.objectIds.map(id => <Text key={id} style={styles.muted}>{objectNames.get(String(id)) ?? `Объект №${id}`}</Text>)}
      </>}
      <AmountLine label="Монтаж" value={contract.installationAmount} />
      <AmountLine label="Сопровождение" value={contract.supportAmount} />
      <AmountLine label="Итого по договору" value={total} />
      <View style={styles.balance} accessibilityLiveRegion="polite">
        <AmountLine label="Оплачено" value={contract.paidAmount ?? 0} />
        <AmountLine label="Осталось оплатить" value={contract.outstandingAmount ?? total} />
      </View>
    </Section>
    <Section title="График оплаты" icon="calendar">
      <Text style={styles.muted}>{contract.paymentMode === 'combined' ? 'Одним платежом' : 'Раздельные платежи'}</Text>
      {rows.map((payment, index) => {
        const planned = payment.installationAmount + payment.supportAmount;
        const paid = payment.paidAmount ?? 0;
        const outstanding = payment.outstandingAmount ?? planned - paid;
        const receipts = payment.receipts ?? [];
        return <View key={payment.paymentIndex ?? index} style={styles.installment}>
          <AmountLine label={paymentLabel(payment)} value={planned} />
          <Text style={styles.muted}>Срок оплаты · {displayDate(payment.dueOn)}</Text>
          {active && <>
            <AmountLine label="Оплачено" value={paid} />
            <AmountLine label="Осталось" value={outstanding} />
            {receipts.length > 0 && <View style={styles.receipts}>
              <Text style={styles.label}>Поступления</Text>
              {receipts.map(receipt => <View key={receipt.id} style={styles.receipt}>
                <AmountLine label={displayDate(receipt.receivedOn)} value={receipt.amount} />
                {Boolean(receipt.recordedBy?.name) && <Text style={styles.muted}>Отметил(а) {receipt.recordedBy.name}</Text>}
              </View>)}
            </View>}
            {onRecordPayment && Number.isInteger(payment.paymentIndex) && outstanding > 0 &&
              <Button secondary onPress={() => onRecordPayment(payment)} disabled={busy || offline}>
                Отметить поступление
              </Button>}
          </>}
        </View>;
      })}
    </Section>
    <ErrorText message={error} />
    {!active && <>
      <Text style={styles.muted}>{onActivate
        ? 'При активации суммы и график оплаты фиксируются. Затем бухгалтер сможет отмечать поступления.'
        : 'Поступления можно отмечать после активации договора руководителем.'}</Text>
      {onEdit && <Button secondary onPress={onEdit} disabled={busy || offline}>Редактировать черновик</Button>}
      {onActivate && <Button onPress={onActivate} disabled={busy || offline}>
        {activating ? 'Активируем…' : 'Активировать договор'}
      </Button>}
    </>}
  </>;
}

export default function ContractsScreen({ request, objects = [], role = 'manager', offline = false, onBack, onNavigate }) {
  const [contracts, setContracts] = useState(null);
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(false);
  const [recordingPayment, setRecordingPayment] = useState(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [listRevision, setListRevision] = useState(0);
  const actionLock = useRef(false);
  const canManage = role === 'manager' || role === 'dispatcher';

  useEffect(() => {
    if (offline || !request) {
      setLoading(false);
      return undefined;
    }
    let current = true;
    setLoading(true);
    setError('');
    request('/contracts').then(result => {
      if (current) setContracts(result.contracts);
    }).catch(failure => {
      if (current) setError(failure.status === 404 ? 'Обновите сервер Qwork, чтобы открыть договоры.'
        : failure.message || 'Не удалось загрузить договоры.');
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [request, offline, listRevision]);

  function updateContract(contract) {
    setContracts(current => current?.some(item => item.id === contract.id)
      ? current.map(item => item.id === contract.id ? contract : item)
      : [contract, ...(current ?? [])]);
    setSelected(contract);
  }

  async function runAction(kind, operation) {
    if (actionLock.current) return;
    actionLock.current = true;
    setAction(kind);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(failure.message || 'Не удалось выполнить действие.');
    } finally {
      actionLock.current = false;
      setAction('');
    }
  }

  function openContract(contract) {
    if (offline) {
      setSelected(contract);
      onNavigate?.();
      return;
    }
    return runAction('open', async () => {
      const result = await request(`/contracts/${encodeURIComponent(contract.id)}`);
      updateContract(result.contract);
      onNavigate?.();
    });
  }

  async function saveContract(body) {
    const path = selected ? `/contracts/${encodeURIComponent(selected.id)}` : '/contracts';
    const result = await request(path, { method: selected ? 'PUT' : 'POST', body });
    updateContract(result.contract);
    setEditing(false);
    onNavigate?.();
  }

  async function saveReceipt(body) {
    const result = await request(`/contracts/${encodeURIComponent(selected.id)}/receipts`, { method: 'POST', body });
    updateContract(result.contract);
    setRecordingPayment(null);
    onNavigate?.();
  }

  function confirmActivation() {
    Alert.alert('Активировать договор?', 'Договор получит статус «Действует». Условия и график оплаты будут зафиксированы, а бухгалтер сможет отмечать поступления.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Активировать', onPress: () => runAction('activate', async () => {
        const result = await request(`/contracts/${encodeURIComponent(selected.id)}/activate`, {
          method: 'POST', body: { revision: selected.revision },
        });
        updateContract(result.contract);
      }) },
    ]);
  }

  if (editing) return <ContractForm contract={selected} objects={objects} offline={offline}
    onCancel={() => { setEditing(false); onNavigate?.(); }} onSave={saveContract} />;

  if (recordingPayment) return <ReceiptForm contract={selected} payment={recordingPayment} offline={offline}
    onCancel={() => { setRecordingPayment(null); onNavigate?.(); }} onSave={saveReceipt} />;

  if (selected) return <ContractDetails contract={selected} objects={objects} offline={offline}
    activating={action === 'activate'} refreshing={action === 'open'} error={error}
    onBack={() => { setSelected(null); setError(''); onNavigate?.(); }} onRefresh={() => openContract(selected)}
    onEdit={canManage ? () => { setError(''); setEditing(true); onNavigate?.(); } : undefined}
    onActivate={canManage ? confirmActivation : undefined}
    onRecordPayment={role === 'accountant' ? payment => { setRecordingPayment(payment); onNavigate?.(); } : undefined} />;

  return <>
    {onBack && <Button secondary onPress={onBack}>‹ К обзору</Button>}
    {canManage && <Button onPress={() => { setError(''); setEditing(true); onNavigate?.(); }}
      disabled={offline || !request || loading || Boolean(action) || !contracts}>
      ＋ Новый договор
    </Button>}
    {offline && <Text style={styles.muted}>Подключитесь к интернету, чтобы загрузить или изменить договоры.</Text>}
    {(loading || action === 'open') && <ActivityIndicator color={colors.blue} accessibilityLabel="Загрузка договоров" />}
    <ErrorText message={error} />
    {!offline && !loading && (error || contracts !== null) && <Button secondary disabled={Boolean(action)}
      onPress={() => setListRevision(value => value + 1)}>{error ? 'Повторить загрузку' : 'Обновить список'}</Button>}
    {contracts?.map(contract => <Pressable key={contract.id} accessibilityRole="button"
      accessibilityLabel={`Договор ${contract.number}, ${contract.customer}`} accessibilityState={{ disabled: loading || Boolean(action) }}
      disabled={loading || Boolean(action)} onPress={() => openContract(contract)}
      style={({ pressed }) => [styles.card, pressed && styles.dim]}>
      <View style={styles.row}>
        <Text style={[styles.cardTitle, styles.flex]}>Договор {contract.number}</Text>
        <Status status={contract.status} />
      </View>
      <Text style={styles.muted}>{contract.customer} · {displayDate(contract.signedOn)}</Text>
      <View style={styles.row}>
        <Text style={[styles.amount, styles.flex]}>{money(contract.installationAmount + contract.supportAmount)}</Text>
        <Icon name="chevron-right" size={18} color={colors.muted} />
      </View>
      {contract.status === 'active' && <Text style={styles.muted}>
        Оплачено {money(contract.paidAmount ?? 0)} · Осталось {money(contract.outstandingAmount ??
          contract.installationAmount + contract.supportAmount)}
      </Text>}
    </Pressable>)}
    {contracts?.length === 0 && <Section title="Договоров пока нет" icon="clipboard">
      <Text style={styles.muted}>{canManage ? 'Добавьте договор, чтобы запланировать оплату монтажа и сопровождения.'
        : 'Здесь появятся договоры вашей компании.'}</Text>
    </Section>}
  </>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10 },
  cardTitle: { fontSize: 17, fontWeight: '700', color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1, minWidth: 0 },
  label: { fontSize: 14, fontWeight: '600', color: colors.ink },
  muted: { fontSize: 13, lineHeight: 19, color: '#5B6C85' },
  amount: { fontSize: 15, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  amountLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  statusRow: { flexDirection: 'row' },
  status: { color: '#485A72', backgroundColor: colors.canvas, fontSize: 12, fontWeight: '700', padding: 7,
    borderRadius: 7, overflow: 'hidden', flexShrink: 1 },
  activeStatus: { color: '#08795A', backgroundColor: '#E8F8F1' },
  button: { minHeight: 44, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blue },
  buttonText: { fontSize: 14, fontWeight: '700', color: '#FFFFFF', textAlign: 'center' },
  secondary: { backgroundColor: colors.tint },
  secondaryText: { color: '#075ABF', fontSize: 14, fontWeight: '700' },
  dim: { opacity: 0.65 },
  error: { color: '#A62636', backgroundColor: '#FFF0F1', borderRadius: 10, padding: 10, fontSize: 13 },
  fieldGroup: { gap: 5 },
  inputRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.canvas, gap: 8 },
  input: { minHeight: 44, fontSize: 16, color: colors.ink, paddingVertical: 8 },
  touchLink: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  choice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8,
    borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  chosen: { backgroundColor: colors.tint, borderColor: '#A5D1FF' },
  segment: { flexDirection: 'row', gap: 4, padding: 3, borderRadius: 12, backgroundColor: colors.canvas },
  segmentChoice: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', padding: 6, borderRadius: 9 },
  segmentSelected: { backgroundColor: '#FFFFFF' },
  segmentText: { color: '#5B6C85', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  installment: { gap: 7, padding: 10, borderRadius: 12, backgroundColor: colors.canvas },
  balance: { gap: 6, borderRadius: 10, padding: 10, backgroundColor: colors.tint },
  receipts: { gap: 6, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  receipt: { gap: 2 },
});
