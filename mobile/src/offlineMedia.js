import * as FS from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

export async function openOfflineMedia(scope, request, imageSource) {
  const key = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope);
  const directory = FS.documentDirectory + 'qwork-materials/' + key + '/';
  await FS.makeDirectoryAsync(directory, { intermediates: true });

  const localPath = (taskId, photoId) => directory + taskId + '-' + photoId + '.jpg';
  const indexKey = taskId => 'qwork-materials:' + key + ':' + taskId;
  const inFlight = new Map();

  async function read(taskId) {
    try {
      return JSON.parse(await AsyncStorage.getItem(indexKey(taskId)));
    } catch {
      return null;
    }
  }

  async function download(task) {
    const taskId = String(task.id);
    if (!/^\d+$/.test(taskId)) return;
    const previous = await read(taskId);
    if (previous?.revision === task.revision) {
      const files = await Promise.all(previous.photos.map(photo => FS.getInfoAsync(localPath(taskId, photo.id))));
      if (files.every(file => file.exists)) return;
    }
    const path = '/tasks/' + taskId + '/photos';
    const { photos } = await request(path);
    for (const photo of photos) {
      if (!/^\d+$/.test(photo.id)) continue;
      const final = localPath(taskId, photo.id);
      if ((await FS.getInfoAsync(final)).exists) continue;
      const source = imageSource(path + '/' + photo.id);
      const temporary = final + '.tmp';
      try {
        const response = await FS.downloadAsync(source.uri, temporary, { headers: source.headers });
        if (response.status !== 200) throw new Error('Не удалось загрузить фото.');
        await FS.moveAsync({ from: temporary, to: final });
      } finally {
        await FS.deleteAsync(temporary, { idempotent: true }).catch(() => {});
      }
    }
    // Publish the manifest only after every referenced file exists.
    await AsyncStorage.setItem(indexKey(taskId), JSON.stringify({ revision: task.revision, photos }));
  }

  return {
    prefetch(task) {
      if (inFlight.has(task.id)) return inFlight.get(task.id);
      const action = download(task).finally(() => inFlight.delete(task.id));
      inFlight.set(task.id, action);
      return action;
    },
    async gallery(taskId) {
      const snapshot = await read(taskId);
      if (!snapshot) return null;
      return snapshot.photos.map(photo => ({ ...photo, localUri: localPath(taskId, photo.id) }));
    },
  };
}
