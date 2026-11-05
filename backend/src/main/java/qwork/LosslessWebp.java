package qwork;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

final class LosslessWebp {
    private static final int MAX_ENCODED_BYTES = 64 * 1024 * 1024;
    private static final int ENCODE_TIMEOUT_SECONDS = 40;
    private static final int PIPE_TIMEOUT_SECONDS = 5;

    private LosslessWebp() {}

    static byte[] encode(BufferedImage image) {
        try {
            // Spool the output so a large WebP needs only one byte array on the JVM heap.
            Path output = Files.createTempFile("qwork-webp-", ".webp");
            try {
                encodeToFile(image, output);
                if (Files.size(output) > MAX_ENCODED_BYTES) throw unavailable("oversized_output");
                byte[] encoded = Files.readAllBytes(output);
                if (!isWebp(encoded)) throw unavailable("invalid_output");
                return encoded;
            } finally {
                Files.deleteIfExists(output);
            }
        } catch (IOException error) {
            throw unavailable("io_" + error.getClass().getSimpleName());
        }
    }

    private static void encodeToFile(BufferedImage image, Path output) throws IOException {
        Process encoder = new ProcessBuilder("cwebp", "-lossless", "-exact", "-z", "0", "-metadata", "none",
            "-quiet", "-o", "-", "--", "-").redirectOutput(output.toFile())
            .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        // Java 21 can pin a carrier thread on a blocking subprocess pipe.
        var pipe = Executors.newSingleThreadExecutor(Thread.ofPlatform().daemon().name("qwork-webp-pipe").factory());
        try {
            var input = pipe.submit(() -> {
                writePixels(encoder, image);
                return null;
            });
            if (!encoder.waitFor(ENCODE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw unavailable("timeout");
            }
            if (encoder.exitValue() != 0) throw unavailable("exit_" + encoder.exitValue());
            input.get(PIPE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw unavailable("interrupted");
        } catch (ExecutionException error) {
            throw unavailable("pipe_" + error.getCause().getClass().getSimpleName());
        } catch (TimeoutException error) {
            throw unavailable("pipe_timeout");
        } finally {
            encoder.destroyForcibly();
            pipe.shutdownNow();
        }
    }

    private static void writePixels(Process encoder, BufferedImage image) throws IOException {
        int width = image.getWidth();
        int height = image.getHeight();
        boolean alpha = image.getColorModel().hasAlpha();
        String header = alpha ? "P7\nWIDTH " + width + "\nHEIGHT " + height +
            "\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n" : "P6\n" + width + " " + height + "\n255\n";
        int[] pixels = new int[width];
        int channels = alpha ? 4 : 3;
        byte[] row = new byte[width * channels];
        try (var stream = encoder.getOutputStream()) {
            stream.write(header.getBytes(StandardCharsets.US_ASCII));
            for (int y = 0; y < height; y++) {
                image.getRGB(0, y, width, 1, pixels, 0, width);
                for (int x = 0; x < width; x++) {
                    int argb = pixels[x];
                    int offset = x * channels;
                    row[offset] = (byte) (argb >>> 16);
                    row[offset + 1] = (byte) (argb >>> 8);
                    row[offset + 2] = (byte) argb;
                    if (alpha) row[offset + 3] = (byte) (argb >>> 24);
                }
                stream.write(row);
            }
        }
    }

    static boolean isWebp(byte[] bytes) {
        return bytes.length >= 12 && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
            && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P';
    }

    private static Domain.Failure unavailable(String reason) {
        System.err.printf("qwork WebP conversion failed: %s%n", reason);
        return Domain.error(503, "Не удалось сохранить фото в WebP. Попробуйте ещё раз.");
    }
}
