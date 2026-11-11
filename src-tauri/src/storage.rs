use serde_json::Value;
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};

#[derive(Default)]
pub struct StorageLock(pub Mutex<()>);

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
pub fn load_state(app: tauri::AppHandle, lock: State<StorageLock>) -> Result<Value, String> {
    let _guard = lock.0.lock().map_err(|_| "存储锁不可用")?;
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let bytes = fs::read(&path).map_err(|_| "无法读取本地数据")?;
    serde_json::from_slice(&bytes).map_err(|_| {
        // Preserve damaged data for recovery rather than overwriting it on startup.
        let _ = fs::copy(&path, path.with_extension("json.recovery"));
        "本地数据损坏，已保留恢复副本。请检查数据目录后重启。".to_string()
    })
}

#[tauri::command]
pub fn save_state(
    app: tauri::AppHandle,
    data: Value,
    lock: State<StorageLock>,
) -> Result<(), String> {
    let _guard = lock.0.lock().map_err(|_| "存储锁不可用")?;
    if !data.is_object() {
        return Err("数据格式无效".into());
    }
    let bytes = serde_json::to_vec(&data).map_err(|_| "数据无法保存")?;
    if bytes.len() > 128 * 1024 * 1024 {
        return Err("本地数据超过 128 MB，请清理部分图片对话".into());
    }
    let path = state_path(&app)?;
    let temp = path.with_extension("json.tmp");
    use std::io::Write;
    let mut file = fs::File::create(&temp).map_err(|_| "无法创建本地数据文件")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置数据权限")?;
    }
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "本地数据保存失败")?;
    fs::rename(&temp, &path).map_err(|_| "本地数据替换失败".into())
}

const SERVICE: &str = "com.cybercompanion.desktop";
fn service() -> &'static str {
    if cfg!(debug_assertions) && std::env::var("COMPANION_SMOKE").as_deref() == Ok("1") {
        "com.cybercompanion.smoke"
    } else {
        SERVICE
    }
}
fn account(slot: &str) -> Result<&str, String> {
    match slot {
        "tts" | "chat" | "vision" | "search" => Ok(slot),
        _ => Err("未知的凭据类型".into()),
    }
}

#[cfg(target_os = "macos")]
pub fn read_key(slot: &str) -> Result<String, String> {
    let key = security_framework::passwords::get_generic_password(service(), account(slot)?)
        .map_err(|error| match error.code() {
            -25300 => "尚未保存 API Key，请到设置中保存".to_string(),
            -128 | -25293 | -25308 => "钥匙串访问未获授权。请在 macOS 提示中使用登录密码授权 KBOT，再重试；已保存的 API Key 没有被删除".to_string(),
            _ => "无法读取钥匙串，请检查 macOS 的访问提示后重试".to_string(),
        })?;
    String::from_utf8(key).map_err(|_| "API Key 格式无效".into())
}
#[cfg(not(target_os = "macos"))]
pub fn read_key(_slot: &str) -> Result<String, String> {
    Err("当前版本只支持 macOS 钥匙串".into())
}

#[tauri::command]
pub async fn save_key(slot: String, key: String) -> Result<(), String> {
    account(&slot)?;
    if key.trim().is_empty() || key.len() > 4096 {
        return Err("请输入有效的 API Key".into());
    }
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || {
        security_framework::passwords::set_generic_password(service(), &slot, key.trim().as_bytes())
            .map_err(|_| "无法保存到钥匙串，请检查 macOS 的访问提示".into())
    })
    .await
    .map_err(|_| "钥匙串任务失败".to_string())?;
    #[cfg(not(target_os = "macos"))]
    Err("当前版本只支持 macOS 钥匙串".into())
}
#[tauri::command]
pub async fn delete_key(slot: String) -> Result<(), String> {
    account(&slot)?;
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || {
        // Deleting does not require first retrieving the secret.
        match security_framework::passwords::delete_generic_password(service(), &slot) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(_) => Err("无法删除钥匙串凭据，请检查 macOS 的访问提示".to_string()),
        }
    })
    .await
    .map_err(|_| "钥匙串任务失败".to_string())?;
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[cfg(target_os = "macos")]
fn key_exists(slot: &str) -> Option<bool> {
    use security_framework::item::{ItemClass, ItemSearchOptions};
    // Only metadata is requested; never retrieve kSecReturnData just to paint
    // the settings status. Authentication UI must not interrupt application boot.
    match ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service())
        .account(slot)
        .load_attributes(true)
        .load_data(false)
        .skip_authenticated_items(true)
        .limit(1)
        .search()
    {
        Ok(items) => Some(!items.is_empty()),
        Err(error) if error.code() == -25300 => Some(false),
        Err(_) => None,
    }
}
#[cfg(not(target_os = "macos"))]
fn key_exists(_slot: &str) -> Option<bool> {
    Some(false)
}

#[tauri::command]
pub async fn key_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        serde_json::json!({
            "tts": key_exists("tts"),
            "chat": key_exists("chat"),
            "vision": key_exists("vision"),
            "search": key_exists("search"),
        })
    }).await.map_err(|_| "无法检查钥匙串状态".to_string())
}
