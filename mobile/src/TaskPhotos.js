import React, { useEffect, useRef, useState } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File, FileMode } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import {
  ActivityIndicator, Image, Linking, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from './ui';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const MAX_IMAGE_PIXELS = 16_000_000;
const PHOTO_SIZE_ERROR = 'Размер снимка превышает 12 МБ.';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PHOTO_LABELS = {
  before: 'Фото «до»',
  after: 'Фото «после»',
  checklist: 'Фото к пункту чек-листа',
  material: 'Материал руководителя',
};

function PhotoButton({ children, disabled = false, onPress, secondary = false, icon, tile = false }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button, secondary && styles.secondary, tile && styles.uploadTile, pressed && styles.pressed, disabled && styles.disabled,
      ]}
    >
      {icon && <Icon name={icon} color={secondary ? '#087CFF' : '#FFFFFF'} size={tile ? 29 : 19} />}
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{children}</Text>
    </Pressable>
  );
}

function ErrorMessage({ message }) {
  return message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null;
}

function checkResolution({ width, height }) {
  if (width * height > MAX_IMAGE_PIXELS) throw new Error('Разрешение снимка превышает 16 Мп.');
}

function checkFileSize(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error(PHOTO_SIZE_ERROR);
}

async function readPhotoBase64(file) {
  checkFileSize(file);
  const base64 = await file.base64();
  if (!base64) throw new Error('Не удалось подготовить снимок.');
  if (base64.length > MAX_BASE64_LENGTH) throw new Error(PHOTO_SIZE_ERROR);
  return base64;
}

async function prepareGalleryPhoto(asset) {
  checkResolution(asset);
  const source = new File(asset.uri);
  checkFileSize(source);
  const handle = source.open(FileMode.ReadOnly);
  let header;
  try {
    header = await handle.readBytes(21);
  } finally {
    handle.close();
  }
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const png = PNG_SIGNATURE.every((byte, index) => header[index] === byte);
  if (jpeg || png) return readPhotoBase64(source);

  const signature = String.fromCharCode(...header);
  const animatedWebP = signature.startsWith('RIFF') && signature.startsWith('WEBPVP8X', 8) && (header[20] & 2);
  if (signature.startsWith('GIF8') || animatedWebP) throw new Error('Выберите неподвижную фотографию.');

  // Send formats such as HEIC as PNG so the native decoder can apply orientation without a JPEG re-encode.
  const context = ImageManipulator.manipulate(asset.uri);
  try {
    const image = await context.renderAsync();
    try {
      checkResolution(image);
      const normalized = await image.saveAsync({ format: SaveFormat.PNG });
      const file = new File(normalized.uri);
      try {
        return await readPhotoBase64(file);
      } finally {
        try {
          if (file.exists) file.delete();
        } catch {
          // The temporary PNG is in the system cache and can be evicted.
        }
      }
    } finally {
      image.release();
    }
  } finally {
    context.release();
  }
}

async function getPhotoPosition(onLocate) {
  if (!onLocate) return {};
  try {
    const position = await onLocate();
    if (Number.isFinite(position?.latitude) && Number.isFinite(position?.longitude)) {
      return {
        latitude: position.latitude,
        longitude: position.longitude,
        ...(Number.isFinite(position.accuracy) && { accuracy: position.accuracy }),
      };
    }
  } catch {
    // An arrival can be recorded manually, so a photo can also have no coordinates.
  }
  return {};
}

export function EmployeeCamera({ kind, pairKey, checklistId, onUpload, onLocate, disabled = false, actionLabel }) {
  const camera = useRef(null);
  const actionInProgress = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [pictureSize, setPictureSize] = useState();
  const [torch, setTorch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const title = PHOTO_LABELS[kind];

  async function open() {
    if (actionInProgress.current) return;
    actionInProgress.current = true;
    setError('');
    try {
      const access = permission?.granted ? permission : await requestPermission();
      if (!access.granted) throw new Error('Разрешите qwork доступ к камере в настройках телефона.');
      setPreview(null);
      setReady(false);
      setPictureSize(undefined);
      setTorch(false);
      setVisible(true);
    } catch (failure) {
      setError(failure.message || 'Не удалось открыть камеру.');
    } finally {
      actionInProgress.current = false;
    }
  }

  function close() {
    if (actionInProgress.current) return;
    setVisible(false);
    setPreview(null);
    setError('');
  }

  function retake() {
    setError('');
    setReady(false);
    setPreview(null);
  }

  async function cameraReady() {
    const mountedCamera = camera.current;
    if (!mountedCamera) return;
    try {
      const sizes = await mountedCamera.getAvailablePictureSizesAsync();
      const best = sizes.map(size => {
        const [width, height] = size.split('x').map(Number);
        return { size, width, height, distance: Math.abs(Math.max(width, height) - 1920) };
      }).filter(({ width, height }) => Math.min(width, height) >= 480 && Math.max(width, height) >= 640
        && width * height <= MAX_IMAGE_PIXELS).sort((a, b) => a.distance - b.distance)[0];
      if (camera.current === mountedCamera && best) setPictureSize(best.size);
    } catch {
      // Some devices only expose their default capture size.
    }
    if (camera.current === mountedCamera) setReady(true);
  }

  async function capture() {
    if (!camera.current || !ready || actionInProgress.current) return;
    actionInProgress.current = true;
    setBusy(true);
    setError('');
    try {
      const capturedAt = new Date().toISOString();
      // Expo's iOS PNG capture drops the orientation. JPEG carries it to the server.
      const options = Platform.OS === 'ios'
        ? { imageType: 'jpg', exif: true, quality: 1 }
        : { imageType: 'png', exif: false };
      const photo = await camera.current.takePictureAsync(options);
      if (!photo?.uri) throw new Error('Не удалось подготовить снимок.');
      checkResolution(photo);
      if (Math.min(photo.width, photo.height) < 480 || Math.max(photo.width, photo.height) < 640) {
        throw new Error('Разрешение снимка слишком низкое. Сделайте новый снимок.');
      }
      const imageBase64 = await readPhotoBase64(new File(photo.uri));
      setPreview({ imageBase64, uri: photo.uri, capturedAt, position: getPhotoPosition(onLocate) });
    } catch (failure) {
      setError(failure.message || 'Не удалось сделать снимок. Попробуйте ещё раз.');
    } finally {
      actionInProgress.current = false;
      setBusy(false);
    }
  }

  async function upload() {
    if (!preview || actionInProgress.current) return;
    actionInProgress.current = true;
    setBusy(true);
    setError('');
    try {
      await onUpload({
        kind,
        ...(pairKey && { pairKey }),
        ...(checklistId && { checklistId }),
        imageBase64: preview.imageBase64,
        capturedAt: preview.capturedAt,
        ...await preview.position,
      });
      setPreview(null);
      setVisible(false);
    } catch (failure) {
      setError(failure.message || 'Не удалось отправить снимок.');
    } finally {
      actionInProgress.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={styles.group}>
      <PhotoButton onPress={open} disabled={disabled} secondary icon="camera" tile={!actionLabel}>
        {actionLabel ?? `Снять ${title.toLowerCase()}`}
      </PhotoButton>
      {!visible && <ErrorMessage message={error} />}
      {!visible && error && permission?.canAskAgain === false && !permission.granted && (
        <PhotoButton secondary onPress={() => Linking.openSettings().catch(() => {})}>Открыть настройки</PhotoButton>
      )}
      <Modal visible={visible} animationType="slide" onRequestClose={close}>
        <SafeAreaView style={styles.cameraScreen}>
          <Text accessibilityRole="header" style={styles.cameraTitle}>{title}</Text>
          {visible && (preview
            ? <Image accessibilityLabel={title} source={{ uri: preview.uri }} style={styles.cameraPreview} resizeMode="contain" />
            : <CameraView
                ref={camera}
                facing="back"
                enableTorch={torch}
                pictureSize={pictureSize}
                style={styles.cameraPreview}
                onCameraReady={cameraReady}
                onMountError={() => setError('Камера недоступна. Закройте её и попробуйте ещё раз.')}
              />)}
          <View style={styles.cameraControls}>
            <ErrorMessage message={error} />
            {preview ? (
              <>
                <PhotoButton onPress={upload} disabled={busy} icon="upload">{busy ? 'Отправка…' : 'Отправить снимок'}</PhotoButton>
                <PhotoButton onPress={retake} disabled={busy} secondary>Переснять</PhotoButton>
              </>
            ) : (
              <>
                <PhotoButton onPress={capture} disabled={!ready || busy} icon="camera">{busy ? 'Подготовка…' : 'Сделать снимок'}</PhotoButton>
                <PhotoButton onPress={() => setTorch(current => !current)} disabled={!ready || busy} secondary>
                  {torch ? 'Выключить фонарик' : 'Включить фонарик'}
                </PhotoButton>
              </>
            )}
            <PhotoButton onPress={close} disabled={busy} secondary>Закрыть</PhotoButton>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

export function DispatcherPhotoPicker({ onUpload, disabled = false }) {
  const actionInProgress = useRef(false);
  const [asset, setAsset] = useState(null);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function choose() {
    if (actionInProgress.current) return;
    actionInProgress.current = true;
    setError('');
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], allowsEditing: false, quality: 1,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (!result.canceled && result.assets?.[0]) setAsset(result.assets[0]);
    } catch (failure) {
      setError(failure.message || 'Не удалось открыть галерею.');
    } finally {
      actionInProgress.current = false;
    }
  }

  async function upload() {
    if (!asset || actionInProgress.current) return;
    actionInProgress.current = true;
    setBusy(true);
    setError('');
    try {
      const imageBase64 = await prepareGalleryPhoto(asset);
      await onUpload({ kind: 'material', imageBase64, caption: caption.trim() });
      setAsset(null);
      setCaption('');
    } catch (failure) {
      setError(failure.message || 'Не удалось добавить материал.');
    } finally {
      actionInProgress.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={styles.group}>
      <PhotoButton onPress={choose} disabled={disabled || busy} secondary icon="camera" tile>
        {asset ? 'Выбрать другое фото' : 'Добавить материал из галереи'}
      </PhotoButton>
      {asset && (
        <>
          <Image source={{ uri: asset.uri }} accessibilityLabel="Выбранный материал" style={styles.photo} resizeMode="contain" />
          <TextInput
            accessibilityLabel="Подпись к материалу"
            placeholder="Подпись к материалу (необязательно)"
            value={caption}
            onChangeText={setCaption}
            editable={!busy && !disabled}
            maxLength={240}
            style={styles.input}
          />
          <PhotoButton onPress={upload} disabled={disabled || busy}>{busy ? 'Отправка…' : 'Добавить фото'}</PhotoButton>
          <PhotoButton onPress={() => { setAsset(null); setCaption(''); setError(''); }} disabled={busy} secondary>Отмена</PhotoButton>
        </>
      )}
      <ErrorMessage message={error} />
    </View>
  );
}

function PhotoMetadata({ photo, location }) {
  const captured = photo.capturedAt || photo.createdAt;
  const date = captured ? new Date(captured) : null;
  const hasPosition = Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude);
  const geofence = {
    inside: 'В зоне объекта', outside: 'Вне зоны объекта',
    uncertain: 'Недостаточно точная геопозиция', unavailable: 'Геопозиция недоступна',
  }[photo.geofenceStatus];
  return (
    <>
      {date && Number.isFinite(date.getTime()) && <Text style={styles.muted}>{date.toLocaleString('ru-RU')}</Text>}
      {location ? <Text style={styles.muted}>Объект · {location}</Text> : null}
      <Text style={styles.muted}>
        {hasPosition ? `${photo.latitude.toFixed(5)}, ${photo.longitude.toFixed(5)}` : 'Без координат GPS'}
      </Text>
      {Number.isFinite(photo.accuracy) ? <Text style={styles.muted}>Точность GPS · ±{Math.round(photo.accuracy)} м</Text> : null}
      {Number.isFinite(photo.distanceToObject) ? <Text style={styles.muted}>До объекта · {photo.distanceToObject} м</Text> : null}
      {geofence && geofence !== 'unavailable' ? (
        <Text style={photo.geofenceStatus === 'outside' ? styles.error : styles.muted}>{geofence}</Text>
      ) : null}
    </>
  );
}

function GalleryPhoto({ photo, path, imageSource, onReject, rejectDisabled, comparison = false, location, contextLabel }) {
  const [show, setShow] = useState(comparison);
  const [imageError, setImageError] = useState(false);
  const [reason, setReason] = useState(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const actionInProgress = useRef(false);
  const rejected = Boolean(photo.rejectedAt || photo.rejectedReason);
  const label = comparison ? (photo.kind === 'before' ? 'До' : 'После') : (PHOTO_LABELS[photo.kind] || 'Фотография');

  async function reject() {
    if (actionInProgress.current || !reason?.trim()) return;
    actionInProgress.current = true;
    setSending(true);
    setError('');
    try {
      await onReject(photo.id, reason.trim());
      setReason(null);
    } catch (failure) {
      setError(failure.message || 'Не удалось отклонить снимок.');
    } finally {
      actionInProgress.current = false;
      setSending(false);
    }
  }

  return (
    <View style={[styles.photoCard, comparison && styles.comparisonCard]}>
      <View style={styles.photoHeading}>
        {!comparison && <View style={styles.photoIcon}><Icon name="camera" color="#087CFF" size={18} /></View>}
        <Text style={styles.photoTitle}>{label}</Text>
        {rejected || photo.issue ? <Icon name="alert" color="#ED5267" size={17} /> : photo.pending ? <Icon name="clock" color="#F3A227" size={17} /> : <Icon name="check" color="#21B885" size={17} />}
      </View>
      {photo.caption ? <Text style={styles.muted}>{photo.caption}</Text> : null}
      {contextLabel ? <Text style={styles.muted}>{contextLabel}</Text> : null}
      {photo.authorName ? <Text style={styles.muted}>{photo.authorName}</Text> : null}
      {rejected && <Text style={styles.error}>Отклонено{photo.rejectedReason ? ' · ' + photo.rejectedReason : ''}</Text>}
      {show && !imageError ? (
        <Image accessibilityLabel={label} style={[styles.photo, comparison && styles.comparisonImage]}
          source={photo.localUri ? { uri: photo.localUri } : imageSource(path)} resizeMode="contain" onError={() => setImageError(true)} />
      ) : null}
      {comparison && <PhotoMetadata photo={photo} location={location} />}
      {imageError && <ErrorMessage message="Не удалось открыть снимок." />}
      {photo.issue ? <Text style={styles.error}>{photo.issue}</Text>
        : photo.pending && <Text style={styles.muted}>Сохранено на телефоне · ожидает отправки</Text>}
      <PhotoButton
        onPress={() => { setShow(imageError || !show); setImageError(false); }}
        secondary
      >
        {imageError ? 'Загрузить снова' : show ? 'Скрыть снимок' : 'Открыть снимок'}
      </PhotoButton>
      {onReject && photo.kind !== 'material' && !rejected && (reason === null ? (
        <PhotoButton onPress={() => setReason('')} disabled={rejectDisabled} secondary>Отклонить снимок</PhotoButton>
      ) : (
        <>
          <TextInput
            accessibilityLabel="Причина отклонения"
            placeholder="Укажите причину отклонения"
            value={reason}
            onChangeText={setReason}
            maxLength={1000}
            multiline
            editable={!sending && !rejectDisabled}
            style={styles.input}
          />
          <PhotoButton onPress={reject} disabled={sending || rejectDisabled || !reason.trim()}>
            {sending ? 'Сохранение…' : 'Подтвердить отклонение'}
          </PhotoButton>
          <PhotoButton onPress={() => { setReason(null); setError(''); }} disabled={sending} secondary>Отмена</PhotoButton>
        </>
      ))}
      <ErrorMessage message={error} />
    </View>
  );
}

export function TaskPhotoGallery({
  taskId, request, imageSource, kinds, canReject = false, onRejected, revision,
  photoPairs = [], compare = false, location, checklist = [],
}) {
  const requestRef = useRef(request);
  const pendingRejection = useRef(false);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const path = '/tasks/' + encodeURIComponent(taskId) + '/photos';

  useEffect(() => { requestRef.current = request; }, [request]);
  useEffect(() => {
    let active = true;
    setState(previous => previous?.taskId === taskId ? { ...previous, error: '' } : null);
    Promise.resolve().then(() => requestRef.current(path)).then(
      data => { if (active) setState({ taskId, photos: data.photos, error: '' }); },
      failure => {
        if (active) setState(previous => ({
          taskId, photos: previous?.taskId === taskId ? previous.photos : [],
          error: failure.message || 'Не удалось загрузить фотографии.',
        }));
      },
    );
    return () => { active = false; };
  }, [path, taskId, revision, version]);

  async function reject(photoId, reason) {
    if (pendingRejection.current) throw new Error('Дождитесь завершения предыдущего действия.');
    pendingRejection.current = true;
    setRejecting(true);
    try {
      const response = await request(path + '/' + encodeURIComponent(photoId) + '/reject', { method: 'POST', body: { reason } });
      setVersion(value => value + 1);
      await onRejected?.(response);
    } finally {
      pendingRejection.current = false;
      setRejecting(false);
    }
  }

  if (state?.taskId !== taskId) return <ActivityIndicator accessibilityLabel="Загрузка фотографий" />;
  const photos = (state.photos ?? []).filter(photo => !kinds || kinds.includes(photo.kind));
  const activeProof = photo => ['before', 'after'].includes(photo.kind) && !photo.rejectedAt && !photo.rejectedReason && !photo.issue;
  const renderPhoto = (photo, comparison = false) => (
    <GalleryPhoto
      key={String(taskId) + ':' + String(photo.id)}
      photo={photo}
      path={path + '/' + encodeURIComponent(photo.id)}
      imageSource={imageSource}
      onReject={canReject ? reject : undefined}
      rejectDisabled={rejecting}
      comparison={comparison}
      location={location}
      contextLabel={photo.kind === 'checklist' ? checklist.find(item => item.id === photo.checklistId)?.title
        : !comparison ? photoPairs.find(pair => pair.key === (photo.pairKey ?? 'main'))?.label : undefined}
    />
  );
  return (
    <View style={styles.group}>
      {state.error ? (
        <>
          <ErrorMessage message={state.error} />
          <PhotoButton onPress={() => setVersion(value => value + 1)} secondary>Повторить загрузку</PhotoButton>
        </>
      ) : photos.length === 0 && !compare ? <Text style={styles.muted}>Фотографий пока нет.</Text> : null}
      {compare && photoPairs.map(pair => (
        <View key={pair.key} style={styles.group}>
          <Text accessibilityRole="header" style={styles.photoTitle}>{pair.label}</Text>
          <View style={styles.comparisonRow}>
            {['before', 'after'].map(kind => {
              const photo = photos.find(item => activeProof(item) && item.kind === kind && (item.pairKey ?? 'main') === pair.key);
              return photo ? renderPhoto(photo, true) : (
                <View key={kind} style={[styles.photoCard, styles.comparisonCard]}>
                  <Text style={styles.photoTitle}>{kind === 'before' ? 'До' : 'После'}</Text>
                  <Text style={styles.muted}>Нет снимка</Text>
                </View>
              );
            })}
          </View>
        </View>
      ))}
      {photos.filter(photo => !compare || !activeProof(photo)).map(photo => renderPhoto(photo))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 9 },
  button: { minHeight: 44, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 13, backgroundColor: '#087CFF' },
  secondary: { backgroundColor: '#EAF4FF' },
  uploadTile: { flexDirection: 'column', minHeight: 92, borderWidth: 1, borderStyle: 'dashed', borderColor: '#AAD4FF', backgroundColor: '#F1F7FF' },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.45 },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13, textAlign: 'center' },
  secondaryText: { color: '#087CFF' },
  cameraScreen: { flex: 1, backgroundColor: '#142034' },
  cameraTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '600', padding: 16 },
  cameraPreview: { flex: 1, width: '100%' },
  cameraControls: { padding: 16, gap: 8, backgroundColor: '#FFFFFF' },
  photoCard: { backgroundColor: '#F5F7FC', borderRadius: 12, padding: 11, gap: 7 },
  comparisonRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  comparisonCard: { flex: 1, minWidth: 0 },
  comparisonImage: { height: 144 },
  photoHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  photoIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: '#EAF4FF', alignItems: 'center', justifyContent: 'center' },
  photo: { width: '100%', height: 220, backgroundColor: '#142034', borderRadius: 10 },
  photoTitle: { color: '#142034', fontWeight: '600', fontSize: 13, flex: 1 },
  error: { color: '#DD4A61', fontSize: 13, lineHeight: 18 },
  muted: { color: '#8493AA', fontSize: 12, lineHeight: 18 },
  input: { color: '#142034', padding: 11, borderWidth: 1, borderColor: '#E4EBF5', backgroundColor: '#FFFFFF', borderRadius: 10, fontSize: 13 },
});
