//! AX、CF、CGWindowList 与显示器清单的轻量封装：CF 值转换为 `facts::Raw`，AX 错误码以整数原样返回。
//!
//! 本模块只负责调用与类型换算，判定一律位于纯换算模块中。

use std::ffi::c_void;
use std::ptr::NonNull;

use objc2_application_services::{
    AXCopyMultipleAttributeOptions, AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType,
};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFEqual, CFHash, CFNull, CFNumber, CFRange, CFRetained,
    CFString, CFType, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{
    kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer,
    kCGWindowName, kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID, CGDirectDisplayID,
    CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayMode, CGGetActiveDisplayList,
    CGPreflightScreenCaptureAccess, CGRectMakeWithDictionaryRepresentation,
    CGWindowListCopyWindowInfo, CGWindowListOption,
};

use crate::macos::pure::associate::CgWindow;
use crate::macos::pure::facts::{code, Frame, Raw};
use crate::macos::pure::identity::Handle;
use crate::macos::pure::plan::Setting;
use crate::macos::pure::screen::Display;

/// AX 元素引用：进程号加元素标识的令牌，按 `CFEqual` 比较。
#[derive(Clone)]
pub struct Element(CFRetained<AXUIElement>);

// SAFETY: 元素引用是不可变的 CF 对象，引用计数的增减是线程安全的；AX 客户端调用不绑定
// 调用线程。执行线程、等待线程与动作调用线程各自持有引用并各自发起调用。
unsafe impl Send for Element {}

impl Handle for Element {
    fn hash(&self) -> u64 {
        CFHash(Some(self.as_type())) as u64
    }

    fn same(&self, other: &Self) -> bool {
        CFEqual(Some(self.as_type()), Some(other.as_type()))
    }
}

fn status(err: AXError) -> Result<(), i32> {
    if err == AXError::Success {
        Ok(())
    } else {
        Err(err.0)
    }
}

/// 将出参中的 +1 引用包装为 `CFRetained`。调用成功但返回空指针时视为「没有值」。
///
/// # Safety
///
/// `ptr` 必须是按 Copy 规则返回、调用方持有一次引用的 `T`，或空指针。
unsafe fn owned<T: objc2_core_foundation::Type>(ptr: *const T) -> Result<CFRetained<T>, i32> {
    NonNull::new(ptr.cast_mut())
        .map(|p| unsafe { CFRetained::from_raw(p) })
        .ok_or(code::NO_VALUE)
}

impl Element {
    /// 系统范围元素。在该元素上设置的消息上界对本进程全局生效。
    pub fn system_wide() -> Self {
        // SAFETY: 无参数；系统保证返回非空引用。
        Self(unsafe { AXUIElement::new_system_wide() })
    }

    pub fn application(pid: i32) -> Self {
        // SAFETY: 任意进程号都能创建引用，进程不存在时后续调用返回错误码。
        Self(unsafe { AXUIElement::new_application(pid) })
    }

    fn as_type(&self) -> &CFType {
        &self.0
    }

    pub fn pid(&self) -> Result<i32, i32> {
        let mut pid: libc::pid_t = 0;
        // SAFETY: 出参指向本函数的局部变量。
        status(unsafe { self.0.pid(NonNull::from(&mut pid)) })?;
        Ok(pid)
    }

    fn copy(&self, attribute: &str) -> Result<CFRetained<CFType>, i32> {
        let name = CFString::from_str(attribute);
        let mut value: *const CFType = std::ptr::null();
        // SAFETY: 出参指向局部变量；成功时返回的引用归调用方。
        status(unsafe {
            self.0
                .copy_attribute_value(&name, NonNull::from(&mut value))
        })?;
        unsafe { owned(value) }
    }

    /// 属性的值。元素不支持该属性或该属性没有值时返回 `Raw::Missing`，其余错误返回错误码。
    pub fn raw(&self, attribute: &str) -> Result<Raw, i32> {
        match self.copy(attribute) {
            Ok(value) => Ok(raw(&value)),
            Err(code::ATTRIBUTE_UNSUPPORTED | code::NO_VALUE) => Ok(Raw::Missing),
            Err(e) => Err(e),
        }
    }

    /// 元素类型的属性（前台应用、焦点窗口、关闭按钮）。不支持、没有值或值不是元素时缺失。
    pub fn element(&self, attribute: &str) -> Result<Option<Element>, i32> {
        match self.copy(attribute) {
            Ok(value) => Ok(value.downcast::<AXUIElement>().ok().map(Element)),
            Err(code::ATTRIBUTE_UNSUPPORTED | code::NO_VALUE) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// 系统范围元素上的命中测试：全局坐标（点）处层级最深的元素。
    pub fn element_at(&self, x: f32, y: f32) -> Result<Element, i32> {
        let mut found: *const AXUIElement = std::ptr::null();
        // SAFETY: 出参指向局部变量；成功时返回的引用归调用方。
        status(unsafe {
            self.0
                .copy_element_at_position(x, y, NonNull::from(&mut found))
        })?;
        unsafe { owned(found) }.map(Element)
    }

    /// 元素数组类型的属性（子节点、窗口、选中行）。不支持或没有值时返回空表。
    pub fn elements(&self, attribute: &str) -> Result<Vec<Element>, i32> {
        match self.copy(attribute) {
            Ok(value) => Ok(elements(&value)),
            Err(code::ATTRIBUTE_UNSUPPORTED | code::NO_VALUE) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// 一次跨进程调用读取 `attributes` 与追加在末尾的 `children` 属性，前者按位置转换为 `Raw`，
    /// 后者转换为元素表。单项错误放在对应位置上，不使整次读取失败。
    pub fn batch(
        &self,
        attributes: &[&str],
        children: &str,
    ) -> Result<(Vec<Raw>, Vec<Element>), i32> {
        let mut names: Vec<CFRetained<CFString>> =
            attributes.iter().map(|a| CFString::from_str(a)).collect();
        names.push(CFString::from_str(children));
        let request = CFArray::from_retained_objects(&names);
        let mut values: *const CFArray = std::ptr::null();
        // SAFETY: 请求数组的元素都是 CFString；出参指向局部变量，成功时返回的数组归调用方。
        status(unsafe {
            self.0.copy_multiple_attribute_values(
                request.as_opaque(),
                AXCopyMultipleAttributeOptions::empty(),
                NonNull::from(&mut values),
            )
        })?;
        let values = unsafe { owned(values) }?;
        // SAFETY: 返回的数组按位置对应请求，每一项都是 CF 对象。
        let values: &CFArray<CFType> = unsafe { values.cast_unchecked() };
        let mut out: Vec<Raw> = Vec::with_capacity(attributes.len());
        let mut kids = Vec::new();
        for (i, value) in values.iter().enumerate() {
            if i < attributes.len() {
                out.push(raw(&value));
            } else if i == attributes.len() {
                kids = elements(&value);
            }
        }
        Ok((out, kids))
    }

    pub fn action_names(&self) -> Result<Vec<String>, i32> {
        let mut names: *const CFArray = std::ptr::null();
        // SAFETY: 出参指向局部变量；成功时返回的数组归调用方。
        let err = unsafe { self.0.copy_action_names(NonNull::from(&mut names)) };
        match status(err) {
            Ok(()) => {}
            // 没有动作的元素返回以下错误码之一，不属于失败。
            Err(code::ACTION_UNSUPPORTED | code::ATTRIBUTE_UNSUPPORTED | code::NO_VALUE) => {
                return Ok(Vec::new())
            }
            Err(e) => return Err(e),
        }
        let Ok(names) = (unsafe { owned(names) }) else {
            return Ok(Vec::new());
        };
        // SAFETY: 动作名数组的元素都是 CFString。
        let names: &CFArray<CFString> = unsafe { names.cast_unchecked() };
        Ok(names.iter().map(|n| n.to_string()).collect())
    }

    /// 该属性是否可写。元素不支持该属性时视为不可写。
    pub fn settable(&self, attribute: &str) -> Result<bool, i32> {
        let name = CFString::from_str(attribute);
        let mut settable: u8 = 0;
        // SAFETY: 出参指向局部变量。
        match status(unsafe {
            self.0
                .is_attribute_settable(&name, NonNull::from(&mut settable))
        }) {
            Ok(()) => Ok(settable != 0),
            Err(code::ATTRIBUTE_UNSUPPORTED | code::NO_VALUE) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn perform(&self, action: &str) -> Result<(), i32> {
        let name = CFString::from_str(action);
        // SAFETY: 参数都是有效的 CF 对象。
        status(unsafe { self.0.perform_action(&name) })
    }

    pub fn set(&self, attribute: &str, setting: &Setting) -> Result<(), i32> {
        match setting {
            Setting::Text(text) => self.set_value(attribute, &CFString::from_str(text)),
            Setting::Number(n) => self.set_value(attribute, &CFNumber::new_f64(*n)),
            Setting::Bool(b) => self.set_value(attribute, CFBoolean::new(*b)),
            Setting::Range { location, length } => {
                let mut range = CFRange::new(*location as isize, *length as isize);
                // SAFETY: 值指针指向与 `CFRange` 类型标记一致的局部变量，调用期间有效。
                let value = unsafe {
                    AXValue::new(
                        AXValueType::CFRange,
                        NonNull::from(&mut range).cast::<c_void>(),
                    )
                }
                .ok_or(code::FAILURE)?;
                self.set_value(attribute, &value)
            }
            Setting::Point { x, y } => {
                let mut point = CGPoint { x: *x, y: *y };
                // SAFETY: 值指针指向与 `CGPoint` 类型标记一致的局部变量，调用期间有效。
                let value = unsafe {
                    AXValue::new(
                        AXValueType::CGPoint,
                        NonNull::from(&mut point).cast::<c_void>(),
                    )
                }
                .ok_or(code::FAILURE)?;
                self.set_value(attribute, &value)
            }
            Setting::Size { width, height } => {
                let mut size = CGSize {
                    width: *width,
                    height: *height,
                };
                // SAFETY: 值指针指向与 `CGSize` 类型标记一致的局部变量，调用期间有效。
                let value = unsafe {
                    AXValue::new(
                        AXValueType::CGSize,
                        NonNull::from(&mut size).cast::<c_void>(),
                    )
                }
                .ok_or(code::FAILURE)?;
                self.set_value(attribute, &value)
            }
        }
    }

    /// 将元素数组类型的属性写为给定的元素表。
    pub fn set_elements(&self, attribute: &str, members: &[Element]) -> Result<(), i32> {
        let retained: Vec<CFRetained<AXUIElement>> = members.iter().map(|e| e.0.clone()).collect();
        let array = CFArray::from_retained_objects(&retained);
        self.set_value(attribute, array.as_opaque())
    }

    fn set_value(&self, attribute: &str, value: &CFType) -> Result<(), i32> {
        let name = CFString::from_str(attribute);
        // SAFETY: 参数都是有效的 CF 对象。
        status(unsafe { self.0.set_attribute_value(&name, value) })
    }

    pub fn set_messaging_timeout(&self, seconds: f32) -> Result<(), i32> {
        // SAFETY: 参数是有限正数，由调用方保证。
        status(unsafe { self.0.set_messaging_timeout(seconds) })
    }
}

/// 将 CF 值转换为 `Raw`。
fn raw(value: &CFType) -> Raw {
    if let Some(text) = value.downcast_ref::<CFString>() {
        return Raw::Text(text.to_string());
    }
    if let Some(flag) = value.downcast_ref::<CFBoolean>() {
        return Raw::Bool(flag.as_bool());
    }
    if let Some(number) = value.downcast_ref::<CFNumber>() {
        return number.as_f64().map_or(Raw::Other, Raw::Number);
    }
    if value.downcast_ref::<CFNull>().is_some() {
        return Raw::Missing;
    }
    let Some(boxed) = value.downcast_ref::<AXValue>() else {
        return Raw::Other;
    };
    // SAFETY: 每个分支的出参类型都与读取的类型标记一致。
    unsafe {
        match boxed.r#type() {
            AXValueType::CGPoint => {
                let mut p = CGPoint { x: 0.0, y: 0.0 };
                if boxed.value(AXValueType::CGPoint, NonNull::from(&mut p).cast()) {
                    return Raw::Point { x: p.x, y: p.y };
                }
            }
            AXValueType::CGSize => {
                let mut s = CGSize {
                    width: 0.0,
                    height: 0.0,
                };
                if boxed.value(AXValueType::CGSize, NonNull::from(&mut s).cast()) {
                    return Raw::Size {
                        width: s.width,
                        height: s.height,
                    };
                }
            }
            AXValueType::CFRange => {
                let mut r = CFRange::new(0, 0);
                if boxed.value(AXValueType::CFRange, NonNull::from(&mut r).cast()) {
                    return Raw::Range {
                        location: r.location as i64,
                        length: r.length as i64,
                    };
                }
            }
            // 批量读取把单项错误封装为该类型放在对应位置上。
            AXValueType::AXError => return Raw::Missing,
            _ => {}
        }
    }
    Raw::Other
}

/// CF 值中的 AX 元素。不是数组，或数组中的项不是元素时，跳过这些项。
fn elements(value: &CFType) -> Vec<Element> {
    let Some(array) = value.downcast_ref::<CFArray>() else {
        return Vec::new();
    };
    // SAFETY: 只把每一项作为 CF 对象读取，是否为元素逐项判定。
    let array: &CFArray<CFType> = unsafe { array.cast_unchecked() };
    array
        .iter()
        .filter_map(|item| item.downcast::<AXUIElement>().ok())
        .map(Element)
        .collect()
}

/// 本进程是否为受信任的辅助功能客户端。每次调用时实时查询：用户可以在 worker 运行期间开启或关闭授权。
pub fn trusted() -> bool {
    // SAFETY: 无参数。
    unsafe { AXIsProcessTrusted() }
}

/// 本进程是否有屏幕录制授权。只查询，不弹出授权框。
pub fn screen_capture_allowed() -> bool {
    CGPreflightScreenCaptureAccess()
}

/// 该进程当前是否存在。没有发送信号的权限（`EPERM`）同样说明进程存在。
pub fn alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: 信号 0 只做存在性与权限检查，不投递任何信号。
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// 当前使用的显示器：全局矩形（点）与每点像素数。无法读取清单时返回空表。
pub fn displays() -> Vec<Display> {
    const MAX_DISPLAYS: u32 = 32;
    let mut ids: [CGDirectDisplayID; MAX_DISPLAYS as usize] = [0; MAX_DISPLAYS as usize];
    let mut count: u32 = 0;
    // SAFETY: 两个出参都指向本函数的局部变量，数组长度与 `MAX_DISPLAYS` 一致。
    let err = unsafe { CGGetActiveDisplayList(MAX_DISPLAYS, ids.as_mut_ptr(), &mut count) };
    if err.0 != 0 {
        return Vec::new();
    }
    ids[..count.min(MAX_DISPLAYS) as usize]
        .iter()
        .map(|&id| {
            let bounds = CGDisplayBounds(id);
            let mode = CGDisplayCopyDisplayMode(id);
            let points = CGDisplayMode::width(mode.as_deref());
            let pixels = CGDisplayMode::pixel_width(mode.as_deref());
            Display {
                id,
                bounds: Frame {
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    width: bounds.size.width,
                    height: bounds.size.height,
                },
                // 无法读取显示模式时比例为 0，`screen::place` 不使用该显示器。
                scale: if points == 0 {
                    0.0
                } else {
                    pixels as f64 / points as f64
                },
            }
        })
        .collect()
}

/// 全部窗口，从前到后。不在屏幕上的窗口（最小化、隐藏、位于其他桌面空间）也包含在内。
pub fn cg_windows() -> Vec<CgWindow> {
    let option = CGWindowListOption::OptionAll | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(option, kCGNullWindowID) else {
        return Vec::new();
    };
    // SAFETY: 窗口信息数组的每一项都是以 CFString 为键的字典。
    let list: &CFArray<CFDictionary<CFString, CFType>> = unsafe { list.cast_unchecked() };
    list.iter().filter_map(|info| cg_window(&info)).collect()
}

fn cg_window(info: &CFDictionary<CFString, CFType>) -> Option<CgWindow> {
    // SAFETY: 这些键是系统导出的常量。
    let (number, pid, layer, bounds, on_screen, alpha, owner, name) = unsafe {
        (
            kCGWindowNumber,
            kCGWindowOwnerPID,
            kCGWindowLayer,
            kCGWindowBounds,
            kCGWindowIsOnscreen,
            kCGWindowAlpha,
            kCGWindowOwnerName,
            kCGWindowName,
        )
    };
    let number_of = |key: &CFString| {
        info.get(key)
            .and_then(|v| v.downcast_ref::<CFNumber>().and_then(CFNumber::as_f64))
    };
    let text_of = |key: &CFString| {
        info.get(key)
            .and_then(|v| v.downcast_ref::<CFString>().map(ToString::to_string))
            .unwrap_or_default()
    };
    let rect = info.get(bounds).and_then(|v| {
        let dict = v.downcast_ref::<CFDictionary>()?;
        let mut rect = CGRect::default();
        // SAFETY: 字典是窗口信息中的矩形表示；出参指向局部变量。
        unsafe { CGRectMakeWithDictionaryRepresentation(Some(dict), &mut rect) }.then(|| Frame {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        })
    });
    Some(CgWindow {
        number: u32::try_from(number_of(number)? as i64).ok()?,
        pid: i32::try_from(number_of(pid)? as i64).ok()?,
        layer: number_of(layer).map_or(0, |l| l as i32),
        bounds: rect
            .filter(|r| r.width > 0.0 && r.height > 0.0)
            .map(|r| r.rounded()),
        // 不在屏幕上的窗口没有该键。
        on_screen: info.get(on_screen).is_some_and(|v| match raw(&v) {
            Raw::Bool(b) => b,
            Raw::Number(n) => n != 0.0,
            _ => false,
        }),
        alpha: number_of(alpha).unwrap_or(1.0),
        owner: text_of(owner),
        name: text_of(name),
    })
}
