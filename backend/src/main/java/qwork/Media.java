package qwork;

import java.awt.Color;
import java.awt.Font;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.Set;
import java.util.concurrent.Semaphore;
import javax.imageio.ImageIO;
import javax.imageio.stream.MemoryCacheImageInputStream;
import javax.imageio.stream.MemoryCacheImageOutputStream;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

/** Company-scoped storage and verification of work photos. */
final class Media {
    static final int MAX_IMAGE_BYTES = 12 * 1024 * 1024;
    private static final int MAX_IMAGE_PIXELS = 16_000_000;
    private static final int MAX_IMAGE_EDGE = 16_383;
    private static final byte[] PNG_SIGNATURE = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10};
    private static final String BIT_DEPTH_ERROR = "Для конвертации без потерь нужен снимок с глубиной цвета до 8 бит на канал.";
    private static final int MAX_PHOTOS = 32;
    private static final Semaphore IMAGE_SLOTS = new Semaphore(2);
    private static final Set<String> KINDS = Set.of("material", "before", "after");
    private static final Set<String> CLOSED = Set.of("done", "cancelled", "repeated");
    private static final String COLUMNS = """
        id, kind, caption, author_name, created_at, captured_at, latitude, longitude, accuracy,
        sha256, width, height, rejected_reason, rejected_at
        """;

    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS task_media (
            id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
            author_id INTEGER NOT NULL REFERENCES users(id), author_name TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('material', 'before', 'after')),
            caption TEXT NOT NULL, created_at TEXT NOT NULL, captured_at TEXT NOT NULL,
            latitude REAL, longitude REAL, accuracy REAL, sha256 TEXT NOT NULL,
            width INTEGER NOT NULL, height INTEGER NOT NULL,
            original_image BLOB NOT NULL, display_image BLOB NOT NULL,
            rejected_reason TEXT, rejected_at TEXT, rejected_by INTEGER REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS task_media_task ON task_media(task_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS task_media_active_proof ON task_media(task_id, kind)
            WHERE kind IN ('before', 'after') AND rejected_at IS NULL;
        """;

    private record Position(Double latitude, Double longitude, Double accuracy) {}
    private record Picture(byte[] original, byte[] display, int width, int height) {}

    private Media() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user, long taskId) throws SQLException {
        task(db, user, taskId);
        return Map.of("photos", listPhotos(db, taskId));
    }

    static List<Map<String, Object>> listPhotos(Connection db, long taskId) throws SQLException {
        return Db.rows(db, "SELECT " + COLUMNS + " FROM task_media WHERE task_id = ? ORDER BY id", taskId)
            .stream().map(Media::metadata).toList();
    }

    static boolean hasAccepted(Connection db, long taskId, String kind) throws SQLException {
        return Db.one(db, """
            SELECT id FROM task_media WHERE task_id = ? AND kind = ? AND rejected_at IS NULL
            """, taskId, kind) != null;
    }

    static Map<String, Object> upload(Connection db, Map<String, Object> user, long taskId,
                                      Map<String, Object> payload) throws SQLException {
        String kind = field(payload, "kind", "Вид фотографии", 20, false);
        if (!KINDS.contains(kind)) {
            throw error(400, "Неизвестный вид фотографии.");
        }
        String caption = field(payload, "caption", "Подпись к фотографии", 300, true);
        boolean material = kind.equals("material");
        Instant now = Instant.now();
        Position position = material ? new Position(null, null, null) : position(payload);
        String capturedAt = material ? now.toString() : captureTime(payload.get("capturedAt"), now);
        String name = (String) user.get("name");
        Db.lockTask(db, number(user, "company_id"), taskId);
        var task = task(db, user, taskId);
        if (!material && "employee".equals(user.get("role"))
            && !Shift.isAvailable(db, number(user, "company_id"), number(user, "id"))) {
            throw error(409, "Отметьте возвращение, прежде чем продолжить работу.");
        }
        checkUploadState(user, task, kind);
        long count = number(Db.one(db, "SELECT COUNT(*) AS total FROM task_media WHERE task_id = ?", taskId), "total");
        if (count >= MAX_PHOTOS) {
            throw error(409, "В заявке достигнут предел количества фотографий.");
        }
        if (!material && hasAccepted(db, taskId, kind)) {
            throw error(409, "Фото этого вида уже прикреплено.");
        }
        byte[] input = decode(payload.get("imageBase64"));
        if (!IMAGE_SLOTS.tryAcquire()) {
            throw error(429, "Сервер обрабатывает другие фотографии. Попробуйте ещё раз.");
        }
        Picture photo;
        try {
            photo = process(input, material, name, capturedAt, position);
        } finally {
            IMAGE_SLOTS.release();
        }
        long id = Db.insert(db, """
            INSERT INTO task_media(task_id, author_id, author_name, kind, caption, created_at, captured_at,
                latitude, longitude, accuracy, sha256, width, height, original_image, display_image)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, taskId, number(user, "id"), name, kind, caption, now.toString(), capturedAt,
            position.latitude(), position.longitude(), position.accuracy(), sha256(photo.original()),
            photo.width(), photo.height(), photo.original(), photo.display());
        if (!material) {
            // Keep the original task response counters compatible with older clients.
            String column = kind.equals("before") ? "photo_before" : "photo_after";
            Db.update(db, "UPDATE tasks SET " + column + " = 1, revision = revision + 1 WHERE id = ?", taskId);
        }
        return Map.of("photo", metadata(Db.one(db, "SELECT " + COLUMNS + " FROM task_media WHERE id = ?", id)));
    }

    static byte[] read(Connection db, Map<String, Object> user, long taskId, long photoId,
                       boolean original) throws SQLException {
        task(db, user, taskId);
        String column = original ? "original_image" : "display_image";
        var row = Db.one(db, "SELECT " + column + " FROM task_media WHERE id = ? AND task_id = ?", photoId, taskId);
        if (row == null) {
            throw error(404, "Фотография не найдена.");
        }
        return (byte[]) row.get(column);
    }

    static Map<String, Object> reject(Connection db, Map<String, Object> user, long taskId, long photoId,
                                      Map<String, Object> payload) throws SQLException {
        Accounts.requireReviewer(user);
        String reason = field(payload, "reason", "Причина отклонения", 1000, false);
        Db.lockTask(db, number(user, "company_id"), taskId);
        var task = task(db, user, taskId);
        var photo = Db.one(db, "SELECT " + COLUMNS + " FROM task_media WHERE id = ? AND task_id = ?", photoId, taskId);
        if (photo == null) {
            throw error(404, "Фотография не найдена.");
        }
        String kind = (String) photo.get("kind");
        if (!Set.of("review", "rework").contains(task.get("status")) || kind.equals("material") ||
            photo.get("rejected_at") != null) {
            throw error(409, "Можно отклонить только снимок из отчёта на проверке или доработке.");
        }
        String now = Instant.now().toString();
        Db.update(db, "UPDATE task_media SET rejected_reason = ?, rejected_at = ?, rejected_by = ? WHERE id = ?",
            reason, now, number(user, "id"), photoId);
        String column = kind.equals("before") ? "photo_before" : "photo_after";
        Db.update(db, "UPDATE tasks SET status = 'rework', rework_reason = ?, " + column +
            " = 0, revision = revision + 1 WHERE id = ?", reason, taskId);
        if (kind.equals("before")) {
            invalidateAfter(db, taskId, user);
        }
        String label = kind.equals("before") ? "Фото «до»" : "Фото «после»";
        Db.update(db, """
            INSERT INTO task_events(task_id, status, actor_id, actor_name, created_at, reason, position)
            VALUES (?, 'rework', ?, ?, ?, ?, NULL)
            """, taskId, number(user, "id"), user.get("name"), now, label + ": " + reason);
        return Map.of("photo", metadata(Db.one(db, "SELECT " + COLUMNS + " FROM task_media WHERE id = ?", photoId)));
    }

    static void invalidateAfter(Connection db, long taskId, Map<String, Object> reviewer) throws SQLException {
        Db.update(db, """
            UPDATE task_media SET rejected_reason = ?, rejected_at = ?, rejected_by = ?
            WHERE task_id = ? AND kind = 'after' AND rejected_at IS NULL
            """, "Снимок требуется обновить после доработки.", Instant.now().toString(), number(reviewer, "id"), taskId);
        Db.update(db, "UPDATE tasks SET photo_after = 0 WHERE id = ?", taskId);
    }

    private static Map<String, Object> task(Connection db, Map<String, Object> user, long id) throws SQLException {
        var row = Db.one(db, "SELECT status, assignee_id FROM tasks WHERE id = ? AND company_id = ?",
            id, number(user, "company_id"));
        if (row == null || ("employee".equals(user.get("role"))
            && (number(row, "assignee_id") != number(user, "id") || "unassigned".equals(row.get("status"))))) {
            throw error(404, "Заявка не найдена.");
        }
        return row;
    }

    private static void checkUploadState(Map<String, Object> user, Map<String, Object> task, String kind) {
        String status = (String) task.get("status");
        if (kind.equals("material")) {
            if (!"dispatcher".equals(user.get("role"))) {
                throw error(403, "Материалы к заявке может добавить диспетчер.");
            }
            if (CLOSED.contains(status)) {
                throw error(409, "Эта заявка уже закрыта.");
            }
            return;
        }
        if (!"employee".equals(user.get("role"))) {
            throw error(403, "Фотоотчёт загружает назначенный сотрудник.");
        }
        boolean available = kind.equals("before") ? Set.of("arrived", "work", "rework", "paused").contains(status) : status.equals("work");
        if (!available) {
            throw error(409, "Фотография недоступна на текущем этапе работы.");
        }
    }

    private static Map<String, Object> metadata(Map<String, Object> row) {
        var result = new LinkedHashMap<String, Object>();
        result.put("id", String.valueOf(row.get("id")));
        for (String key : List.of("kind", "caption", "latitude", "longitude", "accuracy", "sha256", "width", "height")) {
            result.put(key, row.get(key));
        }
        result.put("authorName", row.get("author_name"));
        result.put("createdAt", row.get("created_at"));
        result.put("capturedAt", row.get("captured_at"));
        result.put("rejectedReason", row.get("rejected_reason"));
        result.put("rejectedAt", row.get("rejected_at"));
        return result;
    }

    private static Position position(Map<String, Object> payload) {
        Double lat = measure(payload.get("latitude"), -90, 90);
        Double lon = measure(payload.get("longitude"), -180, 180);
        Double accuracy = measure(payload.get("accuracy"), 0, 100_000);
        if ((lat == null) != (lon == null) || (lat == null && accuracy != null)) {
            throw error(400, "Укажите обе координаты фотографии.");
        }
        return new Position(lat, lon, accuracy);
    }

    private static Double measure(Object value, double min, double max) {
        if (value == null) {
            return null;
        }
        if (!(value instanceof Number number) || !Double.isFinite(number.doubleValue()) ||
            number.doubleValue() < min || number.doubleValue() > max) {
            throw error(400, "Некорректная геопозиция фотографии.");
        }
        return number.doubleValue();
    }

    private static String captureTime(Object value, Instant now) {
        if (value == null) {
            return now.toString();
        }
        if (value instanceof String text && text.length() <= 40) {
            try {
                Instant time = Instant.parse(text);
                if (!time.isAfter(now.plusSeconds(300))) {
                    return time.toString();
                }
            } catch (DateTimeParseException ignored) {
                // Report the validation error below.
            }
        }
        throw error(400, "Некорректное время съёмки.");
    }

    private static byte[] decode(Object value) {
        if (!(value instanceof String base64) || base64.length() > ((MAX_IMAGE_BYTES + 2) / 3) * 4) {
            throw error(400, "Прикрепите JPEG или PNG размером до 12 МБ.");
        }
        byte[] data;
        try {
            data = Base64.getDecoder().decode(base64);
        } catch (IllegalArgumentException e) {
            throw error(400, "Фотография повреждена.");
        }
        boolean jpeg = data.length >= 4 && data[0] == (byte) 0xff && data[1] == (byte) 0xd8
            && data[data.length - 2] == (byte) 0xff && data[data.length - 1] == (byte) 0xd9;
        boolean png = data.length >= 33 && Arrays.equals(data, 0, PNG_SIGNATURE.length,
            PNG_SIGNATURE, 0, PNG_SIGNATURE.length);
        if (data.length > MAX_IMAGE_BYTES || !(jpeg || png)) {
            throw error(400, "Прикрепите корректный JPEG или PNG размером до 12 МБ.");
        }
        if (png) {
            validatePng(data);
        }
        return data;
    }

    private static void validatePng(byte[] data) {
        if ((data[24] & 0xff) > 8) {
            throw error(400, BIT_DEPTH_ERROR);
        }
        var chunks = ByteBuffer.wrap(data).position(PNG_SIGNATURE.length);
        while (chunks.remaining() >= 12) {
            int length = chunks.getInt();
            int type = chunks.getInt();
            if (length < 0 || length > chunks.remaining() - 4) {
                break;
            }
            if (type == 0x6163544c) { // acTL must precede the first IDAT in an animated PNG.
                throw error(400, "Прикрепите статичную фотографию. Анимация не поддерживается.");
            }
            if (type == 0x49444154) { // IDAT
                return;
            }
            chunks.position(chunks.position() + length + 4);
        }
        throw error(400, "Фотография повреждена.");
    }

    private static Picture process(byte[] input, boolean material, String author, String capturedAt, Position position) {
        try (var stream = new MemoryCacheImageInputStream(new ByteArrayInputStream(input))) {
            var readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext()) {
                throw error(400, "Фотография повреждена.");
            }
            var reader = readers.next();
            try {
                reader.setInput(stream, true, true);
                int width = reader.getWidth(0);
                int height = reader.getHeight(0);
                if (width <= 0 || height <= 0 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE
                        || (long) width * height > MAX_IMAGE_PIXELS) {
                    throw error(400, "Разрешение фотографии слишком большое.");
                }
                if (!material && (Math.min(width, height) < 480 || Math.max(width, height) < 640)) {
                    throw error(400, "Фото слишком маленькое. Снимите его ещё раз.");
                }
                BufferedImage decoded = reader.read(0);
                BufferedImage image = decoded;
                try {
                    for (int bits : decoded.getColorModel().getComponentSize()) {
                        if (bits > 8) {
                            throw error(400, BIT_DEPTH_ERROR);
                        }
                    }
                    image = JpegOrientation.normalize(decoded, input);
                    if (!material) {
                        validateQuality(image);
                    }
                    byte[] original = LosslessWebp.encode(image);
                    byte[] display = material ? jpeg(image) : watermarked(image, author, capturedAt, position);
                    return new Picture(original, display, image.getWidth(), image.getHeight());
                } finally {
                    if (image != decoded) {
                        image.flush();
                    }
                    decoded.flush();
                }
            } finally {
                reader.dispose();
            }
        } catch (IOException e) {
            throw error(400, "Не удалось обработать фотографию. Снимите её ещё раз.");
        }
    }

    private static void validateQuality(BufferedImage image) {
        int width = image.getWidth();
        int height = image.getHeight();
        int size = 192;
        int[][] light = new int[size][size];
        long lightSum = 0;
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                int rgb = image.getRGB((x * width + width / 2) / size, (y * height + height / 2) / size);
                int level = (77 * ((rgb >>> 16) & 255) + 150 * ((rgb >>> 8) & 255) + 29 * (rgb & 255)) >>> 8;
                light[y][x] = level;
                lightSum += level;
            }
        }
        if (lightSum < 35L * size * size) {
            throw error(400, "Фото слишком тёмное. Добавьте света и снимите ещё раз.");
        }
        long edgeSum = 0;
        for (int y = 1; y < size - 1; y++) {
            for (int x = 1; x < size - 1; x++) {
                int edge = 4 * light[y][x] - light[y - 1][x] - light[y + 1][x] - light[y][x - 1] - light[y][x + 1];
                edgeSum += (long) edge * edge;
            }
        }
        int samples = (size - 2) * (size - 2);
        if (edgeSum < 20L * samples) {
            throw error(400, "Фото размыто или на нём мало деталей. Снимите ещё раз.");
        }
    }

    private static byte[] watermarked(BufferedImage source, String author, String capturedAt, Position position)
        throws IOException {
        double scale = Math.min(1.0, 1920.0 / Math.max(source.getWidth(), source.getHeight()));
        int width = (int) Math.round(source.getWidth() * scale);
        int height = (int) Math.round(source.getHeight() * scale);
        int fontSize = Math.max(14, width / 43);
        int padding = fontSize;
        int band = fontSize * 4;
        var result = new BufferedImage(width, height + band, BufferedImage.TYPE_INT_RGB);
        var graphics = result.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            graphics.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            graphics.drawImage(source, 0, 0, width, height, null);
            graphics.setColor(new Color(20, 27, 36));
            graphics.fillRect(0, height, width, band);
            graphics.setColor(Color.WHITE);
            graphics.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, fontSize));
            String time = DateTimeFormatter.ISO_INSTANT.format(Instant.parse(capturedAt).truncatedTo(java.time.temporal.ChronoUnit.SECONDS));
            String coordinates = position.latitude() == null ? "Геопозиция недоступна" :
                String.format(Locale.ROOT, "%.5f, %.5f", position.latitude(), position.longitude());
            String[] lines = {"qwork · " + author, time, coordinates};
            for (int index = 0; index < lines.length; index++) {
                String line = lines[index];
                var metrics = graphics.getFontMetrics();
                while (line.length() > 1 && metrics.stringWidth(line) > width - 2 * padding) {
                    line = line.substring(0, line.offsetByCodePoints(line.length(), -1));
                }
                graphics.drawString(line, padding, height + fontSize * (index + 1) + fontSize / 4);
            }
            return jpeg(result);
        } finally {
            graphics.dispose();
            result.flush();
        }
    }

    private static byte[] jpeg(BufferedImage source) throws IOException {
        BufferedImage preview = source;
        if (source.getType() != BufferedImage.TYPE_INT_RGB && source.getType() != BufferedImage.TYPE_3BYTE_BGR
                && source.getType() != BufferedImage.TYPE_BYTE_GRAY) {
            preview = new BufferedImage(source.getWidth(), source.getHeight(), BufferedImage.TYPE_INT_RGB);
            var graphics = preview.createGraphics();
            try {
                graphics.setColor(Color.WHITE);
                graphics.fillRect(0, 0, preview.getWidth(), preview.getHeight());
                graphics.drawImage(source, 0, 0, null);
            } finally {
                graphics.dispose();
            }
        }
        var bytes = new ByteArrayOutputStream();
        try (var stream = new MemoryCacheImageOutputStream(bytes)) {
            if (!ImageIO.write(preview, "jpeg", stream)) {
                throw new IOException("Missing JPEG encoder");
            }
        } finally {
            if (preview != source) {
                preview.flush();
            }
        }
        return bytes.toByteArray();
    }

    private static String sha256(byte[] data) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
