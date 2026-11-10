use crate::network::{ChatEvent, ModelConfig};
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn chat_body(
    config: &ModelConfig,
    messages: Vec<Value>,
    tools: Vec<Value>,
    web: bool,
) -> Result<(&'static str, Value), String> {
    let protocol = if web {
        config
            .web_protocol
            .as_deref()
            .unwrap_or(match config.provider.as_str() {
                "openai" | "grok" => "responses",
                "qwen" => "qwen",
                _ => "none",
            })
    } else {
        "none"
    };
    if protocol == "responses" {
        let input: Vec<Value> = messages.into_iter().map(|mut message| {
            if let Some(parts) = message["content"].as_array_mut() {
                for part in parts {
                    match part["type"].as_str() {
                        Some("text") => { part["type"] = json!("input_text"); }
                        Some("image_url") => { *part = json!({"type":"input_image", "image_url":part["image_url"]["url"]}); }
                        _ => {}
                    }
                }
            }
            message
        }).collect();
        let mut tools: Vec<Value> = tools
            .into_iter()
            .map(|tool| {
                let mut function = tool["function"].clone();
                function["type"] = json!("function");
                function
            })
            .collect();
        tools.push(json!({"type":"web_search"}));
        return Ok((
            "responses",
            json!({"model":config.model,"input":input,"tools":tools,
            "tool_choice":"auto","stream":true,"store":false}),
        ));
    }
    if web && protocol != "qwen" {
        return Err("这个联网接口尚未适配，请选择正确的联网格式或使用独立搜索服务".into());
    }
    let mut body = json!({"model":config.model,"messages":messages,"stream":true});
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    if web {
        body["enable_search"] = json!(true);
        body["search_options"] = json!({"forced_search":true});
    }
    Ok(("chat/completions", body))
}

pub fn source(value: &Value) -> Option<ChatEvent> {
    let address = value["url"].as_str()?;
    let url = url::Url::parse(address).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(ChatEvent::Source {
        source: json!({"url":address,"title":value["title"].as_str().unwrap_or(address),
        "startIndex":value["start_index"],"endIndex":value["end_index"]}),
    })
}

#[derive(Default)]
pub struct ResponseStream {
    names: HashSet<usize>,
    arguments: HashSet<usize>,
    text: HashSet<usize>,
}

impl ResponseStream {
    fn item(&mut self, index: usize, item: &Value, out: &mut Vec<ChatEvent>, complete: bool) {
        if item["type"] == "function_call" {
            if self.names.insert(index) {
                out.push(ChatEvent::Tool {
                    index,
                    name: item["name"].as_str().map(String::from),
                    arguments: None,
                });
            }
            if complete && !self.arguments.contains(&index) {
                if let Some(args) = item["arguments"].as_str() {
                    self.arguments.insert(index);
                    out.push(ChatEvent::Tool {
                        index,
                        name: None,
                        arguments: Some(args.into()),
                    });
                }
            }
        }
        if complete && item["type"] == "web_search_call" {
            out.push(ChatEvent::Search {
                state: "completed".into(),
            });
            if let Some(sources) = item["action"]["sources"].as_array() {
                out.extend(sources.iter().filter_map(source));
            }
        }
        if let Some(content) = item["content"].as_array() {
            let mut text = String::new();
            for part in content {
                if let Some(annotations) = part["annotations"].as_array() {
                    out.extend(annotations.iter().filter_map(source));
                }
                if let Some(value) = part["text"].as_str() {
                    text.push_str(value);
                }
            }
            if complete && !text.is_empty() && self.text.insert(index) {
                out.push(ChatEvent::Delta { text });
            }
        }
    }

    pub fn consume(&mut self, data: &Value) -> Result<(Vec<ChatEvent>, bool), String> {
        let mut out = Vec::new();
        let index = data["output_index"].as_u64().unwrap_or(0) as usize;
        let mut done = false;
        match data["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => {
                if let Some(text) = data["delta"].as_str() {
                    self.text.insert(index);
                    out.push(ChatEvent::Delta { text: text.into() });
                }
            }
            "response.output_item.added" => self.item(index, &data["item"], &mut out, false),
            "response.output_item.done" => self.item(index, &data["item"], &mut out, true),
            "response.function_call_arguments.delta" => {
                if let Some(args) = data["delta"].as_str() {
                    self.arguments.insert(index);
                    out.push(ChatEvent::Tool {
                        index,
                        name: None,
                        arguments: Some(args.into()),
                    });
                }
            }
            "response.output_text.annotation.added" => {
                out.extend(source(&data["annotation"]));
            }
            "response.web_search_call.in_progress" | "response.web_search_call.searching" => {
                out.push(ChatEvent::Search {
                    state: "searching".into(),
                });
            }
            "response.web_search_call.completed" => {
                out.push(ChatEvent::Search {
                    state: "completed".into(),
                });
            }
            "response.completed" => {
                if let Some(output) = data["response"]["output"].as_array() {
                    for (i, item) in output.iter().enumerate() {
                        self.item(i, item, &mut out, true);
                    }
                }
                if let Some(citations) = data["response"]["citations"].as_array() {
                    for url in citations {
                        out.extend(source(&json!({"url":url})));
                    }
                }
                done = true;
            }
            "response.failed" | "error" => {
                return Err("模型的联网请求失败，请检查模型是否支持联网及账户权限".into())
            }
            "response.incomplete" => return Err("联网回复未完成，已保留收到的内容，请重试".into()),
            _ => {}
        }
        Ok((out, done))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(provider: &str) -> ModelConfig {
        ModelConfig {
            base: "https://api.example.com/v1".into(),
            model: "test-model".into(),
            provider: provider.into(),
            web_protocol: None,
        }
    }

    #[test]
    fn responses_search_preserves_images_and_confirmation_tools() {
        let tools = vec![
            json!({"type":"function","function":{"name":"create_reminder","parameters":{"type":"object"}}}),
        ];
        let messages = vec![
            json!({"role":"user","content":[{"type":"text","text":"看图搜索"},{"type":"image_url","image_url":{"url":"data:image/png;base64,fixture"}}]}),
        ];
        for provider in ["openai", "grok"] {
            let (route, body) =
                chat_body(&config(provider), messages.clone(), tools.clone(), true).unwrap();
            assert_eq!(route, "responses");
            assert_eq!(body["store"], false);
            assert_eq!(body["tools"][0]["name"], "create_reminder");
            assert_eq!(body["tools"][1]["type"], "web_search");
            assert_eq!(body["input"][0]["content"][1]["type"], "input_image");
            assert_eq!(
                body["input"][0]["content"][1]["image_url"],
                "data:image/png;base64,fixture"
            );
        }
    }
    #[test]
    fn offline_requests_do_not_enable_native_search() {
        let (route, body) = chat_body(&config("openai"), vec![], vec![], false).unwrap();
        assert_eq!(route, "chat/completions");
        assert!(body.get("tools").is_none());
        let (_, body) = chat_body(&config("qwen"), vec![], vec![], true).unwrap();
        assert_eq!(body["enable_search"], true);
        assert_eq!(body["search_options"]["forced_search"], true);
        assert!(chat_body(&config("custom"), vec![], vec![], true).is_err());
    }
    #[test]
    fn responses_stream_keeps_fragmented_tools_and_does_not_duplicate_final_text() {
        let mut stream = ResponseStream::default();
        stream
            .consume(&json!({"type":"response.output_text.delta","output_index":0,"delta":"你好"}))
            .unwrap();
        stream.consume(&json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","name":"create_reminder"}})).unwrap();
        let (events, _) = stream.consume(&json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"content\":"})).unwrap();
        assert!(
            matches!(&events[0], ChatEvent::Tool { arguments: Some(args), .. } if args == "{\"content\":")
        );
        let (events, done) = stream.consume(&json!({"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"你好","annotations":[{"url":"https://example.com/doc","title":"文档","start_index":0,"end_index":2}]}]}]}})).unwrap();
        assert!(done);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], ChatEvent::Source { .. }));
        assert!(stream
            .consume(&json!({"type":"response.incomplete"}))
            .is_err());
    }
}
