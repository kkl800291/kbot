//! Stdio MCP client.
//! Messages are newline-delimited JSON-RPC, as in the 2025-11-25 spec:
//! https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
//! The client sends `initialize`, then `notifications/initialized`, then
//! `tools/list` / `tools/call`. A crashed process only fails that service.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex as AsyncMutex,
};

const CLIENT_PROTOCOL: &str = "2025-11-25";
const SUPPORTED_PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LINE: usize = 8 * 1024 * 1024;
const MAX_SERVICES: usize = 8;
const SERVICE: &str = "com.cybercompanion.desktop";

fn service() -> &'static str {
    if cfg!(debug_assertions) && std::env::var("COMPANION_SMOKE").as_deref() == Ok("1") {
        "com.cybercompanion.smoke"
    } else {
        SERVICE
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "empty_schema", rename = "inputSchema")]
    pub input_schema: Value,
}

fn empty_schema() -> Value {
    json!({"type": "object", "properties": {}})
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStarted {
    pub name: String,
    pub protocol_version: String,
    pub server_name: String,
    pub instructions: String,
    pub tools: Vec<McpTool>,
}

pub struct StartRequest {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub timeout: Duration,
}

#[derive(Default)]
pub struct McpHub {
    sessions: Mutex<HashMap<String, Arc<AsyncMutex<Session>>>>,
}

struct Session {
    name: String,
    stdin: ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    child: Child,
    next_id: u64,
    dead: bool,
    protocol: String,
    server_name: String,
    instructions: String,
}

#[tauri::command]
pub async fn mcp_start(
    hub: tauri::State<'_, McpHub>,
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    secret_envs: Vec<String>,
) -> Result<McpStarted, String> {
    let mut env = env;
    let secrets = load_secrets(&name, &secret_envs)?;
    for (key, value) in secrets {
        if env.contains_key(&key) {
            return Err("环境变量名与钥匙串密钥重复".into());
        }
        env.insert(key, value);
    }
    hub.start(StartRequest {
        name,
        command,
        args,
        env,
        timeout: LIST_TIMEOUT,
    })
    .await
}

#[tauri::command]
pub async fn mcp_list_tools(
    hub: tauri::State<'_, McpHub>,
    name: String,
) -> Result<Vec<McpTool>, String> {
    hub.list_tools(&name, LIST_TIMEOUT).await
}

#[tauri::command]
pub async fn mcp_call_tool(
    hub: tauri::State<'_, McpHub>,
    name: String,
    tool: String,
    arguments: Value,
) -> Result<String, String> {
    hub.call(&name, &tool, arguments, CALL_TIMEOUT).await
}

#[tauri::command]
pub async fn mcp_stop(hub: tauri::State<'_, McpHub>, name: String) -> Result<(), String> {
    hub.stop(&name).await
}

#[tauri::command]
pub async fn mcp_save_secret(name: String, env: String, value: String) -> Result<(), String> {
    let account = secret_account(&name)?;
    validate_env_name(&env)?;
    validate_secret_value(&value)?;
    tauri::async_runtime::spawn_blocking(move || write_secret(&account, &env, &value))
        .await
        .map_err(|_| "钥匙串任务失败".to_string())?
}

#[tauri::command]
pub async fn mcp_delete_secrets(name: String) -> Result<(), String> {
    let account = secret_account(&name)?;
    tauri::async_runtime::spawn_blocking(move || delete_secret(&account))
        .await
        .map_err(|_| "钥匙串任务失败".to_string())?
}

impl McpHub {
    pub async fn start(&self, request: StartRequest) -> Result<McpStarted, String> {
        validate_service_name(&request.name)?;
        let _ = launch_parts(&request.command, &request.args)?;
        self.stop(&request.name).await?;
        {
            let guard = self.sessions.lock().map_err(|_| "工具服务状态不可用")?;
            if guard.len() >= MAX_SERVICES {
                return Err("工具服务最多同时运行 8 个".into());
            }
        }
        let mut session =
            Session::launch(&request.name, &request.command, &request.args, &request.env).await?;
        let timeout = if request.timeout.is_zero() {
            LIST_TIMEOUT
        } else {
            request.timeout
        };
        if let Err(error) = session.initialize(timeout).await {
            session.shutdown();
            return Err(error);
        }
        let tools = match session.list_tools(timeout).await {
            Ok(tools) => tools,
            Err(error) => {
                session.shutdown();
                return Err(error);
            }
        };
        let started = McpStarted {
            name: request.name.clone(),
            protocol_version: session.protocol.clone(),
            server_name: String::new(),
            instructions: String::new(),
            tools,
        };
        // server_name is filled below from the stored initialize result.
        let started = session.take_started(started);
        let name = request.name.clone();
        let arc = Arc::new(AsyncMutex::new(session));
        self.sessions
            .lock()
            .map_err(|_| "工具服务状态不可用")?
            .insert(name, arc);
        Ok(started)
    }

    pub async fn list_tools(&self, name: &str, timeout: Duration) -> Result<Vec<McpTool>, String> {
        let session = self.lookup(name)?;
        let mut session = session.lock().await;
        let result = session.list_tools(timeout).await;
        self.drop_if_dead(name, &session);
        result
    }

    pub async fn call(
        &self,
        name: &str,
        tool: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<String, String> {
        if tool.trim().is_empty() || tool.contains('\n') || tool.len() > 128 {
            return Err("工具名称无效".into());
        }
        let arguments = if arguments.is_null() {
            json!({})
        } else if arguments.is_object() {
            arguments
        } else {
            return Err("工具参数需要是对象".into());
        };
        let session = self.lookup(name)?;
        let mut session = session.lock().await;
        let result = session.call_tool(tool, arguments, timeout).await;
        self.drop_if_dead(name, &session);
        result
    }

    pub async fn stop(&self, name: &str) -> Result<(), String> {
        let removed = self
            .sessions
            .lock()
            .map_err(|_| "工具服务状态不可用")?
            .remove(name);
        if let Some(session) = removed {
            let mut session = session.lock().await;
            session.shutdown();
        }
        Ok(())
    }

    fn lookup(&self, name: &str) -> Result<Arc<AsyncMutex<Session>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "工具服务状态不可用")?
            .get(name)
            .cloned()
            .ok_or_else(|| format!("工具服务「{name}」没有启动"))
    }

    fn drop_if_dead(&self, name: &str, session: &Session) {
        if session.dead {
            if let Ok(mut guard) = self.sessions.lock() {
                guard.remove(name);
            }
        }
    }
}

impl Session {
    async fn launch(
        name: &str,
        program: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        let (program, args) = launch_parts(program, args)?;
        for (key, value) in env {
            validate_env_name(key)?;
            validate_env_value(value)?;
        }
        let mut command = Command::new(&program);
        command
            .args(&args)
            .envs(env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| format!("无法启动工具服务 {program}"))?;
        let stdin = child.stdin.take().ok_or("无法连接工具服务")?;
        let stdout = child.stdout.take().ok_or("无法连接工具服务")?;
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
            });
        }
        Ok(Self {
            name: name.to_string(),
            stdin,
            stdout: BufReader::new(stdout),
            child,
            next_id: 1,
            dead: false,
            protocol: String::new(),
            server_name: String::new(),
            instructions: String::new(),
        })
    }

    async fn initialize(&mut self, timeout: Duration) -> Result<(), String> {
        let result = self
            .roundtrip(
                "initialize",
                json!({
                    "protocolVersion": CLIENT_PROTOCOL,
                    "capabilities": {},
                    "clientInfo": {"name": "KBOT", "version": env!("CARGO_PKG_VERSION")}
                }),
                timeout,
            )
            .await?;
        let version = result["protocolVersion"].as_str().unwrap_or("").to_string();
        if !SUPPORTED_PROTOCOLS.contains(&version.as_str()) {
            self.shutdown();
            return Err(format!("工具服务使用了不支持的协议版本 {version}"));
        }
        self.protocol = version;
        self.server_name = result["serverInfo"]["name"]
            .as_str()
            .unwrap_or("")
            .to_string();
        self.instructions = result["instructions"].as_str().unwrap_or("").to_string();
        self.send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await?;
        Ok(())
    }

    fn take_started(&self, mut started: McpStarted) -> McpStarted {
        started.server_name = self.server_name.clone();
        started.instructions = self.instructions.clone();
        started.protocol_version = self.protocol.clone();
        started
    }

    async fn list_tools(&mut self, timeout: Duration) -> Result<Vec<McpTool>, String> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..10 {
            let params = match &cursor {
                Some(cursor) => json!({"cursor": cursor}),
                None => json!({}),
            };
            let result = self.roundtrip("tools/list", params, timeout).await?;
            let page = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or("工具服务没有返回工具列表")?;
            for tool in page {
                let name = tool["name"].as_str().unwrap_or("").trim().to_string();
                if name.is_empty() || name.contains('\n') || name.len() > 128 {
                    continue;
                }
                tools.push(McpTool {
                    name,
                    description: tool["description"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(2_000)
                        .collect(),
                    input_schema: tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(empty_schema),
                });
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|cursor| !cursor.is_empty());
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }

    async fn call_tool(
        &mut self,
        tool: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<String, String> {
        let result = self
            .roundtrip(
                "tools/call",
                json!({"name": tool, "arguments": arguments}),
                timeout,
            )
            .await?;
        tool_result_text(&result)
    }

    async fn roundtrip(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if self.dead {
            return Err(format!("工具服务「{}」已断开", self.name));
        }
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                self.shutdown();
                return Err(format!("工具服务「{}」响应超时，已断开", self.name));
            }
            let line = match tokio::time::timeout(remaining, self.read_line()).await {
                Ok(Ok(line)) => line,
                Ok(Err(error)) => return Err(error),
                Err(_) => {
                    self.shutdown();
                    return Err(format!("工具服务「{}」响应超时，已断开", self.name));
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let message: Value = match serde_json::from_str(line.trim()) {
                Ok(message) => message,
                Err(_) => {
                    self.shutdown();
                    return Err("工具服务返回了无法识别的数据".into());
                }
            };
            if message.get("method").and_then(Value::as_str).is_some()
                && !same_id(message.get("id").unwrap_or(&Value::Null), id)
            {
                if let Some(request_id) = message.get("id").filter(|id| !id.is_null()) {
                    self.send(&json!({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32601, "message": "Method not found"}
                    }))
                    .await?;
                }
                continue;
            }
            if same_id(message.get("id").unwrap_or(&Value::Null), id) {
                if let Some(error) = message.get("error") {
                    let text = error["message"].as_str().unwrap_or("工具服务返回错误");
                    return Err(format!("工具服务错误：{text}"));
                }
                return message
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "工具服务没有返回结果".to_string());
            }
        }
    }

    async fn send(&mut self, message: &Value) -> Result<(), String> {
        if self.dead {
            return Err(format!("工具服务「{}」已断开", self.name));
        }
        let mut line = serde_json::to_string(message).map_err(|_| "无法编码工具请求")?;
        if line.contains('\n') {
            return Err("工具请求无效".into());
        }
        line.push('\n');
        if self.stdin.write_all(line.as_bytes()).await.is_err() || self.stdin.flush().await.is_err()
        {
            self.shutdown();
            return Err(format!("工具服务「{}」已断开", self.name));
        }
        Ok(())
    }

    async fn read_line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        let read = self.stdout.read_line(&mut line).await;
        match read {
            Ok(0) => {
                self.shutdown();
                Err(format!("工具服务「{}」已断开", self.name))
            }
            Ok(_) if line.len() > MAX_LINE => {
                self.shutdown();
                Err("工具服务返回的数据过大".into())
            }
            Ok(_) => Ok(line),
            Err(_) => {
                self.shutdown();
                Err(format!("工具服务「{}」已断开", self.name))
            }
        }
    }

    fn shutdown(&mut self) {
        self.dead = true;
        let _ = self.child.start_kill();
    }
}

pub(crate) fn tool_result_text(result: &Value) -> Result<String, String> {
    let mut texts = Vec::new();
    let content = result
        .get("content")
        .and_then(Value::as_array)
        .ok_or("工具服务没有返回内容")?;
    for item in content {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => texts.push(
                item.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ),
            Some("image") | Some("audio") => texts.push("（这一期只回传文本结果）".into()),
            Some(other) => texts.push(format!("（不支持的结果类型 {other}）")),
            None => {}
        }
    }
    let mut text = texts.join("\n");
    if text.chars().count() > 16_000 {
        text = text.chars().take(16_000).collect();
    }
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(if text.is_empty() {
            "工具执行失败".into()
        } else {
            text
        });
    }
    Ok(text)
}

fn same_id(value: &Value, id: u64) -> bool {
    if value.as_u64() == Some(id) {
        return true;
    }
    value.as_str().is_some_and(|text| text == id.to_string())
}

pub(crate) fn launch_parts(
    program: &str,
    args: &[String],
) -> Result<(String, Vec<String>), String> {
    if program.is_empty()
        || program.len() > 1024
        || program.starts_with('-')
        || program.contains('\0')
        || program.contains('\n')
        || program.contains('\r')
    {
        return Err("工具服务命令无效".into());
    }
    if args.len() > 64 {
        return Err("工具服务参数过多".into());
    }
    for arg in args {
        if arg.len() > 4096 || arg.contains('\0') {
            return Err("工具服务参数无效".into());
        }
    }
    Ok((program.to_string(), args.to_vec()))
}

pub(crate) fn validate_service_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("工具服务名称需为 1–64 个字符".into());
    }
    if name
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
    {
        return Err("工具服务名称不能包含斜杠、冒号或控制字符".into());
    }
    Ok(())
}

pub(crate) fn secret_account(name: &str) -> Result<String, String> {
    validate_service_name(name)?;
    Ok(format!("mcp:{}", name.trim()))
}

pub(crate) fn validate_env_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().enumerate().all(|(index, ch)| {
            ch == '_'
                || ch.is_ascii_alphanumeric()
                    && (index > 0 || ch.is_ascii_alphabetic() || ch == '_')
        });
    if !ok {
        return Err("环境变量名无效".into());
    }
    if matches!(
        name,
        "DYLD_INSERT_LIBRARIES"
            | "DYLD_LIBRARY_PATH"
            | "DYLD_FRAMEWORK_PATH"
            | "LD_PRELOAD"
            | "LD_LIBRARY_PATH"
    ) {
        return Err("不能通过工具服务设置这个环境变量".into());
    }
    Ok(())
}

pub(crate) fn validate_env_value(value: &str) -> Result<(), String> {
    if value.len() > 32 * 1024
        || value.contains('\0')
        || value.chars().any(|ch| ch.is_control() && ch != '\t')
    {
        return Err("环境变量无效".into());
    }
    Ok(())
}

pub(crate) fn validate_secret_value(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 || value.chars().any(|ch| ch.is_control()) {
        return Err("密钥无效".into());
    }
    Ok(())
}

pub(crate) fn upsert_secret(
    map: &mut BTreeMap<String, String>,
    env: &str,
    value: &str,
) -> Result<(), String> {
    validate_env_name(env)?;
    validate_secret_value(value)?;
    map.insert(env.to_string(), value.trim().to_string());
    Ok(())
}

pub(crate) fn encode_secrets(map: &BTreeMap<String, String>) -> Result<Vec<u8>, String> {
    serde_json::to_vec(map).map_err(|_| "无法保存密钥".to_string())
}

pub(crate) fn decode_secrets(bytes: &[u8]) -> Result<BTreeMap<String, String>, String> {
    serde_json::from_slice(bytes).map_err(|_| "钥匙串里的工具服务密钥无法读取".to_string())
}

fn load_secrets(name: &str, keys: &[String]) -> Result<HashMap<String, String>, String> {
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let account = secret_account(name)?;
    let stored = match read_secret_blob(&account)? {
        Some(bytes) => decode_secrets(&bytes)?,
        None => BTreeMap::new(),
    };
    let mut out = HashMap::new();
    for key in keys {
        validate_env_name(key)?;
        let value = stored
            .get(key)
            .cloned()
            .ok_or_else(|| format!("钥匙串里没有环境变量 {key}"))?;
        out.insert(key.clone(), value);
    }
    Ok(out)
}

#[cfg(target_os = "macos")]
fn read_secret_blob(account: &str) -> Result<Option<Vec<u8>>, String> {
    match security_framework::passwords::get_generic_password(service(), account) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(match error.code() {
            -128 | -25293 | -25308 => {
                "钥匙串访问未获授权。请在 macOS 提示中使用登录密码授权 KBOT，再重试".into()
            }
            _ => "无法读取钥匙串，请检查 macOS 的访问提示后重试".into(),
        }),
    }
}
#[cfg(not(target_os = "macos"))]
fn read_secret_blob(_account: &str) -> Result<Option<Vec<u8>>, String> {
    Err("当前版本只支持 macOS 钥匙串".into())
}

#[cfg(target_os = "macos")]
fn write_secret(account: &str, env: &str, value: &str) -> Result<(), String> {
    let mut map = match read_secret_blob(account)? {
        Some(bytes) => decode_secrets(&bytes)?,
        None => BTreeMap::new(),
    };
    upsert_secret(&mut map, env, value)?;
    let bytes = encode_secrets(&map)?;
    security_framework::passwords::set_generic_password(service(), account, &bytes)
        .map_err(|_| "无法保存到钥匙串，请检查 macOS 的访问提示".to_string())
}
#[cfg(not(target_os = "macos"))]
fn write_secret(_account: &str, _env: &str, _value: &str) -> Result<(), String> {
    Err("当前版本只支持 macOS 钥匙串".into())
}

#[cfg(target_os = "macos")]
fn delete_secret(account: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(service(), account) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("无法删除钥匙串凭据，请检查 macOS 的访问提示".into()),
    }
}
#[cfg(not(target_os = "macos"))]
fn delete_secret(_account: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn secrets_are_separate_per_service_and_commands_are_not_a_shell() {
        assert_eq!(secret_account("notes").unwrap(), "mcp:notes");
        assert_eq!(secret_account("笔记").unwrap(), "mcp:笔记");
        assert_ne!(
            secret_account("notes").unwrap(),
            secret_account("mail").unwrap()
        );
        assert!(secret_account("a/b").is_err());
        assert!(secret_account("a:b").is_err());
        let mut map = BTreeMap::new();
        upsert_secret(&mut map, "API_TOKEN", "  abc  ").unwrap();
        upsert_secret(&mut map, "OTHER", "zzz").unwrap();
        let decoded = decode_secrets(&encode_secrets(&map).unwrap()).unwrap();
        assert_eq!(decoded.get("API_TOKEN").unwrap(), "abc");
        assert_eq!(decoded.get("OTHER").unwrap(), "zzz");
        assert!(upsert_secret(&mut map, "DYLD_INSERT_LIBRARIES", "evil").is_err());
        let (program, args) = launch_parts("/usr/local/bin/tool", &["--stdio".into()]).unwrap();
        assert_eq!(program, "/usr/local/bin/tool");
        assert_eq!(args, vec!["--stdio".to_string()]);
        assert!(launch_parts("sh\n-c", &[]).is_err());
        assert!(launch_parts("-rf", &[]).is_err());
    }

    #[test]
    fn tool_text_keeps_errors_distinct() {
        let ok =
            tool_result_text(&json!({"content":[{"type":"text","text":"pong"}],"isError":false}))
                .unwrap();
        assert_eq!(ok, "pong");
        assert!(tool_result_text(
            &json!({"content":[{"type":"text","text":"失败原因"}],"isError":true})
        )
        .is_err());
    }

    fn node_path() -> String {
        let output = std::process::Command::new("node")
            .arg("-e")
            .arg("process.stdout.write(process.execPath)")
            .output()
            .expect("需要本机 node 来运行假的 MCP 服务");
        assert!(output.status.success(), "node 无法运行");
        String::from_utf8(output.stdout).unwrap()
    }

    fn fake_script() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("kbot-fake-mcp-{}.js", std::process::id()));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(FAKE_MCP.as_bytes()).unwrap();
        path
    }

    async fn started(
        hub: &McpHub,
        name: &str,
        mode: &str,
        node: &str,
        script: &std::path::Path,
        timeout: Duration,
    ) -> Result<McpStarted, String> {
        let mut env = HashMap::new();
        env.insert("KBOT_FAKE_MCP".into(), mode.into());
        hub.start(StartRequest {
            name: name.into(),
            command: node.into(),
            args: vec![script.to_string_lossy().into_owned()],
            env,
            timeout,
        })
        .await
    }

    #[tokio::test]
    async fn fake_stdio_server_lists_and_calls_and_a_crash_stays_isolated() {
        let result = tokio::time::timeout(Duration::from_secs(20), async {
            let node = node_path();
            let script = fake_script();
            let hub = McpHub::default();
            let timeout = Duration::from_secs(5);
            let bad = started(&hub, "bad", "immediate", &node, &script, timeout)
                .await
                .unwrap_err();
            assert!(bad.contains("断开") || bad.contains("无法启动"), "{bad}");
            let good = started(&hub, "good", "ok", &node, &script, timeout)
                .await
                .unwrap();
            assert_eq!(good.protocol_version, CLIENT_PROTOCOL);
            assert_eq!(good.tools.len(), 1);
            assert_eq!(good.tools[0].name, "echo");
            let echoed = hub
                .call("good", "echo", json!({"text":"ping"}), timeout)
                .await
                .unwrap();
            assert_eq!(echoed, "ping");
            let trace = hub.call("good", "echo", json!({}), timeout).await.unwrap();
            assert!(trace.contains("initialize"), "{trace}");
            assert!(trace.contains("notifications/initialized"), "{trace}");
            assert!(trace.contains("tools/list"), "{trace}");
            assert!(trace.contains("tools/call"), "{trace}");

            let dying = started(&hub, "dying", "die-on-call", &node, &script, timeout)
                .await
                .unwrap();
            assert_eq!(dying.tools[0].name, "echo");
            let crashed = hub
                .call("dying", "echo", json!({"text":"x"}), timeout)
                .await
                .unwrap_err();
            assert!(crashed.contains("断开"), "{crashed}");
            let still = hub
                .call("good", "echo", json!({"text":"still"}), timeout)
                .await
                .unwrap();
            assert_eq!(still, "still");

            let hang = started(&hub, "hang", "hang-on-call", &node, &script, timeout)
                .await
                .unwrap();
            assert_eq!(hang.server_name, "fake");
            let timed = hub
                .call(
                    "hang",
                    "echo",
                    json!({"text":"wait"}),
                    Duration::from_millis(400),
                )
                .await
                .unwrap_err();
            assert!(timed.contains("超时"), "{timed}");
            let after = hub
                .call("good", "echo", json!({"text":"after"}), timeout)
                .await
                .unwrap();
            assert_eq!(after, "after");
            hub.stop("good").await.unwrap();
            let missing = hub
                .call("good", "echo", json!({}), timeout)
                .await
                .unwrap_err();
            assert!(missing.contains("没有启动"), "{missing}");
            let _ = std::fs::remove_file(&script);
        })
        .await;
        result.expect("假 MCP 服务测试超时");
    }

    const FAKE_MCP: &str = r#"
const mode = process.env.KBOT_FAKE_MCP || 'ok';
if (mode === 'immediate') process.exit(1);
if (process.stdout._handle && process.stdout._handle.setBlocking) process.stdout._handle.setBlocking(true);
const seen = [];
let buf = '';
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method) seen.push(msg.method);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.1' }, instructions: 'test' } });
    } else if (msg.method === 'notifications/initialized') {
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: '回传文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
    } else if (msg.method === 'tools/call') {
      if (mode === 'die-on-call') process.exit(1);
      if (mode === 'hang-on-call') return;
      const arg = msg.params && msg.params.arguments ? msg.params.arguments.text : '';
      const text = typeof arg === 'string' && arg.length ? arg : seen.join(',');
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } });
    } else if (msg.id !== undefined && msg.id !== null) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
"#;
}
