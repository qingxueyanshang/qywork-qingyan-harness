//! SPA POD：PipeWire 参数的二进制格式。只实现拉一帧要用的三件：声明接受的视频格式、
//! 要求 VideoCrop 与 Header 元数据、从协商结果里读出像素格式与尺寸。
//!
//! 每个 POD 是 8 字节头（正文字节数、类型）加正文，正文按 8 字节补齐，头里的字节数不含补齐。
//! 对象的正文是（对象类型、参数号）加一串属性；属性是（键、标志）加一个 POD。
//! 选择（Choice）的正文是（选择类型、标志）、元素的 POD 头，再接元素值。本模块不调任何接口。

const TYPE_ID: u32 = 3;
const TYPE_INT: u32 = 4;
const TYPE_RECTANGLE: u32 = 10;
const TYPE_OBJECT: u32 = 15;
const TYPE_CHOICE: u32 = 19;

const OBJECT_FORMAT: u32 = 0x4_0003;
const OBJECT_PARAM_META: u32 = 0x4_0005;

const PARAM_ENUM_FORMAT: u32 = 3;
/// `param_changed` 里协商好的格式的参数号。
pub const PARAM_FORMAT: u32 = 4;
const PARAM_META: u32 = 6;

const FORMAT_MEDIA_TYPE: u32 = 1;
const FORMAT_MEDIA_SUBTYPE: u32 = 2;
const FORMAT_VIDEO_FORMAT: u32 = 0x2_0001;
const FORMAT_VIDEO_SIZE: u32 = 0x2_0003;
const MEDIA_TYPE_VIDEO: u32 = 2;
const MEDIA_SUBTYPE_RAW: u32 = 1;

const CHOICE_NONE: u32 = 0;
const CHOICE_RANGE: u32 = 1;
const CHOICE_ENUM: u32 = 3;

const PARAM_META_TYPE: u32 = 1;
const PARAM_META_SIZE: u32 = 2;
pub const META_HEADER: u32 = 1;
pub const META_VIDEO_CROP: u32 = 2;
/// `spa_meta_header` 与 `spa_meta_region` 的字节数。
const META_HEADER_SIZE: u32 = 32;
const META_REGION_SIZE: u32 = 16;

/// 每像素 4 字节、每通道 8 位的几种排法，值是 `spa_video_format`。
pub const VIDEO_RGBX: u32 = 7;
pub const VIDEO_BGRX: u32 = 8;
pub const VIDEO_XRGB: u32 = 9;
pub const VIDEO_XBGR: u32 = 10;
pub const VIDEO_RGBA: u32 = 11;
pub const VIDEO_BGRA: u32 = 12;
pub const VIDEO_ARGB: u32 = 13;
pub const VIDEO_ABGR: u32 = 14;

/// 声明接受的格式，按偏好排。只要不带 alpha 的与带 alpha 的 8 位四通道：不声明 modifier，
/// 合成器因此只给共享内存缓冲区，不给要经 GPU 才读得到的 DMA-BUF。
const ACCEPTED: [u32; 8] = [
    VIDEO_BGRX, VIDEO_BGRA, VIDEO_RGBX, VIDEO_RGBA, VIDEO_XRGB, VIDEO_XBGR, VIDEO_ARGB, VIDEO_ABGR,
];

/// 协商好的视频格式：像素排法与帧的像素尺寸。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoFormat {
    pub format: u32,
    pub width: u32,
    pub height: u32,
}

struct Builder {
    bytes: Vec<u8>,
}

impl Builder {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn word(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_ne_bytes());
    }

    fn pad(&mut self) {
        while self.bytes.len() % 8 != 0 {
            self.bytes.push(0);
        }
    }

    /// 写一个 POD 头，交回字节数那一格的位置，由 `end` 回填。
    fn begin(&mut self, kind: u32) -> usize {
        let at = self.bytes.len();
        self.word(0);
        self.word(kind);
        at
    }

    fn end(&mut self, at: usize) {
        let size = u32::try_from(self.bytes.len() - at - 8).unwrap_or(u32::MAX);
        self.bytes[at..at + 4].copy_from_slice(&size.to_ne_bytes());
        self.pad();
    }

    fn scalar(&mut self, kind: u32, value: u32) {
        let at = self.begin(kind);
        self.word(value);
        self.end(at);
    }

    fn prop(&mut self, key: u32) {
        self.word(key);
        self.word(0);
    }
}

/// 拉流时声明接受的格式（`EnumFormat`）。尺寸不限，由合成器按流定。
pub fn enum_format() -> Vec<u8> {
    let mut b = Builder::new();
    let object = b.begin(TYPE_OBJECT);
    b.word(OBJECT_FORMAT);
    b.word(PARAM_ENUM_FORMAT);
    b.prop(FORMAT_MEDIA_TYPE);
    b.scalar(TYPE_ID, MEDIA_TYPE_VIDEO);
    b.prop(FORMAT_MEDIA_SUBTYPE);
    b.scalar(TYPE_ID, MEDIA_SUBTYPE_RAW);
    b.prop(FORMAT_VIDEO_FORMAT);
    let choice = b.begin(TYPE_CHOICE);
    b.word(CHOICE_ENUM);
    b.word(0);
    b.word(4);
    b.word(TYPE_ID);
    // 枚举的第一个值是默认值，后面才是可选项。
    b.word(ACCEPTED[0]);
    for format in ACCEPTED {
        b.word(format);
    }
    b.end(choice);
    b.prop(FORMAT_VIDEO_SIZE);
    let choice = b.begin(TYPE_CHOICE);
    b.word(CHOICE_RANGE);
    b.word(0);
    b.word(8);
    b.word(TYPE_RECTANGLE);
    for (w, h) in [(1280, 800), (1, 1), (16_384, 16_384)] {
        b.word(w);
        b.word(h);
    }
    b.end(choice);
    b.end(object);
    b.bytes
}

/// 要求缓冲区带上的一种元数据（`Meta`）。
pub fn meta(kind: u32) -> Vec<u8> {
    let size = if kind == META_HEADER {
        META_HEADER_SIZE
    } else {
        META_REGION_SIZE
    };
    let mut b = Builder::new();
    let object = b.begin(TYPE_OBJECT);
    b.word(OBJECT_PARAM_META);
    b.word(PARAM_META);
    b.prop(PARAM_META_TYPE);
    b.scalar(TYPE_ID, kind);
    b.prop(PARAM_META_SIZE);
    b.scalar(TYPE_INT, size);
    b.end(object);
    b.bytes
}

fn word_at(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at + 4)?;
    Some(u32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
}

/// 一个 POD 的整段字节数（头加正文）。`head` 至少要有 8 字节。
pub fn total_len(head: &[u8]) -> Option<usize> {
    word_at(head, 0)
        .and_then(|size| usize::try_from(size).ok())
        .map(|size| size + 8)
}

/// 属性值里的第一个值：直接给的值，或选择里的默认值。交回（值的类型，值的字节起点）。
fn first_value(pod: &[u8], at: usize) -> Option<(u32, usize)> {
    let kind = word_at(pod, at + 4)?;
    if kind != TYPE_CHOICE {
        return Some((kind, at + 8));
    }
    let choice = word_at(pod, at + 8)?;
    if ![CHOICE_NONE, CHOICE_RANGE, CHOICE_ENUM].contains(&choice) {
        return None;
    }
    Some((word_at(pod, at + 20)?, at + 24))
}

/// 从协商好的 `Format` 对象里读出像素排法与尺寸。缺任何一项交回 `None`。
pub fn video_format(pod: &[u8]) -> Option<VideoFormat> {
    if word_at(pod, 4)? != TYPE_OBJECT {
        return None;
    }
    let end = total_len(pod)?.min(pod.len());
    let mut at = 16;
    let mut format = None;
    let mut size = None;
    while at + 16 <= end {
        let key = word_at(pod, at)?;
        let value_len = usize::try_from(word_at(pod, at + 8)?).ok()?;
        match (key, first_value(pod, at + 8)) {
            (FORMAT_VIDEO_FORMAT, Some((TYPE_ID, v))) => format = word_at(pod, v),
            (FORMAT_VIDEO_SIZE, Some((TYPE_RECTANGLE, v))) => {
                size = Some((word_at(pod, v)?, word_at(pod, v + 4)?));
            }
            _ => {}
        }
        at += 8 + (8 + value_len).div_ceil(8) * 8;
    }
    let (width, height) = size?;
    Some(VideoFormat {
        format: format?,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 声明的格式经同一个解析读回来是默认值：偏好的第一种格式与默认尺寸。
    #[test]
    fn the_enum_format_reads_back_its_defaults() {
        let pod = enum_format();
        assert_eq!(pod.len() % 8, 0);
        assert_eq!(total_len(&pod), Some(pod.len()));
        assert_eq!(
            video_format(&pod),
            Some(VideoFormat {
                format: VIDEO_BGRX,
                width: 1280,
                height: 800,
            })
        );
    }

    /// 协商结果的形状：属性直接给值，不带选择。
    #[test]
    fn a_fixed_format_gives_its_format_and_size() {
        let mut b = Builder::new();
        let object = b.begin(TYPE_OBJECT);
        b.word(OBJECT_FORMAT);
        b.word(PARAM_FORMAT);
        b.prop(FORMAT_MEDIA_TYPE);
        b.scalar(TYPE_ID, MEDIA_TYPE_VIDEO);
        b.prop(FORMAT_VIDEO_FORMAT);
        b.scalar(TYPE_ID, VIDEO_BGRA);
        b.prop(FORMAT_VIDEO_SIZE);
        let rect = b.begin(TYPE_RECTANGLE);
        b.word(2560);
        b.word(1600);
        b.end(rect);
        b.end(object);
        assert_eq!(
            video_format(&b.bytes),
            Some(VideoFormat {
                format: VIDEO_BGRA,
                width: 2560,
                height: 1600,
            })
        );
    }

    #[test]
    fn a_format_without_a_size_or_of_another_type_is_not_read() {
        let mut b = Builder::new();
        let object = b.begin(TYPE_OBJECT);
        b.word(OBJECT_FORMAT);
        b.word(PARAM_FORMAT);
        b.prop(FORMAT_VIDEO_FORMAT);
        b.scalar(TYPE_ID, VIDEO_BGRX);
        b.end(object);
        assert_eq!(video_format(&b.bytes), None);
        assert_eq!(video_format(&meta(META_VIDEO_CROP)[..8]), None);
        let mut int = Builder::new();
        int.scalar(TYPE_INT, 5);
        assert_eq!(video_format(&int.bytes), None);
    }

    /// 元数据参数：类型是 Id，尺寸是对应结构体的字节数。
    #[test]
    fn a_meta_param_carries_the_meta_type_and_its_size() {
        let crop = meta(META_VIDEO_CROP);
        assert_eq!(word_at(&crop, 4), Some(TYPE_OBJECT));
        assert_eq!(word_at(&crop, 8), Some(OBJECT_PARAM_META));
        assert_eq!(word_at(&crop, 12), Some(PARAM_META));
        // 第一个属性：键、标志、Id 头、值。
        assert_eq!(word_at(&crop, 16), Some(PARAM_META_TYPE));
        assert_eq!(word_at(&crop, 28), Some(TYPE_ID));
        assert_eq!(word_at(&crop, 32), Some(META_VIDEO_CROP));
        assert_eq!(word_at(&crop, 56), Some(META_REGION_SIZE));
        assert_eq!(word_at(&meta(META_HEADER), 56), Some(META_HEADER_SIZE));
    }
}
