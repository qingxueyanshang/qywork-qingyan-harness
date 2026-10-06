//! 后台语义动作：按动作获取接口、判定前置条件，然后经由 `backend::dispatch_call` 发出。
//!
//! 前置条件在此处判定：只读、越界、接口或动作缺失都可证明未发出调用，归入
//! `not_dispatched`。应用对调用返回 `false` 时记为结果未知：调用已送达应用。

use atspi::proxy::accessible::AccessibleProxyBlocking;
use atspi::proxy::action::ActionProxyBlocking;
use atspi::proxy::editable_text::EditableTextProxyBlocking;
use atspi::proxy::selection::SelectionProxyBlocking;
use atspi::proxy::text::TextProxyBlocking;
use atspi::proxy::value::ValueProxyBlocking;
use atspi::{Interface, State};
use zbus::blocking::Connection;

use super::bus::{Failure, Obj};
use super::node::{self, Axis, Click};
use super::text;
use super::walk::{self, Located};
use crate::backend::{dispatch_call, Attempt, Job, Outcome, Watch};
use crate::protocol::{
    toggle_steps, ActionSpec, Dispatch, ScrollDirection, ScrollStep, ToggleState,
};

/// 一次 `set_toggle` 最多切换的次数。三态循环最长三步。
///
/// 到达目标状态即停止，不按 `toggle_steps` 计算的步数执行到底：Qt 从中间态切换到未选中，GTK 3 从中间态
/// 切换到选中，两个工具包的循环顺序不同，按固定步数会停在其他状态。
const MAX_TOGGLE_STEPS: u32 = 3;

/// 执行一个后台动作。`parent` 是目标的父对象，经由其 Selection 接口修改选中项。
pub fn perform(
    conn: &Connection,
    watch: &dyn Watch,
    target: &Located,
    parent: Option<&Obj>,
    action: &ActionSpec,
) -> Attempt {
    if let ActionSpec::SetToggle { state } = action {
        return set_toggle(conn, watch, target, *state);
    }
    match plan(conn, target, parent, action) {
        Ok(job) => dispatch_call(watch, job),
        Err(reason) => Attempt::Refused(reason),
    }
}

/// 把应用对调用返回的布尔值转换为调用结果。
fn accepted(step: &'static str, result: zbus::Result<bool>) -> Result<(), String> {
    match result {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("declined: 应用对 {step} 返回 false")),
        Err(e) => Err(Failure::from_zbus(step, &e).into_reason()),
    }
}

fn missing(what: &str) -> String {
    format!("pattern_missing: {what}")
}

fn proxy<P>(conn: &Connection, obj: &Obj) -> Result<P, String>
where
    P: zbus::blocking::proxy::ProxyImpl<'static> + From<zbus::Proxy<'static>>,
{
    obj.proxy(conn).map_err(Failure::into_reason)
}

fn do_action(conn: &Connection, obj: &Obj, index: i32) -> Result<Job, String> {
    let action: ActionProxyBlocking = proxy(conn, obj)?;
    Ok(Box::new(move || {
        accepted("DoAction", action.do_action(index))
    }))
}

/// 目标在父对象子节点中的下标，即 Selection 接口使用的下标。
fn child_index(target: &Located) -> Result<i32, String> {
    target
        .path
        .last()
        .and_then(|i| i32::try_from(*i).ok())
        .ok_or_else(|| "missing_target: 窗口根没有父对象，无法经由 Selection 修改选中项".to_owned())
}

/// 一次动作的准入判定与调用构造。`Err` 一律表示可证明未发出调用。
fn plan(
    conn: &Connection,
    target: &Located,
    parent: Option<&Obj>,
    action: &ActionSpec,
) -> Result<Job, String> {
    let facts = &target.facts;
    let obj = &target.obj;
    let claimed = node::claim(facts);
    match action {
        ActionSpec::Invoke => match claimed {
            Some(Click::Invoke(index)) => do_action(conn, obj, index),
            _ => Err(missing("该控件没有默认动作")),
        },
        ActionSpec::SetValue { value } => {
            if !facts.interfaces.contains(Interface::EditableText) {
                return Err(missing("该控件未实现 EditableText，无法在后台设置文本"));
            }
            if !node::editable(facts) {
                return Err("read_only".to_owned());
            }
            let editable: EditableTextProxyBlocking = proxy(conn, obj)?;
            let value = value.clone();
            Ok(Box::new(move || {
                accepted("SetTextContents", editable.set_text_contents(&value))
            }))
        }
        ActionSpec::SetRangeValue { value } => {
            if !facts.interfaces.contains(Interface::Value) {
                return Err(missing("Value"));
            }
            if node::range_read_only(facts) {
                return Err("read_only".to_owned());
            }
            let numbers = walk::numbers(conn, obj).map_err(Failure::into_reason)?;
            // 越界时不截取到边界值：截取后的值看似合法，但不是调用方请求的值。
            if numbers.min.is_finite()
                && numbers.max.is_finite()
                && (*value < numbers.min || *value > numbers.max)
            {
                return Err(format!(
                    "out_of_range: {value}，允许范围为 {} 到 {}",
                    numbers.min, numbers.max
                ));
            }
            set_number(conn, obj, *value)
        }
        ActionSpec::Select => match claimed {
            Some(Click::Select(index)) => do_action(conn, obj, index),
            _ => {
                let (container, index) = selection(conn, target, parent)?;
                Ok(Box::new(move || {
                    // 选中即替换为该项：已有其他选中项时先清空。只有该项被选中时不清空：
                    // 要求始终有一项被选中的容器会拒绝清空。
                    let selected = container
                        .n_selected_children()
                        .map_err(|e| Failure::from_zbus("读取选中项数", &e).into_reason())?;
                    let only_this = selected == 1
                        && container
                            .is_child_selected(index)
                            .map_err(|e| Failure::from_zbus("读取选中状态", &e).into_reason())?;
                    if selected > 0 && !only_this {
                        accepted("ClearSelection", container.clear_selection())?;
                    }
                    accepted("SelectChild", container.select_child(index))
                }))
            }
        },
        ActionSpec::AddToSelection | ActionSpec::RemoveFromSelection => {
            let multiple = node::selectable_in(facts, target.context)
                .ok_or_else(|| missing("父对象没有可用的 Selection"))?;
            // 在单选容器上增选会替换已有的选中项：可证明无法完成调用方请求的操作。
            if !multiple {
                return Err(
                    "single_selection_only: 该容器一次只能选择一项 · 改用 select".to_owned(),
                );
            }
            let (container, index) = selection(conn, target, parent)?;
            let add = matches!(action, ActionSpec::AddToSelection);
            Ok(Box::new(move || {
                if add {
                    accepted("SelectChild", container.select_child(index))
                } else {
                    accepted("DeselectChild", container.deselect_child(index))
                }
            }))
        }
        ActionSpec::Expand | ActionSpec::Collapse => {
            let Some(Click::Expand(index)) = claimed else {
                return Err(missing("该控件没有展开动作"));
            };
            let expanded = facts.states.contains(State::Expanded);
            let expand = matches!(action, ActionSpec::Expand);
            if expand == expanded {
                return Err(format!(
                    "already_in_state: {}",
                    if expanded { "expanded" } else { "collapsed" }
                ));
            }
            do_action(conn, obj, index)
        }
        ActionSpec::Scroll { direction, step } => {
            let (axis, _) = node::scroll_bar(facts).ok_or_else(|| missing("滚动条的 Value"))?;
            let vertical = matches!(direction, ScrollDirection::Up | ScrollDirection::Down);
            if vertical != (axis == Axis::Vertical) {
                return Err("not_scrollable: 该方向无法滚动".to_owned());
            }
            if *step == ScrollStep::Page {
                return Err("page_step_unavailable: AT-SPI 的滚动条不提供页步长 · 改用 step=line 或 set_range_value".to_owned());
            }
            let numbers = walk::numbers(conn, obj).map_err(Failure::into_reason)?;
            if numbers.increment <= 0.0 {
                return Err("line_step_unavailable: 该滚动条未提供步长 · 改用 set_range_value".to_owned());
            }
            let forward = matches!(direction, ScrollDirection::Down | ScrollDirection::Right);
            let delta = if forward { numbers.increment } else { -numbers.increment };
            let next = (numbers.current + delta).clamp(numbers.min, numbers.max);
            if (next - numbers.current).abs() < f64::EPSILON {
                return Err("not_scrollable: 已滚动到尽头".to_owned());
            }
            set_number(conn, obj, next)
        }
        ActionSpec::SelectText { start, length } => {
            if !node::text_selectable(facts) {
                return Err("selection_unsupported: 该控件不支持选区".to_owned());
            }
            let (from, to) = text::char_range(conn, obj, *start, *length)?;
            let text: TextProxyBlocking = proxy(conn, obj)?;
            Ok(Box::new(move || {
                // GTK 3 的输入框在已有选区时拒绝 AddSelection，只能修改第 0 段。
                let existing = text
                    .get_n_selections()
                    .map_err(|e| Failure::from_zbus("读取选区数量", &e).into_reason())?;
                if existing > 0 {
                    accepted("SetSelection", text.set_selection(0, from, to))
                } else {
                    accepted("AddSelection", text.add_selection(from, to))
                }
            }))
        }
        ActionSpec::ScrollIntoView => Err(
            "unsupported: scroll_into_view 在 Linux 上不提供，GTK 3 与 Qt 均未实现 Component.ScrollTo"
                .to_owned(),
        ),
        ActionSpec::RealizeItem { .. } => {
            Err("unsupported: realize_item 在 Linux 上不提供，AT-SPI 没有对应接口".to_owned())
        }
        // 以下各项由 `perform` 或调用方单独分派。逐条列出而不使用
        // `_` 通配：新增后台动作而遗漏接入时，必须在此处编译失败，而不是变为一条拒绝。
        ActionSpec::SetToggle { .. } => Err("not_planned: set_toggle 使用独立的执行路径".to_owned()),
        ActionSpec::Click { .. }
        | ActionSpec::Hover
        | ActionSpec::Drag { .. }
        | ActionSpec::Wheel { .. }
        | ActionSpec::TypeText { .. }
        | ActionSpec::PressKey { .. }
        | ActionSpec::Activate
        | ActionSpec::SetWindowState { .. }
        | ActionSpec::MoveWindow { .. }
        | ActionSpec::ResizeWindow { .. }
        | ActionSpec::CloseWindow => Err("not_planned: 前台动作不经由后台动作路径".to_owned()),
    }
}

fn set_number(conn: &Connection, obj: &Obj, value: f64) -> Result<Job, String> {
    let target: ValueProxyBlocking = proxy(conn, obj)?;
    Ok(Box::new(move || {
        target
            .set_current_value(value)
            .map_err(|e| Failure::from_zbus("设置 CurrentValue", &e).into_reason())
    }))
}

/// 目标所在的选择容器与目标在其中的下标。
fn selection(
    conn: &Connection,
    target: &Located,
    parent: Option<&Obj>,
) -> Result<(SelectionProxyBlocking<'static>, i32), String> {
    if node::selectable_in(&target.facts, target.context).is_none() {
        return Err(missing("父对象没有可用的 Selection"));
    }
    let parent = parent.ok_or_else(|| missing("父对象没有可用的 Selection"))?;
    Ok((proxy(conn, parent)?, child_index(target)?))
}

/// 把复选控件切换到目标状态。每次切换后重读状态，到达即停止。
fn set_toggle(
    conn: &Connection,
    watch: &dyn Watch,
    target: &Located,
    want: ToggleState,
) -> Attempt {
    let Some(Click::Toggle(index)) = node::claim(&target.facts) else {
        return Attempt::Refused(missing("该控件没有切换动作"));
    };
    let read = || -> Result<ToggleState, String> {
        let accessible: AccessibleProxyBlocking = proxy(conn, &target.obj)?;
        accessible
            .get_state()
            .map(node::toggle_state)
            .map_err(|e| Failure::from_zbus("读取复选状态", &e).into_reason())
    };
    let current = match read() {
        Ok(s) => s,
        Err(reason) => return Attempt::Refused(reason),
    };
    if current == want {
        return Attempt::Refused(format!(
            "already_in_state: 该控件已处于 {}",
            want.as_str()
        ));
    }
    let tri_state = current == ToggleState::Indeterminate || want == ToggleState::Indeterminate;
    if toggle_steps(current, want, tri_state).is_none() {
        return Attempt::Refused(format!(
            "toggle_state_unsupported: 无法切换到 {}",
            want.as_str()
        ));
    }
    let mut last = current;
    for press in 0..MAX_TOGGLE_STEPS {
        let job = match do_action(conn, &target.obj, index) {
            Ok(job) => job,
            Err(reason) if press == 0 => return Attempt::Refused(reason),
            Err(reason) => {
                return Attempt::Called(Outcome::returned(Dispatch::Unknown, Some(reason)))
            }
        };
        match dispatch_call(watch, job) {
            Attempt::Called(outcome)
                if outcome.dispatch == Dispatch::Submitted && outcome.returned => {}
            other => return other,
        }
        match read() {
            Ok(state) => {
                last = state;
                if state == want {
                    return Attempt::Called(Outcome::returned(Dispatch::Submitted, None));
                }
            }
            // 无法读取状态时不再切换：继续切换将无法确定最终状态。
            Err(reason) => {
                return Attempt::Called(Outcome::returned(
                    Dispatch::Unknown,
                    Some(format!("按下后无法读取状态：{reason}")),
                ))
            }
        }
    }
    Attempt::Called(Outcome::returned(
        Dispatch::Unknown,
        Some(format!(
            "toggle_target_unreached: 切换 {MAX_TOGGLE_STEPS} 次后为 {}，目标为 {}",
            last.as_str(),
            want.as_str()
        )),
    ))
}
