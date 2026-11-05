package qwork;

import java.awt.image.BufferedImage;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Applies EXIF orientation to JPEG pixels before the upload metadata is removed. */
final class JpegOrientation {
    private JpegOrientation() {}

    static BufferedImage normalize(BufferedImage image, byte[] source) {
        int orientation = orientation(source);
        if (orientation == 1) return image;

        int width = image.getWidth();
        int height = image.getHeight();
        boolean swapAxes = orientation >= 5;
        var result = new BufferedImage(swapAxes ? height : width, swapAxes ? width : height,
            BufferedImage.TYPE_INT_RGB);
        var row = new int[width];
        for (int y = 0; y < height; y++) {
            image.getRGB(0, y, width, 1, row, 0, width);
            for (int x = 0; x < width; x++) {
                switch (orientation) {
                    case 2 -> result.setRGB(width - 1 - x, y, row[x]);
                    case 3 -> result.setRGB(width - 1 - x, height - 1 - y, row[x]);
                    case 4 -> result.setRGB(x, height - 1 - y, row[x]);
                    case 5 -> result.setRGB(y, x, row[x]);
                    case 6 -> result.setRGB(height - 1 - y, x, row[x]);
                    case 7 -> result.setRGB(height - 1 - y, width - 1 - x, row[x]);
                    case 8 -> result.setRGB(y, width - 1 - x, row[x]);
                    default -> throw new AssertionError("Invalid EXIF orientation");
                }
            }
        }
        return result;
    }

    private static int orientation(byte[] jpeg) {
        if (jpeg.length < 2 || jpeg[0] != (byte) 0xff || jpeg[1] != (byte) 0xd8) return 1;

        int offset = 2;
        while (offset < jpeg.length && jpeg[offset] == (byte) 0xff) {
            while (offset < jpeg.length && jpeg[offset] == (byte) 0xff) offset++;
            if (offset == jpeg.length) break;
            int marker = jpeg[offset++] & 0xff;
            if (marker == 0xda || marker == 0xd9) break;
            if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            if (jpeg.length - offset < 2) break;
            int length = ((jpeg[offset] & 0xff) << 8) | (jpeg[offset + 1] & 0xff);
            if (length < 2 || length > jpeg.length - offset) break;
            if (marker == 0xe1 && length >= 16 && jpeg[offset + 2] == 'E' && jpeg[offset + 3] == 'x'
                && jpeg[offset + 4] == 'i' && jpeg[offset + 5] == 'f'
                && jpeg[offset + 6] == 0 && jpeg[offset + 7] == 0) {
                return tiffOrientation(ByteBuffer.wrap(jpeg, offset + 8, length - 8).slice());
            }
            offset += length;
        }
        return 1;
    }

    private static int tiffOrientation(ByteBuffer data) {
        int order = data.getShort(0);
        if (order == 0x4949) data.order(ByteOrder.LITTLE_ENDIAN);
        else if (order != 0x4d4d) return 1;
        if (data.getShort(2) != 42) return 1;

        long directory = Integer.toUnsignedLong(data.getInt(4));
        if (directory < 8 || directory > data.limit() - 2) return 1;
        int entries = Short.toUnsignedInt(data.getShort((int) directory));
        int entry = (int) directory + 2;
        if (entries > (data.limit() - entry) / 12) return 1;
        for (int index = 0; index < entries; index++, entry += 12) {
            if (data.getShort(entry) == 0x0112 && data.getShort(entry + 2) == 3 && data.getInt(entry + 4) == 1) {
                int orientation = data.getShort(entry + 8);
                return orientation >= 1 && orientation <= 8 ? orientation : 1;
            }
        }
        return 1;
    }
}
