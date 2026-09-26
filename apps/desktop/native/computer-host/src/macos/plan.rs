//! 后台语义动作的发法：按动作与元素事实挑一次 AX 调用，或给出「可证明没有发出调用」的拒绝原因。
//!
//! 本模块不调用 AX。拒绝一律是派发之前判得出的前置条件：只读、越界、缺发法、已在目标状态，
//! 归 `not_dispatched`。调用发出之后的结果由 FFI 层按 AX 错误码定，一律不在这里判。

use super::facts::{action, attr, on_boundary, utf16_len, Facts, Value};
use super::node::{self, Axis, Click, Context, Expander, Selector};
use crate::protocol::{toggle_steps, ActionSpec, ScrollDirection, ScrollStep, ToggleState};

/// 一次 AX 调用。
#[derive(Debug, Clone, PartialEq)]
pub enum Call {
    /// `AXUIElementPerformAction`。
    Perform(&'static str),
    /// `AXUIElementSetAttributeValue`。
    Set(&'static str, Setting),
    /// 把父元素这一项的选中集合写成只有目标元素。
    SelectInParent(&'static str),
}

/// 写进属性的值。
#[derive(Debug, Clone, PartialEq)]
pub enum Setting {
    Text(String),
    Number(f64),
    Bool(bool),
    /// `CFRange`，UTF-16 码元。
    Range {
        location: u32,
        length: u32,
    },
}

/// 一次 `set_toggle` 最多按几下。三态环最长三格。
///
/// 按到目标态即停，不按 `toggle_steps` 算出的格数按满：三态环的顺序由应用决定，按固定格数
/// 会停在别的状态上。
pub const MAX_TOGGLE_STEPS: u32 = 3;

fn missing(what: &str) -> String {
    format!("pattern_missing: {what}")
}

/// 一次动作的发法。`Err` 一律是「可证明没有发出调用」。
///
/// `select_text` 要判选区边界，调用方交进来的 `facts.value` 必须是全文。
pub fn plan(facts: &Facts, context: Context, spec: &ActionSpec) -> Result<Call, String> {
    match spec {
        ActionSpec::Invoke => match node::claim(facts) {
            Some(Click::Invoke) => Ok(Call::Perform(action::PRESS)),
            _ => Err(missing("这个控件没有默认动作")),
        },
        ActionSpec::SetValue { value } => {
            if !node::text_editable(facts) {
                return Err(missing("可编辑文本"));
            }
            if !facts.settable.value {
                return Err("read_only".to_owned());
            }
            Ok(Call::Set(attr::VALUE, Setting::Text(value.clone())))
        }
        ActionSpec::SetRangeValue { value } => {
            let Some(numbers) = node::numbers(facts) else {
                return Err(missing("数值区间"));
            };
            if !facts.settable.value {
                return Err("read_only".to_owned());
            }
            // 越界不夹到边上：夹出来的值看着合法，而它不是调用方要的那一个。
            if !value.is_finite() || *value < numbers.min || *value > numbers.max {
                return Err(format!(
                    "out_of_range: {value}，允许 {} 到 {}",
                    numbers.min, numbers.max
                ));
            }
            Ok(Call::Set(attr::VALUE, Setting::Number(*value)))
        }
        ActionSpec::Select => match node::select_route(facts, context) {
            Some(Selector::Press) => Ok(Call::Perform(action::PRESS)),
            Some(Selector::Parent(collection)) => Ok(Call::SelectInParent(collection)),
            Some(Selector::Own) => Ok(Call::Set(attr::SELECTED, Setting::Bool(true))),
            None => Err(missing("可写的选中状态")),
        },
        ActionSpec::AddToSelection | ActionSpec::RemoveFromSelection => Err(
            "unsupported: AX 不报容器是否允许多选，macOS 上不提供增选与取消选中 · 改用 select"
                .to_owned(),
        ),
        ActionSpec::Expand | ActionSpec::Collapse => {
            let Some(route) = node::expand_route(facts) else {
                return Err(missing("这个控件没有展开动作"));
            };
            let expand = matches!(spec, ActionSpec::Expand);
            if node::expand_state(facts) == Some(expand) {
                return Err(format!(
                    "already_in_state: {}",
                    if expand { "expanded" } else { "collapsed" }
                ));
            }
            Ok(match route {
                Expander::Attribute(name) => Call::Set(name, Setting::Bool(expand)),
                Expander::Press => Call::Perform(action::PRESS),
            })
        }
        ActionSpec::Scroll { direction, step } => {
            let Some((axis, numbers)) = node::scroll_bar(facts) else {
                return Err(missing("滚动条"));
            };
            let vertical = matches!(direction, ScrollDirection::Up | ScrollDirection::Down);
            if vertical != (axis == Axis::Vertical) {
                return Err("not_scrollable: 这个方向滚不动".to_owned());
            }
            if *step == ScrollStep::Page {
                return Err(
                    "page_step_unavailable: AX 的滚动条不提供页步长 · 改用 step=line 或 set_range_value"
                        .to_owned(),
                );
            }
            let forward = matches!(direction, ScrollDirection::Down | ScrollDirection::Right);
            if (forward && numbers.current >= numbers.max)
                || (!forward && numbers.current <= numbers.min)
            {
                return Err("not_scrollable: 已经滚到尽头".to_owned());
            }
            let name = if forward {
                action::INCREMENT
            } else {
                action::DECREMENT
            };
            if !facts.has_action(name) {
                return Err(format!(
                    "line_step_unavailable: 这个滚动条没有 {name} · 改用 set_range_value"
                ));
            }
            Ok(Call::Perform(name))
        }
        ActionSpec::ScrollIntoView => {
            if facts.has_action(action::SCROLL_TO_VISIBLE) {
                Ok(Call::Perform(action::SCROLL_TO_VISIBLE))
            } else {
                Err(missing(action::SCROLL_TO_VISIBLE))
            }
        }
        ActionSpec::RealizeItem { .. } => {
            Err("unsupported: realize_item 在 macOS 上不提供，AX 没有对应接口".to_owned())
        }
        ActionSpec::SelectText { start, length } => {
            if !node::text_selectable(facts) {
                return Err("selection_unsupported: 这个控件不支持选区".to_owned());
            }
            let Value::Text(text) = &facts.value else {
                return Err("text_unavailable: 读不到这个控件的文本，判不出选区边界".to_owned());
            };
            let end = start.saturating_add(*length);
            // 偏移落在代理对中间或超出末尾即拒绝，不就近取整：取整之后选中的不是调用方要的那一段。
            if !on_boundary(text, *start) || !on_boundary(text, end) {
                return Err(format!(
                    "out_of_range: 起点 {start} 长度 {length} 不落在字符边界上，或超出文本的 {} 个码元",
                    utf16_len(text)
                ));
            }
            Ok(Call::Set(
                attr::SELECTED_TEXT_RANGE,
                Setting::Range {
                    location: *start,
                    length: *length,
                },
            ))
        }
        // 上面一条条列完，剩下的是单独分流的那些。逐条列而不是写一个 `_`：新增一个后台动作
        // 忘了接进来时要在这里编译失败，不是变成一句拒绝。
        ActionSpec::SetToggle { .. } => Err("not_planned: set_toggle 走它自己的路径".to_owned()),
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
        | ActionSpec::CloseWindow => Err("not_planned: 前台动作不经后台动作路径".to_owned()),
    }
}

/// `set_toggle` 派发之前的判定：有切换动作、现态读得出、不在目标态、目标态在环上。交回现态。
pub fn toggle_precheck(facts: &Facts, want: ToggleState) -> Result<ToggleState, String> {
    if node::claim(facts) != Some(Click::Toggle) {
        return Err(missing("这个控件没有切换动作"));
    }
    let Some(current) = node::toggle_state(facts) else {
        return Err("toggle_state_unknown: 读不出这个控件的复选状态".to_owned());
    };
    if current == want {
        return Err(format!(
            "already_in_state: 这个控件已经是 {}",
            want.as_str()
        ));
    }
    let tri_state = current == ToggleState::Indeterminate || want == ToggleState::Indeterminate;
    if toggle_steps(current, want, tri_state).is_none() {
        return Err(format!(
            "toggle_state_unsupported: 到不了 {}",
            want.as_str()
        ));
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::macos::node::kind;

    fn facts(role: &str, actions: &[&str]) -> Facts {
        Facts {
            role: role.to_owned(),
            actions: actions.iter().map(|a| (*a).to_owned()).collect(),
            ..Facts::default()
        }
    }

    fn refused(facts: &Facts, spec: &ActionSpec) -> String {
        plan(facts, Context::default(), spec).expect_err("应当拒绝")
    }

    #[test]
    fn invoke_is_a_press() {
        let button = facts("AXButton", &[action::PRESS]);
        assert_eq!(
            plan(&button, Context::default(), &ActionSpec::Invoke),
            Ok(Call::Perform(action::PRESS))
        );
        assert!(
            refused(&facts("AXButton", &[]), &ActionSpec::Invoke).starts_with("pattern_missing")
        );
        // 复选框的 AXPress 归 set_toggle，不接受 invoke。
        let check = facts(kind::CHECK_BOX, &[action::PRESS]);
        assert!(refused(&check, &ActionSpec::Invoke).starts_with("pattern_missing"));
    }

    /// 只读输入框设值被拒且没有派发；可写的写 `AXValue`。
    #[test]
    fn set_value_writes_text_only_when_settable() {
        let mut field = facts(kind::TEXT_FIELD, &[]);
        field.value = Value::Text("旧".to_owned());
        let spec = ActionSpec::SetValue {
            value: "新".to_owned(),
        };
        assert_eq!(refused(&field, &spec), "read_only");
        field.settable.value = true;
        assert_eq!(
            plan(&field, Context::default(), &spec),
            Ok(Call::Set(attr::VALUE, Setting::Text("新".to_owned())))
        );
        assert!(refused(&facts(kind::STATIC_TEXT, &[]), &spec).starts_with("pattern_missing"));
    }

    /// 越界不夹到边上，只读不发。
    #[test]
    fn set_range_value_checks_bounds_first() {
        let mut slider = facts("AXSlider", &[]);
        slider.value = Value::Number(10.0);
        slider.min = Some(0.0);
        slider.max = Some(100.0);
        let to = |value| ActionSpec::SetRangeValue { value };
        assert_eq!(refused(&slider, &to(50.0)), "read_only");
        slider.settable.value = true;
        assert!(refused(&slider, &to(101.0)).starts_with("out_of_range"));
        assert!(refused(&slider, &to(f64::NAN)).starts_with("out_of_range"));
        assert_eq!(
            plan(&slider, Context::default(), &to(100.0)),
            Ok(Call::Set(attr::VALUE, Setting::Number(100.0)))
        );
    }

    /// 行经父元素的集合选中；单选按钮按一下；增选与取消选中一律拒绝。
    #[test]
    fn select_follows_the_route_and_multi_selection_is_refused() {
        let mut row = facts(kind::ROW, &[]);
        row.selected = Some(false);
        let rows = Context {
            rows: true,
            children: false,
        };
        assert_eq!(
            plan(&row, rows, &ActionSpec::Select),
            Ok(Call::SelectInParent(attr::SELECTED_ROWS))
        );
        let radio = facts(kind::RADIO_BUTTON, &[action::PRESS]);
        assert_eq!(
            plan(&radio, Context::default(), &ActionSpec::Select),
            Ok(Call::Perform(action::PRESS))
        );
        row.settable.selected = true;
        assert_eq!(
            plan(&row, Context::default(), &ActionSpec::Select),
            Ok(Call::Set(attr::SELECTED, Setting::Bool(true)))
        );
        for spec in [ActionSpec::AddToSelection, ActionSpec::RemoveFromSelection] {
            assert!(plan(&row, rows, &spec)
                .expect_err("应当拒绝")
                .starts_with("unsupported"));
        }
    }

    /// 已经在目标状态即拒绝；否则按发法写属性或按一下三角。
    #[test]
    fn expand_and_collapse_refuse_the_current_state() {
        let mut row = facts(kind::ROW, &[]);
        row.disclosing = Some(false);
        row.settable.disclosing = true;
        assert!(refused(&row, &ActionSpec::Collapse).starts_with("already_in_state"));
        assert_eq!(
            plan(&row, Context::default(), &ActionSpec::Expand),
            Ok(Call::Set(attr::DISCLOSING, Setting::Bool(true)))
        );
        let mut triangle = facts(kind::DISCLOSURE_TRIANGLE, &[action::PRESS]);
        triangle.value = Value::Number(1.0);
        assert_eq!(
            plan(&triangle, Context::default(), &ActionSpec::Collapse),
            Ok(Call::Perform(action::PRESS))
        );
        assert!(
            refused(&facts("AXButton", &[action::PRESS]), &ActionSpec::Expand)
                .starts_with("pattern_missing")
        );
    }

    fn scroll(direction: ScrollDirection, step: ScrollStep) -> ActionSpec {
        ActionSpec::Scroll { direction, step }
    }

    /// 滚动条按行滚走增减动作；错轴、页步长、到头与缺动作各自拒绝。
    #[test]
    fn scroll_steps_through_the_bar_actions() {
        let mut bar = facts(kind::SCROLL_BAR, &[action::INCREMENT]);
        bar.orientation = kind::VERTICAL.to_owned();
        bar.value = Value::Number(0.0);
        assert_eq!(
            plan(
                &bar,
                Context::default(),
                &scroll(ScrollDirection::Down, ScrollStep::Line)
            ),
            Ok(Call::Perform(action::INCREMENT))
        );
        assert!(
            refused(&bar, &scroll(ScrollDirection::Right, ScrollStep::Line))
                .starts_with("not_scrollable")
        );
        assert!(
            refused(&bar, &scroll(ScrollDirection::Down, ScrollStep::Page))
                .starts_with("page_step_unavailable")
        );
        assert!(
            refused(&bar, &scroll(ScrollDirection::Up, ScrollStep::Line))
                .starts_with("not_scrollable: 已经滚到尽头")
        );
        bar.value = Value::Number(0.5);
        assert!(
            refused(&bar, &scroll(ScrollDirection::Up, ScrollStep::Line))
                .starts_with("line_step_unavailable")
        );
    }

    #[test]
    fn scroll_into_view_needs_the_action() {
        let row = facts(kind::ROW, &[action::SCROLL_TO_VISIBLE]);
        assert_eq!(
            plan(&row, Context::default(), &ActionSpec::ScrollIntoView),
            Ok(Call::Perform(action::SCROLL_TO_VISIBLE))
        );
        assert!(refused(&facts(kind::ROW, &[]), &ActionSpec::ScrollIntoView)
            .starts_with("pattern_missing"));
    }

    /// 选区偏移按 UTF-16 码元原样交给 AX；落在代理对中间或超出末尾即拒绝。
    #[test]
    fn select_text_checks_character_boundaries() {
        let mut field = facts(kind::TEXT_FIELD, &[]);
        field.value = Value::Text("a🙂b".to_owned());
        field.characters = Some(4);
        field.text_range = Some((0, 0));
        let select = |start, length| ActionSpec::SelectText { start, length };
        assert!(refused(&field, &select(0, 1)).starts_with("selection_unsupported"));
        field.settable.text_range = true;
        assert_eq!(
            plan(&field, Context::default(), &select(1, 2)),
            Ok(Call::Set(
                attr::SELECTED_TEXT_RANGE,
                Setting::Range {
                    location: 1,
                    length: 2
                }
            ))
        );
        assert!(refused(&field, &select(2, 1)).starts_with("out_of_range"));
        assert!(refused(&field, &select(3, 5)).starts_with("out_of_range"));
        field.value = Value::Absent;
        assert!(refused(&field, &select(0, 1)).starts_with("text_unavailable"));
    }

    /// 切换之前的判定：已在目标态、到不了、读不出现态都在派发之前拒绝。
    #[test]
    fn toggle_prechecks_run_before_any_press() {
        let mut check = facts(kind::CHECK_BOX, &[action::PRESS]);
        check.value = Value::Number(0.0);
        assert_eq!(
            toggle_precheck(&check, ToggleState::On),
            Ok(ToggleState::Off)
        );
        assert!(toggle_precheck(&check, ToggleState::Off)
            .expect_err("应当拒绝")
            .starts_with("already_in_state"));
        check.value = Value::Absent;
        assert!(toggle_precheck(&check, ToggleState::On)
            .expect_err("应当拒绝")
            .starts_with("toggle_state_unknown"));
        let button = facts("AXButton", &[action::PRESS]);
        assert!(toggle_precheck(&button, ToggleState::On)
            .expect_err("应当拒绝")
            .starts_with("pattern_missing"));
        assert!(refused(
            &check,
            &ActionSpec::SetToggle {
                state: ToggleState::On
            }
        )
        .starts_with("not_planned"));
    }

    #[test]
    fn realize_item_is_not_offered() {
        let spec = ActionSpec::RealizeItem {
            name: "x".to_owned(),
        };
        assert!(refused(&facts("AXList", &[]), &spec).starts_with("unsupported"));
    }
}
