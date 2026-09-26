//! 采集帧的缩放与 PNG 编码。输入输出都是自上而下、每像素 3 字节的 RGB 行。
//!
//! 缩放按面积加权平均：每个输出像素取它在源图上覆盖的那一块，边上只覆盖一部分的源像素按
//! 覆盖比例计。不要改成最近邻取样：界面截图里一两个像素宽的文字笔画与边框会整条丢掉。

use miniz_oxide::deflate::compress_to_vec_zlib;

/// DEFLATE 的压缩级别。6 是 zlib 的缺省级别。
const LEVEL: u8 = 6;

/// 把 `width × height` 的 RGB 缩到 `out_width × out_height`。只用于缩小。
pub fn scale(rgb: &[u8], width: u32, height: u32, out_width: u32, out_height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let (ow, oh) = (out_width as usize, out_height as usize);
    let columns = taps(w, ow);
    let rows = taps(h, oh);
    // 先横向：每一源行缩成 `ow` 个像素。
    let mut wide = vec![0f32; ow * h * 3];
    for y in 0..h {
        let line = &rgb[y * w * 3..(y + 1) * w * 3];
        for (x, column) in columns.iter().enumerate() {
            let at = (y * ow + x) * 3;
            for &(source, weight) in column {
                for channel in 0..3 {
                    wide[at + channel] += f32::from(line[source * 3 + channel]) * weight;
                }
            }
        }
    }
    // 再纵向。
    let mut out = vec![0u8; ow * oh * 3];
    for (y, row) in rows.iter().enumerate() {
        for x in 0..ow {
            for channel in 0..3 {
                let sum: f32 = row
                    .iter()
                    .map(|&(source, weight)| wide[(source * ow + x) * 3 + channel] * weight)
                    .sum();
                out[(y * ow + x) * 3 + channel] = sum.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// 每个输出位置取哪些源位置、各占多少权重。一个输出位置的权重和为 1。
fn taps(source: usize, target: usize) -> Vec<Vec<(usize, f32)>> {
    let ratio = source as f64 / target as f64;
    (0..target)
        .map(|i| {
            let start = i as f64 * ratio;
            let end = (start + ratio).min(source as f64);
            let mut out = Vec::new();
            let mut at = start.floor() as usize;
            while (at as f64) < end && at < source {
                let covered = end.min(at as f64 + 1.0) - start.max(at as f64);
                if covered > 0.0 {
                    out.push((at, (covered / ratio) as f32));
                }
                at += 1;
            }
            out
        })
        .collect()
}

/// 编码成 8 位 RGB、不隔行的 PNG。
///
/// 每一行按五种滤波各算一遍，取滤波后字节按有符号数求绝对值之和最小的那一种。
pub fn encode(rgb: &[u8], width: u32, height: u32) -> Vec<u8> {
    let row = width as usize * 3;
    let mut filtered = Vec::with_capacity((row + 1) * height as usize);
    let blank = vec![0u8; row];
    let mut candidate = vec![0u8; row];
    let mut best = vec![0u8; row];
    for y in 0..height as usize {
        let line = &rgb[y * row..(y + 1) * row];
        let above = if y == 0 {
            &blank[..]
        } else {
            &rgb[(y - 1) * row..y * row]
        };
        let mut best_kind = 0u8;
        let mut best_cost = u64::MAX;
        for kind in 0..5u8 {
            filter(kind, line, above, &mut candidate);
            let cost: u64 = candidate
                .iter()
                .map(|&b| u64::from((b as i8).unsigned_abs()))
                .sum();
            if cost < best_cost {
                best_cost = cost;
                best_kind = kind;
                best.copy_from_slice(&candidate);
            }
        }
        filtered.push(best_kind);
        filtered.extend_from_slice(&best);
    }
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    // 位深 8、颜色类型 2（RGB）、压缩 0、滤波 0、不隔行。
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &compress_to_vec_zlib(&filtered, LEVEL));
    chunk(&mut out, b"IEND", &[]);
    out
}

/// 按 PNG 的第 `kind` 种滤波处理一行。每像素 3 字节，左邻取同一通道。
fn filter(kind: u8, line: &[u8], above: &[u8], out: &mut [u8]) {
    for i in 0..line.len() {
        let a = if i >= 3 { line[i - 3] } else { 0 };
        let b = above[i];
        let c = if i >= 3 { above[i - 3] } else { 0 };
        let predictor = match kind {
            0 => 0,
            1 => a,
            2 => b,
            3 => ((u16::from(a) + u16::from(b)) / 2) as u8,
            _ => paeth(a, b, c),
        };
        out[i] = line[i].wrapping_sub(predictor);
    }
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = i16::from(a) + i16::from(b) - i16::from(c);
    let pa = (p - i16::from(a)).abs();
    let pb = (p - i16::from(b)).abs();
    let pc = (p - i16::from(c)).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// 写一个数据块：长度、类型、数据，以及类型加数据的 CRC-32。
fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&u32::try_from(data.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(kind.iter().chain(data));
    out.extend_from_slice(&crc.to_be_bytes());
}

/// PNG 用的 CRC-32（多项式 0xEDB88320，初值与结果都取反）。
fn crc32<'a>(bytes: impl Iterator<Item = &'a u8>) -> u32 {
    const TABLE: [u32; 256] = {
        let mut table = [0u32; 256];
        let mut n = 0;
        while n < 256 {
            let mut c = n as u32;
            let mut k = 0;
            while k < 8 {
                c = if c & 1 == 1 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
                k += 1;
            }
            table[n] = c;
            n += 1;
        }
        table
    };
    !bytes.fold(!0u32, |c, &b| {
        TABLE[((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniz_oxide::inflate::decompress_to_vec_zlib;

    /// 解一张本模块编出来的 PNG：核对各块的 CRC，解压并逆滤波，交回尺寸与 RGB。
    fn decode(png: &[u8]) -> (u32, u32, Vec<u8>) {
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let mut at = 8;
        let mut size = (0u32, 0u32);
        let mut idat = Vec::new();
        while at < png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            let kind = &png[at + 4..at + 8];
            let data = &png[at + 8..at + 8 + len];
            let crc = u32::from_be_bytes(png[at + 8 + len..at + 12 + len].try_into().unwrap());
            assert_eq!(crc, crc32(kind.iter().chain(data)), "{:?} 块的 CRC", kind);
            match kind {
                b"IHDR" => {
                    size = (
                        u32::from_be_bytes(data[0..4].try_into().unwrap()),
                        u32::from_be_bytes(data[4..8].try_into().unwrap()),
                    );
                    assert_eq!(&data[8..], &[8, 2, 0, 0, 0]);
                }
                b"IDAT" => idat.extend_from_slice(data),
                _ => {}
            }
            at += 12 + len;
        }
        let raw = decompress_to_vec_zlib(&idat).expect("IDAT 解得开");
        let row = size.0 as usize * 3;
        let mut out: Vec<u8> = Vec::new();
        for y in 0..size.1 as usize {
            let kind = raw[y * (row + 1)];
            let line = &raw[y * (row + 1) + 1..(y + 1) * (row + 1)];
            for i in 0..row {
                let a = if i >= 3 { out[y * row + i - 3] } else { 0 };
                let b = if y > 0 { out[(y - 1) * row + i] } else { 0 };
                let c = if y > 0 && i >= 3 {
                    out[(y - 1) * row + i - 3]
                } else {
                    0
                };
                let predictor = match kind {
                    0 => 0,
                    1 => a,
                    2 => b,
                    3 => ((u16::from(a) + u16::from(b)) / 2) as u8,
                    4 => paeth(a, b, c),
                    other => panic!("未知滤波 {other}"),
                };
                out.push(line[i].wrapping_add(predictor));
            }
        }
        (size.0, size.1, out)
    }

    #[test]
    fn the_crc_matches_the_known_iend_value() {
        assert_eq!(crc32(b"IEND".iter()), 0xae42_6082);
    }

    /// 编出来的 PNG 解回来与原像素逐字节相同：渐变、纯色块与噪声都覆盖到五种滤波。
    #[test]
    fn an_encoded_image_decodes_back_to_the_same_pixels() {
        let (w, h) = (37u32, 23u32);
        let mut rgb = Vec::new();
        let mut seed = 7u32;
        for y in 0..h {
            for x in 0..w {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                let noise = (seed >> 16) as u8;
                let px = if y < 8 {
                    [x as u8 * 6, y as u8 * 9, 128]
                } else if y < 16 {
                    [200, 30, 30]
                } else {
                    [noise, noise.wrapping_mul(3), noise ^ 0x5a]
                };
                rgb.extend_from_slice(&px);
            }
        }
        let png = encode(&rgb, w, h);
        let (dw, dh, back) = decode(&png);
        assert_eq!((dw, dh), (w, h));
        assert_eq!(back, rgb);
    }

    /// 缩小按面积平均：整块同色的区域缩完仍是那个颜色，两色各半的像素取中间值。
    #[test]
    fn scaling_averages_the_area_each_output_pixel_covers() {
        // 4×2：左半红、右半蓝。
        let mut rgb = Vec::new();
        for _ in 0..2 {
            for x in 0..4 {
                rgb.extend_from_slice(if x < 2 { &[255, 0, 0] } else { &[0, 0, 255] });
            }
        }
        assert_eq!(scale(&rgb, 4, 2, 2, 1), vec![255, 0, 0, 0, 0, 255]);
        // 缩成 1×1：两色各占一半。
        assert_eq!(scale(&rgb, 4, 2, 1, 1), vec![128, 0, 128]);
        // 3 → 2：中间那一列一半归左、一半归右。
        let line = [0u8, 0, 0, 90, 90, 90, 180, 180, 180];
        assert_eq!(scale(&line, 3, 1, 2, 1), vec![30, 30, 30, 150, 150, 150]);
    }

    #[test]
    fn every_output_position_gets_weights_that_sum_to_one() {
        for (source, target) in [(1920, 1568), (1000, 7), (5, 3), (3, 3)] {
            for column in taps(source, target) {
                let total: f32 = column.iter().map(|t| t.1).sum();
                assert!((total - 1.0).abs() < 1e-4, "{source}→{target}: {total}");
            }
        }
    }
}
