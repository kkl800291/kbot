use crate::storage::read_key;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Requests(pub Mutex<HashMap<String, CancellationToken>>);

#[derive(Deserialize)]
pub struct ModelConfig {
    pub base: String,
    pub model: String,
    pub provider: String,
    #[serde(default, rename = "webProtocol")]
    pub web_protocol: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatEvent {
    Done,
    Delta {
        text: String,
    },
    Tool {
        index: usize,
        name: Option<String>,
        arguments: Option<String>,
    },
    Search {
        state: String,
    },
    Source {
        source: Value,
    },
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("CyberCompanion/0.1")
        .build()
        .map_err(|_| "无法创建网络连接".into())
}

fn endpoint(base: &str) -> Result<String, String> {
    api_endpoint(base, "chat/completions")
}

fn api_endpoint(base: &str, route: &str) -> Result<String, String> {
    let u = url::Url::parse(base.trim()).map_err(|_| "API 地址格式无效")?;
    if u.scheme() != "https"
        && !(u.scheme() == "http"
            && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return Err("API 地址需使用 HTTPS；本机模型可以使用 HTTP".into());
    }
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("API 地址不能包含账号、查询参数或片段".into());
    }
    Ok(format!("{}/{}", base.trim().trim_end_matches('/'), route))
}

async fn checked(response: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    // Never include response bodies, headers, or credentials in errors/logs.
    Err(match status.as_u16() {
        401 | 403 => "API Key 无效或无权访问这个模型，请检查设置".into(),
        402 => "服务商账户余额不足，请检查额度".into(),
        404 => "API 地址或模型名不存在，请检查设置".into(),
        429 => "调用过于频繁或额度已用完，请稍后重试".into(),
        400 | 422 => "服务商不接受本次请求，请检查模型是否支持图片和工具调用".into(),
        _ => format!("服务商暂时不可用（HTTP {}）", status.as_u16()),
    })
}

#[tauri::command]
pub async fn chat_stream(
    id: String,
    slot: String,
    config: ModelConfig,
    messages: Vec<Value>,
    tools: Vec<Value>,
    web: bool,
    on_event: Channel<ChatEvent>,
    requests: State<'_, Requests>,
) -> Result<(), String> {
    if !matches!(slot.as_str(), "chat" | "vision") {
        return Err("未知的模型配置".into());
    }
    let (route, body) = crate::model_protocol::chat_body(&config, messages, tools, web)?;
    let address = api_endpoint(&config.base, route)?;
    let key = read_key(&slot)?;
    let token = CancellationToken::new();
    {
        let mut active = requests.0.lock().map_err(|_| "请求状态不可用")?;
        if active.contains_key(&id) {
            return Err("请求已存在".into());
        }
        active.insert(id.clone(), token.clone());
    }
    let work = async {
        let response = tokio::time::timeout(
            Duration::from_secs(60),
            client()?.post(address).bearer_auth(key).json(&body).send(),
        )
        .await
        .map_err(|_| "模型服务连接超时，请稍后重试")?
        .map_err(|_| "无法连接模型服务，请检查网络和 API 地址")?;
        if web && matches!(response.status().as_u16(), 400 | 404 | 422) {
            return Err("当前模型或 API 地址不支持所选联网接口，请换用支持联网的模型、调整联网格式，或配置独立搜索服务".into());
        }
        let response = checked(response).await?;
        let mut events = response.bytes_stream().eventsource();
        let mut response_stream = crate::model_protocol::ResponseStream::default();
        let mut finished = false;
        while let Some(event) = tokio::time::timeout(Duration::from_secs(60), events.next())
            .await
            .map_err(|_| "模型响应超时，已保留收到的内容")?
        {
            let event = event.map_err(|_| "回复中断，已保留收到的内容")?;
            if event.data.trim() == "[DONE]" {
                if route != "responses" {
                    finished = true;
                }
                break;
            }
            let data: Value =
                serde_json::from_str(&event.data).map_err(|_| "服务商返回了无法识别的数据")?;
            if data.get("error").is_some() {
                return Err("服务商返回错误，已保留收到的内容".into());
            }
            if route == "responses" {
                let (events, done) = response_stream.consume(&data)?;
                for event in events {
                    on_event.send(event).map_err(|_| "对话窗口已关闭")?;
                }
                if done {
                    finished = true;
                    break;
                }
                continue;
            }
            if let Some(sources) = data["search_info"]["search_results"].as_array() {
                for event in sources.iter().filter_map(crate::model_protocol::source) {
                    on_event.send(event).map_err(|_| "对话窗口已关闭")?;
                }
            }
            if let Some(choices) = data["choices"].as_array() {
                for choice in choices {
                    if choice["finish_reason"].as_str() == Some("length") {
                        return Err("回复达到模型长度限制，可以继续提问".into());
                    }
                    if choice["finish_reason"].as_str() == Some("content_filter") {
                        return Err("服务商未能完成本次回复".into());
                    }
                    if !choice["finish_reason"].is_null() {
                        finished = true;
                    }
                    let delta = &choice["delta"];
                    if let Some(text) = delta["content"].as_str() {
                        on_event
                            .send(ChatEvent::Delta { text: text.into() })
                            .map_err(|_| "对话窗口已关闭")?;
                    }
                    if let Some(calls) = delta["tool_calls"].as_array() {
                        for call in calls {
                            on_event
                                .send(ChatEvent::Tool {
                                    index: call["index"].as_u64().unwrap_or(0) as usize,
                                    name: call["function"]["name"].as_str().map(String::from),
                                    arguments: call["function"]["arguments"]
                                        .as_str()
                                        .map(String::from),
                                })
                                .map_err(|_| "对话窗口已关闭")?;
                        }
                    }
                }
            }
        }
        if !finished {
            return Err("回复连接提前关闭，已保留收到的内容".into());
        }
        on_event
            .send(ChatEvent::Done)
            .map_err(|_| "对话窗口已关闭")?;
        Ok(())
    };
    let result =
        tokio::select! { _ = token.cancelled() => Err("已停止生成".into()), r = work => r };
    requests.0.lock().map_err(|_| "请求状态不可用")?.remove(&id);
    result
}

#[tauri::command]
pub fn cancel_chat(id: String, requests: State<Requests>) {
    if let Ok(active) = requests.0.lock() {
        if let Some(t) = active.get(&id) {
            t.cancel();
        }
    }
}

#[tauri::command]
pub async fn test_model(slot: String, config: ModelConfig, vision: bool) -> Result<(), String> {
    let key = read_key(&slot)?;
    let content = if vision {
        json!([
            {"type":"text", "text":"What color is this pixel? Answer briefly."},
            {"type":"image_url", "image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC"}}
        ])
    } else {
        json!("Reply with OK.")
    };
    checked(client()?.post(endpoint(&config.base)?).bearer_auth(key).timeout(Duration::from_secs(30))
        .json(&json!({"model":config.model,"messages":[{"role":"user","content":content}],"stream":false}))
        .send().await.map_err(|_| "连接超时或网络不可用")?).await?;
    Ok(())
}

pub fn model_ids(data: &Value) -> Result<Vec<String>, String> {
    let rows = data["data"]
        .as_array()
        .ok_or("服务商没有返回兼容的模型列表，可以手动填写模型名")?;
    let mut models: Vec<String> = rows
        .iter()
        .filter_map(|row| row["id"].as_str())
        .filter(|id| !id.trim().is_empty() && id.len() <= 512)
        .map(String::from)
        .collect();
    models.sort();
    models.dedup();
    Ok(models)
}

#[tauri::command]
pub async fn list_models(slot: String, config: ModelConfig) -> Result<Vec<String>, String> {
    if !matches!(slot.as_str(), "chat" | "vision") {
        return Err("未知的模型配置".into());
    }
    let key = read_key(&slot)?;
    let response = client()?
        .get(api_endpoint(&config.base, "models")?)
        .bearer_auth(key)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "模型列表获取失败，请检查网络后重试")?;
    let data: Value = checked(response)
        .await?
        .json()
        .await
        .map_err(|_| "模型列表格式无效，可以手动填写模型名")?;
    model_ids(&data)
}

fn deepseek_search_body(config: Option<&ModelConfig>, query: &str) -> Result<Value, String> {
    let config = config.ok_or("请先配置 DeepSeek 对话模型")?;
    // Built-in search reuses the chat credential only with the official service.
    // A custom chat proxy must never receive (or silently enable) this request.
    endpoint(&config.base)?;
    let base = url::Url::parse(config.base.trim()).map_err(|_| "API 地址格式无效")?;
    if base.origin().ascii_serialization() != "https://api.deepseek.com"
        || !matches!(base.path().trim_end_matches('/'), "" | "/v1")
    {
        return Err("DeepSeek 自带联网需要官方 API 地址 https://api.deepseek.com/v1；其他服务可选择 Tavily 或 Brave Search".into());
    }
    // The Search API accepts at most 128 Unicode characters, not 128 bytes.
    Ok(
        json!({"query": query.trim().chars().take(128).collect::<String>(), "count": 5, "need_content": false}),
    )
}

fn search_request(
    c: &reqwest::Client,
    provider: &str,
    query: &str,
    config: Option<&ModelConfig>,
    key: &str,
) -> Result<reqwest::RequestBuilder, String> {
    if query.trim().is_empty() || query.chars().count() > 2000 {
        return Err("请输入 1–2000 字的搜索词".into());
    }
    Ok(match provider {
        "builtin" => c
            .post("https://api.deepseek.com/v1/tools/search")
            .bearer_auth(key)
            .json(&deepseek_search_body(config, query)?),
        "tavily" => c
            .post("https://api.tavily.com/search")
            .bearer_auth(key)
            .json(&json!({"query":query,"max_results":5,"search_depth":"basic"})),
        "brave" => c
            .get("https://api.search.brave.com/res/v1/web/search")
            .header("X-Subscription-Token", key)
            .query(&[("q", query), ("count", "5".into())]),
        _ => return Err("请选择 DeepSeek 官方搜索、Tavily 或 Brave Search".into()),
    })
}

fn search_results(provider: &str, data: &Value) -> Result<Value, String> {
    let rows = if provider == "brave" {
        &data["web"]["results"]
    } else {
        &data["results"]
    };
    let rows = rows.as_array().ok_or("搜索服务没有返回有效的结果列表")?;
    Ok(json!(rows
        .iter()
        .filter_map(|r| {
            let address = r["url"].as_str()?;
            let url = url::Url::parse(address).ok()?;
            if !matches!(url.scheme(), "https" | "http")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return None;
            }
            let content = ["content", "summary", "snippet", "description"]
                .iter()
                .find_map(|field| {
                    r.get(field)
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                })
                .unwrap_or("");
            Some(
                json!({"title": r["title"].as_str().unwrap_or(address), "url": address,
            "content": content.chars().take(2000).collect::<String>()}),
            )
        })
        .take(5)
        .collect::<Vec<_>>()))
}

#[tauri::command]
pub async fn search_web(
    provider: String,
    query: String,
    config: Option<ModelConfig>,
) -> Result<Value, String> {
    if provider == "builtin" {
        deepseek_search_body(config.as_ref(), &query)?;
    }
    let key = read_key(if provider == "builtin" {
        "chat"
    } else {
        "search"
    })?;
    let response = search_request(&client()?, &provider, &query, config.as_ref(), &key)?
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "搜索服务连接失败，请检查网络后重试")?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            400 | 422 => "搜索服务不接受本次请求，请检查搜索配置或缩短搜索词".into(),
            401 | 403 => "搜索 API Key 无效或没有搜索权限，请在设置中检查对应服务的 Key".into(),
            402 => "搜索服务账户余额不足，请检查额度".into(),
            404 => "当前服务没有提供这个搜索接口，请检查服务配置".into(),
            429 => "搜索过于频繁或额度已用完，请稍后重试".into(),
            _ => format!("搜索服务暂时不可用（HTTP {}）", status.as_u16()),
        });
    }
    let data: Value = response.json().await.map_err(|_| "搜索结果格式无效")?;
    search_results(&provider, &data)
}

#[tauri::command]
pub async fn weather_get(latitude: f64, longitude: f64) -> Result<Value, String> {
    if !latitude.is_finite()
        || latitude.abs() > 90.0
        || !longitude.is_finite()
        || longitude.abs() > 180.0
    {
        return Err("城市坐标无效".into());
    }
    client()?
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", latitude.to_string()),
            ("longitude", longitude.to_string()),
            ("current", "temperature_2m,weather_code".into()),
            (
                "daily",
                "temperature_2m_max,temperature_2m_min,precipitation_probability_max".into(),
            ),
            ("timezone", "auto".into()),
            ("forecast_days", "1".into()),
        ])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "天气暂不可用")?
        .error_for_status()
        .map_err(|_| "天气暂不可用")?
        .json()
        .await
        .map_err(|_| "天气格式无效".into())
}

#[tauri::command]
pub async fn city_search(name: String) -> Result<Value, String> {
    if name.len() > 200 {
        return Err("城市名过长".into());
    }
    client()?
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[
            ("name", name.as_str()),
            ("count", "5"),
            ("language", "zh"),
            ("format", "json"),
        ])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "城市查询失败，请检查网络")?
        .error_for_status()
        .map_err(|_| "城市查询失败")?
        .json()
        .await
        .map_err(|_| "城市查询失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_transport() {
        assert!(endpoint("https://api.example.com/v1").is_ok());
        assert!(endpoint("http://127.0.0.1:1234/v1").is_ok());
        assert!(endpoint("http://example.com/v1").is_err());
        assert!(endpoint("https://user:pass@example.com/v1").is_err());
        assert!(endpoint("https://example.com/v1?key=secret").is_err());
    }
    #[test]
    fn deepseek_search_uses_the_documented_endpoint_and_unicode_limit() {
        let config = ModelConfig {
            base: "https://api.deepseek.com/v1".into(),
            model: "deepseek-chat".into(),
            provider: "deepseek".into(),
            web_protocol: None,
        };
        let request = search_request(
            &client().unwrap(),
            "builtin",
            &"中🙂".repeat(100),
            Some(&config),
            "fixture-only",
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(
            request.url().as_str(),
            "https://api.deepseek.com/v1/tools/search"
        );
        let body: Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["query"].as_str().unwrap().chars().count(), 128);
        assert_eq!(body["count"], 5);
        let bad = ModelConfig {
            base: "https://proxy.example.com/v1".into(),
            ..config
        };
        assert!(deepseek_search_body(Some(&bad), "test").is_err());
    }
    #[test]
    fn search_results_use_deepseek_summaries_and_reject_invalid_responses() {
        let data = json!({"results":[{"title":"文档","url":"https://example.com/doc","content":"","summary":"供模型使用的摘要","snippet":"短摘要"},{"url":"javascript:alert(1)"}]});
        let results = search_results("builtin", &data).unwrap();
        assert_eq!(results.as_array().unwrap().len(), 1);
        assert_eq!(results[0]["content"], "供模型使用的摘要");
        assert!(search_results("builtin", &json!({"error":"unavailable"})).is_err());
        assert_eq!(
            search_results("builtin", &json!({"results":[]})).unwrap(),
            json!([])
        );
    }
    #[test]
    fn model_list_is_sorted_unique_and_preserves_provider_model_ids() {
        assert_eq!(model_ids(&json!({"data":[{"id":"qwen-plus"},{"id":"deepseek-chat"},{"id":"qwen-plus"},{"id":""},{}]})).unwrap(), vec!["deepseek-chat", "qwen-plus"]);
        assert!(model_ids(&json!({"models":[]})).is_err());
        assert_eq!(
            api_endpoint("https://api.example.com/v1/", "models").unwrap(),
            "https://api.example.com/v1/models"
        );
    }
}
