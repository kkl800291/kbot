use crate::storage::{delete_key_internal, read_key, read_or_create_device_id, save_key_internal};
use serde_json::{json, Value};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn normalize_gateway_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("尚未配置 KBOT 云托管网关地址".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "KBOT 网关地址格式无效".to_string())?;
    let host = parsed.host_str().ok_or("KBOT 网关地址缺少主机名")?;
    let local = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if parsed.scheme() != "https" && !(local && parsed.scheme() == "http") {
        return Err("KBOT 网关必须使用 HTTPS（本机调试除外）".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() {
        return Err("KBOT 网关地址不能包含凭据或查询参数".into());
    }
    Ok(parsed)
}

fn gateway_url(base: &str, suffix: &str) -> Result<String, String> {
    let mut url = normalize_gateway_url(base)?;
    let prefix = url.path().trim_end_matches('/');
    let next_path = if prefix.is_empty() {
        suffix.to_string()
    } else {
        format!("{prefix}{suffix}")
    };
    url.set_path(&next_path);
    Ok(url.to_string())
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "云端连接组件初始化失败".to_string())
}

fn extract_gateway_error(code: u16, raw_body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(raw_body).ok();
    let msg = parsed
        .as_ref()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["message"].as_str())
                .or_else(|| v["error"].as_str())
        })
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (code, msg) {
        (401, Some(m)) => format!("云端会话已失效，请重新连接或登录（{m}）"),
        (401, None) => "云端会话已失效，请重新连接或登录".into(),
        (402, Some(m)) => m.to_string(),
        (402, None) => "平台体验额度或点数已用完，请充值点数或切换自带 API Key".into(),
        (_, Some(m)) => m.to_string(),
        (_, None) => format!("KBOT 托管网关暂不可用（HTTP {code}）"),
    }
}

/// Strip raw `token` from gateway payload after storing it safely inside the local credential vault.
pub(crate) fn sanitize_and_store_session(mut payload: Value) -> Result<Value, String> {
    if let Some(token) = payload
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
    {
        save_key_internal("managed", &token)?;
    }
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("token");
        obj.insert("hasSession".into(), Value::Bool(read_key("managed").is_ok()));
    }
    Ok(payload)
}

async fn post_gateway(endpoint: &str, suffix: &str, body: Value, bearer: Option<&str>) -> Result<Value, String> {
    let url = gateway_url(endpoint, suffix)?;
    let client = build_client()?;
    let mut req = client.post(url).json(&body);
    if let Some(tok) = bearer {
        req = req.bearer_auth(tok);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "连接 KBOT 托管服务超时".to_string() } else { "无法连接 KBOT 托管服务，请检查网络或网关地址".to_string() })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(extract_gateway_error(status.as_u16(), &text));
    }
    serde_json::from_str::<Value>(&text).map_err(|_| "KBOT 托管服务返回格式无效".to_string())
}

#[tauri::command]
pub async fn cloud_bootstrap(endpoint: String) -> Result<Value, String> {
    let device_id = tokio::task::spawn_blocking(read_or_create_device_id)
        .await
        .map_err(|_| "生成设备标识失败".to_string())??;
    let existing = read_key("managed").ok();
    let payload = post_gateway(
        &endpoint,
        "/v1/kbot/bootstrap",
        json!({ "deviceId": device_id }),
        existing.as_deref(),
    )
    .await?;
    sanitize_and_store_session(payload)
}

#[tauri::command]
pub async fn cloud_status(endpoint: String) -> Result<Value, String> {
    let token = read_key("managed").map_err(|_| "尚未建立云端体验会话".to_string())?;
    let url = gateway_url(&endpoint, "/v1/kbot/account")?;
    let client = build_client()?;
    let resp = client
        .get(url)
        .bearer_auth(token.trim())
        .send()
        .await
        .map_err(|_| "无法连接 KBOT 托管服务".to_string())?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(extract_gateway_error(status.as_u16(), &text));
    }
    let parsed = serde_json::from_str::<Value>(&text).map_err(|_| "KBOT 托管服务返回格式无效".to_string())?;
    sanitize_and_store_session(parsed)
}

#[tauri::command]
pub async fn cloud_login(
    endpoint: String,
    account: String,
    password: Option<String>,
    code: Option<String>,
) -> Result<Value, String> {
    let acct = account.trim();
    if acct.is_empty() || acct.len() > 120 {
        return Err("请输入手机号或邮箱账号".into());
    }
    let device_id = tokio::task::spawn_blocking(read_or_create_device_id)
        .await
        .map_err(|_| "读取设备标识失败".to_string())??;
    let existing = read_key("managed").ok();
    let payload = post_gateway(
        &endpoint,
        "/v1/kbot/auth/login",
        json!({
            "account": acct,
            "password": password.unwrap_or_default(),
            "code": code.unwrap_or_default(),
            "deviceId": device_id,
        }),
        existing.as_deref(),
    )
    .await?;
    sanitize_and_store_session(payload)
}

#[tauri::command]
pub async fn cloud_redeem(endpoint: String, code: String) -> Result<Value, String> {
    let trimmed = code.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("请输入有效的点数兑换码".into());
    }
    let token = read_key("managed").map_err(|_| "请先领取体验额度或登录 KBOT 账号".to_string())?;
    let payload = post_gateway(
        &endpoint,
        "/v1/kbot/redeem",
        json!({ "code": trimmed }),
        Some(token.trim()),
    )
    .await?;
    sanitize_and_store_session(payload)
}

#[tauri::command]
pub async fn cloud_sign_out() -> Result<(), String> {
    tokio::task::spawn_blocking(|| delete_key_internal("managed"))
        .await
        .map_err(|_| "退出云端会话失败".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_url_validates_scheme_and_strips_trailing_slash() {
        assert_eq!(
            gateway_url("https://api.example.com/", "/v1/kbot/bootstrap").unwrap(),
            "https://api.example.com/v1/kbot/bootstrap"
        );
        assert_eq!(
            gateway_url("http://127.0.0.1:8787/prefix/", "/v1/kbot/account").unwrap(),
            "http://127.0.0.1:8787/prefix/v1/kbot/account"
        );
        assert!(gateway_url("http://remote.example.com", "/v1/kbot/account").is_err());
        assert!(gateway_url("https://api.example.com?token=leak", "/v1/kbot/account").is_err());
    }
}
