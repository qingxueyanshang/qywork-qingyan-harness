//! 宿主连接的帧。字段名与 `packages/core/src/protocol/native-browser.ts` 逐字对应，
//! 契约由两侧共用的 JSON 样例锁住。
//!
//! 缺省值一律用 `Option` + `skip_serializing_if`：多发一个 `null` 字段会让
//! 服务端那侧的可选字段判定从「没有」变成「有且为空」。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshot {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub marker: String,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostReady {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub host_instance_id: String,
    pub connection_epoch: u64,
    pub platform: &'static str,
    pub runtime_version: String,
    pub debug_port: u16,
    pub tabs: Vec<TabSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestFrame {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub connection_epoch: u64,
    pub deadline: u64,
    pub op: String,
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// `download.arm` / `download.disarm` 认的本次下载身份。服务端每次生成一个不复用的值。
    #[serde(default)]
    pub download_id: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultFrame {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: String,
    pub connection_epoch: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<ResultData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFrame {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub connection_epoch: u64,
    pub seq: u64,
    #[serde(rename = "kind")]
    pub event: &'static str,
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_name: Option<String>,
    /// 消费掉的那份授权的身份。缺席即这次下载没有命中授权，不得结算任何工具调用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_id: Option<String>,
}

impl EventFrame {
    pub fn new(connection_epoch: u64, seq: u64, event: &'static str, tab_id: String) -> Self {
        Self {
            kind: "browser.event",
            connection_epoch,
            seq,
            event,
            tab_id,
            url: None,
            title: None,
            marker: None,
            conversation_id: None,
            path: None,
            success: None,
            reason: None,
            suggested_name: None,
            download_id: None,
        }
    }
}

/// 请求准入。返回 `Some(原因)` 即拒绝，调用方原样回成 `ok:false`。
///
/// 两条判据都必须在执行之前：过期的请求发出时对端已经放弃了它，
/// 跨重连的旧纪元请求属于上一条连接，执行它等于让作废的控制权继续生效。
pub fn reject_reason(
    current_epoch: u64,
    frame: &RequestFrame,
    now_ms: u64,
) -> Option<&'static str> {
    if frame.kind != "browser.request" {
        return Some("unknown_frame");
    }
    if frame.connection_epoch != current_epoch {
        return Some("stale_epoch");
    }
    if frame.deadline <= now_ms {
        return Some("deadline_passed");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{reject_reason, EventFrame, HostReady, RequestFrame, ResultData, ResultFrame, TabSnapshot};
    use serde_json::{json, Value};

    /// 与 server 侧同一份样例。两侧各写一份样例就不再是契约，
    /// 改一处漏一处的表现是运行期字段读成 `undefined`。
    const SAMPLES: &str =
        include_str!("../../../../../packages/core/src/protocol/native-browser.samples.json");

    fn sample(key: &str) -> Value {
        let all: Value = serde_json::from_str(SAMPLES).expect("样例文件要能解析");
        all.get(key).cloned().unwrap_or_else(|| panic!("样例里没有 {key}"))
    }

    fn frame(epoch: u64, deadline: u64) -> RequestFrame {
        RequestFrame {
            kind: "browser.request".into(),
            request_id: "r1".into(),
            connection_epoch: epoch,
            deadline,
            op: "close".into(),
            tab_id: Some("t1".into()),
            conversation_id: None,
            url: None,
            path: None,
            download_id: None,
        }
    }

    #[test]
    fn stale_epoch_and_passed_deadline_are_refused_before_execution() {
        assert_eq!(reject_reason(7, &frame(7, 1_000), 999), None);
        assert_eq!(reject_reason(7, &frame(6, 1_000), 999), Some("stale_epoch"));
        assert_eq!(reject_reason(7, &frame(7, 1_000), 1_000), Some("deadline_passed"));
    }

    #[test]
    fn request_sample_decodes_into_the_dispatch_shape() {
        let parsed: RequestFrame =
            serde_json::from_value(sample("request")).expect("样例必须能解出来");
        assert_eq!(parsed.op, "download.arm");
        assert_eq!(parsed.connection_epoch, 3);
        assert_eq!(parsed.conversation_id.as_deref(), Some("cv_a1"));
        assert_eq!(parsed.tab_id.as_deref(), Some("bt_1"));
        assert_eq!(parsed.path.as_deref(), Some(r"D:\work\out.bin"));
        assert_eq!(parsed.download_id.as_deref(), Some("dl_4"));
        assert_eq!(parsed.url, None);
    }

    #[test]
    fn host_ready_encodes_to_the_sample_bytes() {
        let ready = HostReady {
            kind: "host.ready",
            host_instance_id: "6f2a0c11".into(),
            connection_epoch: 3,
            platform: "windows",
            runtime_version: "152.0.4191.66".into(),
            debug_port: 51234,
            tabs: vec![
                TabSnapshot {
                    tab_id: "bt_1".into(),
                    url: "http://127.0.0.1:9000/page".into(),
                    title: "夹具页".into(),
                    marker: "9a3f".into(),
                    conversation_id: Some("cv_a1".into()),
                },
                TabSnapshot {
                    tab_id: "bt_2".into(),
                    url: "http://127.0.0.1:9000/page".into(),
                    title: "夹具页".into(),
                    marker: "b1c4".into(),
                    conversation_id: None,
                },
            ],
        };
        assert_eq!(serde_json::to_value(&ready).unwrap(), sample("hostReady"));
    }

    #[test]
    fn result_and_event_encode_to_the_sample_bytes() {
        let result = ResultFrame {
            kind: "browser.result",
            request_id: "br_12".into(),
            connection_epoch: 3,
            ok: true,
            data: Some(ResultData {
                tab_id: Some("bt_1".into()),
                marker: Some("9a3f".into()),
                url: Some("http://127.0.0.1:9000/page".into()),
                title: Some("夹具页".into()),
                removed: None,
            }),
            error: None,
        };
        assert_eq!(serde_json::to_value(&result).unwrap(), sample("result"));

        let mut event = EventFrame::new(3, 11, "download.blocked", "bt_1".into());
        event.url = Some("http://127.0.0.1:9000/file.bin".into());
        event.reason = Some("unauthorized");
        event.suggested_name = Some("file.bin".into());
        assert_eq!(serde_json::to_value(&event).unwrap(), sample("event"));

        // 终态带回消费掉的那份授权身份；服务端按它认领，不按 tabId。
        let mut finished = EventFrame::new(3, 12, "download.finished", "bt_1".into());
        finished.path = Some(r"D:\work\out.bin".into());
        finished.success = Some(true);
        finished.download_id = Some("dl_4".into());
        assert_eq!(serde_json::to_value(&finished).unwrap(), sample("downloadFinished"));
    }

    /// 缺省字段不能发成 `null`：接收端的可选字段判定会从「没有」变成「有且为空」。
    #[test]
    fn absent_optional_fields_are_omitted_not_nulled() {
        let event = EventFrame::new(1, 1, "closed", "bt_9".into());
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({"type":"browser.event","connectionEpoch":1,"seq":1,"kind":"closed","tabId":"bt_9"})
        );
    }
}
